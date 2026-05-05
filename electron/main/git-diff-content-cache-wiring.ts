/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Singletons that glue the per-project content cache + precompute scheduler
// to the existing main-process IPC layer.
//
//   gitDiffContentCache         — pure data, eviction policy
//   gitDiffPrecomputeScheduler  — eager fetch orchestrator
//   fetchFileContentWithCache() — single fetch helper used by both the
//                                 ipcMain handler (synchronous demand) and
//                                 the scheduler (background prefill).
//
// Wiring contract:
//   - Whenever `gitDiffCacheInvalidator` fires for a cwd, the project bucket
//     is wiped AND a precompute burst is queued (see `installCacheInvalidator`
//     below). Caller invokes that hook exactly once at setup.
//   - The handler in `ipc-handlers.ts` calls `fetchFileContentWithCache` for
//     every renderer-driven `getFileContent` request. Cache hits return in
//     microseconds; misses fall through to the worker.
//   - The scheduler's `loadWorkingSet` re-uses `gitIpcWorkerClient.getDiff`
//     so it inherits the existing list-level cache and FS-watch invalidation.

import type { GitFileContentResult, GitFileStatus } from './git-utils'
import { GitDiffContentCache } from './git-diff-content-cache'
import { GitDiffPrecomputeScheduler, type DiffFile } from './git-diff-precompute-scheduler'
import { gitIpcWorkerClient } from './git-ipc-worker-client'
import { gitDiffCacheInvalidator } from './git-diff-cache-invalidator'
import { perfTraceLogger } from './perf-trace-logger'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

type ContentCacheFile = Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType' | 'isSubmoduleEntry'>

const PREFETCH_SKIP_EXTENSIONS = new Set<string>([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff',
  'pdf', 'epub',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
  'mp3', 'mp4', 'mov', 'avi', 'wav', 'ogg', 'flac',
  'so', 'dll', 'dylib', 'exe', 'class', 'jar',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'wasm'
])

export const gitDiffContentCache = new GitDiffContentCache<GitFileContentResult>({
  // Per-project budget as agreed in the design discussion. Smallest entries
  // evict first so the cache biases toward big files (whose first-click
  // latency is what users actually feel).
  projectByteLimit: 100 * 1024 * 1024,
  maxProjects: 8,
  // Single-file cap matches the precompute scheduler's skip threshold so a
  // 50 MB lock file does not blow the bucket; it falls through to lazy load.
  singleFileByteLimit: 10 * 1024 * 1024
})

function buildCacheKey(file: ContentCacheFile): string {
  // changeType + status disambiguate the same path's working-tree-vs-index
  // vs index-vs-HEAD vs untracked variants. originalFilename is part of the
  // key for renames so a rename's two ends do not collide.
  return `${file.changeType}::${file.status}::${file.originalFilename ?? ''}::${file.filename}`
}

function estimateBytes(result: GitFileContentResult): number {
  // Sum the dominant string fields. UTF-16 byte underestimates non-ASCII
  // content but stays close enough for budget bookkeeping. Image data-URLs
  // count too since they dominate cache size for image-heavy projects.
  let total = 0
  total += result.originalContent?.length ?? 0
  total += result.modifiedContent?.length ?? 0
  total += result.originalImageUrl?.length ?? 0
  total += result.modifiedImageUrl?.length ?? 0
  return total
}

export interface FetchFileContentArgs {
  cwd: string
  file: ContentCacheFile
  repoRoot?: string
}

/**
 * Single canonical path for "give me this file's diff content". Used by
 * both the renderer-driven IPC handler and the background precompute
 * scheduler. Submodule entries get their own bucket via `repoRoot`; the
 * fallback is `cwd`.
 */
export async function fetchFileContentWithCache(args: FetchFileContentArgs): Promise<GitFileContentResult> {
  const project = args.repoRoot ?? args.cwd
  const key = buildCacheKey(args.file)

  const cached = gitDiffContentCache.get(project, key)
  if (cached) {
    perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CONTENT_CACHE_HIT, {
      project,
      filename: args.file.filename,
      changeType: args.file.changeType
    })
    return cached
  }

  perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CONTENT_CACHE_MISS, {
    project,
    filename: args.file.filename,
    changeType: args.file.changeType
  })
  const result = await gitIpcWorkerClient.getFileContent(args.cwd, args.file, args.repoRoot)
  if (result.success) {
    const bytes = estimateBytes(result)
    const stored = gitDiffContentCache.put(project, key, result, bytes)
    if (!stored && bytes > 0) {
      perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_PRECOMPUTE_SKIP_TOO_LARGE, {
        project,
        filename: args.file.filename,
        bytes,
        reason: 'single-file-cap'
      })
    }
  }
  return result
}

export const gitDiffPrecomputeScheduler = new GitDiffPrecomputeScheduler({
  // Click-latency autotest showed 1-2 files still cache-missed at click time
  // because the previous concurrency=3 / burst=50 left tail entries behind
  // even after the 800 ms autotest dwell. Bumping concurrency to 6 and the
  // burst cap to 100 keeps tail-end fetches racing with the user instead of
  // stalling them.
  concurrency: 6,
  debounceMs: 100,
  maxCandidatesPerBurst: 100,
  isEligible: (file: DiffFile) => {
    if (file.isSubmoduleEntry) return false
    if (file.status === 'D' || file.status === '!') return false
    const leaf = file.filename.split(/[\\/]/).pop() ?? file.filename
    const dot = leaf.lastIndexOf('.')
    if (dot <= 0 || dot === leaf.length - 1) return true
    const extension = leaf.slice(dot + 1).toLowerCase()
    return !PREFETCH_SKIP_EXTENSIONS.has(extension)
  },
  loadWorkingSet: async (project) => {
    // Force a fresh list — the invalidator just told us something changed.
    const result = await gitIpcWorkerClient.getDiff(project, { force: true })
    if (!result || !result.success) return []
    return result.files
  },
  fetchFile: async (project, file) => {
    // The scheduler hands us a `DiffFile` shape; we need the real
    // GitFileStatus subset for the cache key. The `repoRoot` argument lives
    // on the original list entry — propagate it when present so submodules
    // route to their own bucket.
    const repoRoot = file.repoRoot ?? project
    const cwd = repoRoot
    const cacheFile = {
      filename: file.filename,
      status: file.status,
      originalFilename: undefined,
      changeType: file.changeType,
      isSubmoduleEntry: file.isSubmoduleEntry
    } as ContentCacheFile
    await fetchFileContentWithCache({ cwd, file: cacheFile, repoRoot })
  }
})

let invalidatorInstalled = false

/**
 * Install the once-per-process listener that links the existing fs.watch +
 * mirror-delta invalidator to our content cache and scheduler. Idempotent —
 * subsequent calls are no-ops so test harnesses can call freely.
 */
export function installContentCacheInvalidatorOnce(): void {
  if (invalidatorInstalled) return
  invalidatorInstalled = true
  gitDiffCacheInvalidator.addListener((cwd, reason) => {
    if (reason === 'lru') {
      // Project was evicted from the watcher — drop the bucket too so we do
      // not keep a stale snapshot for a project we no longer track.
      gitDiffContentCache.invalidateProject(cwd)
      gitDiffPrecomputeScheduler.cancelProject(cwd)
      perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CONTENT_CACHE_INVALIDATE_LRU, {
        project: cwd,
        reason
      })
      return
    }
    const dropped = gitDiffContentCache.invalidateProject(cwd)
    if (dropped > 0) {
      perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CONTENT_CACHE_INVALIDATE_PROJECT, {
        project: cwd,
        reason,
        droppedEntries: dropped
      })
    }
    gitDiffPrecomputeScheduler.onProjectInvalidated(cwd)
  })
}

export function inspectContentCacheStats() {
  return {
    cache: gitDiffContentCache.inspectStats(),
    scheduler: gitDiffPrecomputeScheduler.inspectStats()
  }
}
