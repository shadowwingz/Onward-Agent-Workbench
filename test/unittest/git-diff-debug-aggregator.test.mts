/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { aggregateClickHistory, computePhaseMs, percentile } from '../../src/components/GitDiffViewer/gitDiffDebugAggregator.ts'
import type { ClickLatencyMeasurement } from '../../src/components/GitDiffViewer/clickLatencyTracker.ts'

const make = (overrides: Partial<ClickLatencyMeasurement>): ClickLatencyMeasurement => ({
  fileKey: 'k',
  filename: 'a.ts',
  cacheState: 'hit',
  cacheSource: 'main-content-cache',
  cacheMissReason: null,
  clickAt: 0,
  ipcStartAt: 1,
  ipcEndAt: 5,
  stateSetAt: 6,
  modelBoundAt: 8,
  editorReadyAt: 12,
  diffComputedAt: 16,
  domCommittedAt: 18,
  paintReadyAt: 20,
  tokenizeSettleAt: 24,
  firstPaintMs: 20,
  totalMs: 24,
  settleReason: 'tokens-quiet',
  coldMountMs: null,
  cancelled: false,
  ...overrides
})

test('percentile – empty array returns 0', () => {
  assert.equal(percentile([], 50), 0)
})

test('percentile – p50 / p95 / p100 nearest-rank', () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  assert.equal(percentile(values, 50), 50)
  assert.equal(percentile(values, 95), 100)
  assert.equal(percentile(values, 100), 100)
  assert.equal(percentile(values, 0), 10)
})

test('computePhaseMs – returns deltas, null for missing endpoints', () => {
  const phases = computePhaseMs(make({}))
  assert.equal(phases.ipcMs, 4)
  assert.equal(phases.stateSetMs, 1)
  assert.equal(phases.modelBindMs, 2)
  assert.equal(phases.mountMs, 4)
  assert.equal(phases.diffComputeMs, 4)
  assert.equal(phases.domCommitMs, 2)
  assert.equal(phases.paintMs, 2)
  assert.equal(phases.tokenizeSettleMs, 4)

  const partial = computePhaseMs(make({ stateSetAt: null }))
  assert.equal(partial.stateSetMs, null)
  assert.equal(partial.modelBindMs, null)
  assert.equal(computePhaseMs(make({ stateSetAt: null, modelBoundAt: null })).mountMs, null)
})

test('aggregate – empty history yields total=0 with null totalMs', () => {
  const stats = aggregateClickHistory([])
  assert.equal(stats.total, 0)
  assert.equal(stats.completed, 0)
  assert.equal(stats.totalMs, null)
  assert.equal(stats.hitRate, null)
})

test('aggregate – cancelled entries excluded from latency, counted separately', () => {
  const history = [
    make({ totalMs: 10, tokenizeSettleAt: 10 }),
    make({ totalMs: 20, tokenizeSettleAt: 20 }),
    make({ cancelled: true, paintReadyAt: null, tokenizeSettleAt: null, totalMs: null })
  ]
  const stats = aggregateClickHistory(history)
  assert.equal(stats.total, 3)
  assert.equal(stats.completed, 2)
  assert.equal(stats.cancelled, 1)
  assert.equal(stats.totalMs?.mean, 15)
})

test('aggregate – hit rate over (hit + miss), unknowns excluded', () => {
  const history = [
    make({ cacheState: 'hit', totalMs: 5, tokenizeSettleAt: 5 }),
    make({ cacheState: 'hit', totalMs: 6, tokenizeSettleAt: 6 }),
    make({ cacheState: 'hit', totalMs: 7, tokenizeSettleAt: 7 }),
    make({ cacheState: 'miss', totalMs: 30, tokenizeSettleAt: 30 }),
    make({ cacheState: 'unknown', totalMs: 8, tokenizeSettleAt: 8 })
  ]
  const stats = aggregateClickHistory(history)
  assert.equal(stats.hitCount, 3)
  assert.equal(stats.missCount, 1)
  assert.equal(stats.unknownCount, 1)
  assert.equal(stats.hitRate, 0.75)
})

test('aggregate – window slices to the last N entries only', () => {
  const history: ClickLatencyMeasurement[] = []
  for (let i = 0; i < 50; i += 1) {
    history.push(make({ totalMs: i + 1, tokenizeSettleAt: i + 1 }))
  }
  const stats = aggregateClickHistory(history, 10)
  assert.equal(stats.total, 10)
  // The last 10 entries are totals 41..50 inclusive.
  assert.equal(stats.totalMs?.min, 41)
  assert.equal(stats.totalMs?.max, 50)
})

test('aggregate – per-phase mean averages only the entries that contributed', () => {
  const history = [
    make({}), // ipcMs=4, mountMs=4
    make({ ipcStartAt: 1, ipcEndAt: 11 }), // ipcMs=10
    make({ stateSetAt: null, editorReadyAt: null, diffComputedAt: null }) // only ipc + paint phases skipped where null
  ]
  const stats = aggregateClickHistory(history)
  // ipc means: (4 + 10 + 4) / 3 = 6
  assert.equal(stats.perPhaseMean.ipcMs, 6)
  // stateSet means: only entries 0 + 1 contributed; entry 2 has stateSetAt null
  assert.equal(stats.perPhaseMean.stateSetMs, 1)
})

test('aggregate – p95 is the second-largest in a 20-sample window', () => {
  const history: ClickLatencyMeasurement[] = []
  for (let i = 1; i <= 20; i += 1) {
    history.push(make({ totalMs: i, tokenizeSettleAt: i }))
  }
  const stats = aggregateClickHistory(history)
  // Nearest-rank p95 of 1..20 is 19 (ceil(0.95 * 20) - 1 = 18 → sorted[18] = 19)
  assert.equal(stats.totalMs?.p95, 19)
})
