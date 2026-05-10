/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type GitPdfStatus = 'added' | 'deleted' | 'modified'

export interface PaneVisibility {
  showOriginalPane: boolean
  showModifiedPane: boolean
  isSinglePane: boolean
}

/**
 * Decide which compare panes to render based on the file's git status.
 * 'added' files have no original side; 'deleted' files have no modified
 * side. In those single-side cases the present pane takes the full width
 * instead of being squeezed to half by an empty placeholder.
 */
export function computePaneVisibility(status: GitPdfStatus): PaneVisibility {
  const showOriginalPane = status !== 'added'
  const showModifiedPane = status !== 'deleted'
  return {
    showOriginalPane,
    showModifiedPane,
    isSinglePane: !(showOriginalPane && showModifiedPane)
  }
}
