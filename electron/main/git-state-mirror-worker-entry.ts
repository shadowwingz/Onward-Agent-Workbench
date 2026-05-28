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
 * File watcher failures are supervised inside this Worker Thread: Parcel
 * stays the recursive fast path, while transient failures use restart
 * backoff and temporary low-frequency git-status polling.
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
  computeMirrorWatcherBackoffMs,
  createMirrorWorkerEntry,
  finishMirrorRecomputeIfCurrent,
  hardenReadonlyGitEnv,
  isMirrorWatcherPathMissingError,
  MIRROR_WATCHER_DEGRADED_POLLING_INTERVAL_MS,
  MIRROR_WATCHER_IGNORE,
  MIRROR_WATCHER_POLLING_FAILURE_THRESHOLD,
  MIRROR_WATCHER_SUSPENDED_PROBE_INTERVAL_MS,
  normaliseMirrorRepoRootKey,
  requestMirrorAttach,
  requestMirrorDetach,
  resolveMirrorWatcherRoot,
  type MirrorWorkerEntryCore
} from './git-state-mirror-worker-core'
import { buildMirrorChangeFingerprint } from './git-state-mirror-change-fingerprint'
import { parseStatusPorcelainV2Z } from './git-porcelain-parse'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

import type {
  MainToMirrorMessage,
  MirrorFileBody,
  MirrorState,
  MirrorToMainMessage,
  MirrorWatcherFailureKind,
  MirrorWatcherHealth,
  MirrorWatcherStatus
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

interface MirrorWatcherGroup {
  repoRoot: string
  repoRootKey: string
  entries: Set<string>
  dispose: (() => Promise<void>) | null
  health: MirrorWatcherHealth
  message: string | null
  failureKind: MirrorWatcherFailureKind | null
  failureCount: number
  consecutivePollingFailures: number
  restartTimer: NodeJS.Timeout | null
  pollTimer: NodeJS.Timeout | null
  suspendedProbeTimer: NodeJS.Timeout | null
  pollInFlight: boolean
  attachInFlight: boolean
  restartGeneration: number
  nextRetryAt: number | null
  callbackFailureInjected: boolean
}

const watcherGroups = new Map<string, MirrorWatcherGroup>()
const entryToGroupKey = new Map<string, string>()

const autotestWatcherFailSubscribeOnce =
  process.env.ONWARD_AUTOTEST === '1' &&
  process.env.ONWARD_AUTOTEST_GSM_WATCHER_FAIL_SUBSCRIBE_ONCE === '1'
const autotestWatcherFailCallbackOnce =
  process.env.ONWARD_AUTOTEST === '1' &&
  process.env.ONWARD_AUTOTEST_GSM_WATCHER_FAIL_CALLBACK_ONCE === '1'
let autotestSubscribeFailurePending = autotestWatcherFailSubscribeOnce

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

if (autotestWatcherFailSubscribeOnce || autotestWatcherFailCallbackOnce) {
  log('warn', 'autotest watcher failure injection active', {
    subscribeOnce: autotestWatcherFailSubscribeOnce,
    callbackOnce: autotestWatcherFailCallbackOnce
  })
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
  // Mirror git calls are read-only; disable git's opportunistic index-refresh
  // lock so `git status` never rewrites .git/index and re-triggers the watcher.
  return hardenReadonlyGitEnv(env)
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
      changeFingerprint: '',
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
    const changeFingerprint = await buildMirrorChangeFingerprint(meta.repoRoot, stdout, parsed.files)
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_CHANGE_FINGERPRINT, {
      repoRoot: meta.repoRoot,
      fileCount: changeFingerprint.fileCount,
      statCount: changeFingerprint.statCount,
      missingCount: changeFingerprint.missingCount,
      durationMs: changeFingerprint.durationMs
    })
    return {
      cwd,
      repoRoot: meta.repoRoot,
      repoName,
      branch: parsed.branch,
      status: parsed.status,
      files: parsed.files,
      capturedAt,
      changeFingerprint: changeFingerprint.fingerprint,
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
      changeFingerprint: 'unknown',
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
    void runRecompute(entry, 'watcher')
  }, DEBOUNCE_MS)
}

async function runRecompute(
  entry: MirrorWorkerEntryCore,
  reason: 'attach' | 'watcher' | 'polling' | 'focus-resync' | 'osc-switch',
  options: { queueIfBusy?: boolean } = {}
): Promise<void> {
  if (shuttingDown) return
  if (entry.detachRequested) return
  if (entry.recomputeInFlight) {
    if (options.queueIfBusy !== false) {
      entry.recomputeQueued = true
    }
    return
  }
  entry.recomputeInFlight = true
  const startedAt = Date.now()
  const generation = beginMirrorRecompute(entry)
  let next: MirrorState
  try {
    next = await computeMirrorState(entry.cwd)
  } catch (error) {
    log('error', 'computeMirrorState threw', {
      cwd: entry.cwd,
      error: error instanceof Error ? error.message : String(error)
    })
    entry.recomputeInFlight = false
    if (entry.recomputeQueued && !entry.detachRequested && !shuttingDown) {
      entry.recomputeQueued = false
      scheduleRecompute(entry)
    }
    return
  }
  const delta = finishMirrorRecomputeIfCurrent(entry, generation, next)
  performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_RECOMPUTE_DONE, {
    cwd: entry.cwd,
    repoRoot: next.repoRoot,
    reason,
    fileCount: next.files.length,
    branch: next.branch,
    status: next.status,
    durationMs: Date.now() - startedAt
  })
  entry.recomputeInFlight = false
  if (entry.recomputeQueued && !entry.detachRequested && !shuttingDown) {
    entry.recomputeQueued = false
    scheduleRecompute(entry)
  }
  if (!delta) return // stale, detached, or no-op
  // Short-circuit: only emit when delta has actual fields beyond capturedAt.
  if (Object.keys(delta).length <= 1) return
  emit({ kind: 'mirror-update', cwd: entry.cwd, state: next, delta })
}

function activeEntriesForGroup(group: MirrorWatcherGroup): MirrorWorkerEntryCore[] {
  const active: MirrorWorkerEntryCore[] = []
  for (const cwd of group.entries) {
    const entry = entries.get(cwd)
    if (entry && !entry.detachRequested) {
      active.push(entry)
    }
  }
  return active
}

function createWatcherGroup(repoRoot: string): MirrorWatcherGroup {
  const repoRootKey = normaliseMirrorRepoRootKey(repoRoot)
  return {
    repoRoot,
    repoRootKey,
    entries: new Set(),
    dispose: null,
    health: 'idle',
    message: null,
    failureKind: null,
    failureCount: 0,
    consecutivePollingFailures: 0,
    restartTimer: null,
    pollTimer: null,
    suspendedProbeTimer: null,
    pollInFlight: false,
    attachInFlight: false,
    restartGeneration: 0,
    nextRetryAt: null,
    callbackFailureInjected: false
  }
}

function isWatcherGroupCurrent(group: MirrorWatcherGroup): boolean {
  return !shuttingDown && group.entries.size > 0 && watcherGroups.get(group.repoRootKey) === group
}

function setTimerUnref(timer: NodeJS.Timeout): NodeJS.Timeout {
  timer.unref?.()
  return timer
}

function clearGroupRestartTimer(group: MirrorWatcherGroup): void {
  if (group.restartTimer) {
    clearTimeout(group.restartTimer)
    group.restartTimer = null
  }
  group.nextRetryAt = null
}

function clearGroupPollTimer(group: MirrorWatcherGroup): void {
  if (group.pollTimer) {
    clearInterval(group.pollTimer)
    group.pollTimer = null
  }
  group.pollInFlight = false
}

function clearGroupProbeTimer(group: MirrorWatcherGroup): void {
  if (group.suspendedProbeTimer) {
    clearInterval(group.suspendedProbeTimer)
    group.suspendedProbeTimer = null
  }
}

function buildWatcherStatus(group: MirrorWatcherGroup, cwd: string): MirrorWatcherStatus {
  return {
    cwd,
    repoRoot: group.repoRoot,
    health: group.health,
    message: group.message,
    failureKind: group.failureKind,
    failureCount: group.failureCount,
    polling: Boolean(group.pollTimer),
    pollingIntervalMs: group.pollTimer ? MIRROR_WATCHER_DEGRADED_POLLING_INTERVAL_MS : null,
    nextRetryAt: group.nextRetryAt,
    updatedAt: Date.now()
  }
}

function emitWatcherStatus(group: MirrorWatcherGroup): void {
  for (const cwd of group.entries) {
    const status = buildWatcherStatus(group, cwd)
    const entry = entries.get(cwd)
    if (entry) {
      entry.watcherHealth = status.health
      entry.watcherFailureCount = status.failureCount
      entry.lastWatcherError = status.message
      entry.lastWatcherFailureKind = status.failureKind
      if (status.health === 'healthy') entry.lastWatcherHealthyAt = status.updatedAt
    }
    emit({ kind: 'watcher-status', status })
  }
}

function updateWatcherHealth(
  group: MirrorWatcherGroup,
  health: MirrorWatcherHealth,
  data: {
    message?: string | null
    failureKind?: MirrorWatcherFailureKind | null
  } = {}
): void {
  const prevHealth = group.health
  const prevMessage = group.message
  const prevKind = group.failureKind
  group.health = health
  if ('message' in data) group.message = data.message ?? null
  if ('failureKind' in data) group.failureKind = data.failureKind ?? null

  emitWatcherStatus(group)
  if (prevHealth !== group.health || prevMessage !== group.message || prevKind !== group.failureKind) {
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_STATUS_CHANGED, {
      repoRoot: group.repoRoot,
      health: group.health,
      failureKind: group.failureKind,
      failureCount: group.failureCount,
      polling: Boolean(group.pollTimer)
    })
  }
}

async function disposeGroupWatcher(group: MirrorWatcherGroup): Promise<void> {
  const dispose = group.dispose
  group.dispose = null
  if (!dispose) return
  try {
    await dispose()
  } catch (error) {
    log('warn', 'parcel-watcher unsubscribe failed', {
      repoRoot: group.repoRoot,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function scheduleGroupRecompute(group: MirrorWatcherGroup, paths: string[]): void {
  const activeEntries = activeEntriesForGroup(group)
  for (const entry of activeEntries) {
    for (const eventPath of paths) {
      entry.pendingPaths.add(eventPath)
    }
    scheduleRecompute(entry)
  }
}

function scheduleWatcherRestart(group: MirrorWatcherGroup, failureKind: MirrorWatcherFailureKind): void {
  if (shuttingDown || group.entries.size === 0) return
  if (group.restartTimer) return
  const delayMs = computeMirrorWatcherBackoffMs(group.failureCount)
  const generation = group.restartGeneration + 1
  group.restartGeneration = generation
  group.nextRetryAt = Date.now() + delayMs
  performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_RESTART_SCHEDULED, {
    repoRoot: group.repoRoot,
    health: group.health,
    failureKind,
    failureCount: group.failureCount,
    delayMs,
    polling: Boolean(group.pollTimer)
  })
  group.restartTimer = setTimerUnref(setTimeout(() => {
    group.restartTimer = null
    group.nextRetryAt = null
    if (shuttingDown || group.entries.size === 0 || group.restartGeneration !== generation) return
    void ensureWatcherForGroup(group, 'restart')
  }, delayMs))
  emitWatcherStatus(group)
}

async function runDegradedPoll(group: MirrorWatcherGroup): Promise<void> {
  if (shuttingDown || group.entries.size === 0) return
  if (group.pollInFlight) {
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_POLL, {
      repoRoot: group.repoRoot,
      result: 'skip-in-flight',
      polling: true
    })
    return
  }
  group.pollInFlight = true
  const startedAt = Date.now()
  try {
    const activeEntries = activeEntriesForGroup(group)
    await Promise.all(activeEntries.map((entry) => runRecompute(entry, 'polling', { queueIfBusy: false })))
    group.consecutivePollingFailures = 0
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_POLL, {
      repoRoot: group.repoRoot,
      result: 'success',
      entryCount: activeEntries.length,
      durationMs: Date.now() - startedAt
    })
  } catch (error) {
    group.consecutivePollingFailures += 1
    const message = error instanceof Error ? error.message : String(error)
    log('warn', 'degraded watcher polling failed', {
      repoRoot: group.repoRoot,
      failureCount: group.consecutivePollingFailures,
      error: message
    })
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_POLL, {
      repoRoot: group.repoRoot,
      result: 'error',
      error: message,
      failureCount: group.consecutivePollingFailures,
      durationMs: Date.now() - startedAt
    })
    if (group.consecutivePollingFailures >= MIRROR_WATCHER_POLLING_FAILURE_THRESHOLD) {
      updateWatcherHealth(group, 'failed', {
        message,
        failureKind: 'polling-error'
      })
      for (const cwd of group.entries) {
        emit({ kind: 'watcher-error', cwd, message })
      }
    }
  } finally {
    group.pollInFlight = false
  }
}

function startDegradedPolling(group: MirrorWatcherGroup, failureKind: MirrorWatcherFailureKind, message: string): void {
  if (!group.pollTimer) {
    group.pollTimer = setTimerUnref(setInterval(() => {
      void runDegradedPoll(group)
    }, MIRROR_WATCHER_DEGRADED_POLLING_INTERVAL_MS))
  }
  updateWatcherHealth(group, 'degraded-polling', {
    message,
    failureKind
  })
  void runDegradedPoll(group)
}

async function runSuspendedProbe(group: MirrorWatcherGroup): Promise<void> {
  if (shuttingDown || group.entries.size === 0) return
  const startedAt = Date.now()
  try {
    await fs.access(group.repoRoot, fsConstants.F_OK)
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_SUSPENDED_PROBE, {
      repoRoot: group.repoRoot,
      result: 'found',
      durationMs: Date.now() - startedAt
    })
    clearGroupProbeTimer(group)
    updateWatcherHealth(group, 'recovering', {
      message: null,
      failureKind: 'path-missing'
    })
    await ensureWatcherForGroup(group, 'suspended-probe')
  } catch (error) {
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_SUSPENDED_PROBE, {
      repoRoot: group.repoRoot,
      result: 'missing',
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    })
  }
}

async function enterSuspended(group: MirrorWatcherGroup, message: string): Promise<void> {
  clearGroupRestartTimer(group)
  clearGroupPollTimer(group)
  await disposeGroupWatcher(group)
  updateWatcherHealth(group, 'suspended', {
    message,
    failureKind: 'path-missing'
  })
  if (!group.suspendedProbeTimer) {
    group.suspendedProbeTimer = setTimerUnref(setInterval(() => {
      void runSuspendedProbe(group)
    }, MIRROR_WATCHER_SUSPENDED_PROBE_INTERVAL_MS))
  }
}

async function handleWatcherFault(
  group: MirrorWatcherGroup,
  failureKind: MirrorWatcherFailureKind,
  error: unknown
): Promise<void> {
  if (shuttingDown || group.entries.size === 0) return
  const message = error instanceof Error ? error.message : String(error)
  group.failureCount += 1
  group.message = message
  group.failureKind = failureKind
  log('warn', 'parcel-watcher fault; starting recovery supervisor', {
    repoRoot: group.repoRoot,
    failureKind,
    failureCount: group.failureCount,
    error: message
  })
  await disposeGroupWatcher(group)

  if (failureKind === 'path-missing' || isMirrorWatcherPathMissingError(error)) {
    await enterSuspended(group, message)
    return
  }

  updateWatcherHealth(group, 'recovering', {
    message,
    failureKind
  })
  startDegradedPolling(group, failureKind, message)
  scheduleWatcherRestart(group, failureKind)
}

async function startWatcherForGroup(group: MirrorWatcherGroup): Promise<() => Promise<void>> {
  if (shuttingDown) {
    throw new Error('worker is shutting down')
  }
  if (autotestSubscribeFailurePending) {
    autotestSubscribeFailurePending = false
    throw new Error('autotest subscribe failure')
  }
  // Single parcel-watcher subscription covering both working tree and
  // .git/**. The callback uses classifyEventPath to drop noise (objects,
  // lockfiles, tmpfiles) and keep state-relevant paths.
  const subscription = await parcelWatcher.subscribe(group.repoRoot, (err, events) => {
    if (shuttingDown) return
    if (err) {
      log('error', 'parcel-watcher error', {
        repoRoot: group.repoRoot,
        error: err.message
      })
      void handleWatcherFault(group, 'callback-error', err)
      return
    }
    if (group.entries.size === 0) return
    const keptPaths: string[] = []
    for (const event of events) {
      const classified = classifyEventPath(event.path, group.repoRoot)
      if (classified.drop) {
        performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_FILTERED, {
          repoRoot: group.repoRoot,
          path: event.path,
          kind: event.type,
          reason: classified.reason
        })
        continue
      }
      keptPaths.push(event.path)
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_FIRE, {
        repoRoot: group.repoRoot,
        path: event.path,
        kind: event.type
      })
    }
    if (keptPaths.length > 0) {
      scheduleGroupRecompute(group, keptPaths)
    }
  }, { ignore: [...MIRROR_WATCHER_IGNORE] })

  return async () => {
    try {
      await subscription.unsubscribe()
    } catch (error) {
      log('warn', 'parcel-watcher unsubscribe failed', {
        repoRoot: group.repoRoot,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

async function ensureWatcherForGroup(
  group: MirrorWatcherGroup,
  reason: 'initial' | 'restart' | 'suspended-probe'
): Promise<void> {
  if (!isWatcherGroupCurrent(group) || group.attachInFlight) return
  group.attachInFlight = true
  clearGroupRestartTimer(group)
  updateWatcherHealth(group, reason === 'initial' ? 'attaching' : 'recovering', {
    message: group.message,
    failureKind: group.failureKind
  })
  const startedAt = Date.now()
  try {
    await fs.access(group.repoRoot, fsConstants.F_OK)
  } catch (error) {
    group.attachInFlight = false
    await handleWatcherFault(group, 'path-missing', error)
    return
  }
  if (!isWatcherGroupCurrent(group)) {
    group.attachInFlight = false
    return
  }

  try {
    const dispose = await startWatcherForGroup(group)
    if (!isWatcherGroupCurrent(group)) {
      group.attachInFlight = false
      await dispose()
      return
    }
    group.dispose = dispose
    group.attachInFlight = false
    group.failureCount = 0
    group.consecutivePollingFailures = 0
    group.message = null
    group.failureKind = null
    clearGroupPollTimer(group)
    clearGroupProbeTimer(group)
    updateWatcherHealth(group, 'healthy', {
      message: null,
      failureKind: null
    })
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_RESTART_RESULT, {
      repoRoot: group.repoRoot,
      reason,
      result: 'success',
      durationMs: Date.now() - startedAt
    })
    await Promise.all(activeEntriesForGroup(group).map((entry) => runRecompute(entry, reason === 'initial' ? 'attach' : 'watcher')))
    if (autotestWatcherFailCallbackOnce && !group.callbackFailureInjected) {
      group.callbackFailureInjected = true
      setTimerUnref(setTimeout(() => {
        if (shuttingDown || group.entries.size === 0) return
        void handleWatcherFault(group, 'callback-error', new Error('autotest callback failure'))
      }, 20))
    }
  } catch (error) {
    group.attachInFlight = false
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_RESTART_RESULT, {
      repoRoot: group.repoRoot,
      reason,
      result: 'error',
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    })
    await handleWatcherFault(group, 'subscribe-error', error)
  }
}

async function detachEntryFromWatcherGroup(cwd: string): Promise<void> {
  const groupKey = entryToGroupKey.get(cwd)
  if (!groupKey) return
  const group = watcherGroups.get(groupKey)
  entryToGroupKey.delete(cwd)
  if (!group) return
  group.entries.delete(cwd)
  const entry = entries.get(cwd)
  if (entry) {
    entry.watcherGroupKey = null
    entry.watcherHealth = 'detached'
  }
  if (group.entries.size > 0) {
    emitWatcherStatus(group)
    return
  }
  clearGroupRestartTimer(group)
  clearGroupPollTimer(group)
  clearGroupProbeTimer(group)
  await disposeGroupWatcher(group)
  watcherGroups.delete(groupKey)
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
    await runRecompute(entry, 'attach')
  } catch (error) {
    log('warn', 'initial recompute failed during attach', {
      cwd,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  if (entry.detachRequested) {
    entry.attachInFlight = false
    entries.delete(cwd)
    return
  }

  const watcherRoot = resolveMirrorWatcherRoot(entry.state)
  if (!watcherRoot) {
    log('info', 'skipping parcel-watcher for non-git cwd', { cwd })
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_SKIPPED, {
      cwd,
      reason: 'non-git-cwd'
    })
    entry.attachInFlight = false
    if (entry.detachRequested) {
      entries.delete(cwd)
    }
    return
  }
  entry.watchedRoot = watcherRoot

  const repoRootKey = normaliseMirrorRepoRootKey(watcherRoot)
  let group = watcherGroups.get(repoRootKey)
  const created = !group
  if (!group) {
    group = createWatcherGroup(watcherRoot)
    watcherGroups.set(repoRootKey, group)
  }
  group.entries.add(entry.cwd)
  entryToGroupKey.set(entry.cwd, repoRootKey)
  entry.watcherGroupKey = repoRootKey

  const result = await completeMirrorAttach(entry, async () => {
    await detachEntryFromWatcherGroup(entry.cwd)
  })
  if (result === 'detached') {
    entries.delete(cwd)
    return
  }
  if (created) {
    await ensureWatcherForGroup(group, 'initial')
  } else {
    emitWatcherStatus(group)
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
  await runRecompute(entry, 'focus-resync')
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
  watcherGroups.clear()
  entryToGroupKey.clear()
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
    const st = await fs.stat(absPath, { bigint: true })
    statToken = `${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.mode}`
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

// Announce readiness. From this point on the worker reacts to incoming
// messages and parcel-watcher events; supervisor timers are only armed
// while a watcher is recovering, polling, or suspended.
emit({ kind: 'ready' })
