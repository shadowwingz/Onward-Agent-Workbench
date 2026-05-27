/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type GitDiffSplitViewMode = 'auto' | 'split' | 'inline'

export const DEFAULT_GIT_DIFF_SPLIT_VIEW_MODE: GitDiffSplitViewMode = 'inline'

export function coerceGitDiffSplitViewMode(value: unknown): GitDiffSplitViewMode | null {
  if (value === 'auto' || value === 'split' || value === 'inline') return value
  if (value === 'side-by-side') return 'split'
  if (value === 'unified') return 'inline'
  return null
}

export function resolveGitDiffSplitViewMode(...candidates: unknown[]): GitDiffSplitViewMode {
  for (const candidate of candidates) {
    const mode = coerceGitDiffSplitViewMode(candidate)
    if (mode) return mode
  }
  return DEFAULT_GIT_DIFF_SPLIT_VIEW_MODE
}
