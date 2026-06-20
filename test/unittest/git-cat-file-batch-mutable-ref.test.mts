/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-cat-file-batch-mutable-ref.test.mts
 *
 * Locks the contract that decides which cat-file refs may be served by the
 * long-running `git cat-file --batch` process. The batch caches the index in
 * memory at first access, so a `:<path>` (index) read after a `git add` /
 * stage returns the STALE startup index blob — that surfaced as staged diffs
 * showing HEAD/base content on both sides (GDS-22 / GDS-33). Index refs must
 * bypass the batch (per-call path re-reads the current index); only immutable
 * objects (HEAD:path, <commit>:path, blob oids) are batch-safe. The end-to-end
 * behaviour is locked by run-git-diff-staleness-and-submodule (GDS-22/33).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { isMutableIndexRef } from '../../electron/main/git-cat-file-ref.ts'

test('index refs (mutable) must bypass the long-running batch', () => {
  assert.equal(isMutableIndexRef(':src/main.txt'), true)   // index entry
  assert.equal(isMutableIndexRef(':0:src/main.txt'), true) // stage 0 (merged)
  assert.equal(isMutableIndexRef(':1:src/main.txt'), true) // stage 1 (base, conflict)
  assert.equal(isMutableIndexRef(':2:src/main.txt'), true) // stage 2 (ours)
  assert.equal(isMutableIndexRef(':3:src/main.txt'), true) // stage 3 (theirs)
})

test('immutable refs are batch-safe (not flagged mutable)', () => {
  assert.equal(isMutableIndexRef('HEAD:src/main.txt'), false)
  assert.equal(isMutableIndexRef('abc1234:src/main.txt'), false) // <commit>:path
  assert.equal(isMutableIndexRef('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'), false) // blob oid
  assert.equal(isMutableIndexRef('main:src/main.txt'), false) // branch:path
})
