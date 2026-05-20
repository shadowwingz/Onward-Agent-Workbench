/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export interface GitDiffModelSyncInput {
  currentOriginalContent: string
  currentModifiedContent: string
  nextOriginalContent: string
  nextModifiedContent: string
}

export interface GitDiffModelSyncPlan {
  originalChanged: boolean
  modifiedChanged: boolean
  needsSync: boolean
  originalLen: number
  modifiedLen: number
}

export function buildGitDiffModelSyncPlan(input: GitDiffModelSyncInput): GitDiffModelSyncPlan {
  const originalChanged = input.currentOriginalContent !== input.nextOriginalContent
  const modifiedChanged = input.currentModifiedContent !== input.nextModifiedContent
  return {
    originalChanged,
    modifiedChanged,
    needsSync: originalChanged || modifiedChanged,
    originalLen: input.nextOriginalContent.length,
    modifiedLen: input.nextModifiedContent.length
  }
}
