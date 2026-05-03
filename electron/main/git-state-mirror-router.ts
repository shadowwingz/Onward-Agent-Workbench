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
  perfTraceLogger,
  isPerfTraceWorkerEvent,
  replayPerfTraceWorkerEvent,
  WORKER_TID
} from './perf-trace-logger'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { gitDiffCacheInvalidator } from './git-diff-cache-invalidator'
import type {
  MainToMirrorMessage,
  MirrorToMainMessage,
  MirrorState,
  MirrorDelta,
  MirrorFileBody
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
function canonicalise(rawCwd: string): string {
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

interface FileBodyPending {
  resolve: (body: MirrorFileBody | null) => void
  reject: (error: Error) => void
  startedAt: number
  cwd: string
  fileKey: string
}

const WORKER_REQUEST_TIMEOUT_MS = 30_000

class GitStateMirrorRouter {
  private worker: Worker | null = null
  private workerReady = false
  private respawnAttempt = 0

  /** webContents.id → set of subscribed cwds. */
  private subs = new Map<number, Set<string>>()
  /** cwd → subscriber count (>0 iff worker has attached its watcher). */
  private refCounts = new Map<string, number>()
  /** cwd → latest known snapshot, served immediately on new subscription. */
  private latest = new Map<string, MirrorState>()
  /** terminalId → last cwd pushed through OSC/native cwd detection. */
  private terminalCwds = new Map<string, string | null>()

  /** request-file-body reply correlation. */
  private nextReplyId = 1
  private pendingBodies = new Map<number, FileBodyPending>()

  init(_mainWindow: BrowserWindow): void {
    this.spawnWorker()
    this.registerIpcHandlers()
    this.registerWebContentsCleanup()
  }

  dispose(): void {
    if (this.worker) {
      try {
        this.postToWorker({ kind: 'shutdown' })
      } catch { /* ignore */ }
      this.worker.terminate().catch(() => { /* ignore */ })
      this.worker = null
    }
    this.subs.clear()
    this.refCounts.clear()
    this.latest.clear()
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
    this.worker.on('message', (msg: unknown) => {
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
    this.worker.on('error', (error) => {
      // Loud — anything that hits this is a true worker-thread exception
      // (uncaught throw, native module crash). Always log with the full
      // error and stack so the autotest log captures it.
      console.error('[GitStateMirrorRouter] worker error:', error, error?.stack)
    })
    this.worker.on('exit', (code) => {
      this.workerReady = false
      this.worker = null
      // Loud — every exit gets logged with the exit code and a stack
      // capture of the call site that observed the exit, so we can
      // distinguish "main posted shutdown via dispose()" from "worker
      // crashed silently". Without this, a single death between tests
      // is invisible until 5 in a row trip the giveup branch.
      console.error('[GitStateMirrorRouter] worker EXITED', { code, respawnAttempt: this.respawnAttempt, exitedAt: new Date().toISOString() })
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
      case 'mirror-update':
        this.latest.set(msg.cwd, msg.state)
        perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_FANOUT, {
          cwd: msg.cwd,
          subscriberCount: this.refCounts.get(msg.cwd) ?? 0,
          deltaKeys: Object.keys(msg.delta).filter((k) => k !== 'capturedAt')
        })
        this.fanout(msg.cwd, msg.delta)
        // Phase 2 (Codex review P1-1): drive the diff-cache invalidation
        // chain off the worker's authoritative mirror-update signal
        // instead of leaning on the main-process `git-diff-cache-
        // invalidator` fs.watch to detect `.git/**` changes. The worker
        // already (a) applied the .git event allowlist correctly, (b)
        // debounced via DEBOUNCE_MS, (c) computed a real `MirrorDelta`
        // via `computeDelta` — so by the time we get here, we KNOW
        // state actually changed (the worker only emits mirror-update
        // when delta has > capturedAt). That breaks the feedback loop
        // the cache invalidator's fs.watch was trapped in: our own
        // `git status` writes to `.git/index` no longer drive a
        // GitDiffViewer refetch chain that re-runs `git status`,
        // because the worker's `computeDelta` step short-circuits when
        // git status produces the same answer twice in a row.
        gitDiffCacheInvalidator.invalidate(msg.cwd, 'mirror')
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
      case 'log':
        if (msg.level === 'error') {
          console.error('[git-state-mirror-worker]', msg.message, msg.data ?? '')
        } else if (msg.level === 'warn') {
          console.warn('[git-state-mirror-worker]', msg.message, msg.data ?? '')
        } else if (process.env.ONWARD_DEBUG === '1') {
          console.log('[git-state-mirror-worker]', msg.message, msg.data ?? '')
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
      const newCwd = rawCwd ? canonicalise(rawCwd) : null
      const prevCwd = this.terminalCwds.get(terminalId) ?? null
      this.terminalCwds.set(terminalId, newCwd)
      perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_CWD_SWITCHED, {
        terminalId,
        prevCwd,
        nextCwd: newCwd
      })
      this.postToWorker({ kind: 'switch-cwd', terminalId, newCwd })
    })

    ipcMain.handle(IPC.GIT_STATE_MIRROR_REQUEST_FILE_BODY, (_event, rawCwd: string, fileKey: string, force: boolean) => {
      if (typeof rawCwd !== 'string' || !rawCwd) return null
      return this.requestFileBody(canonicalise(rawCwd), fileKey, Boolean(force))
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
  inspect(): { workerReady: boolean; subscribers: number; cwds: string[] } {
    return {
      workerReady: this.workerReady,
      subscribers: Array.from(this.subs.values()).reduce((acc, s) => acc + s.size, 0),
      cwds: Array.from(this.refCounts.keys())
    }
  }
}

export const gitStateMirrorRouter = new GitStateMirrorRouter()
