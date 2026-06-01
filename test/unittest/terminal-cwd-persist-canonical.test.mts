/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeTerminalCwdCandidate } from '../../src/utils/terminal-cwd-osc.ts'
import { normalizeProjectCwd } from '../../src/utils/pathNormalize.ts'

// Mirror of AppStateContext.normalizePersistedTerminalCwd: validate the cwd,
// then canonicalize separators to '/'. This locks the convergence invariant
// behind the Windows idle-CPU fix — without canonicalization the OSC writer
// ('/') and the git-watcher writer ('\\') ping-pong terminal.lastCwd forever.
function persistCanonical(value: string | null | undefined): string | null {
  const validated = normalizeTerminalCwdCandidate(value)
  return validated === null ? null : normalizeProjectCwd(validated)
}

test('persisted cwd converges: forward-slash and backslash forms map to ONE string', () => {
  // The exact pair the production trace showed ping-ponging.
  assert.equal(persistCanonical('D:/Users/Documents/Onward'), 'D:/Users/Documents/Onward')
  assert.equal(persistCanonical('D:\\Users\\Documents\\Onward'), 'D:/Users/Documents/Onward')
  assert.equal(
    persistCanonical('D:/Users/Documents/Onward'),
    persistCanonical('D:\\Users\\Documents\\Onward')
  )
  assert.equal(persistCanonical('E:/RTOS-stablity/x'), persistCanonical('E:\\RTOS-stablity\\x'))
})

test('persisted cwd canonicalization is idempotent (no second-pass drift)', () => {
  for (const input of ['D:\\Users\\80253146', 'D:/Users/80253146', 'C:\\a\\b\\c', '~/projects/repo', '/Users/x/repo']) {
    const once = persistCanonical(input)
    const twice = persistCanonical(once)
    assert.equal(twice, once, `not idempotent for ${input}`)
    assert.ok(once === null || !once.includes('\\'), `still contains a backslash: ${once}`)
  }
})

test('persisted cwd keeps POSIX paths and home-relative paths intact', () => {
  assert.equal(persistCanonical('/Users/example/repo'), '/Users/example/repo')
  assert.equal(persistCanonical('~/Projects/repo'), '~/Projects/repo')
})

test('persisted cwd rejects invalid candidates (unchanged validation contract)', () => {
  assert.equal(persistCanonical('relative/path'), null)
  assert.equal(persistCanonical('Claude is waiting for your input'), null)
  assert.equal(persistCanonical(null), null)
  assert.equal(persistCanonical(undefined), null)
})
