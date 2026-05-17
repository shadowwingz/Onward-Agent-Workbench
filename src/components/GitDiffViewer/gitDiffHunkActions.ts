/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { SPLIT_WITH_NEWLINES } from '@pierre/diffs'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { GitFileStatus } from '../../types/electron'

export type DiffHunkAction = 'stage' | 'revert' | 'unstage'

export type DiffHunkActionRange = {
  id: string
  index: number
  originalStartLineNumber: number
  originalEndLineNumber: number
  modifiedStartLineNumber: number
  modifiedEndLineNumber: number
}

export type HunkActionWidgetInstallResult = 'installed' | 'retry' | 'skipped'

export type HunkActionWidgetSkipReason =
  | 'no-file'
  | 'submodule'
  | 'untracked'
  | 'deleted'
  | 'loading'
  | 'error'
  | 'binary'
  | 'dirty-draft'
  | 'no-changes'

export type HunkActionWidgetEligibility = {
  result: HunkActionWidgetInstallResult
  reason: HunkActionWidgetSkipReason | null
}

export type HunkActionContentState = {
  loading?: boolean
  error?: string | null
  isBinary?: boolean
}

export type HunkActionLineChange = {
  originalStartLineNumber: number
  originalEndLineNumber: number
  modifiedStartLineNumber: number
  modifiedEndLineNumber: number
}

export type HunkActionWidgetPlanItem = {
  anchorLine: number
  range: DiffHunkActionRange
  primaryAction: DiffHunkAction
  showRevert: boolean
}

export function getHunkActionWidgetEligibility(params: {
  file: Pick<GitFileStatus, 'isSubmoduleEntry' | 'changeType' | 'status'> | null
  state: HunkActionContentState | null
  isDraftDirty: boolean
  changeCount: number
}): HunkActionWidgetEligibility {
  const { file, state, isDraftDirty, changeCount } = params
  if (!file) return { result: 'skipped', reason: 'no-file' }
  if (file.isSubmoduleEntry) return { result: 'skipped', reason: 'submodule' }
  if (file.changeType === 'untracked') return { result: 'skipped', reason: 'untracked' }
  if (file.status === 'D') return { result: 'skipped', reason: 'deleted' }
  if (!state || state.loading) return { result: 'retry', reason: 'loading' }
  if (state.error) return { result: 'skipped', reason: 'error' }
  if (state.isBinary) return { result: 'skipped', reason: 'binary' }
  if (isDraftDirty) return { result: 'skipped', reason: 'dirty-draft' }
  if (changeCount <= 0) return { result: 'skipped', reason: 'no-changes' }
  return { result: 'installed', reason: null }
}

export function createHunkActionRange(change: HunkActionLineChange, index: number): DiffHunkActionRange {
  return {
    id: `${index}:${change.originalStartLineNumber}-${change.originalEndLineNumber}:${change.modifiedStartLineNumber}-${change.modifiedEndLineNumber}`,
    index,
    originalStartLineNumber: change.originalStartLineNumber,
    originalEndLineNumber: change.originalEndLineNumber,
    modifiedStartLineNumber: change.modifiedStartLineNumber,
    modifiedEndLineNumber: change.modifiedEndLineNumber
  }
}

function normalizeLine(value: number): number | null {
  if (!Number.isFinite(value)) return null
  return Math.floor(value)
}

function normalizeLineSide(
  startValue: number,
  endValue: number
): { start: number; end: number } | null {
  // Validate / clamp to positive line numbers. Monaco's diff service
  // already guarantees LineChange entries are inside the model bounds —
  // no defensive maxLineCount check here (that check was the race entry:
  // when the install path read getLineCount() in a setTimeout window
  // before the new model was attached, the stale small value falsely
  // tripped this branch). Trust Monaco's invariant; verify via the
  // `onDidUpdateDiff` model identity check at the install site.
  let start = normalizeLine(startValue)
  let end = normalizeLine(endValue)
  if (start === null || end === null) return null

  if (end === 0) {
    if (start <= 0) return null
    return { start, end: 0 }
  }
  if (start <= 0 && end <= 0) return null
  if (start <= 0) start = end
  if (end <= 0) end = start
  if (start > end) return null
  return { start, end }
}

export function normalizeHunkActionLineChange(
  change: HunkActionLineChange
): HunkActionLineChange | null {
  const original = normalizeLineSide(change.originalStartLineNumber, change.originalEndLineNumber)
  const modified = normalizeLineSide(change.modifiedStartLineNumber, change.modifiedEndLineNumber)
  if (!original || !modified) return null
  return {
    originalStartLineNumber: original.start,
    originalEndLineNumber: original.end,
    modifiedStartLineNumber: modified.start,
    modifiedEndLineNumber: modified.end
  }
}

export function buildHunkActionWidgetPlan(params: {
  file: Pick<GitFileStatus, 'isSubmoduleEntry' | 'changeType' | 'status'> | null
  state: HunkActionContentState | null
  isDraftDirty: boolean
  changes: HunkActionLineChange[]
  lineCount: number
  maxWidgets?: number
}): {
  eligibility: HunkActionWidgetEligibility
  widgets: HunkActionWidgetPlanItem[]
} {
  const lineCount = Math.max(1, params.lineCount)
  const normalizedChanges = params.changes
    .map((change, originalIndex) => ({ change: normalizeHunkActionLineChange(change), originalIndex }))
    .filter((entry): entry is { change: HunkActionLineChange; originalIndex: number } => entry.change !== null)
  const eligibility = getHunkActionWidgetEligibility({
    file: params.file,
    state: params.state,
    isDraftDirty: params.isDraftDirty,
    changeCount: normalizedChanges.length
  })
  if (eligibility.result !== 'installed' || !params.file) {
    return { eligibility, widgets: [] }
  }

  const isStagedFile = params.file.changeType === 'staged'
  const maxWidgets = Math.max(0, Math.floor(params.maxWidgets ?? 100))
  const widgets = normalizedChanges.slice(0, maxWidgets).map(({ change, originalIndex }) => {
    const anchorLine = Math.max(1, Math.min(
      change.modifiedStartLineNumber || change.modifiedEndLineNumber || change.originalStartLineNumber || 1,
      lineCount
    ))
    return {
      anchorLine,
      range: createHunkActionRange(change, originalIndex),
      primaryAction: isStagedFile ? 'unstage' as const : 'stage' as const,
      showRevert: !isStagedFile
    }
  })

  return {
    eligibility: widgets.length > 0
      ? eligibility
      : { result: 'skipped', reason: 'no-changes' },
    widgets
  }
}

export function lineRangesIntersect(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  if (aStart <= 0 || aEnd <= 0 || bStart <= 0 || bEnd <= 0) return false
  return aStart <= bEnd && bStart <= aEnd
}

// Locate the hunk whose modified-side range contains the hovered line. Used by
// the diff viewer to decide which hunk's action pill to surface when the user
// hovers anywhere inside that hunk. For pure deletions Monaco reports
// modifiedEnd === 0; we accept the two surrounding modified lines so the
// deletion marker is reachable from either neighbour.
export function findHunkContainingLine(
  line: number,
  ranges: readonly DiffHunkActionRange[]
): DiffHunkActionRange | null {
  if (!Number.isFinite(line) || line <= 0) return null
  for (const range of ranges) {
    const start = range.modifiedStartLineNumber
    const end = range.modifiedEndLineNumber
    if (end > 0 && start > 0) {
      if (line >= start && line <= end) return range
    } else if (start > 0) {
      if (line === start || line === start + 1) return range
    }
  }
  return null
}

export function buildContentWithChangeRange(
  diff: FileDiffMetadata,
  range: DiffHunkActionRange,
  applySelected: boolean,
  oldContent: string,
  newContent: string
): string {
  const oldLines = diff.oldLines ?? oldContent.split(SPLIT_WITH_NEWLINES)
  const newLines = diff.newLines ?? newContent.split(SPLIT_WITH_NEWLINES)
  const hasLineRangeMatch = (() => {
    let oldIndex = 1
    let newIndex = 1
    for (const hunk of diff.hunks) {
      while (oldIndex < hunk.deletionStart && newIndex < hunk.additionStart) {
        oldIndex += 1
        newIndex += 1
      }
      for (const content of hunk.hunkContent) {
        if (content.type === 'context') {
          oldIndex += content.lines.length
          newIndex += content.lines.length
          continue
        }
        const deletionStart = oldIndex
        const deletionEnd = oldIndex + content.deletions.length - 1
        const additionStart = newIndex
        const additionEnd = newIndex + content.additions.length - 1
        if (
          lineRangesIntersect(deletionStart, deletionEnd, range.originalStartLineNumber, range.originalEndLineNumber) ||
          lineRangesIntersect(additionStart, additionEnd, range.modifiedStartLineNumber, range.modifiedEndLineNumber)
        ) {
          return true
        }
        oldIndex += content.deletions.length
        newIndex += content.additions.length
      }
    }
    return false
  })()
  const output: string[] = []
  let oldIndex = 1
  let newIndex = 1

  for (let hunkIndex = 0; hunkIndex < diff.hunks.length; hunkIndex += 1) {
    const hunk = diff.hunks[hunkIndex]
    while (oldIndex < hunk.deletionStart && newIndex < hunk.additionStart) {
      output.push(oldLines[oldIndex - 1] ?? '')
      oldIndex += 1
      newIndex += 1
    }

    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let i = 0; i < content.lines.length; i += 1) {
          output.push(oldLines[oldIndex - 1] ?? '')
          oldIndex += 1
          newIndex += 1
        }
        continue
      }

      const deletionStart = oldIndex
      const deletionEnd = oldIndex + content.deletions.length - 1
      const additionStart = newIndex
      const additionEnd = newIndex + content.additions.length - 1
      const selected =
        (!hasLineRangeMatch && hunkIndex === range.index) ||
        lineRangesIntersect(deletionStart, deletionEnd, range.originalStartLineNumber, range.originalEndLineNumber) ||
        lineRangesIntersect(additionStart, additionEnd, range.modifiedStartLineNumber, range.modifiedEndLineNumber)
      const shouldApply = applySelected ? selected : !selected

      for (let i = 0; i < content.deletions.length; i += 1) {
        if (!shouldApply) {
          output.push(oldLines[oldIndex - 1] ?? '')
        }
        oldIndex += 1
      }
      for (let i = 0; i < content.additions.length; i += 1) {
        if (shouldApply) {
          output.push(newLines[newIndex - 1] ?? '')
        }
        newIndex += 1
      }
    }
  }

  while (oldIndex <= oldLines.length && newIndex <= newLines.length) {
    output.push(oldLines[oldIndex - 1] ?? '')
    oldIndex += 1
    newIndex += 1
  }

  return output.join('')
}
