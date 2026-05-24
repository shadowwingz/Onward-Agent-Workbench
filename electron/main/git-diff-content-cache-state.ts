/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Pure cache-state logic for the per-file Git Diff content cache. Kept as a
// LEAF module (no transitive `electron`, `git-utils`, IPC, or scheduler
// dependencies) so the cache-classification chain can be exercised by Node
// unit tests without spinning up the worker or the main-process singletons.
//
// The production wiring (`git-diff-content-cache-wiring.ts`) imports the
// factory below and binds it to the real cache + worker + scheduler, while
// tests bind it to mocks. The two paths share this exact same state machine.

import type { GitDiffContentCache } from './git-diff-content-cache'

export type GitDiffContentCacheMissReason =
  | 'first-load'
  | 'invalidated-mutation'
  | 'invalidated-watch'
  | 'invalidated-mirror'
  | 'invalidated-refresh'
  | 'renderer-force-refresh'
  | 'project-queue-evicted'
  | 'single-file-too-large'
  | 'precompute-pending'
  | 'entry-not-warmed'
  | 'worker-error'

export type GitDiffContentCacheSource =
  | 'renderer-memory'
  | 'main-content-cache'
  | 'worker-rebuild'

export interface GitDiffContentCacheInfo {
  state: 'hit' | 'miss'
  source: GitDiffContentCacheSource
  missReason?: GitDiffContentCacheMissReason
  project?: string
  key?: string
  stored?: boolean
  bytes?: number
}

export interface GitFileContentRequestOptions {
  force?: boolean
  missReason?: GitDiffContentCacheMissReason
  allowLargeFile?: boolean
}

/**
 * Subset of `GitFileStatus` that the cache-key path actually reads. Defined
 * here as a structural shape so this module stays free of `git-utils`.
 */
export interface ContentCacheFile {
  filename: string
  status: string
  /** Set for renames (status === 'R') and copies (status === 'C'); empty otherwise. */
  originalFilename?: string
  changeType: string
  isSubmoduleEntry?: boolean
}

/**
 * Minimal fetch-result shape the state machine needs. Real callers pass the
 * full `GitFileContentResult`; the generic `T` lets tests pass simpler shapes.
 */
export interface CacheableFetchResult {
  success: boolean
  cacheInfo?: GitDiffContentCacheInfo
}

/**
 * Build the per-file cache key used by both the scheduler-side prewarm and
 * the renderer-driven click path. **MUST** be deterministic and **MUST**
 * produce the same key for the same logical file regardless of which path
 * called it — otherwise a prewarmed entry will not be reused on click.
 */
export function buildCacheKey(file: ContentCacheFile): string {
  // changeType + status disambiguate the same path's working-tree-vs-index
  // vs index-vs-HEAD vs untracked variants. originalFilename is part of the
  // key for renames so a rename's two ends do not collide.
  return `${file.changeType}::${file.status}::${file.originalFilename ?? ''}::${file.filename}`
}

export interface FetchFileContentArgs {
  cwd: string
  file: ContentCacheFile
  repoRoot?: string
  options?: GitFileContentRequestOptions
}

export interface FetchFileContentDeps<T extends CacheableFetchResult> {
  cache: GitDiffContentCache<T>
  fetchFromWorker: (cwd: string, file: ContentCacheFile, repoRoot?: string, options?: GitFileContentRequestOptions) => Promise<T>
  schedulerPendingProjects: () => string[]
  schedulerInFlightProjects: () => string[]
  recentMissReason: (project: string) => GitDiffContentCacheMissReason | null
  rememberMissReason: (project: string, reason: GitDiffContentCacheMissReason) => void
  estimateBytes: (result: T) => number
  recordHit?: (info: { project: string; filename: string; changeType: string }) => void
  recordMiss?: (info: { project: string; filename: string; changeType: string; reason: GitDiffContentCacheMissReason; force: boolean }) => void
  recordSkipTooLarge?: (info: { project: string; filename: string; bytes: number }) => void
  recordSkipStaleGeneration?: (info: { project: string; filename: string; changeType: string }) => void
}

function withCacheInfo<T extends CacheableFetchResult>(result: T, info: GitDiffContentCacheInfo): T {
  return { ...result, cacheInfo: info }
}

function withoutCacheInfo<T extends CacheableFetchResult>(result: T): T {
  const rest = { ...result }
  delete rest.cacheInfo
  return rest
}

function resolveMissReason<T extends CacheableFetchResult>(
  project: string,
  hadProjectBeforeLookup: boolean,
  explicitReason: GitDiffContentCacheMissReason | undefined,
  deps: FetchFileContentDeps<T>
): GitDiffContentCacheMissReason {
  if (explicitReason) return explicitReason
  const recentReason = deps.recentMissReason(project)
  if (recentReason) return recentReason
  if (deps.cache.consumeRecentProjectQueueEviction(project)) return 'project-queue-evicted'
  if (
    deps.schedulerPendingProjects().includes(project) ||
    deps.schedulerInFlightProjects().includes(project)
  ) {
    return 'precompute-pending'
  }
  return hadProjectBeforeLookup ? 'entry-not-warmed' : 'first-load'
}

/**
 * Factory: returns a `fetchFileContentWithCache` bound to the given deps.
 * The production binding wraps the module singletons; tests pass a fresh
 * `GitDiffContentCache<T>` and a mock worker so each scenario starts from a
 * clean slate.
 *
 * Branch matrix (every branch is exercised by the wiring unit-test suite):
 *
 *   force=false ∧ cache.get → entry  → state='hit'  source='main-content-cache'
 *   force=false ∧ cache.get → null   → fall through to worker
 *   force=true                       → fall through to worker, missReason from caller
 *   worker.success=false             → state='miss'  missReason='worker-error'  NOT cached
 *   worker.success=true ∧ stored=true→ state='miss'  missReason=resolved        cached
   *   worker.success=true ∧ stored=false (single-file-too-large)
   *                                    → state='miss'  missReason='single-file-too-large'  NOT cached
   *   worker.success=true ∧ generation changed during fetch
   *                                    → state='miss'  missReason=resolved  NOT cached
 *
 * Miss-reason resolution order:
 *   1. caller-provided `options.missReason` wins (renderer force-refresh,
 *      mutation invalidation, etc.)
 *   2. recent-invalidation reason from `deps.recentMissReason` (set by
 *      `gitDiffCacheInvalidator` listener via `rememberMissReason`)
 *   3. project-queue-evicted flag from the cache (consumed once)
 *   4. scheduler pending / in-flight → 'precompute-pending'
 *   5. project bucket existed → 'entry-not-warmed', else → 'first-load'
 */
export function createFetchFileContentWithCache<T extends CacheableFetchResult>(deps: FetchFileContentDeps<T>) {
  return async function fetchFileContentWithCacheImpl(args: FetchFileContentArgs): Promise<T> {
    const project = args.repoRoot ?? args.cwd
    const key = buildCacheKey(args.file)
    const force = Boolean(args.options?.force)
    const hadProjectBeforeLookup = deps.cache.hasProject(project)
    const generationAtFetchStart = deps.cache.getProjectGeneration(project)

    const cached = force ? null : deps.cache.get(project, key)
    if (cached) {
      deps.recordHit?.({
        project,
        filename: args.file.filename,
        changeType: args.file.changeType
      })
      return withCacheInfo(cached, {
        state: 'hit',
        source: 'main-content-cache',
        project,
        key
      })
    }

    const missReason = resolveMissReason(project, hadProjectBeforeLookup, args.options?.missReason, deps)
    deps.recordMiss?.({
      project,
      filename: args.file.filename,
      changeType: args.file.changeType,
      reason: missReason,
      force
    })
    const result = await deps.fetchFromWorker(args.cwd, args.file, args.repoRoot, args.options)
    let stored = false
    let bytes = 0
    let finalMissReason: GitDiffContentCacheMissReason = result.success ? missReason : 'worker-error'
    if (result.success) {
      bytes = deps.estimateBytes(result)
      if (deps.cache.isProjectGenerationCurrent(project, generationAtFetchStart)) {
        stored = deps.cache.put(project, key, withoutCacheInfo(result), bytes)
      } else {
        deps.recordSkipStaleGeneration?.({
          project,
          filename: args.file.filename,
          changeType: args.file.changeType
        })
      }
      if (
        !stored &&
        bytes > 0 &&
        deps.cache.isProjectGenerationCurrent(project, generationAtFetchStart)
      ) {
        finalMissReason = 'single-file-too-large'
        deps.recordSkipTooLarge?.({
          project,
          filename: args.file.filename,
          bytes
        })
      }
    }
    return withCacheInfo(result, {
      state: 'miss',
      source: 'worker-rebuild',
      missReason: finalMissReason,
      project,
      key,
      stored,
      bytes
    })
  }
}
