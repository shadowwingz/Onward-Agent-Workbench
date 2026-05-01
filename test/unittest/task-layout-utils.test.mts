/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the LayoutMode pipeline:
 *   - resolveLayout / getEffectiveCount: preset count and custom cells.
 *   - migrateLayoutMode: legacy bare-number persistence shape.
 *   - validateCustomLayout: rectangle + non-overlap + full-coverage rules.
 *
 * These pure functions are the foundation that the renderer (TerminalGrid,
 * Sidebar, downsize logic) and the main-process AppState validator both rely
 * on, so a unit-level regression catches drift cheaply without booting
 * Electron. Pair with the Electron-side runner `run-task-layout-autotest.sh`
 * which covers the DOM and PTY behaviour.
 *
 * Usage: node --experimental-strip-types --test test/unittest/task-layout-utils.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_LAYOUT_MODE,
  PRESET_COUNTS,
  CUSTOM_GRID_TOTAL_CELLS,
  getEffectiveCount,
  isPresetCount,
  isSameLayoutMode,
  layoutDataAttr,
  layoutModeKey,
  migrateLayoutMode,
  resolveLayout
} from '../../src/utils/layout-mode.ts'
import { validateCustomLayout, isValidCustomLayoutCells } from '../../src/utils/custom-layout-validator.ts'
import type { CustomLayoutCell, CustomLayoutPreset, LayoutMode } from '../../src/types/prompt.ts'

const noPresets: readonly CustomLayoutPreset[] = []

function preset(id: string, cells: CustomLayoutCell[]): CustomLayoutPreset {
  return { id, name: id, cells, createdAt: 1 }
}

// ─────────────── PRESET_COUNTS / DEFAULT_LAYOUT_MODE ───────────────

test('TLM-U-01 PRESET_COUNTS matches the documented set 1/2/4/6/8', () => {
  assert.deepEqual([...PRESET_COUNTS], [1, 2, 4, 6, 8])
})

test('TLM-U-02 DEFAULT_LAYOUT_MODE is preset 1', () => {
  assert.deepEqual(DEFAULT_LAYOUT_MODE, { kind: 'preset', count: 1 })
})

test('TLM-U-03 isPresetCount accepts 1/2/4/6/8 only', () => {
  for (const ok of [1, 2, 4, 6, 8]) assert.equal(isPresetCount(ok), true, `accept ${ok}`)
  for (const bad of [0, 3, 5, 7, 9, -1, 1.5, '1', null, undefined]) {
    assert.equal(isPresetCount(bad), false, `reject ${String(bad)}`)
  }
})

// ─────────────── migrateLayoutMode ───────────────

test('TLM-U-10 migrateLayoutMode promotes legacy number → preset', () => {
  for (const n of [1, 2, 4, 6, 8] as const) {
    assert.deepEqual(migrateLayoutMode(n), { kind: 'preset', count: n })
  }
})

test('TLM-U-11 migrateLayoutMode round-trips a valid preset object', () => {
  assert.deepEqual(migrateLayoutMode({ kind: 'preset', count: 4 }), { kind: 'preset', count: 4 })
})

test('TLM-U-12 migrateLayoutMode round-trips a valid custom reference', () => {
  assert.deepEqual(
    migrateLayoutMode({ kind: 'custom', presetId: 'abc' }),
    { kind: 'custom', presetId: 'abc' }
  )
})

test('TLM-U-13 migrateLayoutMode falls back to preset 1 for garbage input', () => {
  for (const bad of [null, undefined, 0, 3, 5, 7, 'preset', { kind: 'custom' }, { kind: 'preset' }, { kind: 'preset', count: 7 }]) {
    assert.deepEqual(migrateLayoutMode(bad), DEFAULT_LAYOUT_MODE, `garbage ${JSON.stringify(bad)}`)
  }
})

// ─────────────── resolveLayout / getEffectiveCount ───────────────

test('TLM-U-20 resolveLayout(preset N) → kind=preset, effectiveCount=N', () => {
  for (const n of [1, 2, 4, 6, 8] as const) {
    const r = resolveLayout({ kind: 'preset', count: n }, noPresets)
    assert.equal(r.kind, 'preset')
    assert.equal(r.effectiveCount, n)
  }
})

test('TLM-U-21 resolveLayout(custom hit) → kind=custom, effectiveCount=cells.length', () => {
  const cells: CustomLayoutCell[] = [
    { rowStart: 1, rowSpan: 2, colStart: 1, colSpan: 2 },
    { rowStart: 1, rowSpan: 2, colStart: 3, colSpan: 2 }
  ]
  const r = resolveLayout({ kind: 'custom', presetId: 'p1' }, [preset('p1', cells)])
  assert.equal(r.kind, 'custom')
  assert.equal(r.effectiveCount, 2)
  if (r.kind === 'custom') {
    assert.equal(r.presetId, 'p1')
    assert.equal(r.presetName, 'p1')
    assert.deepEqual(r.cells, cells)
  }
})

test('TLM-U-22 resolveLayout(custom miss) degrades to preset 1', () => {
  const r = resolveLayout({ kind: 'custom', presetId: 'missing' }, noPresets)
  assert.equal(r.kind, 'preset')
  assert.equal(r.effectiveCount, 1)
})

test('TLM-U-23 getEffectiveCount returns the right N for every shape', () => {
  assert.equal(getEffectiveCount({ kind: 'preset', count: 8 }, noPresets), 8)
  const cells: CustomLayoutCell[] = [
    { rowStart: 1, rowSpan: 1, colStart: 1, colSpan: 4 },
    { rowStart: 2, rowSpan: 1, colStart: 1, colSpan: 4 }
  ]
  const presets = [preset('p1', cells)]
  assert.equal(getEffectiveCount({ kind: 'custom', presetId: 'p1' }, presets), 2)
  assert.equal(getEffectiveCount({ kind: 'custom', presetId: 'gone' }, presets), 1)
})

test('TLM-U-24 layoutDataAttr maps preset→count, custom→"custom"', () => {
  assert.equal(layoutDataAttr({ kind: 'preset', count: 8 }), '8')
  assert.equal(layoutDataAttr({ kind: 'custom', presetId: 'x' }), 'custom')
})

test('TLM-U-25 layoutModeKey is stable per identity', () => {
  const a: LayoutMode = { kind: 'preset', count: 8 }
  const b: LayoutMode = { kind: 'preset', count: 8 }
  const c: LayoutMode = { kind: 'preset', count: 4 }
  assert.equal(layoutModeKey(a), layoutModeKey(b))
  assert.notEqual(layoutModeKey(a), layoutModeKey(c))
  assert.equal(isSameLayoutMode(a, b), true)
  assert.equal(isSameLayoutMode(a, c), false)
})

// ─────────────── validateCustomLayout ───────────────

test('TLM-U-30 validateCustomLayout: empty list is empty error', () => {
  const r = validateCustomLayout([])
  assert.equal(r.valid, false)
  assert.equal(r.error, 'empty')
})

test('TLM-U-31 validateCustomLayout: full single 2x4 covers everything', () => {
  const r = validateCustomLayout([{ rowStart: 1, rowSpan: 2, colStart: 1, colSpan: 4 }])
  assert.equal(r.valid, true)
})

test('TLM-U-32 validateCustomLayout: 8 atomic cells cover everything', () => {
  const cells: CustomLayoutCell[] = []
  for (let r = 1; r <= 2; r++) {
    for (let c = 1; c <= 4; c++) {
      cells.push({ rowStart: r as 1 | 2, rowSpan: 1, colStart: c as 1 | 2 | 3 | 4, colSpan: 1 })
    }
  }
  const result = validateCustomLayout(cells)
  assert.equal(result.valid, true)
  assert.equal(cells.length, CUSTOM_GRID_TOTAL_CELLS)
})

test('TLM-U-33 validateCustomLayout: gap → incomplete-coverage', () => {
  const cells: CustomLayoutCell[] = [
    { rowStart: 1, rowSpan: 1, colStart: 1, colSpan: 2 },
    // (1, 3-4) missing
    { rowStart: 2, rowSpan: 1, colStart: 1, colSpan: 4 }
  ]
  const r = validateCustomLayout(cells)
  assert.equal(r.valid, false)
  assert.equal(r.error, 'incomplete-coverage')
})

test('TLM-U-34 validateCustomLayout: overlap → overlap', () => {
  const cells: CustomLayoutCell[] = [
    { rowStart: 1, rowSpan: 2, colStart: 1, colSpan: 2 },
    // overlaps the (2,2) cell of the first rect
    { rowStart: 2, rowSpan: 1, colStart: 2, colSpan: 2 }
  ]
  const r = validateCustomLayout(cells)
  assert.equal(r.valid, false)
  assert.equal(r.error, 'overlap')
  assert.equal(r.failingCellIndex, 1)
})

test('TLM-U-35 validateCustomLayout: out-of-bounds → out-of-bounds', () => {
  // colStart 3 + colSpan 4 would cover cols 3..6 — beyond the 4-col mesh.
  const cells = [{ rowStart: 1, rowSpan: 2, colStart: 3, colSpan: 4 }] as CustomLayoutCell[]
  const r = validateCustomLayout(cells)
  assert.equal(r.valid, false)
  assert.equal(r.error, 'out-of-bounds')
})

test('TLM-U-36 validateCustomLayout: more than 8 cells → too-many-cells', () => {
  const cells: CustomLayoutCell[] = []
  for (let i = 0; i < 9; i++) cells.push({ rowStart: 1, rowSpan: 1, colStart: 1, colSpan: 1 })
  const r = validateCustomLayout(cells)
  assert.equal(r.valid, false)
  assert.equal(r.error, 'too-many-cells')
})

test('TLM-U-37 isValidCustomLayoutCells rejects malformed shapes and bad coverage', () => {
  // Malformed shape — rowStart missing.
  assert.equal(isValidCustomLayoutCells([{ rowSpan: 1, colStart: 1, colSpan: 1 }]), false)
  // Right shape, full coverage — accepted.
  assert.equal(
    isValidCustomLayoutCells([{ rowStart: 1, rowSpan: 2, colStart: 1, colSpan: 4 }]),
    true
  )
  // Right shape, incomplete coverage — rejected.
  assert.equal(
    isValidCustomLayoutCells([{ rowStart: 1, rowSpan: 1, colStart: 1, colSpan: 2 }]),
    false
  )
})

// ─────────────── User example from the spec ───────────────

test('TLM-U-40 spec example: col1 vertical bar + col2 split + col3 vertical bar + col4 split is valid', () => {
  // First column joined top+bottom, second column split, third column
  // joined, fourth column split. This is the canonical "灵活度" example
  // the user requested in the design discussion.
  const cells: CustomLayoutCell[] = [
    { rowStart: 1, rowSpan: 2, colStart: 1, colSpan: 1 },   // tall col 1
    { rowStart: 1, rowSpan: 1, colStart: 2, colSpan: 1 },   // top col 2
    { rowStart: 2, rowSpan: 1, colStart: 2, colSpan: 1 },   // bot col 2
    { rowStart: 1, rowSpan: 2, colStart: 3, colSpan: 1 },   // tall col 3
    { rowStart: 1, rowSpan: 1, colStart: 4, colSpan: 1 },   // top col 4
    { rowStart: 2, rowSpan: 1, colStart: 4, colSpan: 1 }    // bot col 4
  ]
  const r = validateCustomLayout(cells)
  assert.equal(r.valid, true)
  assert.equal(cells.length, 6)
})

test('TLM-U-41 spec example: equivalent "1 row x 4 cols" via four 1x2 columns', () => {
  const cells: CustomLayoutCell[] = [
    { rowStart: 1, rowSpan: 2, colStart: 1, colSpan: 1 },
    { rowStart: 1, rowSpan: 2, colStart: 2, colSpan: 1 },
    { rowStart: 1, rowSpan: 2, colStart: 3, colSpan: 1 },
    { rowStart: 1, rowSpan: 2, colStart: 4, colSpan: 1 }
  ]
  assert.equal(validateCustomLayout(cells).valid, true)
})
