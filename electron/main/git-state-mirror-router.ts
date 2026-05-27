/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitStateMirrorRouter — main-process thin pub/sub bridge between Worker
 * Thread (`git-state-mirror-worker-entry.ts`) and renderer subscribers.
 *
 * Holds **no** mirror state of its own beyond the latest snapshot per cwd
 * (so a freshly-subscribed renderer receives the current value without a
 * round-trip through the worker). All recompute work happens in the worker;
 * router only routes.
 *
 * Subscribers are addressed by `webContents.id`. When a renderer process
 * is gone we drop its subscription set; if the cwd's last subscriber is
 * dropped we tell the worker to detach the watcher to keep our parcel-
 * watcher count bounded.
 */

import { Worker } from 'worker_threads'
import { join, resolve as resolvePath } from 'path'
import { realpathSync } from 'fs'
import { homedir } from 'os'
import { ipcMain, webContents, type BrowserWindow } from 'electron'

import { IPC } from '../shared/ipc-channels'
import {
  performanceTrace,
  isPerfTraceWorkerEvent,
  replayPerfTraceWorkerEvent,
  WORKER_TID
} from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { gitDiffCacheInvalidator } from './git-diff-cache-invalidator'
import { resolveExistingTerminalCwd } from './terminal-cwd-validation'
import type {
  MainToMirrorMessage,
  MirrorToMainMessage,
  MirrorState,
  MirrorDelta,
  MirrorFileBody,
  MirrorWatcherStatus
} from './git-state-mirror-types'

/**
 * Canonicalise a renderer-supplied cwd to its on-disk truth, so two
 * raw forms that point at the same physical directory map to the same
 * key. Critical on macOS where the system tmpdir is `/var/folders/...`
 * (a symlink) AND `/private/var/folders/...` (the realpath target):
 *   - Renderer's OSC parser pushes the `/var/...` form (mktemp output)
 *   - Renderer's legacy git polling supplies `/private/var/...` (because
 *     the syscall path `proc_pidinfo` returns realpath-resolved paths)
 *   - `path.resolve` does NOT follow symlinks, so it leaves both forms
 *     intact → router and worker would create two entries (and two
 *     parcel-watcher subscriptions) for the same physical repo, which
 *     destabilised the watcher in the GSM autotest.
 *
 * `realpathSync` follows every symlink in the chain and lands on the
 * canonical form. When the path doesn't exist (rare — usually just a
 * race against fixture cleanup) we fall back to `path.resolve` so the
 * caller still gets a stable string identity. The fallback case can in
 * theory leak a subscription if the path is later realpath-resolvable
 * because subscribe and unsubscribe would compute different canonical
 * forms; we accept that tiny edge case (it was already broken with the
 * pure-`path.resolve` baseline in a different way).
 */
export function canonicaliseMirrorCwd(rawCwd: string): string {
  const expanded = rawCwd === '~'
    ? homedir()
    : rawCwd.startsWith('~/') || rawCwd.startsWith('~\\')
      ? join(homedir(), rawCwd.slice(2))
      : rawCwd
  try {
    return realpathSync(expanded)
  } catch {
    return resolvePath(expanded)
  }
}

function canonicalise(rawCwd: string): string {
  return canonicaliseMirrorCwd(rawCwd)
}

interface FileBodyPending {
  resolve: (body: MirrorFileBody | null) => void
  reject: (error: Error) => void
  startedAt: number
  cwd: string
  fileKey: string
}

const WORKER_REQUEST_TIMEOUT_MS = 30_000
const WORKER_SHUTDOWN_TIMEOUT_MS = 5_000

type MirrorUpdateListener = (cwd: string, state: MirrorState, delta: MirrorDelta) => void
type CwdChangeListener = (terminalId: string, prevCwd: string | null, nextCwd: string | null) => void

class GitStateMirrorRouter {
  private worker: Worker | null = null
  private workerReady = false
  private respawnAttempt = 0
  private disposingWorkers = new WeakSet<Worker>()
  private workerShutdownTimers = new WeakMap<Worker, ReturnType<typeof setTimeout>>()
  private workerShutdownStartedAt = new WeakMap<Worker, number>()
  private workerShutdownTimedOut = new WeakSet<Worker>()
  private disposePromise: Promise<void> | null = null

  /** webContents.id → set of subscribed cwds. */
  private subs = new Map<number, Set<string>>()
  /** cwd → subscriber count (>0 iff worker has attached its watcher). */
  private refCounts = new Map<string, number>()
  /** cwd → latest known snapshot, served immediately on new subscription. */
  private latest = new Map<string, MirrorState>()
  /** cwd → latest watcher supervisor health, exposed to renderers/autotests. */
  private watcherStatuses = new Map<string, MirrorWatcherStatus>()
  /** terminalId → last cwd pushed through OSC/native cwd detection. */
  private terminalCwds = new Map<string, string | null>()

  /** Main-process subscribers (e.g. terminal-git-info-bridge). */
  private mirrorUpdateListeners = new Set<MirrorUpdateListener>()
  private cwdChangeListeners = new Set<CwdChangeListener>()

  /** request-file-body reply correlation. */
  private nextReplyId = 1
  private pendingBodies = new Map<number, FileBodyPending>()

  init(_mainWindow: BrowserWindow): void {
    this.spawnWorker()
    this.registerIpcHandlers()
    this.registerWebContentsCleanup()
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      this.clearLocalState()
      return this.disposePromise
    }
    const worker = this.worker
    this.clearLocalState()
    if (!worker) return Promise.resolve()

    this.disposingWorkers.add(worker)
    this.workerShutdownStartedAt.set(worker, Date.now())
    this.worker = null
    this.workerReady = false

    let timer: ReturnType<typeof setTimeout> | null = null
    const exitPromise = new Promise<void>((resolve) => {
      worker.once('exit', () => {
        if (timer) clearTimeout(timer)
        resolve()
      })
      timer = setTimeout(() => {
        this.workerShutdownTimedOut.add(worker)
        worker.terminate().catch(() => { /* ignore */ })
      }, WORKER_SHUTDOWN_TIMEOUT_MS)
      timer.unref?.()
      this.workerShutdownTimers.set(worker, timer)
    })

    try {
      worker.postMessage({ kind: 'shutdown' } satisfies MainToMirrorMessage)
    } catch {
      worker.terminate().catch(() => { /* ignore */ })
    }
    worker.unref()

    const disposePromise = exitPromise.finally(() => {
      if (this.disposePromise === disposePromise) {
        this.disposePromise = null
      }
    })
    this.disposePromise = disposePromise
    return disposePromise
  }

  private clearLocalState(): void {
    this.subs.clear()
    this.refCounts.clear()
    this.latest.clear()
    this.watcherStatuses.clear()
    this.terminalCwds.clear()
    for (const [, pending] of this.pendingBodies) {
      pending.reject(new Error('GitStateMirrorRouter disposed'))
    }
    this.pendingBodies.clear()
  }

  // ---------------------------------------------------------------------
  // Worker lifecycle (with auto-respawn for GSM-31)
  // ---------------------------------------------------------------------

  private spawnWorker(): void {
    const workerPath = join(__dirname, 'git-state-mirror-worker-entry.js')
    this.workerReady = false
    try {
      this.worker = new Worker(workerPath)
    } catch (error) {
      console.error('[GitStateMirrorRouter] failed to spawn worker:', error)
      this.worker = null
      return
    }
    const worker = this.worker
    worker.on('message', (msg: unknown) => {
      // Worker → main perf-trace forwarding lands on the dedicated tid
      // lane so Perfetto UI shows "git-state-mirror-worker" as its own row
      // (matches the convention used by git-ipc-worker / ripgrep-search).
      if (isPerfTraceWorkerEvent(msg)) {
        replayPerfTraceWorkerEvent(msg, {
          tid: WORKER_TID.GIT_STATE_MIRROR,
          threadName: 'git-state-mirror-worker'
        })
        return
      }
      this.handleWorkerMessage(msg as MirrorToMainMessage)
    })
    worker.on('error', (error) => {
      // Loud — anything that hits this is a true worker-thread exception
      // (uncaught throw, native module crash). Always log with the full
      // error and stack so the autotest log captures it.
      console.error('[GitStateMirrorRouter] worker error:', error, error?.stack)
    })
    worker.on('exit', (code) => {
      const shutdownTimer = this.workerShutdownTimers.get(worker)
      if (shutdownTimer) clearTimeout(shutdownTimer)
      this.workerShutdownTimers.delete(worker)

      const wasDisposing = this.disposingWorkers.delete(worker)
      const shutdownStartedAt = this.workerShutdownStartedAt.get(worker)
      this.workerShutdownStartedAt.delete(worker)
      const shutdownTimedOut = this.workerShutdownTimedOut.delete(worker)
      if (wasDisposing && shutdownStartedAt !== undefined) {
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_WORKER_SHUTDOWN, {
          code,
          result: shutdownTimedOut
            ? 'terminated-after-timeout'
            : code === 0 ? 'clean-exit' : 'nonzero-exit',
          durationMs: Date.now() - shutdownStartedAt
        })
      }
      if (this.worker === worker) {
        this.workerReady = false
        this.worker = null
      }
      // Loud — every exit gets logged with the exit code and a stack
      // capture of the call site that observed the exit, so we can
      // distinguish "main posted shutdown via dispose()" from "worker
      // crashed silently". Without this, a single death between tests
      // is invisible until 5 in a row trip the giveup branch.
      console.error('[GitStateMirrorRouter] worker EXITED', { code, respawnAttempt: this.respawnAttempt, exitedAt: new Date().toISOString() })
      if (wasDisposing || this.worker !== null) {
        return
      }
      // Reject every pending file-body request — the renderer will retry.
      for (const [, pending] of this.pendingBodies) {
        pending.reject(new Error(`mirror worker exited (code=${code}) before reply`))
      }
      this.pendingBodies.clear()
      // Respawn with a tiny back-off; clamp to 5 retries before giving up
      // (consumers fall back to manual refresh until the next entry).
      if (this.respawnAttempt >= 5) {
        console.error('[GitStateMirrorRouter] worker exited 5 times in a row; giving up')
        return
      }
      this.respawnAttempt += 1
      setTimeout(() => {
        if (this.worker) return
        this.spawnWorker()
        this.reattachAllAfterRespawn()
      }, Math.min(2000, 100 * this.respawnAttempt))
    })
  }

  private reattachAllAfterRespawn(): void {
    // Re-subscribe every cwd that still has subscribers. The new worker
    // starts empty — we replay attach-watch so it rebuilds its state.
    for (const cwd of this.refCounts.keys()) {
      this.postToWorker({ kind: 'attach-watch', cwd })
    }
  }

  private handleWorkerMessage(msg: MirrorToMainMessage): void {
    switch (msg.kind) {
      case 'ready':
        this.workerReady = true
        this.respawnAttempt = 0
        return
      case 'shutdown-complete':
        return
      case 'mirror-update':
        this.latest.set(msg.cwd, msg.state)
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_FANOUT, {
          cwd: msg.cwd,
          subscriberCount: this.refCounts.get(msg.cwd) ?? 0,
          deltaKeys: Object.keys(msg.delta).filter((k) => k !== 'capturedAt')
        })
        this.fanout(msg.cwd, msg.delta)
        // Notify main-process listeners (e.g. terminal-git-info-bridge).
        for (const listener of this.mirrorUpdateListeners) {
          try {
            listener(msg.cwd, msg.state, msg.delta)
          } catch (error) {
            console.warn('[GitStateMirrorRouter] mirror-update listener threw:', error)
          }
        }
        // Phase 2 (Codex review P1-1): drive the diff-cache invalidation
        // chain off the worker's authoritative mirror-update signal
        // instead of leaning on a main-process `git-diff-cache-
        // invalidator` watcher to detect `.git/**` changes. The worker
        // already (a) applied the .git event allowlist correctly, (b)
        // debounced via DEBOUNCE_MS, (c) computed a real `MirrorDelta`
        // via `computeDelta` — so by the time we get here, we KNOW
        // state actually changed (the worker only emits mirror-update
        // when delta has > capturedAt). That breaks the feedback loop
        // the old cache invalidator watcher was trapped in: our own
        // `git status` writes to `.git/index` no longer drive a
        // GitDiffViewer refetch chain that re-runs `git status`,
        // because the worker's `computeDelta` step short-circuits when
        // git status produces the same answer twice in a row.
        for (const invalidateCwd of new Set([msg.cwd, msg.state.repoRoot].filter(Boolean) as string[])) {
          gitDiffCacheInvalidator.invalidate(invalidateCwd, 'mirror')
        }
        return
      case 'file-body-update': {
        const pending = this.pendingBodies.get(msg.replyId)
        if (!pending) return
        this.pendingBodies.delete(msg.replyId)
        if (msg.error && !msg.body) {
          pending.reject(new Error(msg.error))
        } else {
          pending.resolve(msg.body)
        }
        return
      }
      case 'watcher-status':
        this.watcherStatuses.set(msg.status.cwd, msg.status)
        if (
          process.env.ONWARD_DEBUG === '1' ||
          msg.status.health === 'degraded-polling' ||
          msg.status.health === 'suspended' ||
          msg.status.health === 'failed'
        ) {
          console.log('[GitStateMirrorRouter] watcher-status', {
            cwd: msg.status.cwd,
            repoRoot: msg.status.repoRoot,
            health: msg.status.health,
            failureKind: msg.status.failureKind,
            failureCount: msg.status.failureCount,
            polling: msg.status.polling
          })
        }
        this.fanoutWatcherStatus(msg.status)
        return
      case 'log':
        if (msg.level === 'error') {
          console.error('[git-state-mirror-worker]', msg.message, msg.data ?? '')
        } else if (msg.level === 'warn') {
          console.warn('[git-state-mirror-worker]', msg.message, msg.data ?? '')
        } else if (process.env.ONWARD_DEBUG === '1') {
          console.log('[git-state-mirror-worker]', msg.message, msg.data ?? '')
        }
        return
      case 'watcher-error':
        // Phase 5: surface FS-watcher failure to all renderers as an
        // explicit banner-eligible event. No silent retry / polling.
        console.error('[GitStateMirrorRouter] watcher-error', { cwd: msg.cwd, message: msg.message })
        gitDiffCacheInvalidator.notifyWatcherError(msg.cwd)
        for (const [wcId] of this.subs) {
          const wc = webContents.fromId(wcId)
          if (!wc || wc.isDestroyed()) continue
          try {
            wc.send(IPC.GIT_STATE_MIRROR_WATCHER_ERROR, msg.cwd, msg.message)
          } catch (error) {
            console.warn('[GitStateMirrorRouter] watcher-error send failed:', error)
          }
        }
        return
      default: {
        const exhaustive: never = msg
        console.warn('[GitStateMirrorRouter] unknown msg kind', (exhaustive as { kind?: string })?.kind)
      }
    }
  }

  private postToWorker(msg: MainToMirrorMessage): void {
    if (!this.worker) return
    try {
      this.worker.postMessage(msg)
    } catch (error) {
      console.error('[GitStateMirrorRouter] postMessage failed:', error)
    }
  }

  // ---------------------------------------------------------------------
  // IPC plumbing (renderer ↔ router)
  // ---------------------------------------------------------------------

  private registerIpcHandlers(): void {
    ipcMain.handle(IPC.GIT_STATE_MIRROR_SUBSCRIBE, (event, rawCwd: string) => {
      if (typeof rawCwd !== 'string' || !rawCwd) return null
      // Use realpath canonicalisation (not path.resolve) so symlinked
      // forms like `/var/...` and `/private/var/...` collapse to the
      // same key. See `canonicalise()` for the full rationale.
      const cwd = canonicalise(rawCwd)
      const wcId = event.sender.id
      let set = this.subs.get(wcId)
      if (!set) {
        set = new Set()
        this.subs.set(wcId, set)
      }
      const wasNew = !set.has(cwd)
      set.add(cwd)
      if (wasNew) {
        const next = (this.refCounts.get(cwd) ?? 0) + 1
        this.refCounts.set(cwd, next)
        if (next === 1) this.postToWorker({ kind: 'attach-watch', cwd })
      }
      return this.latest.get(cwd) ?? null
    })

    ipcMain.on(IPC.GIT_STATE_MIRROR_UNSUBSCRIBE, (event, rawCwd: string) => {
      if (typeof rawCwd !== 'string' || !rawCwd) return
      this.dropSubscription(event.sender.id, canonicalise(rawCwd))
    })

    ipcMain.handle(IPC.GIT_STATE_MIRROR_GET, (_event, rawCwd: string) => {
      if (typeof rawCwd !== 'string' || !rawCwd) return null
      return this.latest.get(canonicalise(rawCwd)) ?? null
    })

    ipcMain.on(IPC.GIT_STATE_PUSH_CWD, (_event, terminalId: string, rawCwd: string | null) => {
      this.pushTerminalCwd(terminalId, rawCwd)
    })

    ipcMain.handle(IPC.GIT_STATE_MIRROR_REQUEST_FILE_BODY, (_event, rawCwd: string, fileKey: string, force: boolean) => {
      if (typeof rawCwd !== 'string' || !rawCwd) return null
      return this.requestFileBody(canonicalise(rawCwd), fileKey, Boolean(force))
    })

    // Phase 5 PART 2: Refresh Changes — renderer triggers a full
    // recompute + identity bump. Idempotent; safe to call repeatedly.
    ipcMain.handle(IPC.GIT_STATE_MIRROR_FORCE_REFRESH, (_event, rawCwd: string) => {
      if (typeof rawCwd !== 'string' || !rawCwd) return false
      this.internalForceRecompute(rawCwd)
      return true
    })
  }

  private requestFileBody(cwd: string, fileKey: string, force: boolean): Promise<MirrorFileBody | null> {
    return new Promise<MirrorFileBody | null>((resolveCb, rejectCb) => {
      const replyId = this.nextReplyId++
      const startedAt = Date.now()
      const pending: FileBodyPending = { resolve: resolveCb, reject: rejectCb, startedAt, cwd, fileKey }
      this.pendingBodies.set(replyId, pending)
      this.postToWorker({ kind: 'request-file-body', cwd, fileKey, force, replyId })
      setTimeout(() => {
        if (this.pendingBodies.delete(replyId)) {
          rejectCb(new Error(`request-file-body timed out after ${WORKER_REQUEST_TIMEOUT_MS}ms (cwd=${cwd}, fileKey=${fileKey})`))
        }
      }, WORKER_REQUEST_TIMEOUT_MS)
    })
  }

  private dropSubscription(wcId: number, cwd: string): void {
    const set = this.subs.get(wcId)
    if (!set || !set.has(cwd)) return
    set.delete(cwd)
    if (set.size === 0) this.subs.delete(wcId)
    const next = (this.refCounts.get(cwd) ?? 1) - 1
    if (next <= 0) {
      this.refCounts.delete(cwd)
      // Intentionally KEEP `this.latest.get(cwd)` here. A rapid resubscribe
      // (cd-burst pattern, terminal-grid cwd-flip, etc.) within the same
      // session expects to receive the last-known snapshot synchronously
      // from `subscribeMirror`'s return value. Worker still detaches its
      // parcel-watcher and a fresh recompute will overwrite this cache
      // when the next subscriber attaches. Memory cost is bounded by
      // distinct cwds visited per session.
      this.postToWorker({ kind: 'detach-watch', cwd })
    } else {
      this.refCounts.set(cwd, next)
    }
  }

  private fanout(cwd: string, delta: MirrorDelta): void {
    for (const [wcId, cwdSet] of this.subs) {
      if (!cwdSet.has(cwd)) continue
      const wc = webContents.fromId(wcId)
      if (!wc || wc.isDestroyed()) continue
      try {
        wc.send(IPC.GIT_STATE_MIRROR_UPDATE, cwd, delta)
      } catch (error) {
        console.warn('[GitStateMirrorRouter] fanout send failed:', error)
      }
    }
  }

  private fanoutWatcherStatus(status: MirrorWatcherStatus): void {
    for (const [wcId, cwdSet] of this.subs) {
      if (!cwdSet.has(status.cwd)) continue
      const wc = webContents.fromId(wcId)
      if (!wc || wc.isDestroyed()) continue
      try {
        wc.send(IPC.GIT_STATE_MIRROR_WATCHER_STATUS, status)
      } catch (error) {
        console.warn('[GitStateMirrorRouter] watcher-status send failed:', error)
      }
    }
  }

  /**
   * Drop subscriptions belonging to a webContents that has been destroyed
   * (renderer reload, window close, terminal-tab close). Without this every
   * crash-and-reload would leak a watcher in the worker.
   */
  private registerWebContentsCleanup(): void {
    const handle = (wc: Electron.WebContents) => {
      wc.on('destroyed', () => {
        const set = this.subs.get(wc.id)
        if (!set) return
        for (const cwd of Array.from(set)) {
          this.dropSubscription(wc.id, cwd)
        }
      })
    }
    // Hook every existing + future webContents.
    for (const wc of webContents.getAllWebContents()) handle(wc)
    const onCreate = (_event: Electron.Event, wc: Electron.WebContents) => handle(wc)
    require('electron').app.on('web-contents-created', onCreate)
  }

  /** Test hook for autotest — read-only. */
  inspect(): { workerReady: boolean; subscribers: number; cwds: string[]; watcherStatuses: MirrorWatcherStatus[] } {
    return {
      workerReady: this.workerReady,
      subscribers: Array.from(this.subs.values()).reduce((acc, s) => acc + s.size, 0),
      cwds: Array.from(this.refCounts.keys()),
      watcherStatuses: Array.from(this.watcherStatuses.values())
    }
  }

  // ---------------------------------------------------------------------
  // Main-process API for in-process subscribers (terminal-git-info-bridge,
  // future Authority bridges). Same ref-count semantics as the IPC path
  // but bypasses the per-webContents tracking.
  // ---------------------------------------------------------------------

  /**
   * Subscribe to a cwd from main process. Returns the latest known
   * snapshot (or null if none yet — the worker will compute one and
   * deliver via the mirror-update listener path).
   */
  internalSubscribe(rawCwd: string): MirrorState | null {
    if (!rawCwd) return null
    const cwd = canonicalise(rawCwd)
    const next = (this.refCounts.get(cwd) ?? 0) + 1
    this.refCounts.set(cwd, next)
    if (next === 1) this.postToWorker({ kind: 'attach-watch', cwd })
    return this.latest.get(cwd) ?? null
  }

  /** Symmetric unsubscribe; sends detach-watch when refCount hits 0. */
  internalUnsubscribe(rawCwd: string): void {
    if (!rawCwd) return
    const cwd = canonicalise(rawCwd)
    const next = (this.refCounts.get(cwd) ?? 1) - 1
    if (next <= 0) {
      this.refCounts.delete(cwd)
      this.postToWorker({ kind: 'detach-watch', cwd })
    } else {
      this.refCounts.set(cwd, next)
    }
  }

  /**
   * Force a recompute for an attached cwd. Use sparingly — this is the
   * "Refresh Changes" / focus-resync path. Pure event-driven (the call
   * itself IS the event), not a polled retry.
   */
  internalForceRecompute(rawCwd: string): void {
    if (!rawCwd) return
    const cwd = canonicalise(rawCwd)
    if (!this.refCounts.has(cwd)) return
    this.postToWorker({ kind: 'focus-resync', cwd })
  }

  /** Read-only access to the last-pushed cwd for a terminal (for bridge cold-start). */
  getTerminalCwd(terminalId: string): string | null {
    return this.terminalCwds.get(terminalId) ?? null
  }

  canonicaliseCwd(rawCwd: string): string {
    return canonicalise(rawCwd)
  }

  pushTerminalCwd(terminalId: string, rawCwd: string | null): void {
    if (typeof terminalId !== 'string' || !terminalId) return
    const newCwd = rawCwd ? resolveExistingTerminalCwd(rawCwd) : null
    if (rawCwd && !newCwd) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_CWD_IGNORED, {
        terminalId,
        reason: 'invalid-cwd',
        rawCwd: rawCwd.slice(0, 512)
      })
      return
    }
    const prevCwd = this.terminalCwds.get(terminalId) ?? null
    this.terminalCwds.set(terminalId, newCwd)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_CWD_SWITCHED, {
      terminalId,
      prevCwd,
      nextCwd: newCwd
    })
    this.postToWorker({ kind: 'switch-cwd', terminalId, newCwd })
    // Notify main-process listeners after worker is informed so the
    // bridge can swap its mirror subscription onto the new cwd.
    for (const listener of this.cwdChangeListeners) {
      try {
        listener(terminalId, prevCwd, newCwd)
      } catch (error) {
        console.warn('[GitStateMirrorRouter] cwd-change listener threw:', error)
      }
    }
  }

  /** Read-only access to the last-known snapshot for a cwd. */
  getLatest(rawCwd: string): MirrorState | null {
    if (!rawCwd) return null
    return this.latest.get(canonicalise(rawCwd)) ?? null
  }

  /** Register a listener for mirror-update events. Returns dispose fn. */
  onMirrorUpdate(listener: MirrorUpdateListener): () => void {
    this.mirrorUpdateListeners.add(listener)
    return () => { this.mirrorUpdateListeners.delete(listener) }
  }

  /** Register a listener for terminal cwd-change events (PUSH_CWD). */
  onCwdChange(listener: CwdChangeListener): () => void {
    this.cwdChangeListeners.add(listener)
    return () => { this.cwdChangeListeners.delete(listener) }
  }
}

export const gitStateMirrorRouter = new GitStateMirrorRouter()
