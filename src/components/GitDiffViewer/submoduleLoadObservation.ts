/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure latch reducer for the Git Diff "outline visible before full submodule
 * load" guarantee. The diff loads in two stages — paint the root-only outline
 * immediately (`submodulesLoading: true`, repos still `loading`), then merge the
 * full recursive pass (`submodulesLoading: false`). That intermediate state is a
 * sub-millisecond transient on a small repo, so polling it (DSM-03 / RSM-03)
 * races and misses it. Instead we LATCH the peak observation as each result is
 * applied, so a test can read "did the outline show loading repos before the
 * full pass settled?" deterministically.
 *
 * Dependency-free (minimal shapes, no imports) so it is unit-testable under
 * `node --experimental-strip-types`.
 */

export interface SubmoduleLoadObservation {
  /** true once any applied result had `submodulesLoading: true`. */
  sawSubmodulesLoading: boolean
  /** peak count of repos that were `loading` while `submodulesLoading` was true. */
  maxLoadingRepoCount: number
  /** peak count of NESTED (`depth > 0`) repos that were `loading` (RSM-03). */
  maxNestedLoadingRepoCount: number
}

/** Minimal shape of the bits of a diff result this reducer reads. */
export interface SubmoduleLoadObservationInput {
  submodulesLoading?: boolean
  repos?: ReadonlyArray<{ loading?: boolean; depth?: number }>
}

export function emptySubmoduleLoadObservation(): SubmoduleLoadObservation {
  return { sawSubmodulesLoading: false, maxLoadingRepoCount: 0, maxNestedLoadingRepoCount: 0 }
}

/**
 * Fold one applied diff result into the latch. A result with
 * `submodulesLoading: true` raises the peak loading-repo counts; any other
 * result (e.g. the settled full pass) leaves the latch unchanged so the peak is
 * never lowered by the later, fully-loaded state.
 */
export function foldSubmoduleLoadObservation(
  prev: SubmoduleLoadObservation,
  result: SubmoduleLoadObservationInput | null | undefined
): SubmoduleLoadObservation {
  if (!result || result.submodulesLoading !== true) return prev
  const repos = result.repos ?? []
  let loadingCount = 0
  let nestedLoadingCount = 0
  for (const repo of repos) {
    if (!repo?.loading) continue
    loadingCount += 1
    if ((repo.depth ?? 0) > 0) nestedLoadingCount += 1
  }
  return {
    sawSubmodulesLoading: true,
    maxLoadingRepoCount: Math.max(prev.maxLoadingRepoCount, loadingCount),
    maxNestedLoadingRepoCount: Math.max(prev.maxNestedLoadingRepoCount, nestedLoadingCount)
  }
}
