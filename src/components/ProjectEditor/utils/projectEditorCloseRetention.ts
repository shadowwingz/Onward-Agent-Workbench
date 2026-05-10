/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type ProjectEditorCloseRetentionInput = {
  hasActiveFile: boolean
  hasRootPath: boolean
  hasUnsavedChanges: boolean
  hasMissingFileNotice: boolean
}

export function shouldRetainProjectEditorViewOnClose(input: ProjectEditorCloseRetentionInput): boolean {
  return (
    input.hasActiveFile &&
    input.hasRootPath &&
    !input.hasUnsavedChanges &&
    !input.hasMissingFileNotice
  )
}
