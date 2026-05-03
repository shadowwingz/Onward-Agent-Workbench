/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Do NOT static-import `electron` here. This module is also loaded inside the
// git-ipc-worker thread (via `git-utils.ts`). Electron's worker_threads
// runtime cannot resolve the `electron` module — a synchronous
// `require('electron')` at module-eval time crashes the worker with
// "Cannot find module 'electron'" before any user-level uncaughtException
// handler can register. We lazy-load `electron.app` inside helpers that only
// run in the main thread.
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'fs'
import { dirname, join, resolve } from 'path'
import { isMainThread, parentPort } from 'worker_threads'
import { tmpdir } from 'os'

import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names.ts'

/**
 * Worker → main trace forwarding envelope.
 *
 * When a worker thread calls `perfTraceLogger.record(name, data, source)` we
 * `parentPort.postMessage` this envelope instead of writing a per-worker file.
 * The main-side worker-client dispatches `'event' === 'trace'` messages to
 * `perfTraceLogger.record` so every worker's events land in the single main
 * trace file with a consistent thread track.
 *
 * Shape mirrors `ripgrep-search-worker-entry.ts::postTrace` (the established
 * precedent — see `infra/trace.md` § 2.1) so the same dispatcher pattern in
 * worker-clients can be reused unchanged for any future worker.
 */
export interface PerfTraceWorkerEvent {
  event: 'trace'
  name: string
  data?: Record<string, unknown>
  source?: { process?: 'main' | 'renderer'; tid?: number; terminalId?: string }
}

type ElectronApp = {
  isPackaged: boolean
  getAppPath: () => string
  getPath: (name: string) => string
  getVersion: () => string
  once: (event: string, cb: () => void) => void
}

function loadElectronApp(): ElectronApp | null {
  if (!isMainThread) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('electron') as { app: ElectronApp }).app
  } catch {
    return null
  }
}

export const PERF_TRACE_ENABLED = process.env.ONWARD_PERF_TRACE === '1'

type TracePayload = Record<string, unknown> | undefined

/**
 * Optional context supplied by IPC bridges forwarding events from
 * renderer processes. Main-side emitters can ignore this: the default
 * main-process track (pid=1, tid=1) is used when absent.
 *
 * Pass `terminalId` to route the event onto the per-Task virtual tid
 * managed by `assignTaskTid()`. The side is inferred from `process`.
 *
 * Pass `threadName` together with a stable `tid` to label a worker thread
 * lane in Perfetto UI — emits a `thread_name` metadata packet on first sight
 * of that `(pid, tid)` pair. Used by worker-client trace dispatchers.
 */
interface RecordSource {
  process?: 'main' | 'renderer'
  tid?: number
  terminalId?: string
  threadName?: string
}

/**
 * Stable worker tids used by worker-client dispatchers. Each worker gets its
 * own thread track in the main trace so Perfetto SQL can group events by
 * worker without name parsing. Reserved range: 5000-5999 (well above the
 * default main `tid=1` and below `MAIN_TASK_TID_BASE=10000`).
 */
export const WORKER_TID = {
  GIT_IPC: 5001,
  GIT_STATUS: 5002,
  PROJECT_FS: 5003,
  SQLITE: 5004,
  APP_STATE: 5005,
  RIPGREP_SEARCH: 5006,
  GIT_STATE_MIRROR: 5007
} as const

/**
 * Type guard for the worker→main trace forwarding envelope. Worker-client
 * `worker.on('message')` handlers should call this first so the bridge is
 * uniform across all workers (matches `ripgrep-search.ts::handleWorkerEvent`).
 */
export function isPerfTraceWorkerEvent(message: unknown): message is PerfTraceWorkerEvent {
  return typeof message === 'object'
    && message !== null
    && (message as { event?: unknown }).event === 'trace'
    && typeof (message as { name?: unknown }).name === 'string'
}

/**
 * Replay a worker's forwarded trace event on the main-side perfTraceLogger.
 * `defaultSource` lets each worker-client tag with its own stable tid +
 * threadName so the per-worker thread track in Perfetto stays coherent even
 * when the worker itself didn't set `source`.
 */
export function replayPerfTraceWorkerEvent(
  envelope: PerfTraceWorkerEvent,
  defaultSource?: RecordSource
): void {
  const merged: RecordSource | undefined = envelope.source
    ? { ...defaultSource, ...envelope.source }
    : defaultSource
  perfTraceLogger.record(envelope.name, envelope.data as TracePayload, merged)
}

interface PerfTraceInfo {
  enabled: boolean
  logPath: string | null
  latestPointerPath: string | null
  eventLoop: EventLoopStallMetrics
}

export interface EventLoopStallMetrics {
  resetAt: number
  totalSamples: number
  stallCount: number
  maxDriftMs: number
  over100Ms: number
  over250Ms: number
  over500Ms: number
  over1000Ms: number
  over3000Ms: number
  over6000Ms: number
  lastStallAt: number | null
  recentStalls: Array<{ ts: number; driftMs: number }>
}

const MAX_OBJECT_DEPTH = 5
const MAX_ARRAY_ITEMS = 80
const MAX_OBJECT_KEYS = 80
const MAX_STRING_LENGTH = 4000
const MAX_RECENT_EVENT_LOOP_STALLS = 40

// Chrome Trace Event Format constants.
//
// `pid=1` = main process.  `pid=2` = any renderer; the renderer's
// WebContents id is used as `tid` so each window / utility shows up as
// its own thread track in the Perfetto / Chrome DevTools UI.
//
// Per-Task virtual tids: any event tagged with a `terminalId` lands on
// its own row (`thread_name='task-<shortId>'`) under the relevant
// process. Main-side task tids start at `MAIN_TASK_TID_BASE`, renderer
// at `RENDERER_TASK_TID_BASE`. Real tids (1, WebContents.id) stay
// untouched, so Perfetto still shows the canonical main/renderer rows
// alongside the per-task lanes.
const MAIN_PID = 1
const MAIN_TID = 1
const RENDERER_PID = 2
const MAIN_TASK_TID_BASE = 10000
const RENDERER_TASK_TID_BASE = 20000

function createEventLoopStallMetrics(resetAt = Date.now()): EventLoopStallMetrics {
  return {
    resetAt,
    totalSamples: 0,
    stallCount: 0,
    maxDriftMs: 0,
    over100Ms: 0,
    over250Ms: 0,
    over500Ms: 0,
    over1000Ms: 0,
    over3000Ms: 0,
    over6000Ms: 0,
    lastStallAt: null,
    recentStalls: []
  }
}

function cloneEventLoopStallMetrics(metrics: EventLoopStallMetrics): EventLoopStallMetrics {
  return {
    ...metrics,
    recentStalls: metrics.recentStalls.map((entry) => ({ ...entry }))
  }
}

function normalizeTraceValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated:${value.length}]`
      : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack?.slice(0, MAX_STRING_LENGTH) ?? null
    }
  }
  if (depth >= MAX_OBJECT_DEPTH) return '[MaxDepth]'
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => normalizeTraceValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
      result[key] = normalizeTraceValue(nestedValue, depth + 1)
    }
    return result
  }
  return String(value)
}

function safeNormalize(value: unknown): unknown {
  try {
    return normalizeTraceValue(value)
  } catch (error) {
    return { serializationError: String(error) }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch (error) {
    return JSON.stringify({ serializationError: String(error) })
  }
}

/**
 * Resolve the repository root where `traces/` lives. Order:
 *   1. `ONWARD_REPO_ROOT` env var — autotest runners set this
 *      explicitly before launching the packaged app.
 *   2. `!app.isPackaged` dev mode — `app.getAppPath()` is the project
 *      root (vite dev) or its `out/main/..` sibling; walk two levels
 *      up to reach the checkout.
 *   3. Production packaged build — fall back to
 *      `userData/debug` because end-users don't have a checkout.
 */
function resolveTraceRoot(): { dir: string; kind: 'repo' | 'userdata' } {
  // Worker threads always fall back to tmpdir, even when ONWARD_REPO_ROOT is
  // inherited from the main process. Otherwise main and worker race to write
  // `latest.txt` in the same dir and the runner's trace inspection picks up
  // whichever one wrote last (usually the worker, which is missing the
  // fs-watch events emitted by the main-side cache invalidator).
  if (!isMainThread) {
    return { dir: join(tmpdir(), 'onward-traces-perf-worker'), kind: 'userdata' }
  }
  const envRoot = process.env.ONWARD_REPO_ROOT
  if (envRoot) {
    return { dir: join(envRoot, 'traces', 'perf'), kind: 'repo' }
  }
  // Main thread without electron `app` (very rare — defensive fallback only).
  const electronApp = loadElectronApp()
  if (!electronApp) {
    return { dir: join(tmpdir(), 'onward-traces-perf'), kind: 'userdata' }
  }
  if (!electronApp.isPackaged) {
    // electron-vite builds put main output at <repoRoot>/out/main/index.js;
    // `app.getAppPath()` returns <repoRoot>/out/main in that setup. Walk
    // up twice and land on the repo root regardless.
    const appPath = electronApp.getAppPath()
    const candidateRoot = resolve(appPath, '..', '..')
    return { dir: join(candidateRoot, 'traces', 'perf'), kind: 'repo' }
  }
  return { dir: join(electronApp.getPath('userData'), 'debug'), kind: 'userdata' }
}

/**
 * Decide the Chrome trace "phase" (`ph`) for an event based on the
 * event name and payload. Explicit rules only; anything unknown falls
 * through to a safe `ph:"i"` instant event.
 */
function resolvePhase(event: string, data: TracePayload): { ph: 'X' | 'i' | 'M'; dur?: number; scope?: string } {
  if (event === PERF_TRACE_EVENT.MAIN_TRACE_START) {
    return { ph: 'i', scope: 'g' }
  }
  if (event === PERF_TRACE_EVENT.MAIN_EVENT_LOOP_STALL ||
      event === PERF_TRACE_EVENT.RENDERER_EVENT_LOOP_STALL ||
      event === PERF_TRACE_EVENT.RENDERER_FRAME_STALL) {
    const driftMs = Number((data as Record<string, unknown> | undefined)?.driftMs
      ?? (data as Record<string, unknown> | undefined)?.frameDeltaMs)
    if (Number.isFinite(driftMs) && driftMs > 0) {
      return { ph: 'X', dur: Math.round(driftMs * 1000) }
    }
    return { ph: 'i', scope: 't' }
  }
  if (event === PERF_TRACE_EVENT.RENDERER_LONGTASK) {
    const durationMs = Number((data as Record<string, unknown> | undefined)?.durationMs)
    if (Number.isFinite(durationMs) && durationMs > 0) {
      return { ph: 'X', dur: Math.round(durationMs * 1000) }
    }
    return { ph: 'i', scope: 't' }
  }
  if (event === PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_PAINT) {
    const totalMs = Number((data as Record<string, unknown> | undefined)?.eventToPaintMs)
    if (Number.isFinite(totalMs) && totalMs > 0) {
      return { ph: 'X', dur: Math.round(totalMs * 1000) }
    }
    return { ph: 'i', scope: 't' }
  }
  // Convention: any event carrying `elapsedMs`, `durationMs`, or
  // `workerDurationMs` in its payload is a completed span. We route
  // them to `ph:"X"` so Perfetto SQL's `slice.dur` column is usable
  // for percentile / aggregate queries (see infra/trace.md §5.4).
  // This catches the `main:*-worker-latency` family, `main:app-state-
  // save`, and any future slice-shaped events without requiring each
  // emitter to think about the Chrome Trace Event Format phases.
  const d = data as Record<string, unknown> | undefined
  const inferredMs = Number(
    d?.elapsedMs ?? d?.durationMs ?? d?.workerDurationMs
  )
  if (Number.isFinite(inferredMs) && inferredMs > 0) {
    return { ph: 'X', dur: Math.round(inferredMs * 1000) }
  }
  return { ph: 'i', scope: 't' }
}

class PerfTraceLogger {
  private stream: WriteStream | null = null
  private logPath: string | null = null
  private latestPointerPath: string | null = null
  private traceRootKind: 'repo' | 'userdata' | null = null
  private initialized = false
  private eventLoopTimer: ReturnType<typeof setInterval> | null = null
  private gitRuntimeTimer: ReturnType<typeof setInterval> | null = null
  private eventLoopMetrics: EventLoopStallMetrics = createEventLoopStallMetrics()
  private startMs: number = 0
  private rendererThreadNamesEmitted = new Set<number>()
  // Worker-thread tid labels emitted exactly once per (pid, tid) pair so
  // Perfetto's `thread` table has a name (e.g., "git-ipc-worker") instead
  // of just an integer. Keyed `${pid}:${tid}` for future cross-process use.
  private namedNonRendererTids = new Set<string>()
  // Per-Task tid assignment. Key = `${side}:${terminalId}` so main/
  // renderer lanes have separate auto-incrementing ranges.
  private taskTids = new Map<string, number>()
  private nextMainTaskTid = MAIN_TASK_TID_BASE
  private nextRendererTaskTid = RENDERER_TASK_TID_BASE

  isEnabled(): boolean {
    return PERF_TRACE_ENABLED
  }

  start(): void {
    if (!PERF_TRACE_ENABLED || this.initialized) return
    // Worker context: no file IO. The worker's record() forwards to main via
    // parentPort; main writes the single trace file.
    if (!isMainThread) {
      this.initialized = true
      return
    }
    this.initialized = true

    const { dir, kind } = resolveTraceRoot()
    this.traceRootKind = kind
    mkdirSync(dir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    // Chrome Trace Event Format — `.json`. Perfetto UI and
    // trace_processor_shell both accept this natively.
    this.logPath = join(dir, `perf-trace-${timestamp}-${process.pid}.json`)
    this.latestPointerPath = join(dir, 'latest.txt')
    this.stream = createWriteStream(this.logPath, { flags: 'a', encoding: 'utf8' })
    writeFileSync(this.latestPointerPath, this.logPath, 'utf8')
    // File preamble: open the traceEvents array.
    this.stream.write('{"traceEvents":[\n')
    // Metadata packets: give the main process / thread friendly names.
    this.writeRaw({
      ph: 'M', name: 'process_name', pid: MAIN_PID, tid: MAIN_TID,
      args: { name: 'Onward main' }
    })
    this.writeRaw({
      ph: 'M', name: 'process_sort_index', pid: MAIN_PID, tid: MAIN_TID,
      args: { sort_index: 1 }
    })
    this.writeRaw({
      ph: 'M', name: 'thread_name', pid: MAIN_PID, tid: MAIN_TID,
      args: { name: 'main' }
    })
    this.writeRaw({
      ph: 'M', name: 'process_name', pid: RENDERER_PID,
      args: { name: 'Onward renderer' }
    })
    this.writeRaw({
      ph: 'M', name: 'process_sort_index', pid: RENDERER_PID,
      args: { sort_index: 2 }
    })
    console.log(
      `[PerfTrace] enabled (ONWARD_PERF_TRACE=1) format=chrome-trace-json ` +
      `path=${this.logPath} (${kind})`
    )
    // Register signal handlers so SIGTERM / SIGINT (tests, CI,
    // Ctrl-C) still flush the Chrome trace array closer. The logger
    // is a singleton so these handlers attach at most once; Electron
    // `app.on('will-quit')` still covers graceful menu-quit paths.
    const shutdown = () => {
      try { this.stop() } catch { /* already closing */ }
    }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
    // Worker threads do not have access to electron.app — only register
    // app-lifecycle hooks when we're on the main thread. The worker is
    // terminated by the main process via `Worker.terminate`, which still
    // flushes pending stream writes.
    const electronApp = loadElectronApp()
    if (electronApp) {
      try { electronApp.once('will-quit', shutdown) } catch { /* lifecycle missing */ }
      try { electronApp.once('before-quit', shutdown) } catch { /* lifecycle missing */ }
    }
    // Record the first real event after the metadata.
    this.startMs = Date.now()
    const appVersion = electronApp
      ? (() => { try { return electronApp.getVersion() } catch { return 'unknown' } })()
      : 'worker'
    this.record(PERF_TRACE_EVENT.MAIN_TRACE_START, {
      logPath: this.logPath,
      pid: process.pid,
      platform: process.platform,
      appVersion,
      traceRoot: kind
    })
  }

  getInfo(): PerfTraceInfo {
    if (PERF_TRACE_ENABLED) {
      this.start()
    }
    return {
      enabled: PERF_TRACE_ENABLED,
      logPath: this.logPath,
      latestPointerPath: this.latestPointerPath,
      eventLoop: this.getEventLoopMetrics()
    }
  }

  resetEventLoopMetrics(): EventLoopStallMetrics {
    this.eventLoopMetrics = createEventLoopStallMetrics()
    this.record(PERF_TRACE_EVENT.MAIN_EVENT_LOOP_METRICS_RESET, {
      resetAt: this.eventLoopMetrics.resetAt
    })
    return this.getEventLoopMetrics()
  }

  getEventLoopMetrics(): EventLoopStallMetrics {
    return cloneEventLoopStallMetrics(this.eventLoopMetrics)
  }

  /**
   * Record a trace event. Writes a single Chrome-trace-format entry
   * into the open `.json` file; no buffering beyond the OS page cache.
   *
   * `source` lets IPC bridges tag renderer-forwarded events so they
   * land on a dedicated thread track.
   *
   * If `source.terminalId` is provided, the event is routed to the
   * per-Task virtual tid managed by `assignTaskTid()` instead of the
   * real main/renderer thread. A `thread_name` metadata packet is
   * auto-emitted on first sight so Perfetto UI labels the row.
   */
  record(event: string, data?: TracePayload, source?: RecordSource): void {
    if (!PERF_TRACE_ENABLED) return
    // Worker thread: forward via parentPort and let main write the actual
    // trace event. This avoids the per-worker file fragmentation that made
    // `latest.txt` race-prone and forced runners to inspect multiple traces.
    // Each worker-client (electron/main/*-worker-client.ts) listens for
    // `{event:'trace',…}` envelopes and replays them through main's
    // perfTraceLogger.record(). See `PerfTraceWorkerEvent` above + the
    // ripgrep precedent in `electron/main/ripgrep-search.ts::handleWorkerEvent`.
    if (!isMainThread) {
      try {
        const envelope: PerfTraceWorkerEvent = { event: 'trace', name: event }
        if (data && typeof data === 'object') {
          envelope.data = data as Record<string, unknown>
        }
        if (source) envelope.source = source
        parentPort?.postMessage(envelope)
      } catch {
        // postMessage can throw when the worker is being torn down; safe to drop.
      }
      return
    }
    this.start()
    if (!this.stream || !this.logPath) return

    const isRenderer = source?.process === 'renderer'
    const pid = isRenderer ? RENDERER_PID : MAIN_PID
    let tid: number
    if (source?.terminalId) {
      tid = this.assignTaskTid(source.terminalId, isRenderer ? 'renderer' : 'main')
    } else if (isRenderer) {
      tid = source?.tid ?? 0
      if (tid > 0 && !this.rendererThreadNamesEmitted.has(tid)) {
        this.rendererThreadNamesEmitted.add(tid)
        this.writeRaw({
          ph: 'M', name: 'thread_name', pid, tid,
          args: { name: `renderer#${tid}` }
        })
      }
    } else {
      // Main process — either the canonical tid=1 lane, or a worker's
      // dedicated WORKER_TID lane (forwarded from a worker-client). For the
      // worker case, emit a thread_name metadata packet on first sight so
      // Perfetto UI labels the row (e.g., "git-ipc-worker") instead of a
      // bare integer.
      tid = source?.tid ?? MAIN_TID
      if (source?.threadName && tid !== MAIN_TID) {
        const key = `${pid}:${tid}`
        if (!this.namedNonRendererTids.has(key)) {
          this.namedNonRendererTids.add(key)
          this.writeRaw({
            ph: 'M', name: 'thread_name', pid, tid,
            args: { name: source.threadName }
          })
        }
      }
    }

    const phase = resolvePhase(event, data)
    const tsUs = Date.now() * 1000
    const args = safeNormalize(data) as Record<string, unknown> | undefined
    const entry: Record<string, unknown> = {
      ph: phase.ph,
      name: event,
      ts: tsUs,
      pid,
      tid
    }
    if (phase.dur !== undefined) entry.dur = phase.dur
    if (phase.scope) entry.s = phase.scope
    if (args && Object.keys(args as object).length > 0) entry.args = args

    this.writeRaw(entry)
  }

  /**
   * Assign (or look up) the virtual tid for a given terminalId on the
   * requested side. The first call for a (side, terminalId) pair also
   * emits a `thread_name` metadata packet so Perfetto UI labels the
   * row as `task-<shortId>`.
   *
   * Stable across the process lifetime: the same terminalId always
   * maps to the same tid, so spans issued from main/ipc-handlers and
   * from pty-manager for the same terminal line up on one row.
   */
  private assignTaskTid(terminalId: string, side: 'main' | 'renderer'): number {
    const key = `${side}:${terminalId}`
    const existing = this.taskTids.get(key)
    if (existing !== undefined) return existing

    const tid = side === 'main' ? this.nextMainTaskTid++ : this.nextRendererTaskTid++
    this.taskTids.set(key, tid)

    const pid = side === 'main' ? MAIN_PID : RENDERER_PID
    // 8-char label keeps Perfetto row headers compact while remaining
    // unique enough across the small terminal count a single user
    // keeps open. Full terminalId stays available via event args.
    const shortId = terminalId.length > 8 ? terminalId.slice(0, 8) : terminalId
    this.writeRaw({
      ph: 'M', name: 'thread_name', pid, tid,
      args: { name: `task-${shortId}${side === 'renderer' ? '-rnd' : ''}` }
    })
    return tid
  }

  private writeRaw(entry: Record<string, unknown>): void {
    if (!this.stream) return
    this.stream.write(`  ${safeStringify(entry)},\n`)
  }

  startEventLoopMonitor(): void {
    if (!PERF_TRACE_ENABLED || this.eventLoopTimer) return
    this.start()

    const intervalMs = 250
    const stallThresholdMs = 100
    let expectedAt = Date.now() + intervalMs

    this.eventLoopTimer = setInterval(() => {
      const now = Date.now()
      const driftMs = now - expectedAt
      expectedAt = now + intervalMs
      this.eventLoopMetrics.totalSamples += 1
      if (driftMs >= stallThresholdMs) {
        this.recordEventLoopStall(now, driftMs)
        this.record(PERF_TRACE_EVENT.MAIN_EVENT_LOOP_STALL, {
          driftMs,
          intervalMs,
          stallThresholdMs
        })
      }
    }, intervalMs)
    this.eventLoopTimer.unref?.()
  }

  private recordEventLoopStall(ts: number, driftMs: number): void {
    const metrics = this.eventLoopMetrics
    metrics.stallCount += 1
    metrics.maxDriftMs = Math.max(metrics.maxDriftMs, driftMs)
    metrics.lastStallAt = ts
    if (driftMs >= 100) metrics.over100Ms += 1
    if (driftMs >= 250) metrics.over250Ms += 1
    if (driftMs >= 500) metrics.over500Ms += 1
    if (driftMs >= 1000) metrics.over1000Ms += 1
    if (driftMs >= 3000) metrics.over3000Ms += 1
    if (driftMs >= 6000) metrics.over6000Ms += 1
    metrics.recentStalls.push({
      ts,
      driftMs: Math.round(driftMs)
    })
    if (metrics.recentStalls.length > MAX_RECENT_EVENT_LOOP_STALLS) {
      metrics.recentStalls.splice(0, metrics.recentStalls.length - MAX_RECENT_EVENT_LOOP_STALLS)
    }
  }

  startGitRuntimeMonitor(getMetrics: () => unknown): void {
    if (!PERF_TRACE_ENABLED || this.gitRuntimeTimer) return
    this.start()

    this.gitRuntimeTimer = setInterval(() => {
      try {
        this.record(PERF_TRACE_EVENT.MAIN_GIT_RUNTIME_SUMMARY, getMetrics() as TracePayload)
      } catch (error) {
        this.record(PERF_TRACE_EVENT.MAIN_GIT_RUNTIME_SUMMARY_ERROR, { error: String(error) })
      }
    }, 1000)
    this.gitRuntimeTimer.unref?.()
  }

  stop(): void {
    if (this.eventLoopTimer) {
      clearInterval(this.eventLoopTimer)
      this.eventLoopTimer = null
    }
    if (this.gitRuntimeTimer) {
      clearInterval(this.gitRuntimeTimer)
      this.gitRuntimeTimer = null
    }
    if (this.stream) {
      this.record(PERF_TRACE_EVENT.MAIN_TRACE_STOP)
      // Terminal element: a `{}` entry lets us close the array without
      // chopping the trailing comma from the last real event. Perfetto
      // UI / trace_processor ignore empty events.
      this.stream.write('  {}\n]}\n')
      this.stream.end()
      this.stream = null
    }
  }
}

export const perfTraceLogger = new PerfTraceLogger()
