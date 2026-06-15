/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-cat-file-batch-platform.test.mts
 *
 * Locks the per-platform command policy for the long-running
 * `git cat-file --batch` reader (Phase A of the EDR spawn-reduction plan).
 *
 * The batch MECHANISM is platform-agnostic; this policy decides WHICH git
 * command drives it. Scope is win32 + darwin only, by request:
 *   - win32  -> resolved system git (implemented)
 *   - darwin -> resolved system git (INTERIM placeholder; macOS swaps in its
 *               bundled platform command later)
 *   - linux / others -> null (NOT enabled; caller falls back to per-call cat-file)
 *
 * Pure logic (platform injected), so this runs in plain `node --test` without
 * Electron and without mocking `process.platform`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveBatchGitExecutable,
  resolveDarwinBatchGitExecutable,
  isBatchSupportedPlatform
} from '../../electron/main/git-cat-file-batch-platform.ts'

const GIT = '/resolved/system/git'

test('win32: batch uses the resolved system git', () => {
  assert.equal(resolveBatchGitExecutable('win32', GIT), GIT)
  assert.equal(isBatchSupportedPlatform('win32'), true)
})

test('darwin: batch is enabled and (interim placeholder) uses the resolved system git', () => {
  // INTERIM contract: until macOS ships its bundled command, darwin drives the
  // system git so the mechanism is already active. If the macOS owner later
  // returns a bundled path, this test should be updated alongside that change.
  assert.equal(resolveBatchGitExecutable('darwin', GIT), GIT)
  assert.equal(resolveDarwinBatchGitExecutable(GIT), GIT)
  assert.equal(isBatchSupportedPlatform('darwin'), true)
})

test('linux: batch is intentionally NOT enabled (falls back to per-call cat-file)', () => {
  assert.equal(resolveBatchGitExecutable('linux', GIT), null)
  assert.equal(isBatchSupportedPlatform('linux'), false)
})

test('other platforms (freebsd, aix, sunos, openbsd): not enabled', () => {
  for (const p of ['freebsd', 'aix', 'sunos', 'openbsd'] as NodeJS.Platform[]) {
    assert.equal(resolveBatchGitExecutable(p, GIT), null, `${p} must not enable the batch`)
    assert.equal(isBatchSupportedPlatform(p), false, `${p} must not be supported`)
  }
})

test('resolver is pure: same input -> same output, independent of the running platform', () => {
  // Calling twice with the same args yields the same result, and the supported
  // set is exactly { win32, darwin } regardless of where the test runs.
  assert.equal(resolveBatchGitExecutable('win32', GIT), resolveBatchGitExecutable('win32', GIT))
  const supported = (['win32', 'darwin', 'linux', 'freebsd', 'aix'] as NodeJS.Platform[])
    .filter((p) => isBatchSupportedPlatform(p))
  assert.deepEqual(supported, ['win32', 'darwin'])
})
