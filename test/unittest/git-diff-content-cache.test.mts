/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-diff-content-cache.test.mts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { GitDiffContentCache } from '../../electron/main/git-diff-content-cache.ts'

interface DummyValue {
  payload: string
}

function makeCache(opts: Partial<ConstructorParameters<typeof GitDiffContentCache>[0]> = {}) {
  const cache = new GitDiffContentCache<DummyValue>({
    projectByteLimit: 1000,
    maxProjects: 3,
    singleFileByteLimit: 800,
    ...opts
  })
  return {
    cache
  }
}

test('put + get roundtrips', () => {
  const { cache } = makeCache()
  cache.put('/p1', 'a.ts', { payload: 'A' }, 100)
  assert.deepEqual(cache.get('/p1', 'a.ts'), { payload: 'A' })
  assert.equal(cache.get('/p1', 'b.ts'), null)
  assert.equal(cache.get('/p2', 'a.ts'), null)
})

test('per-project byte budget evicts smallest first', () => {
  const { cache } = makeCache({ projectByteLimit: 500 })
  cache.put('/p', 'tiny.ts', { payload: 't' }, 50)
  cache.put('/p', 'medium.ts', { payload: 'm' }, 200)
  cache.put('/p', 'large.ts', { payload: 'l' }, 200)
  // Push past budget by adding another tiny — total is 500 + 60 → must evict.
  cache.put('/p', 'newcomer.ts', { payload: 'n' }, 60)
  // Smallest entries should be the first to go (tiny + newcomer == 110 bytes).
  // After eviction, the cache should be ≤ 500 bytes and the two largest
  // entries should still be present.
  const stats = cache.inspectStats()
  assert.ok(stats.totalBytes <= 500, `totalBytes=${stats.totalBytes} exceeds 500`)
  assert.deepEqual(cache.get('/p', 'medium.ts'), { payload: 'm' })
  assert.deepEqual(cache.get('/p', 'large.ts'), { payload: 'l' })
  // tiny.ts (50 bytes) was the first victim; newcomer (60 bytes) might also
  // have evicted depending on order — what matters is the budget invariant.
  assert.equal(cache.get('/p', 'tiny.ts'), null)
})

test('single-file cap rejects oversized values without disturbing the bucket', () => {
  const { cache } = makeCache({ singleFileByteLimit: 200 })
  cache.put('/p', 'small.ts', { payload: 's' }, 100)
  const stored = cache.put('/p', 'huge.ts', { payload: 'h' }, 5_000)
  assert.equal(stored, false, 'oversized entries must not be stored')
  assert.deepEqual(cache.get('/p', 'small.ts'), { payload: 's' })
  assert.equal(cache.get('/p', 'huge.ts'), null)
})

test('project queue evicts the tail past maxProjects', () => {
  const { cache } = makeCache({ maxProjects: 2 })
  cache.put('/p1', 'a.ts', { payload: '1a' }, 50)
  cache.put('/p2', 'a.ts', { payload: '2a' }, 50)
  assert.deepEqual(cache.inspectStats().projects.map((p) => p.project), ['/p2', '/p1'])

  cache.put('/p3', 'a.ts', { payload: '3a' }, 50)
  assert.equal(cache.get('/p1', 'a.ts'), null)
  assert.deepEqual(cache.get('/p2', 'a.ts'), { payload: '2a' })
  assert.deepEqual(cache.get('/p3', 'a.ts'), { payload: '3a' })
  assert.equal(cache.consumeRecentProjectQueueEviction('/p1'), true)
  assert.equal(cache.consumeRecentProjectQueueEviction('/p1'), false)
})

test('get moves the project to the front so it survives the next tail eviction', () => {
  const { cache } = makeCache({ maxProjects: 2 })
  cache.put('/p1', 'a.ts', { payload: '1' }, 10)
  cache.put('/p2', 'a.ts', { payload: '2' }, 10)
  assert.deepEqual(cache.inspectStats().projects.map((p) => p.project), ['/p2', '/p1'])

  assert.deepEqual(cache.get('/p1', 'a.ts'), { payload: '1' })
  assert.deepEqual(cache.inspectStats().projects.map((p) => p.project), ['/p1', '/p2'])

  cache.put('/p3', 'a.ts', { payload: '3' }, 10)
  assert.deepEqual(cache.get('/p1', 'a.ts'), { payload: '1' })
  assert.equal(cache.get('/p2', 'a.ts'), null)
  assert.deepEqual(cache.get('/p3', 'a.ts'), { payload: '3' })
})

test('put moves an existing project to the front without changing entry count', () => {
  const { cache } = makeCache({ maxProjects: 3 })
  cache.put('/p1', 'a.ts', { payload: '1a' }, 10)
  cache.put('/p2', 'a.ts', { payload: '2a' }, 10)
  cache.put('/p3', 'a.ts', { payload: '3a' }, 10)
  assert.deepEqual(cache.inspectStats().projects.map((p) => p.project), ['/p3', '/p2', '/p1'])

  cache.put('/p1', 'b.ts', { payload: '1b' }, 10)
  const stats = cache.inspectStats()
  assert.deepEqual(stats.projects.map((p) => p.project), ['/p1', '/p3', '/p2'])
  assert.equal(stats.projects[0].entries, 2)
})

test('invalidateProject drops the whole bucket; other projects unaffected', () => {
  const { cache } = makeCache()
  cache.put('/p1', 'a.ts', { payload: '1a' }, 10)
  cache.put('/p1', 'b.ts', { payload: '1b' }, 20)
  cache.put('/p2', 'a.ts', { payload: '2a' }, 10)
  const dropped = cache.invalidateProject('/p1')
  assert.equal(dropped, 2)
  assert.equal(cache.get('/p1', 'a.ts'), null)
  assert.equal(cache.get('/p1', 'b.ts'), null)
  assert.deepEqual(cache.get('/p2', 'a.ts'), { payload: '2a' })
})

test('invalidateEntry surgically removes one file', () => {
  const { cache } = makeCache()
  cache.put('/p1', 'a.ts', { payload: '1a' }, 10)
  cache.put('/p1', 'b.ts', { payload: '1b' }, 20)
  assert.equal(cache.invalidateEntry('/p1', 'a.ts'), true)
  assert.equal(cache.invalidateEntry('/p1', 'a.ts'), false, 'second invalidate is a no-op')
  assert.equal(cache.get('/p1', 'a.ts'), null)
  assert.deepEqual(cache.get('/p1', 'b.ts'), { payload: '1b' })
})

test('invalidateAll clears every bucket', () => {
  const { cache } = makeCache()
  cache.put('/p1', 'a.ts', { payload: '1a' }, 10)
  cache.put('/p2', 'a.ts', { payload: '2a' }, 10)
  cache.put('/p3', 'a.ts', { payload: '3a' }, 10)
  const dropped = cache.invalidateAll()
  assert.equal(dropped, 3)
  assert.equal(cache.inspectStats().totalEntries, 0)
})

test('inspectStats reports byte totals and configured limits', () => {
  const { cache } = makeCache({
    projectByteLimit: 500,
    maxProjects: 5,
    singleFileByteLimit: 200
  })
  cache.put('/p1', 'a.ts', { payload: '1a' }, 100)
  cache.put('/p1', 'b.ts', { payload: '1b' }, 50)
  cache.put('/p2', 'a.ts', { payload: '2a' }, 30)
  const stats = cache.inspectStats()
  assert.equal(stats.totalBytes, 180)
  assert.equal(stats.totalEntries, 3)
  assert.equal(stats.projectByteLimit, 500)
  assert.equal(stats.maxProjects, 5)
  assert.equal(stats.singleFileByteLimit, 200)
  assert.deepEqual(
    stats.projects.map((p) => ({ project: p.project, bytes: p.bytes, entries: p.entries })),
    [
      { project: '/p2', bytes: 30, entries: 1 },
      { project: '/p1', bytes: 150, entries: 2 }
    ]
  )
  assert.deepEqual(stats.projects[1].entryDetails, [
    { key: 'a.ts', bytes: 100 },
    { key: 'b.ts', bytes: 50 }
  ])
})

test('overwriting an existing entry replaces, does not double-count bytes', () => {
  const { cache } = makeCache()
  cache.put('/p', 'a.ts', { payload: 'v1' }, 100)
  cache.put('/p', 'a.ts', { payload: 'v2' }, 250)
  const stats = cache.inspectStats()
  assert.equal(stats.totalBytes, 250)
  assert.equal(stats.projects.length, 1)
  assert.equal(stats.projects[0].entries, 1)
  assert.deepEqual(cache.get('/p', 'a.ts'), { payload: 'v2' })
})
