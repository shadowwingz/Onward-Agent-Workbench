/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { gitDiffCacheInvalidator } from '../../electron/main/git-diff-cache-invalidator.ts'

test.afterEach(() => {
  gitDiffCacheInvalidator.dispose()
})

test('gitDiffCacheInvalidator is a Mirror-backed event bus, not a Parcel watcher owner', () => {
  gitDiffCacheInvalidator.registerWatch('/tmp/onward-git-diff-a')

  const health = gitDiffCacheInvalidator.inspectHealth()
  assert.equal(health.backend, 'mirror')
  assert.equal(health.active, 1)
  assert.equal(health.projects[0]?.status, 'registered')
  assert.equal(health.projects[0]?.pending, false)
})

test('gitDiffCacheInvalidator fans out Mirror invalidations with normalized cwd', () => {
  const seen: Array<{ cwd: string; reason: string }> = []
  const dispose = gitDiffCacheInvalidator.addListener((cwd, reason) => {
    seen.push({ cwd, reason })
  })

  gitDiffCacheInvalidator.registerWatch('/tmp/onward-git-diff-b')
  gitDiffCacheInvalidator.invalidate('/tmp/onward-git-diff-b', 'mirror')
  dispose()

  assert.deepEqual(seen, [
    { cwd: resolve('/tmp/onward-git-diff-b'), reason: 'mirror' }
  ])
  assert.equal(gitDiffCacheInvalidator.inspectHealth().projects[0]?.lastEventAt !== null, true)
})

test('gitDiffCacheInvalidator emits lru when diagnostic registration exceeds the cap', () => {
  const seen: Array<{ cwd: string; reason: string }> = []
  gitDiffCacheInvalidator.addListener((cwd, reason) => {
    seen.push({ cwd, reason })
  })

  for (let i = 0; i < 9; i += 1) {
    gitDiffCacheInvalidator.registerWatch(`/tmp/onward-git-diff-${i}`)
  }

  assert.equal(gitDiffCacheInvalidator.inspectHealth().active, 8)
  assert.deepEqual(seen, [
    { cwd: resolve('/tmp/onward-git-diff-0'), reason: 'lru' }
  ])
})
