/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export interface GitDiffRequestCacheOptions<T> {
  ttlMs: number
  maxEntries: number
  clone: (value: T) => T
  now?: () => number
}

export interface GitDiffRequestCacheGetOptions<T> {
  force?: boolean
  load: () => Promise<T>
  onCacheHit?: (ageMs: number) => void
  onForceInvalidate?: (entriesCleared: number) => void
}

export interface GitDiffRequestCacheStats {
  /** Current number of resident cached entries. */
  entries: number
  /** Currently in-flight load Promises (deduped requests). */
  inFlight: number
  /** Cumulative cache hits since startup (force-bypass counted in `forces`). */
  hits: number
  /** Cumulative cache misses (key absent or expired). */
  misses: number
  /** Cumulative force-invalidations (caller passed `force: true`). */
  forces: number
  /** TTL configured for entries, in ms. */
  ttlMs: number
  /** Soft cap on resident entries before pruning expired ones. */
  maxEntries: number
  /** Most recent request that touched this cache. */
  lastEvent: {
    kind: 'hit' | 'miss' | 'force' | null
    key: string | null
    at: number | null
    ageMs: number | null
    entriesCleared: number | null
  }
}

export class GitDiffRequestCacheController<T> {
  private readonly options: GitDiffRequestCacheOptions<T>
  private readonly cache = new Map<string, { value: T; at: number }>()
  private readonly inFlight = new Map<string, Promise<T>>()
  private readonly generations = new Map<string, number>()
  private readonly now: () => number
  private hits = 0
  private misses = 0
  private forces = 0
  private lastEvent: GitDiffRequestCacheStats['lastEvent'] = {
    kind: null,
    key: null,
    at: null,
    ageMs: null,
    entriesCleared: null
  }

  constructor(options: GitDiffRequestCacheOptions<T>) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
  }

  inspectStats(): GitDiffRequestCacheStats {
    return {
      entries: this.cache.size,
      inFlight: this.inFlight.size,
      hits: this.hits,
      misses: this.misses,
      forces: this.forces,
      ttlMs: this.options.ttlMs,
      maxEntries: this.options.maxEntries,
      lastEvent: { ...this.lastEvent }
    }
  }

  async get(key: string, options: GitDiffRequestCacheGetOptions<T>): Promise<T> {
    const force = Boolean(options.force)
    const now = this.now()
    const cached = this.cache.get(key)
    if (!force && cached && now - cached.at < this.options.ttlMs) {
      const ageMs = now - cached.at
      this.hits += 1
      this.lastEvent = { kind: 'hit', key, at: now, ageMs, entriesCleared: null }
      options.onCacheHit?.(ageMs)
      return this.options.clone(cached.value)
    }
    this.misses += 1
    this.lastEvent = {
      kind: force ? 'force' : 'miss',
      key,
      at: now,
      ageMs: cached ? now - cached.at : null,
      entriesCleared: null
    }

    if (force) {
      const cleared = this.invalidateKey(key)
      if (cleared) {
        this.forces += 1
        this.lastEvent = { kind: 'force', key, at: now, ageMs: cached ? now - cached.at : null, entriesCleared: 1 }
        options.onForceInvalidate?.(1)
      }
    } else {
      const existing = this.inFlight.get(key)
      if (existing) {
        return this.options.clone(await existing)
      }
    }

    const generation = this.currentGeneration(key)
    const task = options.load()
    this.inFlight.set(key, task)
    try {
      const value = await task
      const capturedAt = this.now()
      if (this.currentGeneration(key) === generation) {
        this.cache.set(key, { value: this.options.clone(value), at: capturedAt })
        this.prune(capturedAt)
      }
      return this.options.clone(value)
    } finally {
      if (this.inFlight.get(key) === task) {
        this.inFlight.delete(key)
      }
    }
  }

  invalidateKey(key: string): boolean {
    const cleared = this.cache.delete(key)
    this.generations.set(key, this.currentGeneration(key) + 1)
    return cleared
  }

  /**
   * Directly store a pre-computed value (batch warming). Used by the History
   * prewarm (git-op aggregation A2) to prime MANY commit-diff entries from a
   * SINGLE `git log --raw --numstat` parse, instead of running one `get(load)`
   * — and thus one git spawn — per commit. The value is cloned on store like
   * any other entry, so callers may reuse their object.
   */
  prime(key: string, value: T): void {
    const at = this.now()
    this.cache.set(key, { value: this.options.clone(value), at })
    this.prune(at)
  }

  clear(): void {
    this.cache.clear()
    this.inFlight.clear()
    this.generations.clear()
  }

  /**
   * Reset the running hit / miss / force counters without clearing
   * the cache. Used by the in-app debug panel's "Reset" button.
   */
  resetStats(): void {
    this.hits = 0
    this.misses = 0
    this.forces = 0
  }

  inspectForTest(key: string): { cached: boolean; inFlight: boolean; generation: number } {
    return {
      cached: this.cache.has(key),
      inFlight: this.inFlight.has(key),
      generation: this.currentGeneration(key)
    }
  }

  private currentGeneration(key: string): number {
    return this.generations.get(key) ?? 0
  }

  private prune(now: number): void {
    if (this.cache.size <= this.options.maxEntries) return
    // First drop time-expired entries.
    for (const [key, entry] of this.cache) {
      if (now - entry.at > this.options.ttlMs) {
        this.cache.delete(key)
      }
    }
    // With an event-driven (watcher-invalidated) cache the TTL is deliberately
    // long, so age-based pruning may free nothing. Fall back to insertion-order
    // (FIFO ≈ LRU) eviction of the oldest entries until we are back under the
    // cap, so the resident set stays bounded regardless of TTL.
    if (this.cache.size <= this.options.maxEntries) return
    const overflow = this.cache.size - this.options.maxEntries
    let dropped = 0
    for (const key of this.cache.keys()) {
      if (dropped >= overflow) break
      this.cache.delete(key)
      dropped += 1
    }
  }
}
