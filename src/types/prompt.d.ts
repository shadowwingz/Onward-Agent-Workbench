/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prompt data structure
 */
export interface Prompt {
  id: string
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

/**
 * Prompt storage status
 */
export interface PromptStore {
  prompts: Prompt[]
  selectedId: string | null
}

/**
 * Preset terminal layout grid count.
 * 1: single, 2: dual horizontal, 4: 2x2, 6: 3x2, 8: 4x2.
 * Each preset cell is the same size (1fr).
 */
export type PresetCount = 1 | 2 | 4 | 6 | 8

/**
 * Custom layout cell — a rectangular Task footprint inside the 2 (rows) x
 * 4 (cols) atomic grid. Coordinates are 1-based; rowSpan/colSpan are
 * inclusive spans. The set of cells in a preset must:
 *  - be pairwise non-overlapping
 *  - completely cover the 2x4 grid (8 atomic cells, no gaps)
 * Validation lives in src/utils/custom-layout-validator.ts.
 */
export interface CustomLayoutCell {
  rowStart: 1 | 2
  rowSpan: 1 | 2
  colStart: 1 | 2 | 3 | 4
  colSpan: 1 | 2 | 3 | 4
}

/**
 * Saved custom layout preset shared globally across all tabs.
 */
export interface CustomLayoutPreset {
  id: string
  name: string
  cells: CustomLayoutCell[]
  createdAt: number
}

/**
 * Tab layout mode. A preset uses one of the fixed grid counts; a custom
 * layout references a CustomLayoutPreset by id (resolved against
 * AppState.customLayoutPresets at render time).
 */
export type LayoutMode =
  | { kind: 'preset'; count: PresetCount }
  | { kind: 'custom'; presetId: string }

/**
 * Legacy persisted form: a bare number was stored in TabState.layoutMode
 * before the union was introduced. Used only for migration on load.
 */
export type LegacyLayoutMode = 1 | 2 | 4 | 6 | 8

/**
 * Terminal information
 */
export interface TerminalInfo {
  id: string
  /** Display name (formatted, such as "Task 1" or "Task 1: Development Task") */
  title: string
  /** Custom name (for editing) */
  customName: string | null
  /**
   * Repo root snapshot taken when customName was last set by a user-initiated
   * action (Rename, Use Branch, Use Repo). Non-null means "manual override
   * active in this repo": auto-follow leaves customName alone while the
   * terminal's cwd is still inside this repoRoot, and clears it once the
   * cwd moves to a different repoRoot. Null means customName was either
   * unset, set automatically by auto-follow, or set outside any repo.
   */
  manualNameRepoRoot: string | null
  /** Persisted working directory */
  lastCwd?: string | null
  isActive: boolean
}

/**
 * Terminal batch operation results
 */
export type TerminalBatchIssueStatus = 'sent-only' | 'failed'

export type TerminalBatchIssueReason =
  | 'unsafe-multiline-send'
  | 'unsafe-multiline-execute'
  | 'send-failed'
  | 'execute-failed'

export interface TerminalBatchIssue {
  terminalId: string
  status: TerminalBatchIssueStatus
  reason: TerminalBatchIssueReason
  message: string
  error?: string
}

export interface TerminalBatchResult {
  successIds: string[]
  sentOnlyIds: string[]
  failedIds: string[]
  issues: TerminalBatchIssue[]
}

/**
 * Terminal shortcut actions
 */
export type TerminalShortcutAction = {
  terminalId: string
  action: 'gitDiff' | 'gitHistory' | 'changeWorkDir' | 'openWorkDir' | 'projectEditor'
  token: number
}

export type TerminalFocusRequest = {
  terminalId: string
  token: number
  reason: 'shortcut-activated' | 'shortcut-terminal' | 'window-focus'
}

/**
 * Prompt Storage API
 */
export interface PromptAPI {
  load: () => Promise<Prompt[]>
  save: (prompt: Prompt) => Promise<boolean>
  delete: (id: string) => Promise<boolean>
}
