/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-ipc-worker-lane-keys.test.mts
 *
 * Locks the three-lane git-runtime isolation (prewarm-cache design decision ⑨):
 *   1. foreground            → bare repoKey                     (priority 'high')
 *   2. prewarm diff list     → `${repoKey}::diff-precompute`    (priority 'low')
 *   3. prewarm content burst → `${repoKey}::precompute-burst`   (priority 'low')
 * A regression that collapses any two of these into one repoKey re-introduces
 * the measured 18-29s first-click latency on EDR-throttled hosts, so the lane
 * keys are pinned here as pure-function output.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  GIT_LANE_SUFFIX,
  diffListLaneKey,
  fileContentLaneKey,
  repoKeyForWorker
} from '../../electron/main/git-ipc-worker-client-helpers.ts'

// ---------------------------------------------------------------------------
// diffListLaneKey — getDiff
// ---------------------------------------------------------------------------

test('diffListLaneKey: foreground enter stays on the bare cwd lane', () => {
  assert.equal(diffListLaneKey('/work/repo', false), '/work/repo')
})

test('diffListLaneKey: background prewarm forks the ::diff-precompute lane', () => {
  assert.equal(diffListLaneKey('/work/repo', true), '/work/repo::diff-precompute')
  assert.equal(diffListLaneKey('/work/repo', true).endsWith(GIT_LANE_SUFFIX.diffPrecompute), true)
})

test('diffListLaneKey: foreground and background are DIFFERENT lanes for the same repo', () => {
  assert.notEqual(diffListLaneKey('/work/repo', false), diffListLaneKey('/work/repo', true))
})

// ---------------------------------------------------------------------------
// fileContentLaneKey — getFileContent
// ---------------------------------------------------------------------------

test('fileContentLaneKey: high-priority foreground click stays on the base lane', () => {
  const base = repoKeyForWorker('/work/repo')
  assert.equal(fileContentLaneKey(base, 'high'), base)
})

test('fileContentLaneKey: normal priority also stays on the base lane (not a precompute)', () => {
  const base = repoKeyForWorker('/work/repo')
  assert.equal(fileContentLaneKey(base, 'normal'), base)
})

test('fileContentLaneKey: low-priority content burst forks the ::precompute-burst lane', () => {
  const base = repoKeyForWorker('/work/repo')
  assert.equal(fileContentLaneKey(base, 'low'), `${base}::precompute-burst`)
  assert.equal(fileContentLaneKey(base, 'low').endsWith(GIT_LANE_SUFFIX.precomputeBurst), true)
})

// ---------------------------------------------------------------------------
// Three-lane mutual isolation
// ---------------------------------------------------------------------------

test('the three lanes for one repo are mutually distinct', () => {
  const base = repoKeyForWorker('/work/repo')
  const foreground = fileContentLaneKey(base, 'high')          // also === diffListLaneKey(cwd,false) base
  const diffPrecompute = diffListLaneKey('/work/repo', true)
  const contentBurst = fileContentLaneKey(base, 'low')
  const lanes = new Set([foreground, diffPrecompute, contentBurst])
  assert.equal(lanes.size, 3, `expected 3 distinct lanes, got ${[...lanes].join(' | ')}`)
})

test('the content-burst suffix is NOT a prefix-collision with the diff-precompute suffix', () => {
  // A naive `startsWith('::precompute')` check elsewhere must not treat the two
  // low lanes as the same family; the suffixes are deliberately disjoint.
  assert.notEqual(GIT_LANE_SUFFIX.precomputeBurst, GIT_LANE_SUFFIX.diffPrecompute)
  assert.equal(GIT_LANE_SUFFIX.diffPrecompute.startsWith(GIT_LANE_SUFFIX.precomputeBurst), false)
  assert.equal(GIT_LANE_SUFFIX.precomputeBurst.startsWith(GIT_LANE_SUFFIX.diffPrecompute), false)
})

// ---------------------------------------------------------------------------
// Submodule routing
// ---------------------------------------------------------------------------

test('a submodule file routes to its OWN per-repoRoot burst lane, not the superproject lane', () => {
  // repoKeyForWorker(cwd, repoRoot) keys on repoRoot when present, so a
  // submodule's content burst lane is distinct from the superproject's.
  const superBase = repoKeyForWorker('/work/super')
  const subBase = repoKeyForWorker('/work/super', '/work/super/modules/x')
  assert.notEqual(subBase, superBase)
  assert.notEqual(
    fileContentLaneKey(subBase, 'low'),
    fileContentLaneKey(superBase, 'low'),
    'submodule burst lane must not collide with superproject burst lane'
  )
})
