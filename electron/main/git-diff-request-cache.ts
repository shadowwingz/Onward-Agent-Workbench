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

export class GitDiffRequestCacheController<T> {
  private readonly options: GitDiffRequestCacheOptions<T>
  private readonly cache = new Map<string, { value: T; at: number }>()
  private readonly inFlight = new Map<string, Promise<T>>()
  private readonly generations = new Map<string, number>()
  private readonly now: () => number

  constructor(options: GitDiffRequestCacheOptions<T>) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
  }

  async get(key: string, options: GitDiffRequestCacheGetOptions<T>): Promise<T> {
    const force = Boolean(options.force)
    const now = this.now()
    const cached = this.cache.get(key)
    if (!force && cached && now - cached.at < this.options.ttlMs) {
      options.onCacheHit?.(now - cached.at)
      return this.options.clone(cached.value)
    }

    if (force) {
      const cleared = this.invalidateKey(key)
      if (cleared) options.onForceInvalidate?.(1)
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

  clear(): void {
    this.cache.clear()
    this.inFlight.clear()
    this.generations.clear()
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
    for (const [key, entry] of this.cache) {
      if (now - entry.at > this.options.ttlMs) {
        this.cache.delete(key)
      }
    }
  }
}
