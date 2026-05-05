/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { watch, type FSWatcher } from 'fs'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { isMainThread } from 'worker_threads'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

// Bug 2 — file-watcher driven Git Diff cache invalidator.
//
// `getGitDiff` keeps a request-level cache (`cwd::scope`) so rapid duplicate
// calls (mount → re-mount, multiple panels asking for the same root) do not
// re-spawn `git status`. The original 3-second TTL was time-based, which made
// the cache return stale data when files mutated between calls.
//
// This module pairs the cache with one fs.watch per active cwd so that ANY
// FS event under the cwd debounces (180 ms, matching ProjectTreeWatchManager)
// and invalidates the cached entries. The cache becomes correct-on-its-own
// when the watcher is healthy. The renderer-side `force=true` knob (used on
// subpage entry) is the deterministic backstop for the watcher-cold-boot
// window and APFS / Linux inotify edge cases.
//
// Cross-platform notes:
//  * macOS / Windows: fs.watch with recursive: true works natively.
//  * Linux: Node 20+ supports recursive fs.watch via inotify; very large
//    trees may run into the 8192 inotify watch limit. The LRU cap (8 cwds)
//    bounds blast radius. A future hardening pass could add chokidar fallback.

const DEBOUNCE_MS = 180
const LRU_LIMIT = 8

interface InvalidationListener {
  (cwd: string, reason: 'watcher' | 'force' | 'lru' | 'manual'): void
}

interface WatchEntry {
  cwd: string
  watcher: FSWatcher | null
  debounceTimer: NodeJS.Timeout | null
  pendingSince: number | null
  lastTouchedAt: number
  disposed: boolean
}

class GitDiffCacheInvalidator {
  private entries = new Map<string, WatchEntry>()
  private listeners = new Set<InvalidationListener>()
  private workerWarnedFor = new Set<string>()

  registerWatch(cwd: string): void {
    if (!isMainThread) {
      // Worker context: the watcher could fire here, but the listener that
      // forwards invalidations to the renderer over IPC only exists in the
      // main process — workers have no `mainWindow` reference. Loud no-op
      // so a future caller does not silently rely on an inert watcher.
      // Warn once per cwd to avoid log spam.
      const key = resolve(cwd)
      if (!this.workerWarnedFor.has(key)) {
        this.workerWarnedFor.add(key)
        console.warn(
          '[git-diff-cache-invalidator] registerWatch called from worker context for cwd=',
          key,
          '— ignored. Move the call into the main-process IPC handler so the watcher can fire IPC notifications.'
        )
      }
      return
    }
    const normalized = resolve(cwd)
    const existing = this.entries.get(normalized)
    if (existing) {
      existing.lastTouchedAt = Date.now()
      return
    }
    if (!existsSync(normalized)) return

    const entry: WatchEntry = {
      cwd: normalized,
      watcher: null,
      debounceTimer: null,
      pendingSince: null,
      lastTouchedAt: Date.now(),
      disposed: false
    }
    this.entries.set(normalized, entry)

    try {
      entry.watcher = watch(
        normalized,
        { recursive: true, persistent: false },
        () => this.handleRawEvent(entry)
      )
      entry.watcher.on('error', () => {
        // Drop the watcher; force-on-entry from the renderer remains the
        // backstop. A later getGitDiff call will re-register.
        this.unregisterWatch(normalized)
      })
    } catch {
      entry.watcher = null
      this.entries.delete(normalized)
      return
    }

    this.evictIfOverLimit()
  }

  unregisterWatch(cwd: string): void {
    const normalized = resolve(cwd)
    const entry = this.entries.get(normalized)
    if (!entry) return
    entry.disposed = true
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        // ignore
      }
      entry.watcher = null
    }
    this.entries.delete(normalized)
  }

  // External trigger for callers that already know the cache is stale (e.g.
  // a `force=true` request landed and we want to broadcast invalidation so any
  // sibling cwds rooted at the same superproject also drop their snapshot).
  invalidate(cwd: string, reason: 'force' | 'manual' = 'manual'): void {
    const normalized = resolve(cwd)
    this.fireListeners(normalized, reason)
  }

  addListener(listener: InvalidationListener): () => void {
    if (!isMainThread) {
      // Worker context: registerWatch is also a no-op here, so any listener
      // attached in the worker would never fire anyway. Refuse silently with
      // an unsubscribe stub so callers don't break.
      console.warn(
        '[git-diff-cache-invalidator] addListener called from worker context — ignored.'
      )
      return () => { /* no-op */ }
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    for (const cwd of [...this.entries.keys()]) {
      this.unregisterWatch(cwd)
    }
    this.listeners.clear()
  }

  // --- private ---

  private handleRawEvent(entry: WatchEntry): void {
    if (entry.disposed) return
    if (entry.debounceTimer) return // already in a debounce window
    entry.pendingSince = Date.now()
    entry.debounceTimer = setTimeout(() => {
      const pendingMs = entry.pendingSince !== null ? Date.now() - entry.pendingSince : 0
      entry.debounceTimer = null
      entry.pendingSince = null
      if (entry.disposed) return
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_FS_WATCH_EVENT, {
        cwd: entry.cwd,
        pendingMs
      })
      this.fireListeners(entry.cwd, 'watcher')
    }, DEBOUNCE_MS)
  }

  private fireListeners(cwd: string, reason: 'watcher' | 'force' | 'lru' | 'manual'): void {
    for (const listener of this.listeners) {
      try {
        listener(cwd, reason)
      } catch {
        // Listener errors must not break the invalidation chain.
      }
    }
  }

  private evictIfOverLimit(): void {
    if (this.entries.size <= LRU_LIMIT) return
    // Drop oldest by lastTouchedAt. The eviction callback notifies listeners
    // so any cached entries for the dropped cwd are flushed proactively.
    const sorted = [...this.entries.values()].sort((a, b) => a.lastTouchedAt - b.lastTouchedAt)
    const victim = sorted[0]
    if (!victim) return
    this.fireListeners(victim.cwd, 'lru')
    this.unregisterWatch(victim.cwd)
  }
}

export const gitDiffCacheInvalidator = new GitDiffCacheInvalidator()
