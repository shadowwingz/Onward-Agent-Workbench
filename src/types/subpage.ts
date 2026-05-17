/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type SubpageId = 'diff' | 'editor' | 'history'

export interface ProjectEditorOpenRequest {
  id: number
  terminalId: string
  filePath: string | null
  repoRoot: string | null
  source?: SubpageId | null
  returnTarget?: SubpageId | null
  diffFilePath?: string | null
  diffRepoRoot?: string | null
}

export interface ProjectEditorOpenEventDetail {
  terminalId?: string
  filePath?: string | null
  repoRoot?: string | null
  source?: SubpageId | null
  returnTarget?: SubpageId | null
  diffFilePath?: string | null
  diffRepoRoot?: string | null
}

export interface SubpageNavigateEventDetail {
  terminalId?: string
  target?: SubpageId
  from?: SubpageId | null
  intent?: 'open' | 'switch' | 'jump' | 'close' | 'restore' | null
  entryPoint?: 'shortcut' | 'dropdown' | 'subpage-switcher' | 'deep-link' | 'escape' | 'session-restore' | 'legacy-event' | 'debug' | null
  filePath?: string | null
  repoRoot?: string | null
  source?: SubpageId | null
  returnTarget?: SubpageId | null
  diffFilePath?: string | null
  diffRepoRoot?: string | null
}
