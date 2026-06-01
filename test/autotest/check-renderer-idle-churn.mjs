#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * AppState render-loop regression smoke test — CDP-driven, hang-proof.
 *
 * Why this design (and NOT the in-app suite harness): the standard autotest
 * harness only starts running suites once the Project Editor panel has opened
 * and loaded its file tree. When PE fails to open, that harness sits in
 * `waiting-for-open-root` forever — a real hang we hit while building this. So
 * this test bypasses the harness entirely: it launches the dev build with a
 * remote-debugging port, connects over CDP, and measures the renderer's idle
 * "render churn". EVERY wait here has a hard deadline and the app is ALWAYS
 * killed in `finally`, so this script cannot hang.
 *
 * What it asserts: during an idle window the renderer must NOT be storming.
 * The Windows idle-CPU bug pinned the JS thread by re-rendering the whole tree
 * ~100x/s (React scheduler postMessage) and arming saveState's setTimeout(500)
 * ~700x/s. A healthy idle renderer does neither. Thresholds are set far below
 * the storm and far above incidental idle activity, so the pass/fail is stable.
 *
 * Note on scope: this proves the WIRING in the real app. The environment-
 * independent guarantee (that the two cwd writers converge) is locked by the
 * unit tests (terminal-cwd-persist-canonical, appstate-update-bailout). This
 * smoke test reproduces the storm when at least one live terminal is present;
 * it logs the observed terminal count so a reviewer can see the scenario was
 * live.
 */

import { spawn, spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { createServer } from 'node:net'

// Pick a free ephemeral port. A previous run can leave a zombie process stuck
// holding a fixed port (the OS won't release the socket immediately, and the
// zombie can't be killed by name) — that bricked every subsequent run when we
// hardcoded 9344. Choosing a fresh free port each run makes the test immune to
// that class of leak.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const APP_BIN = process.argv[2]
// argv[3] (port) is accepted for backwards-compat but ignored — the port is
// chosen dynamically per run (see getFreePort) to dodge leaked-port zombies.
const REPO_ROOT = process.argv[4] || process.cwd()

if (!APP_BIN) {
  console.error('usage: node check-renderer-idle-churn.mjs <appBin> [port] [repoRoot]')
  process.exit(2)
}

// ---- thresholds (per 2.5s measurement window) ----
const WINDOW_MS = 2500
const MAX_POSTMESSAGE = 60   // bug ≈ 257 in 2.5s; idle ≈ 0
const MAX_SETTIMEOUT500 = 50 // bug ≈ 1730 in 2.5s; idle ≈ 0
const SETTLE_MS = 10000
// Cold start of a freshly-built ~200MB exe (first launch + AV scan on Windows)
// can take well over 30s before the renderer page appears. Give generous
// headroom — every wait is still hard-bounded, so this cannot hang.
const READY_TIMEOUT_MS = 60000
const OVERALL_DEADLINE_MS = 130000

// Kill any pre-existing instance of THIS dev build before launching. Onward's
// single-instance lock would otherwise make our spawn forward its args to the
// stale instance and exit immediately, so nothing binds the CDP port and the
// test fails with "renderer target not reachable". The test owns the dev build,
// so an exact-name kill is appropriate here.
function killStaleInstances() {
  const name = basename(APP_BIN)
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/IM', name, '/F'], { stdio: 'ignore' })
    } else {
      // macOS/Linux: match the launched binary path; -f matches the full cmdline.
      spawnSync('pkill', ['-f', name.replace(/[.]app.*$/, '')], { stdio: 'ignore' })
    }
  } catch { /* none running — fine */ }
}

let appChild = null

function killApp() {
  if (!appChild || appChild.killed) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(appChild.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try { process.kill(-appChild.pid, 'SIGKILL') } catch { appChild.kill('SIGKILL') }
    }
  } catch { /* ignore */ }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function withDeadline(promise, ms, label) {
  let t
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout: ${label} (${ms}ms)`)), ms) })
  try { return await Promise.race([promise, timeout]) } finally { clearTimeout(t) }
}

async function getRendererWs(port) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
      const list = await res.json()
      const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url || ''))
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* not ready yet */ }
    await sleep(500)
  }
  throw new Error('CDP renderer target not reachable within timeout')
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
  })
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws error'))) })
  const send = (method, params) => { const id = nextId++; ws.send(JSON.stringify({ id, method, params: params || {} })); return new Promise((res, rej) => pending.set(id, { res, rej })) }
  return { ready, send, close: () => ws.close() }
}

async function measureChurn(send) {
  const expr = `(async () => {
    const counts = { raf:0, setTimeout500:0, postMessage:0 };
    const origRaf = window.requestAnimationFrame.bind(window);
    const origST = window.setTimeout.bind(window);
    const origPM = MessagePort.prototype.postMessage;
    window.requestAnimationFrame = (cb)=>origRaf((t)=>{counts.raf++;return cb(t)});
    window.setTimeout = (cb,d,...a)=>{ if((d|0)===500)counts.setTimeout500++; return origST(cb,d,...a) };
    MessagePort.prototype.postMessage = function(...a){counts.postMessage++;return origPM.apply(this,a)};
    await new Promise(r=>origST(r, ${WINDOW_MS}));
    window.requestAnimationFrame = origRaf;
    MessagePort.prototype.postMessage = origPM;
    const terminals = document.querySelectorAll('.terminal-grid-cell').length;
    return JSON.stringify({ counts, terminals });
  })()`
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  return JSON.parse(r.result.value)
}

async function run() {
  killStaleInstances()
  await sleep(1500) // let the single-instance lock release
  const port = await getFreePort()
  console.log(`Launching dev build with --remote-debugging-port=${port} (dynamic free port)`)
  appChild = spawn(APP_BIN, [`--remote-debugging-port=${port}`], {
    cwd: REPO_ROOT,
    env: { ...process.env, ONWARD_DEBUG: '1' },
    stdio: 'ignore',
    detached: process.platform !== 'win32'
  })
  appChild.on('error', (e) => console.error('app spawn error:', e.message))

  const wsUrl = await withDeadline(getRendererWs(port), READY_TIMEOUT_MS + 2000, 'renderer-ws')
  console.log(`Connected CDP target. Settling ${SETTLE_MS}ms for idle...`)
  await sleep(SETTLE_MS)

  const client = cdp(wsUrl)
  await withDeadline(client.ready, 8000, 'cdp-open')
  await client.send('Runtime.enable')
  const { counts, terminals } = await withDeadline(measureChurn(client.send), WINDOW_MS + 8000, 'measure')
  client.close()

  const postPerSec = +(counts.postMessage / (WINDOW_MS / 1000)).toFixed(1)
  const st500PerSec = +(counts.setTimeout500 / (WINDOW_MS / 1000)).toFixed(1)
  console.log(`\n=== IDLE RENDER-CHURN (${WINDOW_MS}ms window) ===`)
  console.log(`  live terminals on screen : ${terminals}`)
  console.log(`  React commits (postMessage): ${counts.postMessage}  (${postPerSec}/s)  [budget < ${MAX_POSTMESSAGE}]`)
  console.log(`  saveState setTimeout(500)  : ${counts.setTimeout500}  (${st500PerSec}/s)  [budget < ${MAX_SETTIMEOUT500}]`)
  console.log(`  requestAnimationFrame      : ${counts.raf}  (info only)`)
  if (terminals === 0) {
    console.log('  NOTE: no live terminals — storm scenario may not be exercised this run.')
  }

  const failures = []
  if (counts.postMessage >= MAX_POSTMESSAGE) failures.push(`postMessage ${counts.postMessage} >= ${MAX_POSTMESSAGE}`)
  if (counts.setTimeout500 >= MAX_SETTIMEOUT500) failures.push(`setTimeout500 ${counts.setTimeout500} >= ${MAX_SETTIMEOUT500}`)

  if (failures.length) {
    console.log(`\n[AutoTest] FAIL ARC-01-idle-render-churn: ${failures.join('; ')}`)
    console.log('appstate-render-loop:complete')
    return 1
  }
  console.log('\n[AutoTest] PASS ARC-01-idle-render-churn')
  console.log('appstate-render-loop:complete')
  return 0
}

const overall = setTimeout(() => {
  console.error('\n[AutoTest] FAIL ARC-00-deadline: overall deadline exceeded — killing app')
  killApp()
  process.exit(1)
}, OVERALL_DEADLINE_MS)
overall.unref()

run()
  .then((code) => { killApp(); clearTimeout(overall); process.exit(code) })
  .catch((err) => {
    console.error(`\n[AutoTest] FAIL ARC-00-error: ${err.message}`)
    console.log('appstate-render-loop:complete')
    killApp(); clearTimeout(overall); process.exit(1)
  })
