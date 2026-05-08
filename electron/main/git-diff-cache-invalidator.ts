/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'fs'
import { resolve } from 'path'
import { isMainThread } from 'worker_threads'
import * as parcelWatcher from '@parcel/watcher'
import { perfTraceLogger } from './perf-trace-logger'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

// Bug 2 — file-watcher driven Git Diff cache invalidator.
//
// `getGitDiff` keeps a request-level cache (`cwd::scope`) so rapid duplicate
// calls (mount → re-mount, multiple panels asking for the same root) do not
// re-spawn `git status`. The original 3-second TTL was time-based, which made
// the cache return stale data when files mutated between calls.
//
// This module pairs the cache with one Parcel watcher per active cwd so that ANY
// FS event under the cwd debounces (180 ms, matching ProjectTreeWatchManager)
// and invalidates the cached entries. The cache becomes correct-on-its-own
// when the watcher is healthy. The renderer-side `force=true` knob (used on
// subpage entry) is the deterministic backstop for the watcher-cold-boot
// window and native watcher edge cases.
//
// Cross-platform notes:
//  * macOS: Parcel uses FSEvents by default.
//  * Linux: Parcel uses inotify by default.
//  * Windows: Parcel uses ReadDirectoryChangesW by default.
// The active project cap bounds blast radius; watcher errors trigger an
// immediate cache invalidation plus a best-effort re-subscribe.

const DEBOUNCE_MS = 180
const RECENT_PROJECT_LIMIT = 8

export type GitDiffInvalidationReason =
  | 'watcher'
  | 'watcher-error'
  | 'force'
  | 'lru'
  | 'manual'
  | 'mirror'

export interface GitDiffWatcherHealthStats {
  backend: 'parcel'
  active: number
  maxProjects: number
  projects: Array<{
    cwd: string
    status: 'starting' | 'watching' | 'error' | 'disposed'
    eventCount: number
    resyncCount: number
    lastEventAt: number | null
    lastError: string | null
    pending: boolean
  }>
}

interface InvalidationListener {
  /**
   * `reason` provenance:
   *   - `watcher`  — main-process Parcel watcher fired.
   *   - `watcher-error` — Parcel watcher failed or dropped; listeners
   *                       must invalidate and re-fetch actively.
   *   - `force`    — explicit `invalidate(cwd, 'force')` from a caller.
   *   - `lru`      — entry evicted because RECENT_PROJECT_LIMIT was exceeded.
   *   - `manual`   — explicit `invalidate(cwd)` with default reason.
   *   - `mirror`   — GitStateMirror worker reported a real state delta
   *                  (its parcel-watcher is the authoritative event
   *                  source post-Phase 2; main fs.watch is now narrowed
   *                  to non-`.git` events as a redundant backstop).
   */
  (cwd: string, reason: GitDiffInvalidationReason): void
}

interface WatchEntry {
  cwd: string
  watcher: parcelWatcher.AsyncSubscription | null
  debounceTimer: NodeJS.Timeout | null
  restartTimer: NodeJS.Timeout | null
  pendingSince: number | null
  lastTouchedAt: number
  lastEventAt: number | null
  lastError: string | null
  status: 'starting' | 'watching' | 'error' | 'disposed'
  eventCount: number
  pendingEventCount: number
  resyncCount: number
  disposed: boolean
}

class GitDiffCacheInvalidator {
  private entries = new Map<string, WatchEntry>()
  private recentProjectQueue: string[] = []
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
      this.moveProjectToFront(normalized)
      return
    }
    if (!existsSync(normalized)) return

    const entry: WatchEntry = {
      cwd: normalized,
      watcher: null,
      debounceTimer: null,
      restartTimer: null,
      pendingSince: null,
      lastTouchedAt: Date.now(),
      lastEventAt: null,
      lastError: null,
      status: 'starting',
      eventCount: 0,
      pendingEventCount: 0,
      resyncCount: 0,
      disposed: false
    }
    this.entries.set(normalized, entry)
    this.moveProjectToFront(normalized)
    this.startParcelWatcher(entry)
    this.evictIfOverLimit()
  }

  unregisterWatch(cwd: string): void {
    const normalized = resolve(cwd)
    const entry = this.entries.get(normalized)
    if (!entry) return
    entry.disposed = true
    entry.status = 'disposed'
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer)
      entry.restartTimer = null
    }
    if (entry.watcher) {
      void entry.watcher.unsubscribe().catch(() => undefined)
      entry.watcher = null
    }
    this.entries.delete(normalized)
    const queueIndex = this.recentProjectQueue.indexOf(normalized)
    if (queueIndex >= 0) this.recentProjectQueue.splice(queueIndex, 1)
  }

  // External trigger for callers that already know the cache is stale (e.g.
  // a `force=true` request landed and we want to broadcast invalidation so any
  // sibling cwds rooted at the same superproject also drop their snapshot).
  invalidate(cwd: string, reason: 'force' | 'manual' | 'mirror' = 'manual'): void {
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
    this.recentProjectQueue.length = 0
  }

  inspectHealth(): GitDiffWatcherHealthStats {
    return {
      backend: 'parcel',
      active: this.entries.size,
      maxProjects: RECENT_PROJECT_LIMIT,
      projects: this.recentProjectQueue
        .map((cwd) => this.entries.get(cwd))
        .filter((entry): entry is WatchEntry => Boolean(entry))
        .map((entry) => ({
          cwd: entry.cwd,
          status: entry.status,
          eventCount: entry.eventCount,
          resyncCount: entry.resyncCount,
          lastEventAt: entry.lastEventAt,
          lastError: entry.lastError,
          pending: entry.debounceTimer !== null
        }))
    }
  }

  // --- private ---

  private startParcelWatcher(entry: WatchEntry): void {
    if (entry.disposed) return
    entry.status = 'starting'
    entry.lastError = null
    void parcelWatcher.subscribe(
      entry.cwd,
      (err, events) => {
        if (entry.disposed) return
        if (err) {
          this.handleWatcherError(entry, err)
          return
        }
        const visibleEvents = events.filter((event) => !this.isIgnoredGitPath(event.path))
        if (visibleEvents.length === 0) return
        this.handleRawEvent(entry, visibleEvents.length)
      },
      { ignore: ['**/.git/**'] }
    ).then((subscription) => {
      if (entry.disposed) {
        void subscription.unsubscribe().catch(() => undefined)
        return
      }
      entry.watcher = subscription
      entry.status = 'watching'
      entry.lastError = null
    }).catch((error) => {
      this.handleWatcherError(entry, error)
    })
  }

  private handleWatcherError(entry: WatchEntry, error: unknown): void {
    if (entry.disposed) return
    entry.status = 'error'
    entry.lastError = error instanceof Error ? error.message : String(error)
    entry.resyncCount += 1
    this.fireListeners(entry.cwd, 'watcher-error')
    this.scheduleWatcherRestart(entry)
  }

  private scheduleWatcherRestart(entry: WatchEntry): void {
    if (entry.disposed || entry.restartTimer) return
    if (entry.watcher) {
      void entry.watcher.unsubscribe().catch(() => undefined)
      entry.watcher = null
    }
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null
      this.startParcelWatcher(entry)
    }, 500)
    entry.restartTimer.unref?.()
  }

  private isIgnoredGitPath(pathValue: string): boolean {
    const normalised = pathValue.replace(/\\/g, '/')
    return normalised.includes('/.git/') || normalised.endsWith('/.git')
  }

  private handleRawEvent(entry: WatchEntry, eventCount: number): void {
    if (entry.disposed) return
    entry.eventCount += eventCount
    entry.pendingEventCount += eventCount
    entry.lastEventAt = Date.now()
    if (entry.debounceTimer) return // already in a debounce window
    entry.pendingSince = Date.now()
    entry.debounceTimer = setTimeout(() => {
      const pendingMs = entry.pendingSince !== null ? Date.now() - entry.pendingSince : 0
      const batchedEvents = entry.pendingEventCount
      entry.debounceTimer = null
      entry.pendingSince = null
      entry.pendingEventCount = 0
      if (entry.disposed) return
      perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_FS_WATCH_EVENT, {
        cwd: entry.cwd,
        pendingMs,
        backend: 'parcel',
        eventCount: batchedEvents
      })
      this.fireListeners(entry.cwd, 'watcher')
    }, DEBOUNCE_MS)
    entry.debounceTimer.unref?.()
  }

  private fireListeners(cwd: string, reason: GitDiffInvalidationReason): void {
    for (const listener of this.listeners) {
      try {
        listener(cwd, reason)
      } catch {
        // Listener errors must not break the invalidation chain.
      }
    }
  }

  private evictIfOverLimit(): void {
    while (this.recentProjectQueue.length > RECENT_PROJECT_LIMIT) {
      const victim = this.recentProjectQueue.pop()
      if (!victim) return
      this.fireListeners(victim, 'lru')
      this.unregisterWatch(victim)
    }
  }

  private moveProjectToFront(cwd: string): void {
    const existingIndex = this.recentProjectQueue.indexOf(cwd)
    if (existingIndex >= 0) this.recentProjectQueue.splice(existingIndex, 1)
    this.recentProjectQueue.unshift(cwd)
  }
}

export const gitDiffCacheInvalidator = new GitDiffCacheInvalidator()
