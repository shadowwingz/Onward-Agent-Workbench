/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Convert a sealed click-latency measurement into a flat list of perf-trace
// records. Pure data-in / data-out so it is unit-testable; the actual
// `perfTrace(...)` side effect lives at the call site.
//
// Why split this out: keeping the tracker module free of trace-system
// imports lets it run inside Node's test runner without mocking the
// renderer-side `perf-trace` shim.

import type { ClickLatencyMeasurement } from './clickLatencyTracker'
import { CLICK_PHASE_EVENT_NAMES } from '../../utils/click-phase-event-names.ts'

export { CLICK_PHASE_EVENT_NAMES } from '../../utils/click-phase-event-names.ts'

export interface ClickPhaseTraceRecord {
  event: string
  payload: Record<string, unknown>
}

export interface ClickPhaseTraceContext {
  cwd: string
  terminalId: string
}

const round2 = (value: number) => +value.toFixed(2)

/**
 * Build the per-phase span records (`ph='X'`) plus a total span. Returns
 * an empty array when the measurement was cancelled or paint never fired.
 * Each record's payload carries `durationMs` so `perf-trace-logger`'s
 * `resolvePhase` auto-routes it to `ph='X'`.
 */
export function buildClickPhaseTraceRecords(
  measurement: ClickLatencyMeasurement,
  context: ClickPhaseTraceContext
): ClickPhaseTraceRecord[] {
  if (measurement.cancelled) return []
  if (measurement.paintReadyAt === null) return []

  const base = {
    cwd: context.cwd,
    terminalId: context.terminalId,
    fileKey: measurement.fileKey,
    filename: measurement.filename,
    cacheState: measurement.cacheState,
    totalMs: measurement.totalMs ?? 0
  }
  const records: ClickPhaseTraceRecord[] = []

  const pushSpan = (event: string, fromMs: number | null, toMs: number | null): void => {
    if (fromMs === null || toMs === null) return
    const durationMs = toMs - fromMs
    if (!Number.isFinite(durationMs) || durationMs < 0) return
    records.push({ event, payload: { ...base, durationMs: round2(durationMs) } })
  }

  pushSpan(CLICK_PHASE_EVENT_NAMES.IPC, measurement.ipcStartAt, measurement.ipcEndAt)
  pushSpan(CLICK_PHASE_EVENT_NAMES.STATE_SET, measurement.ipcEndAt, measurement.stateSetAt)
  pushSpan(CLICK_PHASE_EVENT_NAMES.MOUNT, measurement.stateSetAt, measurement.editorReadyAt)
  pushSpan(CLICK_PHASE_EVENT_NAMES.DIFF_COMPUTE, measurement.editorReadyAt, measurement.diffComputedAt)
  pushSpan(CLICK_PHASE_EVENT_NAMES.PAINT, measurement.diffComputedAt, measurement.paintReadyAt)

  if (measurement.totalMs !== null) {
    records.push({
      event: CLICK_PHASE_EVENT_NAMES.TOTAL,
      payload: { ...base, durationMs: round2(measurement.totalMs) }
    })
  }

  return records
}
