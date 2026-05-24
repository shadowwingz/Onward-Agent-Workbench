/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-ipc-worker-client.test.mts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildGitDiffWorkerDedupeKey,
  buildGitFileContentWorkerDedupeKey,
  stableStringifyForWorkerKey
} from '../../electron/main/git-ipc-worker-client-helpers.ts'

const file = {
  filename: 'src/a.ts',
  status: 'M' as const,
  originalFilename: undefined,
  changeType: 'unstaged' as const,
  isSubmoduleEntry: undefined
}

test('file-content worker requests dedupe normal reads only', () => {
  const first = buildGitFileContentWorkerDedupeKey('/repo', file, '/repo')
  const second = buildGitFileContentWorkerDedupeKey('/repo', file, '/repo')

  assert.equal(typeof first, 'string')
  assert.equal(first, second)
})

test('file-content worker requests do not dedupe force refreshes', () => {
  const forced = buildGitFileContentWorkerDedupeKey('/repo', file, '/repo', { force: true })

  assert.equal(forced, undefined)
})

test('file-content worker requests separate large-file confirmation bypasses', () => {
  const normal = buildGitFileContentWorkerDedupeKey('/repo', file, '/repo', { allowLargeFile: false })
  const allowed = buildGitFileContentWorkerDedupeKey('/repo', file, '/repo', { allowLargeFile: true })

  assert.equal(typeof normal, 'string')
  assert.equal(typeof allowed, 'string')
  assert.notEqual(normal, allowed)
})

test('diff worker requests dedupe normal reads only', () => {
  const first = buildGitDiffWorkerDedupeKey('/repo', { scope: 'full' })
  const second = buildGitDiffWorkerDedupeKey('/repo', { scope: 'full' })
  const differentScope = buildGitDiffWorkerDedupeKey('/repo', { scope: 'root-only' })

  assert.equal(typeof first, 'string')
  assert.equal(first, second)
  assert.notEqual(first, differentScope)
})

test('diff worker requests do not dedupe force refreshes', () => {
  const forced = buildGitDiffWorkerDedupeKey('/repo', { force: true, scope: 'full' })

  assert.equal(forced, undefined)
})

test('stable worker key stringifier represents undefined explicitly', () => {
  assert.equal(stableStringifyForWorkerKey(undefined), 'undefined')
  assert.equal(stableStringifyForWorkerKey({ a: undefined }), '{"a":undefined}')
  assert.equal(stableStringifyForWorkerKey([undefined]), '[undefined]')
})
