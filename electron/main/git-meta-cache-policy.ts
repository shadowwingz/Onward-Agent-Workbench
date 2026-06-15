/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Freshness policy for the `getGitRepoMeta` cache (git-op aggregation A1).
 *
 * Pure + leaf (no I/O, no Electron) so the "positive = permanent, negative =
 * TTL" decision is unit-testable without loading the heavy `git-utils` module.
 *
 * Rationale: a repo's `repoRoot` / `gitDir` are IMMUTABLE for a given cwd path,
 * so once resolved (a POSITIVE result, `isRepo === true`) the entry never needs
 * re-spawning `rev-parse` — it is fresh forever. A NEGATIVE result (a directory
 * that is not a git repo) keeps the short TTL so a directory that is later
 * `git init`'d is rediscovered. The rare repo-deleted / worktree-moved case is
 * handled by an explicit `clearGitMetaCache()` escape hatch in git-utils.
 */

export interface MetaCacheEntryLike {
  value: { isRepo: boolean }
  at: number
}

export function isMetaCacheEntryFresh(
  entry: MetaCacheEntryLike,
  nowMs: number,
  ttlMs: number
): boolean {
  // Positive results are immutable → always fresh; negative results expire.
  return entry.value.isRepo || nowMs - entry.at < ttlMs
}
