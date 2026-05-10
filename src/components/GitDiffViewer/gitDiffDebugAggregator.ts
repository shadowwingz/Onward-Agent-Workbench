/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Pure aggregator over `ClickLatencyMeasurement` history. Two consumers:
//   1. The in-app debug panel renders aggregate lines + a per-phase mean
//      breakdown.
//   2. Tests assert percentile / hit-rate behaviour without needing a DOM.
//
// All inputs are expected to be sealed measurements (paintReady fired or
// cancelled). Cancelled entries are excluded from latency stats but counted
// separately.

import type { ClickLatencyMeasurement } from './clickLatencyTracker'

export interface PhaseMs {
  ipcMs: number | null
  stateSetMs: number | null
  modelBindMs: number | null
  mountMs: number | null
  diffComputeMs: number | null
  domCommitMs: number | null
  paintMs: number | null
  tokenizeSettleMs: number | null
}

export interface ClickAggregateStats {
  /** Total measurements considered (after slicing the window). */
  total: number
  /** Measurements that completed (tokenizeSettleAt fired). */
  completed: number
  cancelled: number
  hitCount: number
  missCount: number
  hitRate: number | null // 0..1, null when completed === 0
  totalMs: { min: number; p50: number; p95: number; max: number; mean: number } | null
  perPhaseMean: PhaseMs
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

export function computePhaseMs(m: ClickLatencyMeasurement): PhaseMs {
  const span = (from: number | null, to: number | null): number | null => {
    if (from === null || to === null) return null
    const v = to - from
    return Number.isFinite(v) && v >= 0 ? v : null
  }
  return {
    ipcMs: span(m.ipcStartAt, m.ipcEndAt),
    stateSetMs: span(m.ipcEndAt, m.stateSetAt),
    modelBindMs: span(m.stateSetAt, m.modelBoundAt),
    mountMs: span(m.modelBoundAt ?? m.stateSetAt, m.editorReadyAt),
    diffComputeMs: span(m.editorReadyAt ?? m.modelBoundAt, m.diffComputedAt),
    domCommitMs: span(m.diffComputedAt, m.domCommittedAt),
    paintMs: span(m.domCommittedAt ?? m.diffComputedAt, m.paintReadyAt),
    tokenizeSettleMs: span(m.paintReadyAt ?? m.domCommittedAt ?? m.diffComputedAt, m.tokenizeSettleAt)
  }
}

export function aggregateClickHistory(
  history: ClickLatencyMeasurement[],
  windowSize = 30
): ClickAggregateStats {
  const recent = history.slice(-windowSize)
  const total = recent.length
  let cancelled = 0
  let hitCount = 0
  let missCount = 0
  const totals: number[] = []
  const phaseSums: PhaseMs = {
    ipcMs: 0, stateSetMs: 0, modelBindMs: 0, mountMs: 0, diffComputeMs: 0, domCommitMs: 0, paintMs: 0, tokenizeSettleMs: 0
  }
  const phaseCounts: PhaseMs = {
    ipcMs: 0, stateSetMs: 0, modelBindMs: 0, mountMs: 0, diffComputeMs: 0, domCommitMs: 0, paintMs: 0, tokenizeSettleMs: 0
  }

  for (const m of recent) {
    if (m.cancelled || m.tokenizeSettleAt === null || m.totalMs === null) {
      cancelled += 1
      continue
    }
    if (m.cacheState === 'hit') hitCount += 1
    else missCount += 1
    totals.push(m.totalMs)

    const phases = computePhaseMs(m)
    for (const key of Object.keys(phaseSums) as (keyof PhaseMs)[]) {
      const v = phases[key]
      if (v !== null) {
        phaseSums[key] = (phaseSums[key] as number) + v
        phaseCounts[key] = (phaseCounts[key] as number) + 1
      }
    }
  }

  const completed = totals.length
  const round = (n: number): number => +n.toFixed(2)
  const phaseMean: PhaseMs = {
    ipcMs: phaseCounts.ipcMs ? round((phaseSums.ipcMs as number) / (phaseCounts.ipcMs as number)) : null,
    stateSetMs: phaseCounts.stateSetMs ? round((phaseSums.stateSetMs as number) / (phaseCounts.stateSetMs as number)) : null,
    modelBindMs: phaseCounts.modelBindMs ? round((phaseSums.modelBindMs as number) / (phaseCounts.modelBindMs as number)) : null,
    mountMs: phaseCounts.mountMs ? round((phaseSums.mountMs as number) / (phaseCounts.mountMs as number)) : null,
    diffComputeMs: phaseCounts.diffComputeMs ? round((phaseSums.diffComputeMs as number) / (phaseCounts.diffComputeMs as number)) : null,
    domCommitMs: phaseCounts.domCommitMs ? round((phaseSums.domCommitMs as number) / (phaseCounts.domCommitMs as number)) : null,
    paintMs: phaseCounts.paintMs ? round((phaseSums.paintMs as number) / (phaseCounts.paintMs as number)) : null,
    tokenizeSettleMs: phaseCounts.tokenizeSettleMs ? round((phaseSums.tokenizeSettleMs as number) / (phaseCounts.tokenizeSettleMs as number)) : null
  }

  let totalMs: ClickAggregateStats['totalMs'] = null
  if (completed > 0) {
    const sum = totals.reduce((a, b) => a + b, 0)
    totalMs = {
      min: round(Math.min(...totals)),
      p50: round(percentile(totals, 50)),
      p95: round(percentile(totals, 95)),
      max: round(Math.max(...totals)),
      mean: round(sum / completed)
    }
  }

  const cacheCovered = hitCount + missCount
  const hitRate = cacheCovered > 0 ? hitCount / cacheCovered : null

  return {
    total,
    completed,
    cancelled,
    hitCount,
    missCount,
    hitRate,
    totalMs,
    perPhaseMean: phaseMean
  }
}
