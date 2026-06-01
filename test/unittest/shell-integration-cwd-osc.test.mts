/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Pure-logic contract test for the committed shell-integration scripts.
//
// These scripts are what every supported shell sources/dot-sources on each
// prompt so the renderer's xterm OSC parser can detect cwd changes and update
// the Task status bar. The math being locked here:
//
//   1. pwsh.ps1 MUST NOT assign to `$host`. `$Host` is a read-only automatic
//      variable in Windows PowerShell 5.x; assigning to it makes the prompt
//      function throw, PowerShell discards the prompt (and the OSC writes with
//      it) and falls back to `PS>`, so ZERO cwd OSC reach the renderer and the
//      Task status bar never reflects `cd`. This guards against reintroducing
//      that exact regression. The autotest (run-shell-integration-cwd) proves
//      the live wiring; this test pins the script content so a future "tidy-up"
//      that renames `$hostName` back to `$host` fails fast in plain Node.
//   2. Every shell-integration script MUST emit both the OSC 633 (VS Code
//      `P;Cwd=`) and OSC 7 (`file://`) dialects the parser understands.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath converts file:///D:/... to D:\... on Windows, avoiding the
// double-drive-letter (D:\D:\...) that .pathname produces on that platform.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

function readShellIntegration(name: string): string {
  return readFileSync(join(repoRoot, 'resources', 'shell-integration', name), 'utf8')
}

test('pwsh.ps1 never assigns to the read-only $host automatic variable', () => {
  const src = readShellIntegration('pwsh.ps1')
  // Case-insensitive ($host/$Host/$HOST are the same var). The \b after "host"
  // ensures we do not flag the safe $hostName replacement (no word boundary
  // between "host" and "Name"). Match optional whitespace before `=` but not
  // `==`/`-eq` comparisons.
  const forbidden = /\$host\b\s*=(?!=)/i
  assert.equal(
    forbidden.test(src),
    false,
    'pwsh.ps1 assigns to $host (read-only automatic variable in Windows PowerShell 5.x). ' +
      'Use $hostName or another non-reserved name — see the comment in pwsh.ps1.'
  )
})

test('pwsh.ps1 emits both OSC 633 and OSC 7 cwd dialects and chains the original prompt', () => {
  const src = readShellIntegration('pwsh.ps1')
  assert.ok(src.includes(']633;P;Cwd='), 'pwsh.ps1 must emit OSC 633 P;Cwd=')
  assert.ok(src.includes(']7;file://'), 'pwsh.ps1 must emit OSC 7 file://')
  assert.ok(
    src.includes('$Global:__OnwardOriginalPrompt'),
    'pwsh.ps1 must capture and re-invoke the user/default prompt so its visible prompt survives'
  )
})

test('every committed shell-integration script emits OSC 633 and OSC 7', () => {
  // bash.sh is the macOS/Linux reference; pwsh.ps1 the Windows path. Both must
  // emit the same two dialects so the parser behaves identically per platform.
  for (const script of ['bash.sh', 'pwsh.ps1']) {
    const src = readShellIntegration(script)
    assert.ok(src.includes(']633;P;Cwd='), `${script} must emit OSC 633 P;Cwd=`)
    assert.ok(src.includes(']7;file://'), `${script} must emit OSC 7 file://`)
  }
})
