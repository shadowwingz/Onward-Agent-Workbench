/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import {
  expandTerminalCwdCandidate,
  resolveExistingTerminalCwd,
  isUsableTerminalCwd
} from '../../electron/main/terminal-cwd-validation.ts'

test('terminal cwd validation resolves existing directories only', () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-terminal-cwd-'))
  try {
    assert.equal(resolveExistingTerminalCwd(root), realpathSync(root))
    assert.equal(isUsableTerminalCwd(root), true)
    assert.equal(resolveExistingTerminalCwd(join(root, 'missing')), null)
    assert.equal(resolveExistingTerminalCwd('/Claude is waiting for your input'), null)
    assert.equal(resolveExistingTerminalCwd('Claude is waiting for your input'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('terminal cwd validation expands home shorthand before filesystem checks', () => {
  assert.equal(expandTerminalCwdCandidate('~'), homedir())
  assert.equal(resolveExistingTerminalCwd('~'), realpathSync(homedir()))
})
