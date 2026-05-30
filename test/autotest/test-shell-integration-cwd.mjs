/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * ConPTY / PTY-level wiring test for shell-integration cwd OSC emission.
 *
 * The bug this locks: on Windows, pwsh.ps1 used to assign to the read-only
 * `$host` automatic variable, which made the prompt function throw. PowerShell
 * then discarded the whole prompt (including the OSC writes) and showed the
 * bare `PS>` fallback, so NOT A SINGLE cwd OSC reached the renderer and the
 * Task status bar never reflected `cd`. The parser unit tests stayed green the
 * whole time because the parser was never the problem — the SHELL never spoke.
 *
 * This test spawns the host's real default shell through node-pty with the same
 * integration the app injects (see electron/main/pty-manager.ts), drives a
 * sequence of real `cd` commands, and asserts the shell emits a cwd-bearing OSC
 * (633 `P;Cwd=`, 7 `file://`, or 9;9) that decodes to each new directory.
 *
 * Run under Electron's ABI so node-pty's native binary matches:
 *   ELECTRON_RUN_AS_NODE=1 <electron> test/autotest/test-shell-integration-cwd.mjs
 *
 * Timing-sensitive (CLAUDE.md): correctness is boolean ("does the cwd OSC
 * follow the cd?"), so we run N distinct cd trials and require ALL N to be
 * detected. One miss means the emission path has a real hole.
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const INTEGRATION_DIR = join(REPO_ROOT, 'resources', 'shell-integration')
const IS_WINDOWS = process.platform === 'win32'
const TRIALS = 5

let pty
try {
  pty = require('node-pty')
} catch (err) {
  console.error('[AutoTest] FAIL: cannot load node-pty (run under Electron ABI):', String(err))
  process.exit(1)
}

// node-pty 1.1.0 forks conpty_console_list_agent.js during teardown on Windows;
// when the console session is already gone AttachConsole throws ECONNRESET. The
// app suppresses this in electron/main/index.ts — mirror that here so a clean
// run does not exit non-zero on a teardown race.
process.on('uncaughtException', (error) => {
  const code = (error && error.code) || ''
  if (code === 'ECONNRESET' || /AttachConsole/.test(String(error))) return
  console.error('[AutoTest] FAIL: uncaughtException:', error)
  process.exit(1)
})

function log(msg) { console.log(msg) }

// Mirror PtyManager.resolveWindowsShell(): prefer pwsh.exe, then powershell.exe.
function resolveWindowsShell() {
  for (const candidate of ['pwsh.exe', 'powershell.exe']) {
    try {
      const out = execFileSync('where', [candidate], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
        .toString().trim().split(/\r?\n/)[0]
      if (out) return out
    } catch { /* keep trying */ }
  }
  return process.env.COMSPEC || 'cmd.exe'
}

// Build (shell, args, env) mirroring electron/main/pty-manager.ts after the
// getWindowsShellArgs cleanup. Dot-sources / sources the REAL committed scripts
// so a content regression in pwsh.ps1 / bash.sh is caught here.
function buildLaunch() {
  const env = { ...process.env, ONWARD_SHELL_INTEGRATION: '1' }
  if (IS_WINDOWS) {
    const shell = resolveWindowsShell()
    const lower = shell.toLowerCase()
    if (lower.includes('powershell') || lower.includes('pwsh')) {
      const ps1 = join(INTEGRATION_DIR, 'pwsh.ps1')
      return { shell, args: ['-NoLogo', '-NoExit', '-Command', `. '${ps1.replace(/'/g, "''")}'`], env, kind: 'powershell' }
    }
    // cmd.exe: OSC 9;9 via the PROMPT env var (mirrors create()).
    env.PROMPT = '$e]9;9;$P$e\\$P$G'
    return { shell, args: [], env, kind: 'cmd' }
  }
  const sh = process.env.SHELL || '/bin/bash'
  const base = sh.split('/').pop()
  if (base === 'zsh') {
    return { shell: sh, args: ['-i'], env: { ...env, ZDOTDIR: join(INTEGRATION_DIR, 'zsh-zdotdir'), HISTFILE: '/dev/null' }, kind: 'zsh' }
  }
  // bash (and unknown POSIX shells fall back to bash): source the real bash.sh
  // as the rcfile so PROMPT_COMMAND emits OSC 633 + OSC 7.
  const bashRc = join(INTEGRATION_DIR, 'bash.sh')
  return { shell: '/bin/bash', args: ['--rcfile', bashRc, '-i'], env, kind: 'bash' }
}

// Normalize a filesystem path for comparison: lowercase, backslash -> slash,
// percent-decode, strip a single trailing slash. Matches how the renderer's
// normalizeTerminalGitPath collapses Windows/POSIX forms.
function norm(p) {
  let s = p.trim()
  try { s = decodeURIComponent(s) } catch { /* keep raw */ }
  s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
  if (s.length > 3 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

// Extract every cwd path carried by a cwd-bearing OSC in the buffer. We parse
// the OSC payloads specifically so the typed `cd <path>` echo (which also
// contains the path) cannot create a false positive.
function extractOscCwds(buf) {
  const out = []
  const re633 = /\x1b\]633;P;Cwd=([^\x07\x1b]*)/g
  const re7 = /\x1b\]7;file:\/\/[^/]*\/([^\x1b\x07]*)/g
  const re99 = /\x1b\]9;9;([^\x07\x1b]*)/g
  let m
  while ((m = re633.exec(buf))) out.push(norm(m[1]))
  while ((m = re7.exec(buf))) out.push(norm('/' + m[1].replace(/^\//, '')))
  while ((m = re99.exec(buf))) out.push(norm(m[1]))
  return out
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const launch = buildLaunch()
  log(`shell-integration-cwd: platform=${process.platform} kind=${launch.kind} shell=${launch.shell}`)
  log(`shell-integration-cwd: args=${JSON.stringify(launch.args)}`)

  // Per-suite scratch under the OS temp dir (CLAUDE.md fixture isolation).
  const scratch = mkdtempSync(join(tmpdir(), 'onward-si-cwd-'))
  const targets = []
  for (let i = 0; i < TRIALS; i++) {
    const d = join(scratch, `dir${i}`)
    mkdirSync(d, { recursive: true })
    targets.push(d)
  }

  let term
  let buf = ''
  try {
    term = pty.spawn(launch.shell, launch.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: existsSync(REPO_ROOT) ? REPO_ROOT : homedir(),
      env: launch.env
    })
    term.onData((d) => { buf += d })

    // Let the shell finish startup and render its first prompt.
    await delay(IS_WINDOWS ? 4500 : 2500)

    for (let i = 0; i < TRIALS; i++) {
      term.write(`cd "${targets[i]}"\r`)
      await delay(IS_WINDOWS ? 1600 : 900)
    }
    // Final settle so the last prompt's OSC lands in the buffer.
    await delay(1200)
  } finally {
    try { term && term.kill() } catch { /* ignore */ }
  }

  const detected = new Set(extractOscCwds(buf))
  const wantedRoot = norm(scratch)
  log(`shell-integration-cwd: OSC cwds detected=${detected.size} (root=${wantedRoot})`)

  let hits = 0
  for (let i = 0; i < TRIALS; i++) {
    const want = norm(targets[i])
    const ok = detected.has(want)
    if (ok) hits++
    log(`[AutoTest] ${ok ? 'PASS' : 'FAIL'} SIC-0${i + 1} cd dir${i} -> cwd OSC ${ok ? 'emitted' : 'MISSING'} (${want})`)
  }

  // Cleanup scratch (success or failure).
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* ignore */ }

  if (hits === 0) {
    log('[AutoTest] FAIL SIC-00 no cwd OSC emitted at all — shell integration is not speaking')
    log('shell-integration-cwd:complete')
    process.exit(1)
  }
  if (hits < TRIALS) {
    log(`[AutoTest] FAIL SIC-00 only ${hits}/${TRIALS} cd operations produced a cwd OSC`)
    log('shell-integration-cwd:complete')
    process.exit(1)
  }

  log(`[AutoTest] PASS SIC-00 all ${TRIALS}/${TRIALS} cd operations produced a matching cwd OSC`)
  log('shell-integration-cwd:complete')
  process.exit(0)
}

main().catch((err) => {
  console.error('[AutoTest] FAIL: unexpected error:', err)
  console.log('shell-integration-cwd:complete')
  process.exit(1)
})
