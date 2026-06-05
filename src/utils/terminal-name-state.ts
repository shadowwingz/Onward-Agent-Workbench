/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Authoritative lookup of a Task's name + manual-override marker.
 *
 * Auto-follow must decide "keep the user's manual name vs adopt the git branch"
 * from the SOURCE OF TRUTH (AppState), never from a derived copy that lags it by
 * a render cycle. Reading a stale customName / manualNameRepoRoot here is exactly
 * what let a git-info sync clobber a just-stamped manual rename: the lagging copy
 * still showed marker=null, so guard (a) missed and branch adoption fired.
 *
 * Pure (no imports), so it is unit-testable in plain Node and reusable from the
 * AppState provider over `stateRef.current.tabs` (which is updated synchronously
 * inside the state updater, ahead of the visibleTerminals effect copy).
 */

export interface TerminalNameState {
  customName: string | null
  manualNameRepoRoot: string | null
}

interface TerminalLike {
  id: string
  customName?: string | null
  manualNameRepoRoot?: string | null
}

interface TabLike {
  terminals?: ReadonlyArray<TerminalLike> | null
}

const EMPTY: TerminalNameState = { customName: null, manualNameRepoRoot: null }

/**
 * Find a terminal's name + marker across all tabs by id. Terminal ids are
 * globally unique, so the first match wins. Returns nulls when not found.
 */
export function findTerminalNameState(
  tabs: ReadonlyArray<TabLike> | null | undefined,
  terminalId: string
): TerminalNameState {
  if (!tabs || !terminalId) return EMPTY
  for (const tab of tabs) {
    const terminals = tab?.terminals
    if (!terminals) continue
    for (const term of terminals) {
      if (term && term.id === terminalId) {
        return {
          customName: term.customName ?? null,
          manualNameRepoRoot: term.manualNameRepoRoot ?? null
        }
      }
    }
  }
  return EMPTY
}
