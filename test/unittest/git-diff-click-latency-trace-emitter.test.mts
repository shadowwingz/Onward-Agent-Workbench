/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { buildClickPhaseTraceRecords } from '../../src/components/GitDiffViewer/clickLatencyTraceEmitter.ts'
import { CLICK_PHASE_EVENT_NAMES } from '../../src/utils/click-phase-event-names.ts'
import type { ClickLatencyMeasurement } from '../../src/components/GitDiffViewer/clickLatencyTracker.ts'

const CTX = { cwd: '/repo', terminalId: 't1' }

const baseMeasurement = (overrides: Partial<ClickLatencyMeasurement> = {}): ClickLatencyMeasurement => ({
  fileKey: 'k',
  filename: 'a.ts',
  cacheState: 'hit',
  clickAt: 0,
  ipcStartAt: 1,
  ipcEndAt: 5,
  stateSetAt: 6,
  editorReadyAt: 12,
  diffComputedAt: 16,
  paintReadyAt: 18,
  totalMs: 18,
  cancelled: false,
  ...overrides
})

test('emits 5 phase spans + total when measurement is complete', () => {
  const records = buildClickPhaseTraceRecords(baseMeasurement(), CTX)
  assert.equal(records.length, 6)
  const events = records.map((r) => r.event)
  assert.deepEqual(events, [
    CLICK_PHASE_EVENT_NAMES.IPC,
    CLICK_PHASE_EVENT_NAMES.STATE_SET,
    CLICK_PHASE_EVENT_NAMES.MOUNT,
    CLICK_PHASE_EVENT_NAMES.DIFF_COMPUTE,
    CLICK_PHASE_EVENT_NAMES.PAINT,
    CLICK_PHASE_EVENT_NAMES.TOTAL
  ])
})

test('phase durationMs uses end - start with two-decimal rounding', () => {
  const records = buildClickPhaseTraceRecords(baseMeasurement(), CTX)
  const ipc = records.find((r) => r.event === CLICK_PHASE_EVENT_NAMES.IPC)
  const mount = records.find((r) => r.event === CLICK_PHASE_EVENT_NAMES.MOUNT)
  assert.equal((ipc!.payload as Record<string, unknown>).durationMs, 4)
  assert.equal((mount!.payload as Record<string, unknown>).durationMs, 6)
})

test('returns [] when measurement is cancelled', () => {
  const records = buildClickPhaseTraceRecords(baseMeasurement({ cancelled: true }), CTX)
  assert.deepEqual(records, [])
})

test('returns [] when paint never fired', () => {
  const records = buildClickPhaseTraceRecords(
    baseMeasurement({ paintReadyAt: null, totalMs: null }),
    CTX
  )
  assert.deepEqual(records, [])
})

test('skips intermediate phases that are missing endpoints', () => {
  // The state-set timestamp is null — IPC span still emitted, state-set/mount/diff-compute
  // skipped because their boundary endpoints are missing or out of order.
  const records = buildClickPhaseTraceRecords(
    baseMeasurement({ stateSetAt: null, editorReadyAt: null, diffComputedAt: null }),
    CTX
  )
  const events = records.map((r) => r.event)
  assert.ok(events.includes(CLICK_PHASE_EVENT_NAMES.IPC))
  assert.ok(!events.includes(CLICK_PHASE_EVENT_NAMES.STATE_SET))
  assert.ok(!events.includes(CLICK_PHASE_EVENT_NAMES.MOUNT))
  // Total is still emitted.
  assert.ok(events.includes(CLICK_PHASE_EVENT_NAMES.TOTAL))
})

test('payload carries cwd / terminalId / fileKey / filename / cacheState / totalMs', () => {
  const records = buildClickPhaseTraceRecords(
    baseMeasurement({ filename: 'x/y/z.ts', cacheState: 'miss', totalMs: 23 }),
    { cwd: '/abs/repo', terminalId: 'task-42' }
  )
  for (const r of records) {
    const p = r.payload as Record<string, unknown>
    assert.equal(p.cwd, '/abs/repo')
    assert.equal(p.terminalId, 'task-42')
    assert.equal(p.fileKey, 'k')
    assert.equal(p.filename, 'x/y/z.ts')
    assert.equal(p.cacheState, 'miss')
    assert.equal(p.totalMs, 23)
    assert.ok(typeof p.durationMs === 'number')
  }
})
