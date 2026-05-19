/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type GitHistoryDiffDisplayMode = 'side-by-side' | 'inline'
export type GitHistoryPatchDiffStyle = 'split' | 'unified'

export const DEFAULT_GIT_HISTORY_DIFF_DISPLAY_MODE: GitHistoryDiffDisplayMode = 'inline'

export function coerceGitHistoryDiffDisplayMode(value: unknown): GitHistoryDiffDisplayMode | null {
  if (value === 'side-by-side' || value === 'split') return 'side-by-side'
  if (value === 'inline' || value === 'unified') return 'inline'
  return null
}

export function resolveGitHistoryDiffDisplayMode(...candidates: unknown[]): GitHistoryDiffDisplayMode {
  for (const candidate of candidates) {
    const mode = coerceGitHistoryDiffDisplayMode(candidate)
    if (mode) return mode
  }
  return DEFAULT_GIT_HISTORY_DIFF_DISPLAY_MODE
}

export function toGitHistoryPatchDiffStyle(mode: GitHistoryDiffDisplayMode): GitHistoryPatchDiffStyle {
  return mode === 'side-by-side' ? 'split' : 'unified'
}
