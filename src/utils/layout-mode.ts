/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  LayoutMode,
  PresetCount,
  CustomLayoutCell,
  CustomLayoutPreset
} from '../types/prompt.ts'

export const PRESET_COUNTS: readonly PresetCount[] = [1, 2, 4, 6, 8] as const
export const CUSTOM_GRID_ROWS = 2
export const CUSTOM_GRID_COLS = 4
export const CUSTOM_GRID_TOTAL_CELLS = CUSTOM_GRID_ROWS * CUSTOM_GRID_COLS

export function isPresetCount(value: unknown): value is PresetCount {
  return typeof value === 'number' && (PRESET_COUNTS as readonly number[]).includes(value)
}

/**
 * Resolved view of a LayoutMode for renderer consumption.
 * - kind: 'preset' uses the legacy [data-layout="N"] CSS path with N
 *   uniform 1fr cells (no cells array needed at the call site).
 * - kind: 'custom' uses a 4col x 2row atomic grid where each Task is a
 *   stored rectangle. Custom mode is the only mode that exposes cells.
 */
export type ResolvedLayout =
  | {
      kind: 'preset'
      count: PresetCount
      effectiveCount: number
    }
  | {
      kind: 'custom'
      effectiveCount: number
      presetId: string
      presetName: string
      cells: CustomLayoutCell[]
    }

/**
 * Resolve a LayoutMode to its effective shape. When a custom layout
 * references a missing preset id we degrade gracefully to preset 1.
 */
export function resolveLayout(
  mode: LayoutMode,
  customPresets: readonly CustomLayoutPreset[]
): ResolvedLayout {
  if (mode.kind === 'preset') {
    return { kind: 'preset', count: mode.count, effectiveCount: mode.count }
  }
  const preset = customPresets.find(p => p.id === mode.presetId)
  if (!preset || preset.cells.length === 0) {
    return { kind: 'preset', count: 1, effectiveCount: 1 }
  }
  return {
    kind: 'custom',
    effectiveCount: preset.cells.length,
    presetId: preset.id,
    presetName: preset.name,
    cells: preset.cells
  }
}

/**
 * Effective Task count for a layout. Used by App.tsx auto-fill, by the
 * downsize dialog gate, and by telemetry as the legacy "layoutMode" int.
 */
export function getEffectiveCount(
  mode: LayoutMode,
  customPresets: readonly CustomLayoutPreset[]
): number {
  return resolveLayout(mode, customPresets).effectiveCount
}

/**
 * Stable string used for the [data-layout] CSS hook. Presets emit "1" /
 * "2" / "4" / "6" / "8" so existing CSS keeps working; custom emits
 * "custom".
 */
export function layoutDataAttr(mode: LayoutMode): string {
  return mode.kind === 'preset' ? String(mode.count) : 'custom'
}

/**
 * Normalise an unknown persisted layoutMode value into the union form.
 * Old app-state.json stores a bare number; new state stores the union.
 * Anything else degrades to preset 1.
 */
export function migrateLayoutMode(value: unknown): LayoutMode {
  if (isPresetCount(value)) {
    return { kind: 'preset', count: value }
  }
  if (value && typeof value === 'object') {
    const obj = value as { kind?: unknown; count?: unknown; presetId?: unknown }
    if (obj.kind === 'preset' && isPresetCount(obj.count)) {
      return { kind: 'preset', count: obj.count }
    }
    if (obj.kind === 'custom' && typeof obj.presetId === 'string' && obj.presetId.length > 0) {
      return { kind: 'custom', presetId: obj.presetId }
    }
  }
  return { kind: 'preset', count: 1 }
}

export const DEFAULT_LAYOUT_MODE: LayoutMode = { kind: 'preset', count: 1 }

/**
 * Stable identity key for shallow equality. Two LayoutMode values that
 * yield the same key produce the same render. Used by TerminalGrid to
 * decide when to re-init terminals on layout transitions.
 */
export function layoutModeKey(mode: LayoutMode): string {
  return mode.kind === 'preset' ? `preset:${mode.count}` : `custom:${mode.presetId}`
}

/**
 * True when both modes select the same preset count or reference the
 * same custom preset id.
 */
export function isSameLayoutMode(a: LayoutMode, b: LayoutMode): boolean {
  return layoutModeKey(a) === layoutModeKey(b)
}
