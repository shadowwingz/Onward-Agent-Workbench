/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers extracted from `terminal-git-info-bridge.ts` so they can
 * be unit-tested directly under `node --experimental-strip-types`.
 * The bridge class itself uses constructor parameter properties (a TS
 * syntax the strip-types loader does not handle), so importing the
 * full bridge from a unit test would fail to load.
 */

import type { TerminalGitInfo } from './git-utils'
import type { MirrorState } from './git-state-mirror-types'

/**
 * Dedup key for a TerminalGitInfo. Two infos are considered identical
 * when this string matches; the bridge uses it to skip redundant
 * GIT_TERMINAL_INFO IPC emissions to the renderer.
 */
export function fingerprintTerminalGitInfo(info: TerminalGitInfo): string {
  return [
    info.cwd ?? '',
    info.repoRoot ?? '',
    info.branch ?? '',
    info.repoName ?? '',
    info.status ?? ''
  ].join('|')
}

/**
 * Translate a Worker MirrorState into a renderer-facing TerminalGitInfo,
 * substituting the caller-supplied cwd (the bridge tracks per-terminal
 * cwd independently from the mirror's per-repo snapshot).
 */
export function mirrorStateToTerminalGitInfo(state: MirrorState, cwd: string): TerminalGitInfo {
  return {
    cwd,
    repoRoot: state.repoRoot,
    repoName: state.repoName,
    branch: state.branch,
    status: state.status
  }
}

/**
 * Placeholder TerminalGitInfo used at bridge cold-start and when a
 * terminal's cwd is not a git repo. Five-field all-null record.
 */
export function emptyTerminalGitInfo(cwd: string | null): TerminalGitInfo {
  return {
    cwd,
    repoRoot: null,
    repoName: null,
    branch: null,
    status: null
  }
}
