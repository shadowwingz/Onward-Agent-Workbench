/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure decision table for "auto-follow Git branch name" — extracted from
 * TerminalGrid so the rename / keep / clobber rules are unit-testable without
 * an Electron build (see auto-follow-name-decision.test.mts).
 *
 * Background: each Task can carry a `manualNameRepoRoot` marker recording the
 * repo root in scope when the user manually renamed it. While that marker is in
 * scope, auto-follow must NOT overwrite the user's customName. The marker is
 * persisted (see persisted-terminal.ts); if it is ever lost the user's rename
 * silently reverts to the live branch name on the next git-info sync.
 *
 * The HYDRATION BARRIER below is belt-and-suspenders for the boot window: the
 * FIRST git-info sync after a terminal mounts must not overwrite a customName
 * that was just loaded from disk, even if that terminal's marker is transiently
 * null (legacy data, or a name stamped before its repoRoot had resolved).
 */

export type TaskNameAutoFollowSource =
  | 'skipped-disabled'
  | 'not-visible'
  | 'manual'
  | 'cleared-by-repo-switch'
  | 'skipped-initial-hydration'
  | 'auto-branch'
  | 'no-change'

export interface TaskNameAutoFollowInput {
  /** The `autoFollowGitBranchForTaskName` preference. */
  autoFollowEnabled: boolean
  /** Whether the Task is currently in the visible terminal set. */
  terminalVisible: boolean
  /** Task's current customName (null when unnamed). */
  currentCustomName: string | null
  /** Repo root recorded at the user's last manual rename (null = no override). */
  currentManualRepoRoot: string | null
  /** Repo root resolved from the latest git-info sync. */
  newRepoRoot: string | null
  /** Branch resolved from the latest git-info sync. */
  newBranch: string | null
  /** True if this is the first git-info evaluation since the Task mounted. */
  isInitialPass: boolean
}

export interface TaskNameAutoFollowDecision {
  /** When true, replace the customName with `branch`. */
  rename: boolean
  /** When true, the manual override expired (emit the MANUAL_CLEAR breadcrumb). */
  clearedManualOverride: boolean
  /** Diagnostic source — 1:1 with the RENDERER_TASK_NAME_RESOLVE `source`. */
  source: TaskNameAutoFollowSource
  /** Branch to adopt when `rename` is true. */
  branch: string | null
}

/**
 * Decide what auto-follow should do for one Task given the latest git info.
 * Pure — no side effects; the caller maps the result onto trace events and the
 * actual rename call.
 */
export function decideTaskNameAutoFollow(input: TaskNameAutoFollowInput): TaskNameAutoFollowDecision {
  const {
    autoFollowEnabled,
    terminalVisible,
    currentCustomName,
    currentManualRepoRoot,
    newRepoRoot,
    newBranch,
    isInitialPass
  } = input

  const base = { rename: false, clearedManualOverride: false, branch: newBranch }

  if (!autoFollowEnabled) {
    return { ...base, source: 'skipped-disabled' }
  }
  if (!terminalVisible) {
    return { ...base, source: 'not-visible' }
  }

  // (a) Manual override still in scope — leave the user's name alone.
  if (currentManualRepoRoot != null && newRepoRoot != null && currentManualRepoRoot === newRepoRoot) {
    return { ...base, source: 'manual' }
  }

  // (b) Manual override expired — the cwd moved to a different repo. Adopt the
  //     new branch (or null) and signal that the override was cleared.
  if (currentManualRepoRoot != null && newRepoRoot != null && currentManualRepoRoot !== newRepoRoot) {
    return { rename: true, clearedManualOverride: true, source: 'cleared-by-repo-switch', branch: newBranch }
  }

  // (b2) HYDRATION BARRIER — protect a just-loaded customName on the first sync
  //      after mount. Only applies when a clobber would actually occur (there is
  //      an existing name and a different branch). Fresh, unnamed Tasks fall
  //      through so auto-follow can still name them on first sync.
  if (isInitialPass && currentCustomName != null && newBranch != null && newBranch !== currentCustomName) {
    return { ...base, source: 'skipped-initial-hydration' }
  }

  // (c) No active override — track the branch.
  if (newBranch != null && newBranch !== currentCustomName) {
    return { rename: true, clearedManualOverride: false, source: 'auto-branch', branch: newBranch }
  }

  return { ...base, source: 'no-change' }
}
