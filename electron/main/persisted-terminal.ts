/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveExistingTerminalCwd } from './terminal-cwd-validation.ts'

/**
 * On-disk shape of a single Task (terminal) inside a persisted Tab.
 *
 * `manualNameRepoRoot` is the "this customName is a USER-driven manual rename,
 * do not let the auto-follow engine overwrite it" override marker. It records
 * the repo root that was in scope at the moment the user renamed the Task.
 *
 * HARD INVARIANT — this field MUST round-trip on every persist (save / patch /
 * load). Dropping it silently reverts every manually-renamed Task to its live
 * git branch name on the next git-info sync (auto-follow guard `(a)` requires a
 * non-null marker; with the marker gone the rename falls through to branch
 * adoption). That is exactly the auto-update-restart regression this module was
 * extracted to lock down — see `terminal-manual-name-roundtrip.test.mts`.
 */
export interface PersistedTerminalState {
  id: string
  customName: string | null
  manualNameRepoRoot: string | null
  lastCwd: string | null
}

/** Loose shape accepted from disk / IPC, including the legacy `title` format. */
interface RawTerminalLike {
  id?: string
  title?: string
  customName?: string | null
  manualNameRepoRoot?: string | null
  lastCwd?: string | null
}

/**
 * Normalise one raw / legacy terminal record into the persisted shape.
 *
 * Pure (only depends on `resolveExistingTerminalCwd`, which touches the fs but
 * is itself electron-free), so it is unit-testable in plain Node. Every return
 * branch carries `manualNameRepoRoot` through; it is the single source of truth
 * for the field's persistence and the reason the strip cannot reappear.
 */
export function normalizePersistedTerminal(raw: RawTerminalLike): PersistedTerminalState {
  const id = raw.id ?? ''
  const lastCwd = resolveExistingTerminalCwd(raw.lastCwd)
  const manualNameRepoRoot = typeof raw.manualNameRepoRoot === 'string' ? raw.manualNameRepoRoot : null

  // Current format: a customName field is present (possibly explicit null).
  if ('customName' in raw && raw.customName !== undefined) {
    return { id, customName: raw.customName, manualNameRepoRoot, lastCwd }
  }

  // Legacy format: derive customName from the old `title` string.
  if (raw.title) {
    // "Agent N: xxx" → custom part is "xxx".
    const match = raw.title.match(/^Agent \d+: (.+)$/)
    if (match) {
      return { id, customName: match[1], manualNameRepoRoot, lastCwd }
    }
    // "Agent N" (no custom name).
    if (/^Agent \d+$/.test(raw.title)) {
      return { id, customName: null, manualNameRepoRoot, lastCwd }
    }
    // Otherwise the entire title is a custom name.
    return { id, customName: raw.title, manualNameRepoRoot, lastCwd }
  }

  return { id, customName: null, manualNameRepoRoot, lastCwd }
}

/** Normalise an array of raw / legacy terminal records. Non-arrays → []. */
export function normalizePersistedTerminals(rawTerminals: unknown): PersistedTerminalState[] {
  if (!Array.isArray(rawTerminals)) return []
  return rawTerminals.map((t) => normalizePersistedTerminal(t as RawTerminalLike))
}
