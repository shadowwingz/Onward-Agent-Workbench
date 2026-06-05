/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared, dependency-free classification for the Task status-bar Git badge.
 *
 * The badge has five "dirty" colour buckets, derived purely from which *kinds*
 * of change a repository's working tree currently carries:
 *
 *   - clean    (emerald)  no changes at all
 *   - added    (purple)   only additions  (untracked / staged-add / rename / copy)
 *   - deleted  (red)      only deletions
 *   - modified (yellow)   only edits to existing tracked content
 *   - mixed    (blue)     two or more of {add, delete, modify} coexist
 *   - unknown  (slate)    not a git repo / git failed — set by callers, not here
 *
 * The clean / added / modified colours carry an established semantic that
 * pre-dates this module and MUST NOT change. `deleted` and `mixed` only *split
 * out* cases that previously collapsed into `added` (deletions used to count as
 * "added", and any add+modify mixture used to resolve to "added" as well).
 *
 * This module is the single source of truth for the per-file → category →
 * aggregate mapping. Every porcelain parser (the GitStateMirror worker, the
 * legacy `git-utils` RPC path, and the standalone git-status worker) funnels
 * through `categorizeGitStatusCode` + `deriveTerminalGitStatus`, so the badge
 * colour is identical regardless of which path produced it.
 */

export type TerminalGitStatus =
  | 'clean'
  | 'added'
  | 'deleted'
  | 'modified'
  | 'mixed'
  | 'unknown'

/** The bucket a single changed path falls into. */
export type GitChangeCategory = 'add' | 'del' | 'mod'

/**
 * Map one porcelain status code to its change category.
 *
 * Accepts:
 *   - the untracked sentinel `'??'` (porcelain v1) → add
 *   - a porcelain-v1 two-char XY code (e.g. `'AM'`, `' M'`, `'D '`)
 *   - a porcelain-v2 combined XY code (e.g. `'A.'`, `'.M'`, `'R.'`)
 *
 * Precedence when a code carries more than one signal (highest first):
 *   unmerged `U` → modify (a conflict is an edit to existing content);
 *   rename `R` / copy `C` / add `A` → add (the path is new);
 *   delete `D` → delete;
 *   modify `M` → modify.
 *
 * Returns null for clean codes (`''`, `'.'`, `'..'`, `'  '`). Unmerged codes
 * are forced to `mod` here, so callers must NOT route `u ` records through a
 * raw-XY classification — `'AA'` / `'DD'` are conflicts, not add/delete. Pass
 * `'mod'` directly for `u ` records instead.
 */
export function categorizeGitStatusCode(code: string): GitChangeCategory | null {
  if (!code) return null
  if (code === '??') return 'add'
  if (code.includes('U')) return 'mod'
  if (code.includes('R') || code.includes('C') || code.includes('A')) return 'add'
  if (code.includes('D')) return 'del'
  if (code.includes('M')) return 'mod'
  return null
}

/**
 * Accumulate the change categories a single record's combined code contributes,
 * into `into`. Accepts the untracked sentinel `'??'`, a porcelain-v1 two-char XY,
 * or a porcelain-v2 combined XY (index char + worktree char).
 *
 * A path that is NEW on either side (untracked `'??'`, add `A`, rename `R`, copy
 * `C`) is a single `add` — a new-then-edited (`'AM'`) or new-then-deleted (`'AD'`)
 * file is fundamentally an addition, NOT a mix. An unmerged conflict (`U`) is a
 * single `mod`. Otherwise the index and worktree sides are categorized
 * INDEPENDENTLY and unioned, so a genuinely two-sided file like `'MD'` (staged
 * modify + worktree delete) contributes BOTH `mod` and `del` — letting a repo
 * whose only change is that file resolve to `mixed` rather than collapsing to a
 * single bucket.
 */
export function collectXyCategories(code: string, into: Set<GitChangeCategory>): void {
  if (!code) return
  if (code === '??') { into.add('add'); return }
  if (code.includes('U')) { into.add('mod'); return }
  if (code.includes('R') || code.includes('C') || code.includes('A')) { into.add('add'); return }
  // No new-path / conflict marker: each side is an independent change kind.
  for (const side of code) {
    const category = categorizeGitStatusCode(side)
    if (category) into.add(category)
  }
}

/**
 * Collapse the set of change categories seen across a repo's working tree into
 * the five-state badge bucket. Pure and allocation-light (boolean flags, no Set
 * needed): two or more distinct categories → `mixed`; exactly one → its colour;
 * none → `clean`.
 *
 * Never returns `unknown` — that state means "not a repo / git failed" and is
 * owned by the callers (e.g. the mirror's catch path), not by this derivation.
 */
export function deriveTerminalGitStatus(
  categories: Iterable<GitChangeCategory>
): TerminalGitStatus {
  let hasAdd = false
  let hasDel = false
  let hasMod = false
  for (const category of categories) {
    if (category === 'add') hasAdd = true
    else if (category === 'del') hasDel = true
    else if (category === 'mod') hasMod = true
  }
  const distinct = (hasAdd ? 1 : 0) + (hasDel ? 1 : 0) + (hasMod ? 1 : 0)
  if (distinct === 0) return 'clean'
  if (distinct >= 2) return 'mixed'
  if (hasAdd) return 'added'
  if (hasDel) return 'deleted'
  return 'modified'
}
