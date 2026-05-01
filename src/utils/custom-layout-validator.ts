/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomLayoutCell } from '../types/prompt.ts'
import { CUSTOM_GRID_ROWS, CUSTOM_GRID_COLS, CUSTOM_GRID_TOTAL_CELLS } from './layout-mode.ts'

export type CustomLayoutValidationError =
  | 'empty'
  | 'too-many-cells'
  | 'out-of-bounds'
  | 'overlap'
  | 'incomplete-coverage'

export interface CustomLayoutValidationResult {
  valid: boolean
  error: CustomLayoutValidationError | null
  /** Cell index (in input order) that triggered out-of-bounds / overlap. */
  failingCellIndex: number | null
}

function isCellShapeValid(cell: unknown): cell is CustomLayoutCell {
  if (!cell || typeof cell !== 'object') return false
  const c = cell as Partial<CustomLayoutCell>
  return (
    Number.isInteger(c.rowStart) &&
    Number.isInteger(c.rowSpan) &&
    Number.isInteger(c.colStart) &&
    Number.isInteger(c.colSpan) &&
    (c.rowStart as number) >= 1 &&
    (c.rowSpan as number) >= 1 &&
    (c.colStart as number) >= 1 &&
    (c.colSpan as number) >= 1
  )
}

/**
 * Validate a candidate custom-layout cell list. Rules:
 * 1. At least one cell, at most CUSTOM_GRID_TOTAL_CELLS (8) cells.
 * 2. Every rectangle stays inside the 2 (rows) x 4 (cols) atomic grid.
 * 3. No two rectangles overlap.
 * 4. Together the rectangles cover all 8 atomic cells (no gap).
 *
 * Rectangles are by definition rect-shaped (rowSpan / colSpan are
 * scalars), so no L / T shapes can be expressed — the type system
 * already rules those out.
 */
export function validateCustomLayout(cells: readonly CustomLayoutCell[]): CustomLayoutValidationResult {
  if (cells.length === 0) {
    return { valid: false, error: 'empty', failingCellIndex: null }
  }
  if (cells.length > CUSTOM_GRID_TOTAL_CELLS) {
    return { valid: false, error: 'too-many-cells', failingCellIndex: null }
  }

  const occupancy: Array<Array<boolean>> = Array.from(
    { length: CUSTOM_GRID_ROWS },
    () => Array.from({ length: CUSTOM_GRID_COLS }, () => false)
  )

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]
    const rEnd = cell.rowStart + cell.rowSpan - 1
    const cEnd = cell.colStart + cell.colSpan - 1
    if (
      cell.rowStart < 1 || rEnd > CUSTOM_GRID_ROWS ||
      cell.colStart < 1 || cEnd > CUSTOM_GRID_COLS
    ) {
      return { valid: false, error: 'out-of-bounds', failingCellIndex: i }
    }
    for (let r = cell.rowStart; r <= rEnd; r++) {
      for (let c = cell.colStart; c <= cEnd; c++) {
        if (occupancy[r - 1][c - 1]) {
          return { valid: false, error: 'overlap', failingCellIndex: i }
        }
        occupancy[r - 1][c - 1] = true
      }
    }
  }

  for (let r = 0; r < CUSTOM_GRID_ROWS; r++) {
    for (let c = 0; c < CUSTOM_GRID_COLS; c++) {
      if (!occupancy[r][c]) {
        return { valid: false, error: 'incomplete-coverage', failingCellIndex: null }
      }
    }
  }

  return { valid: true, error: null, failingCellIndex: null }
}

/**
 * Type-guard variant for storage hot paths. Also enforces the per-cell
 * shape so a corrupted JSON file cannot smuggle malformed cells in.
 */
export function isValidCustomLayoutCells(cells: unknown): cells is CustomLayoutCell[] {
  if (!Array.isArray(cells)) return false
  for (const c of cells) {
    if (!isCellShapeValid(c)) return false
  }
  return validateCustomLayout(cells as CustomLayoutCell[]).valid
}
