/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-project Git diff content cache.
//
// What this caches: the body of `getFileContent` (originalContent +
// modifiedContent + binary/image flags) that the diff viewer needs to render
// any given file. NOT the diff list itself — that already lives behind
// `GitDiffRequestCacheController`.
//
// Why a new cache: the renderer used to drive a 4-file prefetch loop on its
// own. That hit a cliff the moment you clicked file #5. Moving the cache to
// main lets every renderer (multiple tabs / tasks pointing at the same
// project) share one warm bucket, and lets a precompute scheduler eagerly
// populate it for the entire working set.
//
// Eviction model:
//   1. Per-project byte budget (default 100 MB). Smallest entries evict
//      first — large files dominate first-click latency, so we bias the
//      cache toward keeping them resident.
//   2. Per-instance project budget (default 8 projects). When the 9th
//      project pushes a put, the LRU project (by `lastTouchedAt`) gets
//      its whole bucket dropped.
//   3. HEAD-change / project-wide invalidation: callers that detect a
//      commit / checkout / external mutation invoke
//      `invalidateProject(project)` to wipe the bucket.

export interface GitDiffContentCacheOptions {
  /** Per-project byte budget. Default 100 MB. */
  projectByteLimit?: number
  /** Maximum number of project buckets retained simultaneously. Default 8. */
  maxProjects?: number
  /** Single-file hard cap. Entries larger than this are not stored. Default 10 MB. */
  singleFileByteLimit?: number
  /** Pluggable clock for deterministic tests. */
  now?: () => number
}

export interface GitDiffContentCacheEntry<T> {
  value: T
  bytes: number
  /** Wall-clock millis of last hit / put — used for tie-breaking eviction. */
  touchedAt: number
}

export interface GitDiffContentCacheStats {
  projects: Array<{
    project: string
    bytes: number
    entries: number
    lastTouchedAt: number
  }>
  totalBytes: number
  totalEntries: number
  projectByteLimit: number
  maxProjects: number
  singleFileByteLimit: number
}

interface ProjectBucket<T> {
  project: string
  entries: Map<string, GitDiffContentCacheEntry<T>>
  bytes: number
  lastTouchedAt: number
}

const DEFAULT_PROJECT_BYTE_LIMIT = 100 * 1024 * 1024
const DEFAULT_MAX_PROJECTS = 8
const DEFAULT_SINGLE_FILE_BYTE_LIMIT = 10 * 1024 * 1024

export class GitDiffContentCache<T> {
  private readonly projects = new Map<string, ProjectBucket<T>>()
  private readonly projectByteLimit: number
  private readonly maxProjects: number
  private readonly singleFileByteLimit: number
  private readonly now: () => number

  constructor(options: GitDiffContentCacheOptions = {}) {
    this.projectByteLimit = options.projectByteLimit ?? DEFAULT_PROJECT_BYTE_LIMIT
    this.maxProjects = options.maxProjects ?? DEFAULT_MAX_PROJECTS
    this.singleFileByteLimit = options.singleFileByteLimit ?? DEFAULT_SINGLE_FILE_BYTE_LIMIT
    this.now = options.now ?? (() => Date.now())
  }

  get(project: string, key: string): T | null {
    const bucket = this.projects.get(project)
    if (!bucket) return null
    const entry = bucket.entries.get(key)
    if (!entry) return null
    const stamp = this.now()
    entry.touchedAt = stamp
    bucket.lastTouchedAt = stamp
    return entry.value
  }

  /**
   * Store a value under the given project / key. Returns `false` when the
   * entry exceeds the single-file cap (caller should still render it, just
   * skip caching). Returns `true` when stored — the caller does not need to
   * worry about eviction; this method does that internally.
   */
  put(project: string, key: string, value: T, bytes: number): boolean {
    if (!Number.isFinite(bytes) || bytes < 0) return false
    if (bytes > this.singleFileByteLimit) return false
    if (bytes > this.projectByteLimit) return false

    const stamp = this.now()
    let bucket = this.projects.get(project)
    if (!bucket) {
      this.evictProjectsIfOverLimit()
      bucket = { project, entries: new Map(), bytes: 0, lastTouchedAt: stamp }
      this.projects.set(project, bucket)
    }

    const previous = bucket.entries.get(key)
    if (previous) bucket.bytes -= previous.bytes
    bucket.entries.set(key, { value, bytes, touchedAt: stamp })
    bucket.bytes += bytes
    bucket.lastTouchedAt = stamp

    this.evictWithinProjectIfOverLimit(bucket)
    return true
  }

  /** Drops a single entry. Returns true when something was actually removed. */
  invalidateEntry(project: string, key: string): boolean {
    const bucket = this.projects.get(project)
    if (!bucket) return false
    const entry = bucket.entries.get(key)
    if (!entry) return false
    bucket.entries.delete(key)
    bucket.bytes -= entry.bytes
    if (bucket.entries.size === 0) this.projects.delete(project)
    return true
  }

  /** Drops every entry for the given project. Returns count of dropped entries. */
  invalidateProject(project: string): number {
    const bucket = this.projects.get(project)
    if (!bucket) return 0
    const dropped = bucket.entries.size
    this.projects.delete(project)
    return dropped
  }

  /** Drops everything. Returns count of dropped entries. */
  invalidateAll(): number {
    let dropped = 0
    for (const bucket of this.projects.values()) dropped += bucket.entries.size
    this.projects.clear()
    return dropped
  }

  inspectStats(): GitDiffContentCacheStats {
    const projects: GitDiffContentCacheStats['projects'] = []
    let totalBytes = 0
    let totalEntries = 0
    for (const bucket of this.projects.values()) {
      projects.push({
        project: bucket.project,
        bytes: bucket.bytes,
        entries: bucket.entries.size,
        lastTouchedAt: bucket.lastTouchedAt
      })
      totalBytes += bucket.bytes
      totalEntries += bucket.entries.size
    }
    return {
      projects,
      totalBytes,
      totalEntries,
      projectByteLimit: this.projectByteLimit,
      maxProjects: this.maxProjects,
      singleFileByteLimit: this.singleFileByteLimit
    }
  }

  hasProject(project: string): boolean {
    return this.projects.has(project)
  }

  // --- private ---

  private evictWithinProjectIfOverLimit(bucket: ProjectBucket<T>): void {
    if (bucket.bytes <= this.projectByteLimit) return
    // Smallest-first eviction: drop tiny entries before large ones, on the
    // theory that re-fetching a 1 KB file is fast enough to absorb a cache
    // miss, while re-fetching a 5 MB file is what the user actually feels.
    // Tie-break by oldest touchedAt so two entries of equal size evict the
    // less recently used one first.
    const sorted = [...bucket.entries.entries()].sort((a, b) => {
      const sizeDelta = a[1].bytes - b[1].bytes
      if (sizeDelta !== 0) return sizeDelta
      return a[1].touchedAt - b[1].touchedAt
    })
    for (const [key, entry] of sorted) {
      if (bucket.bytes <= this.projectByteLimit) break
      bucket.entries.delete(key)
      bucket.bytes -= entry.bytes
    }
    if (bucket.entries.size === 0) this.projects.delete(bucket.project)
  }

  private evictProjectsIfOverLimit(): void {
    if (this.projects.size < this.maxProjects) return
    // LRU project: the bucket whose `lastTouchedAt` is the oldest goes.
    let victim: ProjectBucket<T> | null = null
    for (const bucket of this.projects.values()) {
      if (!victim || bucket.lastTouchedAt < victim.lastTouchedAt) victim = bucket
    }
    if (victim) this.projects.delete(victim.project)
  }
}
