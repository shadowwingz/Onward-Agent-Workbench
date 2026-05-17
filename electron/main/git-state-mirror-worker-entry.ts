/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitStateMirror Worker Thread entry.
 *
 * Owns:
 *   - parcel-watcher subscription per attached repo (one watcher covering
 *     both working tree and .git/**, filtered via `classifyEventPath`)
 *   - git command spawn (status / rev-parse / show)
 *   - MirrorState compute + delta short-circuit
 *   - per-file body cache keyed by stat token
 *
 * Single rule: every recompute is triggered by an external event (FS
 * change, attach, switch-cwd, focus-resync). No periodic timers anywhere.
 * The only setTimeout in this file is a debounce window that coalesces
 * FS-event bursts — not a poll.
 */

import { execFile } from 'child_process'
import { promises as fs, constants as fsConstants } from 'fs'
import { delimiter, isAbsolute, join, resolve as resolvePath } from 'path'
import { platform } from 'os'
import { parentPort } from 'worker_threads'
import { promisify } from 'util'
import * as parcelWatcher from '@parcel/watcher'

import {
  beginMirrorRecompute,
  classifyEventPath,
  completeMirrorAttach,
  createMirrorWorkerEntry,
  finishMirrorRecomputeIfCurrent,
  requestMirrorAttach,
  requestMirrorDetach,
  type MirrorWorkerEntryCore
} from './git-state-mirror-worker-core'
import { parseStatusPorcelainV2Z } from './git-porcelain-parse'

import type {
  MainToMirrorMessage,
  MirrorFileBody,
  MirrorState,
  MirrorToMainMessage
} from './git-state-mirror-types'

const execFileAsync = promisify(execFile)

// Debounce window for parcel-watcher bursts (e.g. `git checkout` flipping
// many files at once). Coalesces inside this window — recompute happens
// once at the trailing edge, not per-event. This is debounce, not polling.
const DEBOUNCE_MS = 80
// @parcel/watcher's macOS FSEvents backend can resolve unsubscribe work just
// after our awaited unsubscribe promise; keep the Worker isolate alive briefly
// so those native N-API completions drain before Electron tears workers down.
const NATIVE_WATCHER_SHUTDOWN_DRAIN_MS = 250

// Git command timing budgets. Deadlines (kill after N ms), not intervals.
const EXEC_TIMEOUT_MS = 10_000
const MAX_STATUS_OUTPUT = 32 * 1024 * 1024
const MAX_FILE_BODY = 16 * 1024 * 1024

// Per-entry state, keyed by canonical cwd.
const entries = new Map<string, MirrorWorkerEntryCore>()
const inFlightOperations = new Set<Promise<void>>()
let shuttingDown = false

// Per-cwd MirrorState.generation counter. Bumped on every focus-resync
// (the "Refresh Changes" path) so the renderer's DiffEditor key changes
// and lifecycle resets even when underlying state is byte-identical.
// Regular FS-event-driven recomputes do NOT bump generation — they emit
// new content with the same generation, which is the correct invariant
// for "data changed but mount stays".
const mirrorGenerations = new Map<string, number>()
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function nextGeneration(cwd: string): number {
  const next = (mirrorGenerations.get(cwd) ?? 0) + 1
  mirrorGenerations.set(cwd, next)
  return next
}
function currentGeneration(cwd: string): number {
  // Initial state has generation = 1 (the first emit after attach).
  const value = mirrorGenerations.get(cwd)
  if (value === undefined) {
    mirrorGenerations.set(cwd, 1)
    return 1
  }
  return value
}

// File-body cache: key = `${cwd}\0${fileKey}`. Invalidated implicitly by
// statToken mismatch on next read.
const bodyCache = new Map<string, { body: MirrorFileBody; statToken: string }>()

let cachedGitExecutable: string | null | undefined

// ---------------------------------------------------------------------------
// Cross-thread messaging
// ---------------------------------------------------------------------------

function emit(message: MirrorToMainMessage): void {
  if (!parentPort) return
  try {
    parentPort.postMessage(message)
  } catch (error) {
    console.error('[git-state-mirror-worker] postMessage failed:', error)
  }
}

function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>
): void {
  emit({ kind: 'log', level, message, data })
}

function trackOperation(label: string, promise: Promise<void>): void {
  inFlightOperations.add(promise)
  promise.catch((error) => {
    log('warn', `${label} failed`, {
      error: error instanceof Error ? error.message : String(error)
    })
  }).finally(() => {
    inFlightOperations.delete(promise)
  })
}

// ---------------------------------------------------------------------------
// Git command plumbing
// ---------------------------------------------------------------------------

function getExecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH'
  const currentPath = env[pathKey] || ''
  const extraPaths: string[] = []

  if (platform() === 'win32') {
    extraPaths.push(
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files (x86)\\Git\\cmd',
      'C:\\Program Files (x86)\\Git\\bin'
    )
  } else {
    extraPaths.push('/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin', '/usr/bin', '/bin')
  }

  env[pathKey] = Array.from(
    new Set([...currentPath.split(delimiter).filter(Boolean), ...extraPaths])
  ).join(delimiter)
  return env
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, platform() === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function resolveGitExecutable(): Promise<string | null> {
  if (cachedGitExecutable !== undefined) return cachedGitExecutable

  const candidates: string[] = []
  if (process.env.GIT_PATH) candidates.push(process.env.GIT_PATH)
  if (platform() === 'win32') {
    candidates.push(
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\bin\\git.exe'
    )
  } else {
    candidates.push('/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git', '/opt/local/bin/git', '/bin/git')
  }
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      cachedGitExecutable = candidate
      return candidate
    }
  }
  try {
    await execFileAsync('git', ['--version'], { timeout: EXEC_TIMEOUT_MS, env: getExecEnv() })
    cachedGitExecutable = 'git'
    return cachedGitExecutable
  } catch {
    cachedGitExecutable = null
    return null
  }
}

async function spawnGit(args: string[], cwd: string, maxBuffer = MAX_STATUS_OUTPUT): Promise<string> {
  const exe = await resolveGitExecutable()
  if (!exe) throw new Error('git executable not found')
  const { stdout } = await execFileAsync(exe, args, {
    cwd,
    timeout: EXEC_TIMEOUT_MS,
    env: getExecEnv(),
    maxBuffer
  })
  return String(stdout)
}

async function spawnGitBinary(args: string[], cwd: string, maxBuffer = MAX_FILE_BODY): Promise<Buffer> {
  const exe = await resolveGitExecutable()
  if (!exe) throw new Error('git executable not found')
  const { stdout } = await execFileAsync(exe, args, {
    cwd,
    timeout: EXEC_TIMEOUT_MS,
    env: getExecEnv(),
    maxBuffer,
    encoding: 'buffer'
  })
  return stdout as Buffer
}

// ---------------------------------------------------------------------------
// MirrorState compute
// ---------------------------------------------------------------------------

interface RepoMeta {
  isRepo: boolean
  repoRoot: string | null
  gitDir: string | null
}

async function getRepoMeta(cwd: string): Promise<RepoMeta> {
  try {
    const out = await spawnGit(['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-dir'], cwd)
    const lines = out.trim().split(/\r?\n/)
    const isRepo = lines[0]?.trim() === 'true'
    if (!isRepo) return { isRepo: false, repoRoot: null, gitDir: null }
    const repoRootRaw = lines[1]?.trim() || cwd
    const gitDirRaw = lines[2]?.trim() || null
    const repoRoot = repoRootRaw.replace(/\\/g, '/')
    const gitDir = gitDirRaw
      ? (isAbsolute(gitDirRaw) ? gitDirRaw : resolvePath(repoRootRaw, gitDirRaw)).replace(/\\/g, '/')
      : null
    return { isRepo: true, repoRoot, gitDir }
  } catch {
    return { isRepo: false, repoRoot: null, gitDir: null }
  }
}

// Porcelain v2 parser + GitFileStatus builders live in a sibling module
// (`git-porcelain-parse.ts`) so unit tests can load them without bringing
// the worker's top-level side effects (parentPort listener + ready emit).
// Imports are kept tight to avoid pulling main-process / Electron deps
// into the worker bundle.

async function computeMirrorState(cwd: string): Promise<MirrorState> {
  const capturedAt = Date.now()
  const generation = currentGeneration(cwd)
  const meta = await getRepoMeta(cwd)

  if (!meta.isRepo || !meta.repoRoot) {
    return {
      cwd,
      repoRoot: null,
      repoName: null,
      branch: null,
      status: null,
      files: [],
      capturedAt,
      generation
    }
  }

  const repoName = (() => {
    const parts = meta.repoRoot.replace(/[\\/]+$/, '').split(/[\\/]/)
    return parts[parts.length - 1] || null
  })()

  try {
    const stdout = await spawnGit(
      [
        '-c', 'core.quotepath=false',
        'status',
        '--porcelain=2',
        '--branch',
        '-z',
        '--untracked-files=all'
      ],
      meta.repoRoot
    )
    const parsed = parseStatusPorcelainV2Z(stdout, meta.repoRoot)
    return {
      cwd,
      repoRoot: meta.repoRoot,
      repoName,
      branch: parsed.branch,
      status: parsed.status,
      files: parsed.files,
      capturedAt,
      generation
    }
  } catch (error) {
    log('warn', 'git status failed; emitting unknown state', {
      cwd,
      error: error instanceof Error ? error.message : String(error)
    })
    return {
      cwd,
      repoRoot: meta.repoRoot,
      repoName,
      branch: null,
      status: 'unknown',
      files: [],
      capturedAt,
      generation
    }
  }
}

// ---------------------------------------------------------------------------
// Event-driven recompute loop
// ---------------------------------------------------------------------------

function scheduleRecompute(entry: MirrorWorkerEntryCore): void {
  if (shuttingDown) return
  if (entry.debounceTimer) return
  if (entry.pendingSince === null) entry.pendingSince = Date.now()
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null
    entry.pendingSince = null
    entry.pendingPaths.clear()
    void runRecompute(entry)
  }, DEBOUNCE_MS)
}

async function runRecompute(entry: MirrorWorkerEntryCore): Promise<void> {
  if (shuttingDown) return
  if (entry.detachRequested) return
  const generation = beginMirrorRecompute(entry)
  let next: MirrorState
  try {
    next = await computeMirrorState(entry.cwd)
  } catch (error) {
    log('error', 'computeMirrorState threw', {
      cwd: entry.cwd,
      error: error instanceof Error ? error.message : String(error)
    })
    return
  }
  const delta = finishMirrorRecomputeIfCurrent(entry, generation, next)
  if (!delta) return // stale, detached, or no-op
  // Short-circuit: only emit when delta has actual fields beyond capturedAt.
  if (Object.keys(delta).length <= 1) return
  emit({ kind: 'mirror-update', cwd: entry.cwd, state: next, delta })
}

async function startWatcher(entry: MirrorWorkerEntryCore): Promise<() => Promise<void>> {
  if (shuttingDown) {
    throw new Error('worker is shutting down')
  }
  // Single parcel-watcher subscription covering both working tree and
  // .git/**. The callback uses classifyEventPath to drop noise (objects,
  // lockfiles, tmpfiles) and keep state-relevant paths.
  const subscription = await parcelWatcher.subscribe(entry.watchedRoot, (err, events) => {
    if (shuttingDown) return
    if (err) {
      log('error', 'parcel-watcher error', {
        cwd: entry.cwd,
        error: err.message
      })
      // Phase 5: explicit watcher-failure signal to main + renderer. No
      // silent fallback / polling — UI banner asks the user to manually
      // refresh if they care about FS-event freshness.
      emit({ kind: 'watcher-error', cwd: entry.cwd, message: err.message })
      return
    }
    if (entry.detachRequested) return
    let kept = 0
    for (const event of events) {
      const classified = classifyEventPath(event.path, entry.watchedRoot)
      if (classified.drop) continue
      entry.pendingPaths.add(event.path)
      kept += 1
    }
    if (kept > 0) {
      scheduleRecompute(entry)
    }
  })

  return async () => {
    try {
      await subscription.unsubscribe()
    } catch (error) {
      log('warn', 'parcel-watcher unsubscribe failed', {
        cwd: entry.cwd,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleAttachWatch(cwd: string): Promise<void> {
  if (shuttingDown) return
  let entry = entries.get(cwd)
  if (!entry) {
    entry = createMirrorWorkerEntry(cwd)
    entries.set(cwd, entry)
  }

  const transition = requestMirrorAttach(entry)
  if (transition !== 'start') {
    // Already attached or attach in flight; the original attach delivers
    // mirror-update naturally — nothing new to do here.
    return
  }

  // We own the attach. Compute initial state first so consumers receive
  // a snapshot immediately upon attach.
  try {
    await runRecompute(entry)
  } catch (error) {
    log('warn', 'initial recompute failed during attach', {
      cwd,
      error: error instanceof Error ? error.message : String(error)
    })
  }

  let dispose: (() => Promise<void>) | null = null
  try {
    dispose = await startWatcher(entry)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('error', 'failed to start parcel-watcher', { cwd, error: message })
    // Phase 5: parcel-watcher subscribe failure (NFS, sandboxing, etc.)
    // → renderer banner. Loud failure beats silent staleness.
    emit({ kind: 'watcher-error', cwd, message })
    entry.attachInFlight = false
    return
  }

  const result = await completeMirrorAttach(entry, dispose)
  if (result === 'detached') {
    entries.delete(cwd)
  }
}

async function handleDetachWatch(cwd: string): Promise<void> {
  const entry = entries.get(cwd)
  if (!entry) return
  const result = await requestMirrorDetach(entry)
  if (result === 'detached' || result === 'idle') {
    entries.delete(cwd)
  }
}

async function handleFocusResync(cwd: string | null): Promise<void> {
  if (shuttingDown) return
  if (!cwd) return
  const entry = entries.get(cwd)
  if (!entry) return
  // Event-driven nudge — user focused this terminal OR clicked Refresh
  // Changes. Force recompute immediately (skip debounce) since this is
  // a high-priority user signal. Phase 2: bump the per-cwd generation
  // counter so the renderer's DiffEditor key changes even when the
  // underlying state is byte-identical. This is the cascade that makes
  // Refresh Changes actually re-mount the full chain.
  nextGeneration(cwd)
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer)
    entry.debounceTimer = null
    entry.pendingSince = null
    entry.pendingPaths.clear()
  }
  await runRecompute(entry)
}

async function handleRequestFileBody(
  cwd: string,
  fileKey: string,
  force: boolean,
  replyId: number
): Promise<void> {
  if (shuttingDown) return
  try {
    const body = await readFileBody(cwd, fileKey, force)
    emit({ kind: 'file-body-update', replyId, body })
  } catch (error) {
    emit({
      kind: 'file-body-update',
      replyId,
      body: null,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function shutdownWorker(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  for (const entry of entries.values()) {
    try {
      await requestMirrorDetach(entry)
    } catch { /* shutdown must continue */ }
  }

  if (inFlightOperations.size > 0) {
    await Promise.allSettled(Array.from(inFlightOperations))
  }

  for (const entry of entries.values()) {
    try {
      await requestMirrorDetach(entry)
    } catch { /* shutdown must continue */ }
  }

  entries.clear()
  bodyCache.clear()
  mirrorGenerations.clear()
  await delay(NATIVE_WATCHER_SHUTDOWN_DRAIN_MS)
  emit({ kind: 'shutdown-complete' })
  parentPort?.close()
}

async function readFileBody(cwd: string, fileKey: string, force: boolean): Promise<MirrorFileBody | null> {
  const entry = entries.get(cwd)
  const repoRoot = entry?.state?.repoRoot ?? cwd
  const filename = fileKey

  const absPath = isAbsolute(filename) ? filename : join(repoRoot, filename)
  let statToken = '-'
  try {
    const st = await fs.stat(absPath)
    statToken = `${Math.floor(st.mtimeMs)}:${st.size}`
  } catch {
    statToken = 'missing'
  }

  const cacheKey = `${cwd}\0${fileKey}`
  if (!force) {
    const cached = bodyCache.get(cacheKey)
    if (cached && cached.statToken === statToken) {
      return cached.body
    }
  }

  let originalContent = ''
  try {
    const buf = await spawnGitBinary(['show', `HEAD:${filename}`], repoRoot)
    originalContent = buf.toString('utf8')
  } catch {
    originalContent = ''
  }

  let modifiedContent = ''
  let isBinary = false
  if (statToken === 'missing') {
    modifiedContent = ''
  } else {
    try {
      const buf = await fs.readFile(absPath)
      const probe = buf.subarray(0, Math.min(buf.length, 8192))
      isBinary = probe.includes(0)
      modifiedContent = isBinary ? '' : buf.toString('utf8')
    } catch {
      modifiedContent = ''
    }
  }

  const body: MirrorFileBody = {
    cwd,
    fileKey,
    filename,
    originalContent,
    modifiedContent,
    isBinary,
    statToken
  }
  bodyCache.set(cacheKey, { body, statToken })
  return body
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------

if (!parentPort) {
  console.error('[git-state-mirror-worker] no parentPort; refusing to start')
  process.exit(1)
}

parentPort.on('message', (msg: MainToMirrorMessage) => {
  switch (msg.kind) {
    case 'attach-watch':
      if (!shuttingDown) trackOperation('attach-watch', handleAttachWatch(msg.cwd))
      return
    case 'detach-watch':
      if (!shuttingDown) trackOperation('detach-watch', handleDetachWatch(msg.cwd))
      return
    case 'switch-cwd':
      // Terminal cwd hint; recompute belongs to the new cwd's entry if
      // anyone subscribed. attach/detach handle the subscription side —
      // here we just nudge a recompute for the new cwd's entry if it
      // exists. Still event-driven (this message IS the event).
      if (msg.newCwd) {
        const e = entries.get(msg.newCwd)
        if (e && !shuttingDown) trackOperation('switch-cwd', handleFocusResync(msg.newCwd))
      }
      return
    case 'request-file-body':
      if (!shuttingDown) trackOperation('request-file-body', handleRequestFileBody(msg.cwd, msg.fileKey, msg.force, msg.replyId))
      return
    case 'focus-resync':
      if (!shuttingDown) trackOperation('focus-resync', handleFocusResync(msg.cwd))
      return
    case 'shutdown':
      void shutdownWorker().catch((error) => {
        log('error', 'shutdown failed', {
          error: error instanceof Error ? error.message : String(error)
        })
        parentPort?.close()
      })
      return
    default: {
      const exhaustive: never = msg
      log('warn', 'unknown message kind', { kind: (exhaustive as { kind?: string })?.kind })
    }
  }
})

// Announce readiness. From this point on the worker is purely reactive:
// only acts on incoming messages or parcel-watcher events. No recurring
// timer, no polling loop, no setInterval anywhere.
emit({ kind: 'ready' })
