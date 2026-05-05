/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Append-only NDJSON trace store with chunked rotation.
//
// Single source of truth for on-disk perf / business / diagnostic events.
// Both `perf-trace-logger.ts` (named-event registry) and
// `performance-trace.ts` (flow / task / counter API) delegate writes to
// this module so end-users have ONE folder to read when reporting issues.
//
// Format: NDJSON. Each line is one Chrome Trace Event Format object.
// Why NDJSON instead of the standard `{traceEvents:[...]}` array:
//   - SIGKILL / OOM / power-loss leaves at most one half-written tail
//     line; everything before is intact and parseable. The array form
//     loses the entire file when the closing `]}` is never written.
//   - Append-friendly across rotations and process restarts. No glue
//     logic needed to splice array fragments.
//
// Storage layout (single shared dir):
//   <dir>/perf-NNNN-<isoChunkStart>-<pid>.jsonl   one chunk per ~8 MB
//   <dir>/latest.txt                               points at <dir>
//
// Budget: 64 MB total across the directory; oldest chunk deleted on
// rotation when the cap would be exceeded. Single-chunk cap 8 MB.
//
// `infra/scripts/open_trace.sh` wraps the chunks into the legacy
// `{traceEvents:[…]}` form on demand for `trace_processor_shell` /
// Perfetto UI; on-disk we keep NDJSON for resilience.

import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { isMainThread } from 'worker_threads'

type ElectronApp = {
  getPath: (name: string) => string
  isPackaged: boolean
  getAppPath: () => string
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

// Default-on. ONWARD_PERF_TRACE=0 disables (used by benchmarks that
// want to measure baseline perf without trace overhead). Anything else
// (unset, '1', '2', ...) enables the always-on diagnostic store.
export const TRACE_STORE_ENABLED = process.env.ONWARD_PERF_TRACE !== '0'

export const CHUNK_BYTE_LIMIT = 8 * 1024 * 1024
export const TOTAL_BYTE_LIMIT = 64 * 1024 * 1024
const RATE_LIMIT_PER_SECOND = 100
const RATE_LIMIT_NAME_CAP = 256
const DROPPED_SUMMARY_INTERVAL_MS = 5000

export interface TraceStoreEvent {
  ph: string
  name: string
  ts?: number
  pid: number
  tid: number
  cat?: string
  dur?: number
  id?: string
  s?: string
  args?: Record<string, unknown>
}

interface RateState {
  count: number
  windowStart: number
  dropped: number
  lastSeen: number
}

interface ResolvedRoot {
  dir: string
  kind: 'repo' | 'userdata' | 'tmp'
}

/**
 * Resolve the trace directory.
 *   1. ONWARD_REPO_ROOT — autotest runners set this explicitly so the
 *      packaged app writes traces back into <repo>/traces/perf/.
 *   2. Worker thread (no electron app) — tmpdir/onward-traces-perf-worker.
 *      Workers should normally forward events to main and never reach
 *      this branch, but guards against accidental direct write.
 *   3. Dev (!app.isPackaged) — <repoRoot>/traces/perf/.
 *   4. Production — userData/traces/.
 */
export function resolveTraceStoreRoot(): ResolvedRoot {
  if (!isMainThread) {
    return { dir: join(tmpdir(), 'onward-traces-perf-worker'), kind: 'tmp' }
  }
  const envRoot = process.env.ONWARD_REPO_ROOT
  if (envRoot) {
    return { dir: join(envRoot, 'traces', 'perf'), kind: 'repo' }
  }
  const electronApp = loadElectronApp()
  if (!electronApp) {
    return { dir: join(tmpdir(), 'onward-traces-perf'), kind: 'tmp' }
  }
  if (!electronApp.isPackaged) {
    const appPath = electronApp.getAppPath()
    const candidateRoot = resolve(appPath, '..', '..')
    return { dir: join(candidateRoot, 'traces', 'perf'), kind: 'repo' }
  }
  return { dir: join(electronApp.getPath('userData'), 'traces'), kind: 'userdata' }
}

class TraceStore {
  private dir: string | null = null
  private latestPointerPath: string | null = null
  private chunkSeq = 0
  // Synchronous file-descriptor write path. Each writeEvent invokes
  // fs.writeSync(fd, line) so the byte hits the kernel buffer before
  // we return — survives SIGKILL (kernel keeps the buffer to disk
  // even when the process dies) and gives accurate file sizes to
  // enforceBudget's statSync inside the same synchronous tick.
  // Node's WriteStream queues writes in the process and only drains
  // when the event loop runs; in a tight stress-write loop the queue
  // never drains and the on-disk size lags by tens of MB, defeating
  // both rotation accounting and SIGKILL durability.
  private currentFd: number | null = null
  private currentChunkPath: string | null = null
  private currentChunkBytes = 0
  private initialized = false
  private rateLimits = new Map<string, RateState>()
  private droppedSummaryTimer: ReturnType<typeof setInterval> | null = null
  private rootKind: ResolvedRoot['kind'] | null = null

  isEnabled(): boolean {
    return TRACE_STORE_ENABLED && isMainThread
  }

  /**
   * Initialize the store. Idempotent. If `dir` is omitted, resolved via
   * `resolveTraceStoreRoot()`. Workers should not call this — they
   * forward events through their parent thread instead.
   */
  initialize(dir?: string): void {
    if (!TRACE_STORE_ENABLED || !isMainThread || this.initialized) return
    this.initialized = true

    if (dir) {
      this.dir = dir
      this.rootKind = 'userdata'
    } else {
      const resolved = resolveTraceStoreRoot()
      this.dir = resolved.dir
      this.rootKind = resolved.kind
    }
    this.latestPointerPath = join(this.dir, 'latest.txt')
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch (error) {
      // If we cannot create the trace dir, disable silently. The app must
      // never refuse to start because diagnostics are unavailable.
      console.warn('[TraceStore] mkdir failed; tracing disabled:', String(error))
      this.initialized = false
      this.dir = null
      return
    }

    // Pick up where the last session left off — chunk seqs are
    // monotonically increasing across the directory's lifetime.
    const existingMaxSeq = this.scanExistingMaxSeq()
    this.chunkSeq = existingMaxSeq + 1

    // Enforce total budget on startup (in case the last process exited
    // mid-rotation and left the dir over budget).
    this.enforceBudget()

    if (!this.openNewChunk()) {
      // Open failed; leave the store in a usable but write-noop state.
      this.initialized = false
      return
    }

    this.droppedSummaryTimer = setInterval(() => {
      try { this.flushDroppedSummaries() } catch { /* ignore */ }
    }, DROPPED_SUMMARY_INTERVAL_MS)
    this.droppedSummaryTimer.unref?.()

    console.log(
      `[TraceStore] enabled chunk-bytes=${CHUNK_BYTE_LIMIT} total-bytes=${TOTAL_BYTE_LIMIT} ` +
      `dir=${this.dir} (${this.rootKind}) seq=${this.chunkSeq}`
    )
  }

  /**
   * Write one Chrome-trace-format event. Returns false if the event was
   * rate-limited away or the store is not initialized.
   *
   * `bypassRateLimit` exists exclusively for the rotation autotest, which
   * needs to push tens of MB of synthetic events through a single name to
   * exercise chunk rotation + budget eviction without waiting hours for
   * the per-name 100 events/sec cap to release. Production callers must
   * never pass it; the rate limiter is the only thing that protects
   * against a runaway emitter starving disk and Perfetto's parser.
   */
  writeEvent(event: TraceStoreEvent, options?: { bypassRateLimit?: boolean }): boolean {
    if (!this.initialized || this.currentFd === null) return false
    if (!options?.bypassRateLimit && !this.checkRateLimit(event.name)) return false

    const line = stringifyEventLine(event)
    return this.writeLine(line)
  }

  /**
   * Force a chunk rotation. Public so tests can probe rotation behavior
   * without writing 8 MB of events.
   */
  rotate(): void {
    if (!this.initialized || this.currentFd === null) return
    this.rotateChunk()
  }

  /**
   * Close the current chunk and shut down. Subsequent `writeEvent`
   * calls return false until `initialize()` is called again.
   */
  close(): void {
    if (this.droppedSummaryTimer) {
      clearInterval(this.droppedSummaryTimer)
      this.droppedSummaryTimer = null
    }
    this.flushDroppedSummaries()
    if (this.currentFd !== null) {
      const fd = this.currentFd
      this.currentFd = null
      try { fsyncSync(fd) } catch { /* ignore — kernel will eventually flush */ }
      try { closeSync(fd) } catch { /* ignore */ }
    }
    this.currentChunkPath = null
    this.currentChunkBytes = 0
    this.initialized = false
  }

  getDir(): string | null {
    return this.dir
  }

  getCurrentChunkPath(): string | null {
    return this.currentChunkPath
  }

  getRootKind(): ResolvedRoot['kind'] | null {
    return this.rootKind
  }

  // ---- internals ----

  private writeLine(line: string): boolean {
    if (this.currentFd === null) return false
    const lineBytes = Buffer.byteLength(line, 'utf8')

    // Rotate before writing if this line would push the current chunk
    // past the cap. Rotation is best-effort — if we cannot open a new
    // chunk we drop the event rather than block the caller.
    if (this.currentChunkBytes > 0 && this.currentChunkBytes + lineBytes > CHUNK_BYTE_LIMIT) {
      this.rotateChunk()
      if (this.currentFd === null) return false
    }

    try {
      writeSync(this.currentFd, line)
    } catch {
      // Disk full / fd revoked / etc. Drop the event silently — the
      // diagnostic store must never block production code paths.
      return false
    }
    this.currentChunkBytes += lineBytes
    return true
  }

  private openNewChunk(): boolean {
    if (!this.dir) return false
    const seq = this.chunkSeq
    const startIso = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `perf-${seq.toString().padStart(4, '0')}-${startIso}-${process.pid}.jsonl`
    const path = join(this.dir, filename)
    try {
      // 'a' = O_APPEND so even if multiple processes ever shared a chunk
      // file the writes wouldn't overlap; combined with single-instance
      // lock this is purely defence in depth.
      this.currentFd = openSync(path, 'a')
    } catch (error) {
      console.warn('[TraceStore] openSync failed:', String(error))
      this.currentFd = null
      this.currentChunkPath = null
      return false
    }
    this.currentChunkPath = path
    this.currentChunkBytes = 0

    // Update the pointer to the directory (not a single file — the user
    // tooling reads ALL chunks in this dir for the report bundle).
    if (this.latestPointerPath && this.dir) {
      try { writeFileSync(this.latestPointerPath, this.dir, 'utf8') } catch { /* ignore */ }
    }
    return true
  }

  private rotateChunk(): void {
    if (this.currentFd === null) return
    const fd = this.currentFd
    this.currentFd = null
    try { fsyncSync(fd) } catch { /* ignore */ }
    try { closeSync(fd) } catch { /* ignore */ }
    this.currentChunkPath = null
    this.currentChunkBytes = 0
    this.chunkSeq += 1

    this.enforceBudget()
    this.openNewChunk()
  }

  /**
   * Evict oldest closed chunks until the directory has at least
   * `reserveBytes` of headroom under TOTAL_BYTE_LIMIT. Called from
   * rotateChunk() with reserveBytes=CHUNK_BYTE_LIMIT so the soon-to-be-
   * opened active chunk can grow to 8 MB without ever pushing the
   * combined (closed + active) total past 64 MB. Called from initialize()
   * with the same reserve so a session that resumes a near-full directory
   * has room to write its first chunk.
   */
  private enforceBudget(): void {
    if (!this.dir) return
    const reserveBytes = CHUNK_BYTE_LIMIT
    const evictionTarget = TOTAL_BYTE_LIMIT - reserveBytes

    const entries: Array<{ path: string; size: number; seq: number }> = []
    let dirContents: string[]
    try {
      dirContents = readdirSync(this.dir)
    } catch {
      return
    }
    for (const f of dirContents) {
      if (!f.endsWith('.jsonl')) continue
      const m = f.match(/^perf-(\d+)-/)
      if (!m) continue
      const full = join(this.dir, f)
      try {
        const st = statSync(full)
        entries.push({ path: full, size: st.size, seq: parseInt(m[1], 10) })
      } catch {
        // file vanished mid-scan; ignore
      }
    }

    // Oldest first by seq (chunk seq is monotonically increasing per
    // dir). mtime would suffice, but seq is what we control and is
    // reproducible across systems with quirky mtime resolution.
    entries.sort((a, b) => a.seq - b.seq)

    let total = entries.reduce((s, e) => s + e.size, 0)

    while (total > evictionTarget && entries.length > 0) {
      const oldest = entries.shift()
      if (!oldest) break
      try { unlinkSync(oldest.path) } catch { /* ignore */ }
      total -= oldest.size
    }
  }

  private scanExistingMaxSeq(): number {
    if (!this.dir) return -1
    let max = -1
    try {
      for (const f of readdirSync(this.dir)) {
        const m = f.match(/^perf-(\d+)-/)
        if (m) {
          const seq = parseInt(m[1], 10)
          if (Number.isFinite(seq) && seq > max) max = seq
        }
      }
    } catch { /* ignore */ }
    return max
  }

  /**
   * Per-name 1-second token bucket with a global name cap so a runaway
   * caller cannot inflate the rate-limit map. The dropped count is
   * accumulated and emitted as a `trace-store:dropped-summary` event
   * every 5 s so the operator notices the loss.
   */
  private checkRateLimit(name: string): boolean {
    const now = Date.now()
    let state = this.rateLimits.get(name)
    if (!state) {
      if (this.rateLimits.size >= RATE_LIMIT_NAME_CAP) {
        this.evictStaleRateLimits(now)
      }
      state = { count: 1, windowStart: now, dropped: 0, lastSeen: now }
      this.rateLimits.set(name, state)
      return true
    }
    state.lastSeen = now
    if (now - state.windowStart >= 1000) {
      state.windowStart = now
      state.count = 1
      return true
    }
    if (state.count >= RATE_LIMIT_PER_SECOND) {
      state.dropped += 1
      return false
    }
    state.count += 1
    return true
  }

  private evictStaleRateLimits(now: number): void {
    // Drop the half whose lastSeen is oldest. Entries with non-zero
    // dropped counters get one last summary first so we don't lose the
    // fact that drops happened.
    const sorted = [...this.rateLimits.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
    const dropCount = Math.max(1, Math.floor(sorted.length / 2))
    for (let i = 0; i < dropCount; i += 1) {
      const [name, state] = sorted[i]
      if (state.dropped > 0) this.emitDroppedSummary(name, state.dropped, now)
      this.rateLimits.delete(name)
    }
  }

  private flushDroppedSummaries(): void {
    if (this.currentFd === null) return
    const now = Date.now()
    for (const [name, state] of this.rateLimits) {
      if (state.dropped > 0) {
        this.emitDroppedSummary(name, state.dropped, now)
        state.dropped = 0
      }
    }
  }

  private emitDroppedSummary(name: string, dropped: number, nowMs: number): void {
    if (this.currentFd === null) return
    const line = stringifyEventLine({
      ph: 'i',
      name: 'trace-store:dropped-summary',
      ts: nowMs * 1000,
      pid: process.pid,
      tid: 1,
      cat: 'trace-store',
      args: { dropped, originalName: name }
    })
    this.writeLine(line)
  }
}

function stringifyEventLine(event: TraceStoreEvent): string {
  let json: string
  try {
    json = JSON.stringify(event)
  } catch {
    // Fallback: synthesize a valid line so we never produce a malformed
    // NDJSON record. The reader-side parser will get a clean signal that
    // serialization failed for this event.
    json = JSON.stringify({
      ph: 'i',
      name: 'trace-store:serialization-error',
      pid: event.pid ?? 1,
      tid: event.tid ?? 1,
      cat: 'trace-store',
      args: { originalName: event.name }
    })
  }
  return json + '\n'
}

export const traceStore = new TraceStore()

/**
 * Stress harness used by `run-perf-trace-rotation-autotest.sh`. Writes
 * `mbTarget` MB worth of synthetic events through `traceStore` with the
 * per-name rate limit bypassed so the test exercises chunk rotation +
 * budget eviction in seconds instead of hours.
 *
 * Each event carries a constant 850 B `filler` so byte accounting is
 * predictable. Returns the number of events actually written. Caller is
 * expected to invoke `app.quit()` afterwards.
 *
 * NOT a production code path — keep behind the env-var gate in
 * `electron/main/index.ts`. Documented as part of `infra/trace.md`'s
 * stress test fixture.
 */
export function runRotationStressForAutotest(mbTarget: number): number {
  if (!traceStore.isEnabled()) return 0
  traceStore.initialize()
  const targetBytes = mbTarget * 1024 * 1024
  const fillerBytes = 850
  const filler = 'x'.repeat(fillerBytes)
  let written = 0
  let count = 0
  const baseTsUs = Date.now() * 1000
  while (written < targetBytes) {
    const accepted = traceStore.writeEvent(
      {
        ph: 'i',
        name: 'autotest:trace-rotation-stress',
        ts: baseTsUs + count,
        pid: 1,
        tid: 1,
        cat: 'autotest',
        args: { seq: count, filler }
      },
      { bypassRateLimit: true }
    )
    if (!accepted) break
    written += fillerBytes + 200 // event scaffold + filler; conservative
    count += 1
  }
  return count
}

