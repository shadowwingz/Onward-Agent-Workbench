/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-diff-submodule-load-observation.test.mts
 *
 * Locks the pure latch reducer behind DSM-03 / RSM-03 ("outline visible before
 * full submodule load"). The reducer captures the transient intermediate state
 * at apply-time so the tests read a latch instead of racing a poll. The
 * end-to-end behaviour is locked by run-git-diff-submodules (DSM-03) and
 * run-git-diff-recursive-submodules (RSM-03).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  emptySubmoduleLoadObservation,
  foldSubmoduleLoadObservation
} from '../../src/components/GitDiffViewer/submoduleLoadObservation.ts'

test('root-only result (submodulesLoading) raises the loading peaks', () => {
  const o = foldSubmoduleLoadObservation(emptySubmoduleLoadObservation(), {
    submodulesLoading: true,
    repos: [
      { loading: false, depth: 0 }, // superproject, not loading
      { loading: true, depth: 0 },  // a top-level submodule loading
      { loading: true, depth: 1 }   // a NESTED submodule loading
    ]
  })
  assert.equal(o.sawSubmodulesLoading, true)
  assert.equal(o.maxLoadingRepoCount, 2)       // DSM-03: any loading repo
  assert.equal(o.maxNestedLoadingRepoCount, 1) // RSM-03: nested (depth>0) loading repo
})

test('settled full result (submodulesLoading:false) does NOT lower the latched peaks', () => {
  let o = foldSubmoduleLoadObservation(emptySubmoduleLoadObservation(), {
    submodulesLoading: true,
    repos: [{ loading: true, depth: 0 }, { loading: true, depth: 2 }]
  })
  // the later, fully-loaded pass arrives with nothing loading
  o = foldSubmoduleLoadObservation(o, { submodulesLoading: false, repos: [{ loading: false, depth: 0 }] })
  assert.equal(o.maxLoadingRepoCount, 2)
  assert.equal(o.maxNestedLoadingRepoCount, 1)
  assert.equal(o.sawSubmodulesLoading, true)
})

test('fresh latch with no loading state stays zero (fresh open opens blank of observation)', () => {
  const o = foldSubmoduleLoadObservation(emptySubmoduleLoadObservation(), {
    submodulesLoading: false,
    repos: [{ loading: false, depth: 0 }]
  })
  assert.deepEqual(o, emptySubmoduleLoadObservation())
})

test('null / undefined result is a no-op', () => {
  const base = { sawSubmodulesLoading: true, maxLoadingRepoCount: 3, maxNestedLoadingRepoCount: 1 }
  assert.deepEqual(foldSubmoduleLoadObservation(base, null), base)
  assert.deepEqual(foldSubmoduleLoadObservation(base, undefined), base)
})
