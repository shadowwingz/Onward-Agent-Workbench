/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomLayoutCell } from '../../types/prompt'
import { CUSTOM_GRID_COLS, CUSTOM_GRID_ROWS } from '../../utils/layout-mode'

interface CustomLayoutThumbnailProps {
  cells: readonly CustomLayoutCell[]
  /** Pixel width of the thumbnail; height is auto-derived to keep 2:1. */
  width?: number
}

/**
 * 60x30 (default) network mesh preview of a custom layout. Pure CSS Grid;
 * no DOM events. Used by the popover list and any future tooltip.
 */
export function CustomLayoutThumbnail({ cells, width = 60 }: CustomLayoutThumbnailProps) {
  const height = Math.round(width / 2)
  return (
    <div
      className="custom-layout-thumbnail"
      style={{
        width,
        height,
        display: 'grid',
        gridTemplateColumns: `repeat(${CUSTOM_GRID_COLS}, 1fr)`,
        gridTemplateRows: `repeat(${CUSTOM_GRID_ROWS}, 1fr)`,
        gap: 1,
        background: 'var(--border)',
        borderRadius: 3,
        overflow: 'hidden'
      }}
    >
      {cells.map((cell, index) => (
        <div
          key={index}
          style={{
            gridColumn: `${cell.colStart} / span ${cell.colSpan}`,
            gridRow: `${cell.rowStart} / span ${cell.rowSpan}`,
            background: 'color-mix(in srgb, var(--accent) 35%, var(--bg-1))'
          }}
        />
      ))}
    </div>
  )
}
