/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-meta-cache-policy.test.mts
 *
 * Locks the git-op aggregation A1 cache policy: a POSITIVE repo-meta entry
 * (repoRoot/gitDir, immutable per cwd) is fresh FOREVER so we stop re-spawning
 * `rev-parse`; a NEGATIVE entry (not-a-repo) expires after the TTL so a freshly
 * `git init`'d directory is rediscovered. A regression that re-applies the TTL
 * to positive entries re-introduces the EDR rev-parse storm (85 spawns × 3.5s).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isMetaCacheEntryFresh } from '../../electron/main/git-meta-cache-policy.ts'

const TTL = 1000

test('a positive (isRepo) entry is fresh forever — even far past the TTL', () => {
  const entry = { value: { isRepo: true }, at: 0 }
  assert.equal(isMetaCacheEntryFresh(entry, 500, TTL), true)
  assert.equal(isMetaCacheEntryFresh(entry, 10_000_000, TTL), true, 'immutable root must never expire')
})

test('a negative (not-a-repo) entry is fresh only within the TTL', () => {
  const entry = { value: { isRepo: false }, at: 0 }
  assert.equal(isMetaCacheEntryFresh(entry, 500, TTL), true, 'within TTL → fresh')
  assert.equal(isMetaCacheEntryFresh(entry, 1500, TTL), false, 'past TTL → re-check (catches a later git init)')
})

test('the TTL boundary is exclusive on the upper edge for negatives', () => {
  const entry = { value: { isRepo: false }, at: 0 }
  assert.equal(isMetaCacheEntryFresh(entry, 999, TTL), true)
  assert.equal(isMetaCacheEntryFresh(entry, 1000, TTL), false)
})
