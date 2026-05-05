/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-diff-request-cache.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GitDiffRequestCacheController } from '../../electron/main/git-diff-request-cache.ts'

type DiffValue = { revision: string; files: string[] }

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createController(nowRef: { value: number }) {
  return new GitDiffRequestCacheController<DiffValue>({
    ttlMs: 250,
    maxEntries: 64,
    now: () => nowRef.value,
    clone: (value) => ({
      revision: value.revision,
      files: [...value.files]
    })
  })
}

test('force refresh after mutation does not let an older in-flight request overwrite the cache', async () => {
  const nowRef = { value: 1000 }
  const cache = createController(nowRef)
  const key = '/repo::full'
  const old = createDeferred<DiffValue>()
  const fresh = createDeferred<DiffValue>()

  const oldResult = cache.get(key, {
    load: () => old.promise
  })

  assert.equal(cache.inspectForTest(key).inFlight, true)
  assert.equal(cache.invalidateKey(key), false)

  const forceResult = cache.get(key, {
    force: true,
    load: () => fresh.promise
  })
  const nonForceDuringRefresh = cache.get(key, {
    load: async () => {
      throw new Error('non-force request should join the fresh force request')
    }
  })

  fresh.resolve({ revision: 'fresh-after-lock-change', files: ['Cargo.lock'] })
  assert.deepEqual(await forceResult, { revision: 'fresh-after-lock-change', files: ['Cargo.lock'] })
  assert.deepEqual(await nonForceDuringRefresh, { revision: 'fresh-after-lock-change', files: ['Cargo.lock'] })

  old.resolve({ revision: 'stale-before-lock-change', files: [] })
  assert.deepEqual(await oldResult, { revision: 'stale-before-lock-change', files: [] })

  const cached = await cache.get(key, {
    load: async () => {
      throw new Error('fresh force result should have stayed cached')
    }
  })
  assert.deepEqual(cached, { revision: 'fresh-after-lock-change', files: ['Cargo.lock'] })
})

test('invalidation during in-flight request prevents stale result from being cached', async () => {
  const nowRef = { value: 2000 }
  const cache = createController(nowRef)
  const key = '/repo::full'
  const old = createDeferred<DiffValue>()
  let reloads = 0

  const oldResult = cache.get(key, {
    load: () => old.promise
  })
  assert.equal(cache.invalidateKey(key), false)

  old.resolve({ revision: 'old', files: [] })
  assert.deepEqual(await oldResult, { revision: 'old', files: [] })

  const reloaded = await cache.get(key, {
    load: async () => {
      reloads += 1
      return { revision: 'reload-after-invalidation', files: ['Cargo.lock'] }
    }
  })

  assert.equal(reloads, 1)
  assert.deepEqual(reloaded, { revision: 'reload-after-invalidation', files: ['Cargo.lock'] })
})

test('cached values are cloned on read and write', async () => {
  const nowRef = { value: 3000 }
  const cache = createController(nowRef)
  const key = '/repo::full'

  const first = await cache.get(key, {
    load: async () => ({ revision: 'r1', files: ['a.txt'] })
  })
  first.files.push('mutated-by-caller.txt')

  const second = await cache.get(key, {
    load: async () => {
      throw new Error('second request should use cache')
    }
  })

  assert.deepEqual(second, { revision: 'r1', files: ['a.txt'] })
})
