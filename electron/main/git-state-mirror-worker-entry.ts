/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitStateMirror Worker Thread entry.
 *
 * Owns the per-cwd `MirrorState` map, an `@parcel/watcher` subscription per
 * active cwd, a per-file body cache keyed by stat-token, and the
 * `recomputeStatus` machinery that drives delta emission. Lives entirely
 * off the main thread per the CLAUDE.md "Renderer scheduling and input
 * responsiveness" hard rule (terminal parsing, Git work, project search,
 * DOM sanitization, large diff processing must NOT block input).
 *
 * Skeleton (commit 3): wire postMessage protocol, log everything, no real
 * work yet. Subsequent commits flesh out:
 *   commit 4 — `@parcel/watcher` subscribe + .git whitelist filter.
 *   commit 5 — port `gitRepositorySnapshotService` + `loadGitDiff` here;
 *              implement statToken-aware per-file body cache.
 *   commit 6 — recompute → delta computation against previous snapshot.
 *   commit 7 — focus-resync handler.
 *   commit 9 — switch-cwd handler reads through to attachWatch.
 */

import { parentPort, isMainThread } from 'worker_threads'
import { resolve } from 'path'
import { subscribe as parcelSubscribe, type AsyncSubscription } from '@parcel/watcher'

import { perfTraceLogger } from './perf-trace-logger'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import {
  getGitBranchAndStatus,
  getGitDiff,
  getGitRepoMeta
} from './git-utils'
import { basename } from 'path'
import type {
  MainToMirrorMessage,
  MirrorToMainMessage,
  MirrorState,
  MirrorDelta
} from './git-state-mirror-types'

if (isMainThread) {
  // Defensive: this entry is meant to be loaded only by `new Worker(<this file>)`.
  throw new Error('git-state-mirror-worker-entry must run in a Worker Thread')
}

interface WorkerEntry {
  /**
   * Subscription key — the canonical (path-resolved) form of the cwd the
   * renderer subscribed against. This is what we emit in `mirror-update`
   * messages and what `entries` is keyed by, so the router and renderer
   * can reconcile state.
   */
  cwd: string
  /**
   * The path parcel-watcher is actually subscribed to. When `cwd` is inside
   * a git repo this is the repo root (so we catch `.git/index`, refs/**,
   * and sibling-directory file changes that don't fall under `cwd`'s subtree).
   * For non-git terminal cwds it falls back to `cwd`. Tracked separately so
   * `classifyEventPath` can compute event paths relative to the actual
   * watched root rather than to `cwd`.
   */
  watchedRoot: string
  state: MirrorState | null
  watcherDispose: (() => Promise<void>) | null
  /**
   * In-flight attach guard. Set the moment attachWatch starts, cleared once
   * `parcelSubscribe` resolves and `watcherDispose` is installed. Without
   * this, a `switch-cwd` IPC and an `attach-watch` IPC arriving for the
   * same cwd in rapid succession (the renderer fires both: `pushCwd` →
   * switch-cwd, and `subscribeMirror` → attach-watch — the IPCs race in
   * the worker's message queue) both pass the `if (entry.watcherDispose)`
   * guard, log a duplicate `attach-watch:begin`, and start two parallel
   * `parcelSubscribe` calls for the same path. The result was two parcel-
   * watchers per repo, double the cold-attach cost (≈ 2 × 500 ms = 1 s
   * matching the GSM-09a sample tail), and a leaked watcher on the first
   * subscription handle that nothing ever calls `unsubscribe` on.
   */
  attachInFlight: boolean
  /** Trailing-edge debounce timer for coalesced fs events. */
  debounceTimer: NodeJS.Timeout | null
  /** Window opening timestamp for the current debounce. */
  pendingSince: number | null
  /** Reasons accumulated during the debounce — drives the recompute reason. */
  pendingPaths: Set<string>
  // commit 5: `Map<fileKey, MirrorFileBody>` for per-file diff bodies.
}

const entries = new Map<string, WorkerEntry>()

const DEBOUNCE_MS = 150

/**
 * .git event filter — used by `attachWatch` to decide whether a parcel-
 * watcher event should fire a recompute. Whitelist intent: catch user-
 * driven git operations (commit / checkout / stage) without burning a
 * recompute on every `.git/index.lock` create + delete pair we ourselves
 * triggered by running git status.
 *
 * @returns reason string ('gitObjects' / 'lockfile' / 'tmpfile' /
 *   'gitInternal') if the event should be dropped, or null if it should
 *   fire the watcher pipeline.
 */
export function classifyEventPath(eventPath: string, watchedRoot: string): {
  drop: boolean
  reason: 'gitObjects' | 'lockfile' | 'tmpfile' | 'gitInternal' | 'allowed'
} {
  const normWatched = watchedRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const normEvent = eventPath.replace(/\\/g, '/')
  const rel = normEvent.startsWith(normWatched + '/')
    ? normEvent.slice(normWatched.length + 1)
    : normEvent

  // Filter common transient artefacts regardless of whether they live under .git/
  if (rel.endsWith('.lock')) return { drop: true, reason: 'lockfile' }
  if (/(?:^|\/)\.tmp_/.test(rel)) return { drop: true, reason: 'tmpfile' }
  if (/~\d+$/.test(rel)) return { drop: true, reason: 'tmpfile' }

  if (rel === '.git' || rel.startsWith('.git/')) {
    if (rel.startsWith('.git/objects/')) return { drop: true, reason: 'gitObjects' }
    if (
      rel === '.git/HEAD' ||
      rel === '.git/ORIG_HEAD' ||
      rel === '.git/MERGE_HEAD' ||
      rel === '.git/CHERRY_PICK_HEAD' ||
      rel === '.git/REBASE_HEAD' ||
      rel === '.git/index' ||
      rel === '.git/packed-refs' ||
      rel === '.git/config' ||
      rel.startsWith('.git/refs/') ||
      rel.startsWith('.git/rebase-')
    ) {
      return { drop: false, reason: 'allowed' }
    }
    return { drop: true, reason: 'gitInternal' }
  }

  return { drop: false, reason: 'allowed' }
}

function log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
  const out: MirrorToMainMessage = { kind: 'log', level, message, data }
  parentPort?.postMessage(out)
}

function ensureEntry(cwd: string): WorkerEntry {
  const key = resolve(cwd)
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      cwd: key,
      // Default watchedRoot to the cwd itself; attachWatch upgrades it to
      // the repo root the first time it resolves git metadata. Storing a
      // sensible fallback up front keeps `classifyEventPath` correct even
      // if attachWatch fails before assigning the upgraded value.
      watchedRoot: key,
      state: null,
      watcherDispose: null,
      attachInFlight: false,
      debounceTimer: null,
      pendingSince: null,
      pendingPaths: new Set()
    }
    entries.set(key, entry)
  }
  return entry
}

function fireWatcherEvent(payload: Record<string, unknown>): void {
  perfTraceLogger.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_FIRE, payload)
}

function fireWatcherFiltered(payload: Record<string, unknown>): void {
  perfTraceLogger.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_FILTERED, payload)
}

function flushDebounce(entry: WorkerEntry): void {
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer)
    entry.debounceTimer = null
  }
  if (entry.pendingPaths.size === 0) return
  const reason = entry.pendingSince !== null ? 'watcher' : 'manual'
  entry.pendingPaths.clear()
  entry.pendingSince = null
  void recomputeStatus(entry, reason)
}

/**
 * Single-source-of-truth recompute. Runs `git rev-parse` (via getGitRepoMeta)
 * + `git status --porcelain=v2 -z --branch` (via getGitBranchAndStatus) +
 * `git status` for the file list (via getGitDiff). Computes a `MirrorDelta`
 * vs. `entry.state` and posts a mirror-update message when anything changed.
 *
 * Wrapped in a duration trace event so Perfetto can show "recompute did X
 * ms because reason=Y" — drives the GSM-10 / GSM-11 latency assertions.
 */
async function recomputeStatus(entry: WorkerEntry, reason: string): Promise<void> {
  const startedAt = Date.now()
  let repoRoot: string | null = null
  let repoName: string | null = null
  let branch: string | null = null
  let status: MirrorState['status'] = null
  let files: MirrorState['files'] = []
  let repos: MirrorState['repos'] = undefined
  let submodulesLoading: boolean | undefined = undefined

  try {
    const meta = await getGitRepoMeta(entry.cwd)
    if (meta.isRepo && meta.repoRoot) {
      repoRoot = meta.repoRoot
      repoName = basename(meta.repoRoot.replace(/[\\/]+$/, '')) || null
      const branchStatus = await getGitBranchAndStatus(meta.repoRoot, { priority: 'high', includeUntracked: true })
      branch = branchStatus.branch
      status = branchStatus.status
      const diff = await getGitDiff(meta.repoRoot, { scope: 'full', force: false })
      if (diff.success) {
        files = diff.files
        repos = diff.repos
        submodulesLoading = diff.submodulesLoading
      }
    } else {
      status = 'unknown'
    }
  } catch (error) {
    log('error', 'recompute-failed', { cwd: entry.cwd, reason, error: error instanceof Error ? error.message : String(error) })
    status = 'unknown'
  }

  const capturedAt = Date.now()
  const durationMs = capturedAt - startedAt

  const next: MirrorState = {
    cwd: entry.cwd,
    repoRoot,
    repoName,
    branch,
    status,
    files,
    repos,
    submodulesLoading,
    capturedAt
  }

  const delta = computeDelta(entry.state, next)
  entry.state = next

  perfTraceLogger.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_RECOMPUTE_DONE, {
    cwd: entry.cwd,
    reason,
    branch,
    status,
    fileCount: files.length,
    durationMs
  })

  if (Object.keys(delta).length > 1 /* > capturedAt only */) {
    const update: MirrorToMainMessage = {
      kind: 'mirror-update',
      cwd: entry.cwd,
      state: next,
      delta
    }
    parentPort?.postMessage(update)
  }
}

/**
 * Compute the minimum-payload delta between two MirrorState snapshots.
 * Always includes `capturedAt` (cheap timestamp) so consumers can order
 * deltas without a separate sequence number.
 */
function computeDelta(prev: MirrorState | null, next: MirrorState): MirrorDelta {
  const out: MirrorDelta = { capturedAt: next.capturedAt }
  if (!prev) {
    // First snapshot for this cwd → ship the whole thing.
    out.repoRoot = next.repoRoot
    out.repoName = next.repoName
    out.branch = next.branch
    out.status = next.status
    out.files = next.files
    out.repos = next.repos
    out.submodulesLoading = next.submodulesLoading
    return out
  }
  if (prev.repoRoot !== next.repoRoot) out.repoRoot = next.repoRoot
  if (prev.repoName !== next.repoName) out.repoName = next.repoName
  if (prev.branch !== next.branch) out.branch = next.branch
  if (prev.status !== next.status) out.status = next.status
  if (prev.submodulesLoading !== next.submodulesLoading) out.submodulesLoading = next.submodulesLoading
  if (!sameFileList(prev.files, next.files)) out.files = next.files
  if (!sameRepos(prev.repos, next.repos)) out.repos = next.repos
  return out
}

function sameFileList(a: MirrorState['files'], b: MirrorState['files']): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x.filename !== y.filename
      || x.status !== y.status
      || x.changeType !== y.changeType
      || (x.originalFilename ?? null) !== (y.originalFilename ?? null)
      || (x.repoRoot ?? null) !== (y.repoRoot ?? null)
    ) {
      return false
    }
  }
  return true
}

function sameRepos(a: MirrorState['repos'], b: MirrorState['repos']): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x.root !== y.root || x.label !== y.label || x.changeCount !== y.changeCount || (x.loading ?? false) !== (y.loading ?? false)) {
      return false
    }
  }
  return true
}

function scheduleDebounce(entry: WorkerEntry): void {
  if (entry.debounceTimer) return
  entry.pendingSince = Date.now()
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null
    flushDebounce(entry)
  }, DEBOUNCE_MS)
}

async function attachWatch(cwd: string): Promise<void> {
  const entry = ensureEntry(cwd)
  // Guards against re-entrant attach. `watcherDispose` covers the steady
  // state (already attached); `attachInFlight` covers the in-progress
  // state — set synchronously the moment we decide to attach so a second
  // caller arriving during the parcel-watcher init await sees it and
  // bails. See the WorkerEntry.attachInFlight docstring for the concrete
  // race scenario this prevents.
  if (entry.watcherDispose || entry.attachInFlight) return
  entry.attachInFlight = true

  // Resolve the repo root so we watch the repository as a whole rather
  // than just the terminal's cwd subtree. When the terminal lives in
  // `/repo/src/components`, parcel-watcher previously subscribed to that
  // subdir and missed: (a) `.git/index` updates from `git add`/`commit`
  // (because `.git` is two levels above the watched dir), and (b)
  // sibling file changes under `/repo/docs/**` etc. Both feed
  // `recomputeStatus` (which already reports state for the WHOLE repo
  // via getGitRepoMeta), so missing them produced silently-stale chip
  // state.
  //
  // The duplicate-attach race that blocked an earlier attempt at this
  // fix is now gone: the router canonicalises every renderer-supplied
  // cwd via `realpathSync` (see `canonicalise()` in
  // git-state-mirror-router.ts), so two raw forms that point at the
  // same physical repo collapse to the same canonical key BEFORE they
  // reach the worker — only one entry, one parcel-watcher.
  let watchedRoot = entry.cwd
  let isRepo = false
  try {
    const meta = await getGitRepoMeta(entry.cwd)
    if (meta.isRepo && meta.repoRoot) {
      watchedRoot = resolve(meta.repoRoot)
      isRepo = true
    }
  } catch {
    // Non-fatal. The branch below emits an unknown snapshot without
    // installing a recursive watcher for a non-repo directory.
  }
  entry.watchedRoot = watchedRoot

  if (!isRepo) {
    entry.attachInFlight = false
    log('info', 'attach-watch:non-git', { cwd: entry.cwd })
    void recomputeStatus(entry, 'attach')
    return
  }

  log('info', 'attach-watch:begin', { cwd: entry.cwd, watchedRoot })

  let sub: AsyncSubscription | null = null
  try {
    sub = await parcelSubscribe(watchedRoot, (err, events) => {
      if (err) {
        log('error', 'parcel-watcher callback error', { cwd: entry.cwd, watchedRoot, error: String(err) })
        return
      }
      let allowedCount = 0
      for (const ev of events) {
        const verdict = classifyEventPath(ev.path, entry.watchedRoot)
        if (verdict.drop) {
          fireWatcherFiltered({ cwd: entry.cwd, path: ev.path, reason: verdict.reason })
          continue
        }
        allowedCount += 1
        entry.pendingPaths.add(ev.path)
        fireWatcherEvent({ cwd: entry.cwd, path: ev.path, kind: ev.type })
      }
      if (allowedCount > 0) scheduleDebounce(entry)
    })
  } catch (error) {
    entry.attachInFlight = false
    log('error', 'attach-watch:subscribe failed', { cwd: entry.cwd, watchedRoot, error: error instanceof Error ? error.message : String(error) })
    return
  }

  entry.watcherDispose = async () => {
    if (sub) {
      try { await sub.unsubscribe() } catch { /* ignore */ }
      sub = null
    }
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
    entry.pendingPaths.clear()
    entry.pendingSince = null
  }
  entry.attachInFlight = false

  log('info', 'attach-watch:ready', { cwd: entry.cwd, watchedRoot })

  // Initial recompute so subscribers see a snapshot without waiting for
  // the first fs event. Fire-and-forget — the postMessage on completion
  // populates the router's `latest` cache for any late subscriber.
  void recomputeStatus(entry, 'attach')
}

async function detachWatch(cwd: string): Promise<void> {
  const key = resolve(cwd)
  const entry = entries.get(key)
  if (!entry) return
  if (entry.watcherDispose) {
    try { await entry.watcherDispose() } catch { /* ignore */ }
    entry.watcherDispose = null
  }
  entries.delete(key)
  log('info', 'detach-watch', { cwd: key })
}

async function switchCwd(terminalId: string, newCwd: string | null): Promise<void> {
  log('info', 'switch-cwd', { terminalId, newCwd })
  if (!newCwd) return
  const key = resolve(newCwd)
  const existing = entries.get(key)
  if (existing) {
    // Already watched — kick a recompute so the OSC-triggered switch reflects
    // immediately. The fs.watch handler is still active and will continue to
    // drive subsequent updates.
    void recomputeStatus(existing, 'switch-cwd')
    return
  }
  // First time we see this cwd in the worker: open a watcher + recompute.
  await attachWatch(newCwd)
}

async function requestFileBody(cwd: string, fileKey: string, force: boolean, replyId: number): Promise<void> {
  // commit 5/6 will: read working-tree + index, statToken-cache, return body.
  const reply: MirrorToMainMessage = {
    kind: 'file-body-update',
    replyId,
    body: null,
    error: 'PENDING_COMMIT_5: requestFileBody not yet implemented in worker.'
  }
  parentPort?.postMessage(reply)
  log('warn', 'request-file-body deferred', { cwd, fileKey, force })
}

async function focusResync(cwd: string | null): Promise<void> {
  log('info', 'focus-resync', { cwd })
  if (cwd) {
    const entry = entries.get(resolve(cwd))
    if (entry) {
      void recomputeStatus(entry, 'focus-resync')
      return
    }
  }
  // No specific cwd → recompute every active entry. Cheap: each one is a
  // single git status invocation gated by gitRuntimeManager.
  for (const entry of entries.values()) {
    void recomputeStatus(entry, 'focus-resync-all')
  }
}

// Diagnostic: capture every uncaught failure inside the worker so we can
// see WHY the router observed an exit. Without these, an unhandled
// promise rejection or an uncaught exception inside an async fire-and-
// forget (e.g. `void recomputeStatus(...)`) silently kills the worker
// and the router's exit handler logs only `code=null` with no clue.
process.on('uncaughtException', (err) => {
  log('error', 'worker:uncaughtException', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : null
  })
})
process.on('unhandledRejection', (reason) => {
  log('error', 'worker:unhandledRejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : null
  })
})

parentPort?.on('message', (incoming: MainToMirrorMessage) => {
  void (async () => {
    try {
      switch (incoming.kind) {
        case 'attach-watch':       return await attachWatch(incoming.cwd)
        case 'detach-watch':       return await detachWatch(incoming.cwd)
        case 'switch-cwd':         return await switchCwd(incoming.terminalId, incoming.newCwd)
        case 'request-file-body':  return await requestFileBody(incoming.cwd, incoming.fileKey, incoming.force, incoming.replyId)
        case 'focus-resync':       return await focusResync(incoming.cwd)
        case 'shutdown': {
          // Tear down every active watcher before exiting.
          for (const cwd of Array.from(entries.keys())) {
            await detachWatch(cwd)
          }
          process.exit(0)
        }
        default: {
          const exhaustive: never = incoming
          log('error', 'unknown message kind', { kind: (exhaustive as { kind?: string })?.kind })
        }
      }
    } catch (error) {
      log('error', 'message handler threw', { error: error instanceof Error ? error.message : String(error) })
    }
  })()
})

const ready: MirrorToMainMessage = { kind: 'ready' }
parentPort?.postMessage(ready)
