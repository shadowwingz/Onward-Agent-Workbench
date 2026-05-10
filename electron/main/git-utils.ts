/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { exec, execFile } from 'child_process'
import { createHash } from 'crypto'
import { promisify } from 'util'
import { platform, tmpdir } from 'os'
import { readFile, stat, writeFile, mkdir, access, mkdtemp, rm } from 'fs/promises'
import { constants } from 'fs'
import { resolve, relative, sep, isAbsolute, dirname, delimiter, basename, join } from 'path'
import { fileURLToPath } from 'url'
import { gitRuntimeManager, type GitTaskKind, type GitTaskPriority } from './git-runtime-manager'
import { MAX_IMAGE_FILE_SIZE, bufferToImageDataUrl, isSupportedImageFile } from './image-utils'
import { perfTraceLogger } from './perf-trace-logger'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { gitDiffCacheInvalidator } from './git-diff-cache-invalidator'
import { GitDiffRequestCacheController } from './git-diff-request-cache'
// Static circular import is intentional and safe: every consumer below
// reads `gitRepositorySnapshotService` / `snapshotToLegacySubmoduleInfos`
// from inside async function bodies, never at module-eval time. ESM live
// bindings + Rollup's circular-import support let both modules finish
// evaluating before the first call lands. We previously used a dynamic
// `require('./git-repository-snapshot-service')` to dodge the circular
// dep, but the bundler renames output chunks (esbuild content-hashes)
// and dynamic require paths don't survive that rename — production
// builds threw "Cannot find module './git-repository-snapshot-service'"
// at runtime.
import {
  gitRepositorySnapshotService,
  snapshotToLegacySubmoduleInfos
} from './git-repository-snapshot-service'

const PDF_EXT = '.pdf'
const EPUB_EXT = '.epub'
const MAX_PDF_DIFF_FILE_SIZE = 32 * 1024 * 1024
const MAX_EPUB_DIFF_FILE_SIZE = 16 * 1024 * 1024

function isPdfFilename(filename: string | undefined): boolean {
  return Boolean(filename && filename.toLowerCase().endsWith(PDF_EXT))
}

function isEpubFilename(filename: string | undefined): boolean {
  return Boolean(filename && filename.toLowerCase().endsWith(EPUB_EXT))
}

const rawExecAsync = promisify(exec)
const rawExecFileAsync = promisify(execFile)

type ExecResult = Awaited<ReturnType<typeof rawExecAsync>>
type ExecFileResult = Awaited<ReturnType<typeof rawExecFileAsync>>

type GitTaskMeta = {
  priority?: GitTaskPriority
  kind?: GitTaskKind
  repoKey?: string | null
  repoConcurrencyLimit?: number
  dedupeKey?: string
  label?: string
}

type PtyManagerModule = typeof import('./pty-manager')

let ptyManagerModulePromise: Promise<PtyManagerModule> | null = null

async function getPtyManager(): Promise<PtyManagerModule['ptyManager']> {
  if (!ptyManagerModulePromise) {
    ptyManagerModulePromise = import('./pty-manager')
  }
  return (await ptyManagerModulePromise).ptyManager
}

function normalizeRepoKey(cwd: string | null | undefined): string | undefined {
  if (!cwd) return undefined
  const trimmed = cwd.trim()
  if (!trimmed) return undefined
  return resolve(trimmed)
}

function normalizeExecCwd(cwd: string | URL | undefined): string | undefined {
  if (typeof cwd === 'string') return cwd
  if (cwd instanceof URL) return fileURLToPath(cwd)
  return undefined
}

function normalizeGitPath(pathValue: string | null | undefined): string | null {
  if (!pathValue) return null
  return pathValue.replace(/\\/g, '/')
}

async function execAsync(command: string, options?: Parameters<typeof rawExecAsync>[1], meta: GitTaskMeta = {}): Promise<ExecResult> {
  return gitRuntimeManager.enqueueTask(
    {
      key: meta.dedupeKey,
      repoKey: normalizeRepoKey(meta.repoKey ?? normalizeExecCwd(options?.cwd)),
      repoConcurrencyLimit: meta.repoConcurrencyLimit,
      priority: meta.priority || 'normal',
      kind: meta.kind || 'git',
      label: meta.label || command
    },
    () => rawExecAsync(command, options)
  )
}

function classifyExecBinary(file: string): { binary: string; isGit: boolean } {
  const raw = basename(file).toLowerCase()
  const binary = raw.endsWith('.exe') ? raw.slice(0, -4) : raw
  return { binary, isGit: binary === 'git' }
}

export async function execFileAsync(
  file: string,
  args: string[],
  options?: Parameters<typeof rawExecFileAsync>[2],
  meta: GitTaskMeta = {}
): Promise<ExecFileResult> {
  const label = [file, ...args].join(' ')
  const repoKey = normalizeRepoKey(meta.repoKey ?? normalizeExecCwd(options?.cwd))
  const { binary, isGit } = classifyExecBinary(file)
  return gitRuntimeManager.enqueueTask(
    {
      key: meta.dedupeKey,
      repoKey,
      repoConcurrencyLimit: meta.repoConcurrencyLimit,
      priority: meta.priority || 'normal',
      kind: meta.kind || 'git',
      label: meta.label || label
    },
    async () => {
      const startMs = Date.now()
      const basePayload: Record<string, unknown> = isGit
        ? { subcommand: args[0] ?? null }
        : { binary, firstArg: args[0] ?? null }
      basePayload.repoKey = repoKey ?? null
      basePayload.kind = meta.kind || 'git'
      basePayload.priority = meta.priority || 'normal'
      basePayload.argsLen = args.length
      const eventName = isGit ? PERF_TRACE_EVENT.MAIN_GIT_EXEC : PERF_TRACE_EVENT.MAIN_PROC_EXEC
      try {
        const result = await rawExecFileAsync(file, args, options)
        perfTraceLogger.record(eventName, {
          ...basePayload,
          durationMs: Date.now() - startMs,
          ok: true
        })
        return result
      } catch (error) {
        const err = error as NodeJS.ErrnoException & { code?: string | number }
        perfTraceLogger.record(eventName, {
          ...basePayload,
          durationMs: Date.now() - startMs,
          ok: false,
          exitCode: typeof err?.code === 'number' ? err.code : null,
          errCode: typeof err?.code === 'string' ? err.code : null
        })
        throw error
      }
    }
  )
}

export type GitChangeType = 'unstaged' | 'staged' | 'untracked' | 'conflict'
export type GitResourceGroup = 'workingTree' | 'index' | 'untracked' | 'merge'
export type GitResourceRef = 'HEAD' | 'index' | 'workingTree' | 'empty'
export type GitStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | '?' | '!'

export interface GitSubmoduleInfo {
  name: string
  path: string
  repoRoot: string
  depth: number
  parentRoot: string
}

export interface GitRepoContext {
  root: string
  label: string
  isSubmodule: boolean
  depth: number
  changeCount: number
  parentRoot?: string
  loading?: boolean
}

// Git file status
export interface GitFileStatus {
  filename: string
  originalFilename?: string
  status: GitStatusCode
  additions: number
  deletions: number
  changeType: GitChangeType
  resourceGroup: GitResourceGroup
  originalRef: GitResourceRef | null
  modifiedRef: GitResourceRef | null
  repoRoot?: string
  repoLabel?: string
  isSubmoduleEntry?: boolean
  // Parsed from porcelain v2 sub field S<c><m><u>. Populated only when
  // isSubmoduleEntry is true. The parent's file list keeps the entry only
  // when commitChanged is true; m/u-only state belongs to the submodule's
  // own diff section, not the parent's.
  submoduleFlags?: {
    commitChanged: boolean
    workTreeModified: boolean
    untrackedContent: boolean
  }
}

// Git Diff results
export interface GitDiffResult {
  success: boolean
  cwd: string
  isGitRepo: boolean
  gitInstalled: boolean
  files: GitFileStatus[]
  repos?: GitRepoContext[]
  superprojectRoot?: string
  submodulesLoading?: boolean
  error?: string
}

export interface GitDiffLoadOptions {
  scope?: 'root-only' | 'full'
  // When true, bypass the request-level cache (the watcher-driven
  // invalidator is the primary freshness mechanism, but force is the
  // deterministic backstop for subpage entry where the watcher may not
  // yet have observed an FS event before the call lands).
  force?: boolean
}

export interface GitCommitInfo {
  sha: string
  shortSha: string
  parents: string[]
  summary: string
  body: string
  authorName: string
  authorEmail: string
  authorDate: string
  refs?: string
}

export interface GitHistoryResult {
  success: boolean
  cwd: string
  isGitRepo: boolean
  gitInstalled: boolean
  commits: GitCommitInfo[]
  totalCount?: number
  repos?: GitRepoContext[]
  superprojectRoot?: string
  error?: string
}

export interface GitHistoryFile {
  filename: string
  originalFilename?: string
  status: GitStatusCode
  additions: number
  deletions: number
  isImage?: boolean
  isSvg?: boolean
  isPdf?: boolean
  isEpub?: boolean
}

export interface GitHistoryDiffOptions {
  base: string
  head: string
  filePath?: string
  hideWhitespace?: boolean
  includeFiles?: boolean
}

export interface GitHistoryDiffResult {
  success: boolean
  cwd: string
  isGitRepo: boolean
  gitInstalled: boolean
  base: string
  head: string
  patch: string
  files: GitHistoryFile[]
  error?: string
}

export interface GitHistoryFileContentOptions {
  base: string
  head: string
  file: Pick<GitHistoryFile, 'filename' | 'originalFilename' | 'status'>
}

export interface GitHistoryFileContentResult extends GitFileContentResult {
  base: string
  head: string
}

export interface TerminalGitInfo {
  cwd: string | null
  repoRoot: string | null
  branch: string | null
  repoName: string | null
  status: TerminalGitStatus | null
}

export type TerminalGitStatus = 'clean' | 'modified' | 'added' | 'unknown'

// Cache-state vocabulary lives in a leaf module (no electron / IPC deps) so
// the cache classification chain stays unit-testable. We import the types
// for local use AND re-export them so existing call sites keep working.
import type {
  GitDiffContentCacheMissReason,
  GitDiffContentCacheSource,
  GitDiffContentCacheInfo,
  GitFileContentRequestOptions
} from './git-diff-content-cache-state'

export type {
  GitDiffContentCacheMissReason,
  GitDiffContentCacheSource,
  GitDiffContentCacheInfo,
  GitFileContentRequestOptions
}

// Git file content results
export interface GitFileContentResult {
  success: boolean
  cwd: string
  filename: string
  originalContent: string
  modifiedContent: string
  isBinary: boolean
  isImage?: boolean
  isSvg?: boolean
  originalImageUrl?: string
  modifiedImageUrl?: string
  originalImageSize?: number
  modifiedImageSize?: number
  cacheInfo?: GitDiffContentCacheInfo
  error?: string
}

// Git file save results
export interface GitFileSaveResult {
  success: boolean
  filename: string
  error?: string
}

export interface GitFileActionResult {
  success: boolean
  filename: string
  error?: string
}

// Timeout for command execution (milliseconds)
export const EXEC_TIMEOUT = 10000
const MAX_FILE_SIZE = 1024 * 1024  // 1MB
export const MAX_DIFF_OUTPUT = 10 * 1024 * 1024 // 10MB

// Short TTL + in-flight reuse: avoid frequent forks (lsof/git) causing CPU spikes and cwd read failures.
const TERMINAL_CWD_CACHE_TTL = 1200
const TERMINAL_INFO_CACHE_TTL = 2000
const GIT_META_CACHE_TTL = 1000
const GIT_DIFF_REQUEST_CACHE_TTL = 250
let cachedGitExecutable: string | null | undefined
let cachedGitAvailable: boolean | null = null
let cachedGitCheckedAt: number | null = null

// Diagnosis timeline (for maintenance; retain the key evidence points)
// T0 reproduction: sample repository -> ProjectEditor -> open Git Diff; CPU spikes and occasionally reports "not a Git repository".
// T0+ sample: /usr/bin/sample(main) shows uv_spawn/posix_spawn hotspots, indicating a child-process creation storm.
// T0+ log: gitdiff:view in /tmp/onward_debug.log falls back to the user home directory instead of the repository root.
// T0+ trace: TerminalGrid periodic refresh -> terminal-session-manager -> getTerminalInfo -> getTerminalCwd.
// T0+ root cause: polling re-entry/concurrency repeatedly forks lsof/git in a short window, saturating the main process and causing cwd reads to fail.
// T0+ fix: add short-TTL caches for cwd/info plus in-flight deduplication to stop the concurrency storm.
const terminalCwdCache = new Map<string, { value: string | null; at: number }>()
const terminalCwdInFlight = new Map<string, Promise<string | null>>()
const terminalInfoCache = new Map<string, { value: TerminalGitInfo; at: number }>()
const terminalInfoInFlight = new Map<string, Promise<TerminalGitInfo>>()
const gitMetaCache = new Map<string, { value: GitRepoMeta; at: number }>()
const gitMetaInFlight = new Map<string, Promise<GitRepoMeta>>()
// TTL shared by `detectSuperproject`'s cache; the legacy
// `submoduleCache` was removed when `detectSubmodulesRecursive` migrated
// to the snapshot service (which owns its own cache).
const SUBMODULE_CACHE_TTL = 5000
const superprojectCache = new Map<string, { value: string | null; at: number }>()
const singleRepoDiffCache = new Map<string, { value: { files: GitFileStatus[]; error?: string }; at: number }>()
const singleRepoDiffInFlight = new Map<string, Promise<{ files: GitFileStatus[]; error?: string }>>()
let gitDiffRequestCacheController: GitDiffRequestCacheController<GitDiffResult> | null = null

/**
 * Clear every cached `getGitDiff` result for `cwd`:
 *   - request-level cache (`gitDiffRequestCache`)
 *   - per-repo file-list cache (`singleRepoDiffCache`)
 *   - structural snapshot cache (`gitRepositorySnapshotService`)
 * Returns the number of `gitDiffRequestCache` entries dropped — useful
 * for the trace payload so an SQL query can correlate "watcher fired"
 * with "cache actually held something."
 *
 * Exported because both the watcher listener (main thread) AND the
 * git-ipc-worker need to call it. The watcher only fires in main, but
 * `getGitDiff` (and the caches it owns) live in BOTH module instances —
 * so when main's watcher invalidates, main's IPC handler explicitly
 * forwards the event to the worker via
 * `gitIpcWorkerClient.invalidateDiffCache`, and the worker entry calls
 * this function on its own copies.
 */
export function invalidateGitDiffCache(cwd: string, reason: string): number {
  const normalized = resolve(cwd)
  let cleared = 0
  for (const scope of ['root-only', 'full'] as const) {
    if (invalidateGitDiffRequestKey(`${normalized}::${scope}`)) {
      cleared += 1
    }
  }
  clearSingleRepoDiffCache(normalized)
  // Also drop the structural snapshot. We do this AFTER the diff caches
  // because if a future regression causes the snapshot service to throw,
  // at least the request/file caches have already been cleared and the
  // user gets a fresh git invocation on the next call.
  gitRepositorySnapshotService.invalidate(normalized)
  perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CACHE_INVALIDATE, {
    cwd: normalized,
    reason,
    entriesCleared: cleared
  })
  return cleared
}

// Lazily wire the watcher → cache invalidation chain. The first getGitDiff
// call subscribes; subsequent calls just register a watcher for any new cwd.
// We never unsubscribe — a single process-wide listener is correct.
let gitDiffCacheInvalidatorWired = false
function wireGitDiffCacheInvalidatorOnce(): void {
  if (gitDiffCacheInvalidatorWired) return
  gitDiffCacheInvalidatorWired = true
  gitDiffCacheInvalidator.addListener((cwd, reason) => {
    invalidateGitDiffCache(cwd, reason)
  })
}

export function getExecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH'
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
    extraPaths.push('/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin')
  }

  const merged = [
    ...currentPath.split(delimiter).filter(Boolean),
    ...extraPaths
  ]
  env[pathKey] = Array.from(new Set(merged)).join(delimiter)
  return env
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, platform() === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function formatGitError(error: unknown): string {
  if (!error) return ''
  const anyError = error as { stderr?: string | Buffer; message?: string }
  if (anyError.stderr) {
    const stderrText = typeof anyError.stderr === 'string'
      ? anyError.stderr
      : anyError.stderr.toString('utf-8')
    return stderrText.trim()
  }
  if (anyError.message) return anyError.message.trim()
  return String(error).trim()
}

async function resolveGitExecutable(): Promise<string | null> {
  if (cachedGitExecutable !== undefined) return cachedGitExecutable

  const candidates: string[] = []
  const envGitPath = process.env.GIT_PATH
  if (envGitPath) {
    candidates.push(envGitPath)
  }

  if (platform() === 'win32') {
    candidates.push(
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\bin\\git.exe'
    )
  } else {
    candidates.push(
      '/usr/bin/git',
      '/opt/homebrew/bin/git',
      '/usr/local/bin/git',
      '/opt/local/bin/git',
      '/bin/git'
    )
  }

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      cachedGitExecutable = candidate
      return candidate
    }
  }

  try {
    await execFileAsync(
      'git',
      ['--version'],
      { timeout: EXEC_TIMEOUT, env: getExecEnv() },
      { kind: 'misc', priority: 'low', dedupeKey: 'git:version:resolve' }
    )
    cachedGitExecutable = 'git'
    return cachedGitExecutable
  } catch {
    cachedGitExecutable = null
    return null
  }
}

function resolvePathInRepo(cwd: string, filename: string): string | null {
  const resolved = resolve(cwd, filename)
  const relativePath = relative(cwd, resolved)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null
  }
  return resolved
}

function toGitPath(cwd: string, filename: string): string | null {
  const resolved = resolvePathInRepo(cwd, filename)
  if (!resolved) return null
  const relativePath = relative(cwd, resolved)
  return relativePath.split(sep).join('/')
}

function hasNullByte(content: string): boolean {
  return content.includes('\u0000')
}

function normalizeGitStatusFromCode(statusCode: string): TerminalGitStatus {
  if (!statusCode) return 'clean'
  if (
    statusCode === '??' ||
    statusCode.includes('A') ||
    statusCode.includes('D') ||
    statusCode.includes('R') ||
    statusCode.includes('C')
  ) {
    return 'added'
  }
  if (statusCode.includes('M') || statusCode.includes('U')) {
    return 'modified'
  }
  return 'clean'
}

function mergeTerminalStatus(a: TerminalGitStatus, b: TerminalGitStatus): TerminalGitStatus {
  if (a === 'added' || b === 'added') return 'added'
  if (a === 'modified' || b === 'modified') return 'modified'
  if (a === 'unknown' || b === 'unknown') return 'unknown'
  return 'clean'
}

function parseStatusPorcelainOutput(output: string): TerminalGitStatus {
  if (!output.trim()) return 'clean'
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean)
  let status: TerminalGitStatus = 'clean'
  for (const line of lines) {
    const statusCode = line.substring(0, 2)
    status = mergeTerminalStatus(status, normalizeGitStatusFromCode(statusCode))
    if (status === 'added') return status
  }
  return status
}

export type GitBranchAndStatus = {
  branch: string | null
  status: TerminalGitStatus
}

function parsePorcelainV2BranchAndStatus(output: string): GitBranchAndStatus {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean)
  let branchHead: string | null = null
  let branchOid: string | null = null
  let status: TerminalGitStatus = 'clean'

  for (const line of lines) {
    if (line.startsWith('# branch.head ')) {
      branchHead = line.slice('# branch.head '.length).trim()
      continue
    }
    if (line.startsWith('# branch.oid ')) {
      branchOid = line.slice('# branch.oid '.length).trim()
      continue
    }

    if (line.startsWith('? ')) {
      status = 'added'
      continue
    }

    if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      const tokens = line.split(' ')
      const statusCode = tokens[1] || ''
      status = mergeTerminalStatus(status, normalizeGitStatusFromCode(statusCode))
      if (status === 'added') continue
    }
  }

  if (branchHead && branchHead !== '(detached)' && branchHead !== 'HEAD') {
    return { branch: branchHead, status }
  }

  if (branchHead === '(detached)' || branchHead === 'HEAD') {
    if (branchOid && branchOid !== '(initial)') {
      const shortSha = branchOid.slice(0, 7)
      return { branch: shortSha ? `detached@${shortSha}` : 'detached', status }
    }
    return { branch: 'detached', status }
  }

  return { branch: branchHead || null, status }
}

/**
 * Check if Git is installed
 */
export async function checkGitInstalled(): Promise<boolean> {
  if (cachedGitAvailable === true) {
    return true
  }
  if (cachedGitAvailable === false && cachedGitCheckedAt) {
    if (Date.now() - cachedGitCheckedAt < 5000) {
      return false
    }
  }

  const gitExecutable = await resolveGitExecutable()
  if (!gitExecutable) {
    cachedGitAvailable = false
    cachedGitCheckedAt = Date.now()
    return false
  }

  try {
    await execFileAsync(
      gitExecutable,
      ['--version'],
      { timeout: EXEC_TIMEOUT, env: getExecEnv() },
      { kind: 'misc', priority: 'low', dedupeKey: 'git:version:check-installed' }
    )
    cachedGitAvailable = true
    cachedGitCheckedAt = Date.now()
    return true
  } catch {
    cachedGitAvailable = false
    cachedGitCheckedAt = Date.now()
    return false
  }
}

/**
 * Get the terminal's working directory (via PID)
 */
export async function getTerminalCwd(terminalId: string): Promise<string | null> {
  const now = Date.now()
  const cached = terminalCwdCache.get(terminalId)
  if (cached && now - cached.at < TERMINAL_CWD_CACHE_TTL) {
    return cached.value
  }
  const inflight = terminalCwdInFlight.get(terminalId)
  if (inflight) {
    return inflight
  }

  const task: Promise<string | null> = (async () => {
    const probeStartedAt = Date.now()
    const ptyManager = await getPtyManager()
    const ptyProcess = ptyManager.get(terminalId)
    if (!ptyProcess) {
      terminalCwdCache.set(terminalId, { value: null, at: Date.now() })
      return null
    }

    const pid = ptyProcess.pid

    try {
      const os = platform()

      if (os === 'darwin' || os === 'linux') {
        // macOS/Linux uses single-process lsof to avoid pipeline chains creating additional child processes
        const { stdout } = await execFileAsync(
          'lsof',
          ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
          { timeout: EXEC_TIMEOUT, env: getExecEnv() },
          {
            kind: 'cwd',
            priority: 'high',
            dedupeKey: `cwd:lsof:${terminalId}:${pid}`,
            label: `lsof cwd pid=${pid}`
          }
        )
        const output = typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
        const cwdLine = output.split('\n').find((line) => line.startsWith('n')) || ''
        const cwd = cwdLine.slice(1).trim()
        const value = cwd || ptyManager.getCwd(terminalId)
        terminalCwdCache.set(terminalId, { value, at: Date.now() })
        return value
      } else if (os === 'win32') {
        // Windows: use CWD tracked via shell integration (OSC 9;9 escape
        // sequence emitted by the injected PowerShell prompt / cmd PROMPT).
        // The old approach — (Get-Process -Id $pid).Path | Split-Path —
        // returned the *executable* path, not the working directory.
        const trackedCwd = ptyManager.getCwd(terminalId)
        terminalCwdCache.set(terminalId, { value: trackedCwd, at: Date.now() })
        return trackedCwd
      }

      terminalCwdCache.set(terminalId, { value: null, at: Date.now() })
      return null
    } catch (error) {
      console.error('Failed to get terminal cwd:', error)
      const fallbackCwd = ptyManager.getCwd(terminalId)
      terminalCwdCache.set(terminalId, { value: fallbackCwd, at: Date.now() })
      return fallbackCwd
    } finally {
      gitRuntimeManager.recordCwdProbeLatency(Date.now() - probeStartedAt)
    }
  })()

  terminalCwdInFlight.set(terminalId, task)
  try {
    return await task
  } finally {
    terminalCwdInFlight.delete(terminalId)
  }
}

/**
 * Check whether the directory is a Git repository
 */
async function checkGitRepository(cwd: string, gitExecutable: string): Promise<{ isRepo: boolean; error?: string }> {
  try {
    await execFileAsync(
      gitExecutable,
      ['rev-parse', '--is-inside-work-tree'],
      {
        cwd,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      },
      {
        repoKey: cwd,
        priority: 'high',
        dedupeKey: `repo:check:${resolve(cwd)}`,
        label: 'git rev-parse --is-inside-work-tree'
      }
    )
    return { isRepo: true }
  } catch (error) {
    return {
      isRepo: false,
      error: formatGitError(error)
    }
  }
}

async function getGitRoot(cwd: string, gitExecutable: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      gitExecutable,
      ['rev-parse', '--show-toplevel'],
      {
        cwd,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      },
      {
        repoKey: cwd,
        priority: 'high',
        dedupeKey: `repo:root:${resolve(cwd)}`,
        label: 'git rev-parse --show-toplevel'
      }
    )
    const root = (typeof stdout === 'string' ? stdout : stdout.toString('utf-8')).trim()
    return root || null
  } catch {
    return null
  }
}

/**
 * Get the Git branch name (non-repository or null on failure)
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      {
        cwd,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      },
      {
        repoKey: cwd,
        priority: 'normal',
        dedupeKey: `branch:${resolve(cwd)}`,
        label: 'git rev-parse --abbrev-ref HEAD'
      }
    )
    const branch = (typeof stdout === 'string' ? stdout : stdout.toString('utf-8')).trim()
    if (!branch) return null
    if (branch === 'HEAD') {
      try {
        const { stdout: sha } = await execFileAsync(
          'git',
          ['rev-parse', '--short', 'HEAD'],
          {
            cwd,
            timeout: EXEC_TIMEOUT,
            env: getExecEnv()
          },
          {
            repoKey: cwd,
            priority: 'normal',
            dedupeKey: `branch-short:${resolve(cwd)}`,
            label: 'git rev-parse --short HEAD'
          }
        )
        const shortSha = (typeof sha === 'string' ? sha : sha.toString('utf-8')).trim()
        return shortSha ? `detached@${shortSha}` : 'detached'
      } catch {
        return 'detached'
      }
    }
    return branch
  } catch {
    return null
  }
}

/**
 * Get the Git repository name (not a repository or return null on failure)
 */
export async function getGitRepoName(cwd: string): Promise<string | null> {
  try {
    const meta = await getGitRepoMeta(cwd)
    const repoRoot = meta.repoRoot
    if (!repoRoot) return null
    const normalizedRoot = repoRoot.replace(/[\\/]+$/, '')
    const name = basename(normalizedRoot)
    return name || null
  } catch {
    return null
  }
}

export type GitRepoMeta = {
  gitExecutable: string | null
  repoRoot: string | null
  gitDir: string | null
  isRepo: boolean
}

export async function getGitRepoMeta(cwd: string): Promise<GitRepoMeta> {
  const normalizedCwd = resolve(cwd)
  const now = Date.now()
  const cached = gitMetaCache.get(normalizedCwd)
  if (cached && now - cached.at < GIT_META_CACHE_TTL) {
    return cached.value
  }

  const inflight = gitMetaInFlight.get(normalizedCwd)
  if (inflight) {
    return inflight
  }

  const task = (async () => {
    const gitExecutable = await resolveGitExecutable()
    if (!gitExecutable) {
      return { gitExecutable: null, repoRoot: null, gitDir: null, isRepo: false }
    }

    // Run all three rev-parse queries in a single git invocation
    // to cut 3 sequential process spawns down to 1
    try {
      const { stdout } = await execFileAsync(
        gitExecutable,
        ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-dir'],
        {
          cwd,
          timeout: EXEC_TIMEOUT,
          env: getExecEnv()
        },
        {
          repoKey: cwd,
          priority: 'high',
          dedupeKey: `repo:meta:${resolve(cwd)}`,
          label: 'git rev-parse --is-inside-work-tree --show-toplevel --git-dir'
        }
      )
      const output = (typeof stdout === 'string' ? stdout : stdout.toString('utf-8')).trim()
      const lines = output.split(/\r?\n/)
      // lines[0] = "true", lines[1] = repo root path, lines[2] = git dir path
      const isRepo = lines[0]?.trim() === 'true'
      if (!isRepo) {
        return { gitExecutable, repoRoot: null, gitDir: null, isRepo: false }
      }
      const repoRootRaw = lines[1]?.trim() || cwd
      const rawGitDir = lines[2]?.trim() || null
      const repoRoot = normalizeGitPath(repoRootRaw) || repoRootRaw
      const gitDir = rawGitDir
        ? (normalizeGitPath(isAbsolute(rawGitDir) ? rawGitDir : resolve(repoRootRaw, rawGitDir)) || rawGitDir)
        : null
      return { gitExecutable, repoRoot, gitDir, isRepo: true }
    } catch {
      return { gitExecutable, repoRoot: null, gitDir: null, isRepo: false }
    }
  })()

  gitMetaInFlight.set(normalizedCwd, task)
  try {
    const value = await task
    gitMetaCache.set(normalizedCwd, { value, at: Date.now() })
    return value
  } finally {
    gitMetaInFlight.delete(normalizedCwd)
  }
}

/**
 * Parse the Git repository root directory corresponding to the specified path.
 * Use getGitRepoMeta's cache to avoid repeated execution of git commands.
 * If it is not a Git repository, the original path is returned.
 */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  const meta = await getGitRepoMeta(cwd)
  return meta.repoRoot || cwd
}

export async function detectSuperproject(cwd: string, gitExecutable: string): Promise<string | null> {
  const normalizedCwd = resolve(cwd)
  const cached = superprojectCache.get(normalizedCwd)
  const now = Date.now()
  if (cached && now - cached.at < SUBMODULE_CACHE_TTL) {
    return cached.value
  }

  try {
    const { stdout } = await execFileAsync(
      gitExecutable,
      ['rev-parse', '--show-superproject-working-tree'],
      { cwd, timeout: EXEC_TIMEOUT, env: getExecEnv() },
      {
        repoKey: normalizedCwd,
        priority: 'normal',
        dedupeKey: `repo:superproject:${normalizedCwd}`,
        label: 'git rev-parse --show-superproject-working-tree'
      }
    )
    const value = normalizeGitPath((typeof stdout === 'string' ? stdout : stdout.toString('utf-8')).trim()) || null
    superprojectCache.set(normalizedCwd, { value, at: Date.now() })
    return value
  } catch {
    superprojectCache.set(normalizedCwd, { value: null, at: Date.now() })
    return null
  }
}

export function parseSubmoduleStatusOutput(output: string, repoRoot: string): GitSubmoduleInfo[] {
  if (!output.trim()) return []

  const submodules: GitSubmoduleInfo[] = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    if (line.trimStart().startsWith('-')) continue

    const match = line.match(/^[\s+U]*([0-9a-f]+)\s+(.+?)(?:\s+\(.*\))?$/)
    if (!match) continue

    const subPath = match[2].trim()
    if (!subPath) continue

    const subRepoRoot = normalizeGitPath(resolve(repoRoot, subPath)) || resolve(repoRoot, subPath)
    const depth = submodules.filter((submodule) => subPath.startsWith(`${submodule.path}/`)).length
    let parentRoot = repoRoot
    for (let index = submodules.length - 1; index >= 0; index -= 1) {
      if (subPath.startsWith(`${submodules[index].path}/`)) {
        parentRoot = submodules[index].repoRoot
        break
      }
    }

    submodules.push({
      name: basename(subPath),
      path: subPath,
      repoRoot: subRepoRoot,
      depth,
      parentRoot
    })
  }

  return submodules
}

export async function readGitmodulesSubmodulePaths(repoRoot: string): Promise<string[]> {
  try {
    const content = await readFile(join(repoRoot, '.gitmodules'), 'utf-8')
    const paths: string[] = []
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#') || line.startsWith(';')) {
        continue
      }
      const match = line.match(/^path\s*=\s*(.+)$/)
      if (!match) {
        continue
      }
      const pathValue = match[1].trim()
      if (pathValue) {
        paths.push(pathValue.replace(/\\/g, '/'))
      }
    }
    return paths
  } catch {
    return []
  }
}

async function getStatToken(path: string): Promise<string> {
  try {
    const info = await stat(path)
    return `${Math.floor(info.mtimeMs)}:${info.size}`
  } catch {
    return '-'
  }
}

export async function getGitRepoFingerprint(gitDir: string | null, repoRoot: string): Promise<string> {
  const root = gitDir || join(repoRoot, '.git')
  const [headToken, indexToken, packedRefsToken, refsToken, logsHeadToken] = await Promise.all([
    getStatToken(join(root, 'HEAD')),
    getStatToken(join(root, 'index')),
    getStatToken(join(root, 'packed-refs')),
    getStatToken(join(root, 'refs')),
    getStatToken(join(root, 'logs', 'HEAD'))
  ])
  return [headToken, indexToken, packedRefsToken, refsToken, logsHeadToken].join('|')
}

export async function getGitBranchAndStatus(
  cwd: string,
  options: { priority?: GitTaskPriority; includeUntracked?: boolean } = {}
): Promise<GitBranchAndStatus> {
  const meta = await getGitRepoMeta(cwd)
  if (!meta.isRepo || !meta.repoRoot) {
    return { branch: null, status: 'unknown' }
  }

  try {
    const untrackedArg = options.includeUntracked ? '--untracked-files=all' : '--untracked-files=no'
    const { stdout } = await execFileAsync(
      meta.gitExecutable || 'git',
      ['-c', 'core.quotepath=false', 'status', '--porcelain=2', '--branch', untrackedArg],
      {
        cwd: meta.repoRoot,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv(),
        maxBuffer: MAX_DIFF_OUTPUT
      },
      {
        repoKey: meta.repoRoot,
        repoConcurrencyLimit: 1,
        priority: options.priority || 'low',
        dedupeKey: `branch-status:${options.includeUntracked ? 'uall' : 'uno'}:${resolve(meta.repoRoot)}`,
        label: `git status --porcelain=2 --branch ${untrackedArg}`
      }
    )
    const output = typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
    return parsePorcelainV2BranchAndStatus(output)
  } catch {
    return { branch: null, status: 'unknown' }
  }
}

/**
 * Get Git status summary
 */
export async function getGitStatusSummary(cwd: string): Promise<TerminalGitStatus> {
  const gitExecutable = await resolveGitExecutable()
  if (!gitExecutable) {
    return 'unknown'
  }
  try {
    const { stdout } = await execFileAsync(
      gitExecutable,
      ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall'],
      {
        cwd,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv(),
        maxBuffer: MAX_DIFF_OUTPUT
      },
      {
        repoKey: cwd,
        priority: 'normal',
        label: 'git status --porcelain -uall'
      }
    )
    const output = typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
    return parseStatusPorcelainOutput(output)
  } catch {
    return 'unknown'
  }
}

/**
 * Get terminal Git information (cwd + branch)
 */
export async function getTerminalGitInfo(terminalId: string): Promise<TerminalGitInfo> {
  const now = Date.now()
  const cached = terminalInfoCache.get(terminalId)
  if (cached && now - cached.at < TERMINAL_INFO_CACHE_TTL) {
    return cached.value
  }
  const inflight = terminalInfoInFlight.get(terminalId)
  if (inflight) {
    return inflight
  }

  const task = (async () => {
    const cwd = await getTerminalCwd(terminalId)
    if (!cwd) {
      return { cwd: null, repoRoot: null, branch: null, repoName: null, status: null }
    }

    const meta = await getGitRepoMeta(cwd)
    if (!meta.isRepo || !meta.repoRoot) {
      return { cwd, repoRoot: null, branch: null, repoName: null, status: null }
    }

    const repoName = basename(meta.repoRoot.replace(/[\\/]+$/, '')) || null
    const branchStatus = await getGitBranchAndStatus(meta.repoRoot)
    return {
      cwd,
      repoRoot: meta.repoRoot,
      branch: branchStatus.branch,
      repoName,
      status: branchStatus.status
    }
  })()

  terminalInfoInFlight.set(terminalId, task)
  try {
    const info = await task
    terminalInfoCache.set(terminalId, { value: info, at: Date.now() })
    return info
  } finally {
    terminalInfoInFlight.delete(terminalId)
  }
}

function normalizeGitStatusCode(raw: string): GitStatusCode {
  const code = raw.trim()
  if (!code) return 'M'
  const lead = code.charAt(0)
  switch (lead) {
    case 'A':
    case 'D':
    case 'R':
    case 'C':
    case 'M':
      return lead
    case '?':
      return '?'
    case '!':
    case 'U':
      return '!'
    default:
      return 'M'
  }
}

function buildGitResourceFields(
  changeType: GitChangeType,
  status: GitStatusCode
): Pick<GitFileStatus, 'resourceGroup' | 'originalRef' | 'modifiedRef'> {
  if (changeType === 'conflict') {
    return { resourceGroup: 'merge', originalRef: null, modifiedRef: 'workingTree' }
  }
  if (changeType === 'staged') {
    return {
      resourceGroup: 'index',
      originalRef: status === 'A' || status === '?' ? 'empty' : 'HEAD',
      modifiedRef: status === 'D' ? 'empty' : 'index'
    }
  }
  if (changeType === 'untracked') {
    return { resourceGroup: 'untracked', originalRef: 'empty', modifiedRef: 'workingTree' }
  }
  return {
    resourceGroup: 'workingTree',
    originalRef: status === 'A' || status === '?' ? 'empty' : 'index',
    modifiedRef: status === 'D' ? 'empty' : 'workingTree'
  }
}

function createGitFileStatus(params: {
  filename: string
  originalFilename?: string
  status: GitStatusCode
  additions?: number
  deletions?: number
  changeType: GitChangeType
  isSubmoduleEntry?: boolean
  submoduleFlags?: GitFileStatus['submoduleFlags']
}): GitFileStatus {
  return {
    filename: params.filename,
    originalFilename: params.originalFilename,
    status: params.status,
    additions: params.additions ?? 0,
    deletions: params.deletions ?? 0,
    changeType: params.changeType,
    ...buildGitResourceFields(params.changeType, params.status),
    ...(params.isSubmoduleEntry ? { isSubmoduleEntry: true as const } : {}),
    ...(params.submoduleFlags ? { submoduleFlags: params.submoduleFlags } : {})
  }
}

function parseNameStatusZ(output: string): Array<{ status: GitStatusCode; filename: string; originalFilename?: string }> {
  if (!output) return []
  const tokens = output.split('\0')
  const entries: Array<{ status: GitStatusCode; filename: string; originalFilename?: string }> = []
  let i = 0
  while (i < tokens.length) {
    const statusToken = tokens[i]
    if (!statusToken) {
      i += 1
      continue
    }
    const statusCode = normalizeGitStatusCode(statusToken)
    if (statusCode === 'R' || statusCode === 'C') {
      const originalFilename = tokens[i + 1] || ''
      const filename = tokens[i + 2] || ''
      if (filename) {
        entries.push({
          status: statusCode,
          filename,
          originalFilename: originalFilename || undefined
        })
      }
      i += 3
      continue
    }
    const filename = tokens[i + 1] || ''
    if (filename) {
      entries.push({ status: statusCode, filename })
    }
    i += 2
  }
  return entries
}

function getFieldAfterSpaceCount(record: string, spacesBeforeField: number): string | null {
  let searchIndex = -1
  for (let count = 0; count < spacesBeforeField; count += 1) {
    searchIndex = record.indexOf(' ', searchIndex + 1)
    if (searchIndex === -1) {
      return null
    }
  }
  return record.slice(searchIndex + 1)
}

function parseStatusPorcelainV2Z(output: string): GitFileStatus[] {
  if (!output) return []
  const tokens = output.split('\0')
  const files: GitFileStatus[] = []

  let index = 0
  while (index < tokens.length) {
    const record = tokens[index]
    if (!record) {
      index += 1
      continue
    }

    if (record.startsWith('? ')) {
      const filename = record.slice(2)
      if (filename) {
        files.push(createGitFileStatus({
          filename,
          status: '?',
          changeType: 'untracked'
        }))
      }
      index += 1
      continue
    }

    if (!record.startsWith('1 ') && !record.startsWith('2 ') && !record.startsWith('u ')) {
      index += 1
      continue
    }

    const type = record.charAt(0)
    const xy = record.slice(2, 4)
    const indexStatus = xy.charAt(0)
    const worktreeStatus = xy.charAt(1)
    // Porcelain v2 sub field (positions 5-8): N... for non-submodule,
    // S<c><m><u> for submodule. The c/m/u sub-flags are required for the
    // parent-side filter (Bug 1 — only c=C should surface in the parent's
    // file list; m/u belong to the submodule's own diff section).
    const sub = record.slice(5, 9)
    const isSubmoduleEntry = sub.charAt(0) === 'S'
    const submoduleFlags = isSubmoduleEntry
      ? {
          commitChanged: sub.charAt(1) === 'C',
          workTreeModified: sub.charAt(2) === 'M',
          untrackedContent: sub.charAt(3) === 'U'
        }
      : undefined
    const filename = getFieldAfterSpaceCount(
      record,
      type === '1' ? 8 : type === '2' ? 9 : 10
    )
    const originalFilename = type === '2'
      ? (tokens[index + 1] || undefined)
      : undefined

    if (!filename) {
      index += type === '2' ? 2 : 1
      continue
    }

    if (type === 'u') {
      files.push(createGitFileStatus({
        filename,
        status: '!',
        changeType: 'conflict',
        isSubmoduleEntry,
        submoduleFlags
      }))
      index += 1
      continue
    }

    if (indexStatus && indexStatus !== '.') {
      files.push(createGitFileStatus({
        filename,
        originalFilename: indexStatus === 'R' || indexStatus === 'C' ? originalFilename : undefined,
        status: normalizeGitStatusCode(indexStatus),
        changeType: 'staged',
        isSubmoduleEntry,
        submoduleFlags
      }))
    }

    if (worktreeStatus && worktreeStatus !== '.') {
      files.push(createGitFileStatus({
        filename,
        originalFilename: worktreeStatus === 'R' || worktreeStatus === 'C' ? originalFilename : undefined,
        status: normalizeGitStatusCode(worktreeStatus),
        changeType: 'unstaged',
        isSubmoduleEntry,
        submoduleFlags
      }))
    }

    index += type === '2' ? 2 : 1
  }

  return files
}

function parseNumstatZ(output: string): Map<string, { additions: number; deletions: number; originalFilename?: string }> {
  const stats = new Map<string, { additions: number; deletions: number; originalFilename?: string }>()
  if (!output) return stats
  const tokens = output.split('\0')
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token) {
      i += 1
      continue
    }
    const parts = token.split('\t')
    if (parts.length < 3) {
      i += 1
      continue
    }
    const additions = parseInt(parts[0], 10)
    const deletions = parseInt(parts[1], 10)
    const pathPart = parts.slice(2).join('\t')
    if (pathPart) {
      stats.set(pathPart, {
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0
      })
      i += 1
      continue
    }

    const originalFilename = tokens[i + 1] || ''
    const filename = tokens[i + 2] || ''
    if (filename) {
      stats.set(filename, {
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
        originalFilename: originalFilename || undefined
      })
    }
    i += 3
  }
  return stats
}

function attachDiffStats(
  files: GitFileStatus[],
  stats: Map<string, { additions: number; deletions: number; originalFilename?: string }>
): GitFileStatus[] {
  if (stats.size === 0) return files
  return files.map((file) => {
    const statEntry = stats.get(file.filename)
    if (!statEntry) return file
    return {
      ...file,
      additions: statEntry.additions,
      deletions: statEntry.deletions,
      originalFilename: file.originalFilename ?? statEntry.originalFilename
    }
  })
}

const HISTORY_RECORD_SEPARATOR = '\x1e'
const HISTORY_FIELD_SEPARATOR = '\x1f'

function parseGitLogOutput(output: string): GitCommitInfo[] {
  if (!output) return []
  const records = output.split(HISTORY_RECORD_SEPARATOR).map(item => item.trim()).filter(Boolean)
  const commits: GitCommitInfo[] = []
  for (const record of records) {
    const fields = record.split(HISTORY_FIELD_SEPARATOR)
    if (fields.length < 8) continue
    const [
      sha,
      shortSha,
      parentsRaw,
      authorName,
      authorEmail,
      authorDate,
      refs,
      summary,
      body = ''
    ] = fields
    commits.push({
      sha,
      shortSha,
      parents: parentsRaw ? parentsRaw.trim().split(/\s+/).filter(Boolean) : [],
      summary,
      body,
      authorName,
      authorEmail,
      authorDate,
      refs: refs || undefined
    })
  }
  return commits
}

async function getGitDiffNameStatus(
  cwd: string,
  gitExecutable: string,
  staged: boolean,
  meta?: GitTaskMeta
): Promise<string> {
  const args = ['-c', 'core.quotepath=false', 'diff', '--name-status', '-z']
  if (staged) args.push('--cached')
  args.push('--')
  const { stdout } = await execFileAsync(gitExecutable, args, {
    cwd,
    timeout: EXEC_TIMEOUT,
    env: getExecEnv(),
    maxBuffer: MAX_DIFF_OUTPUT
  }, meta)
  return typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
}

async function getGitDiffNumstat(
  cwd: string,
  gitExecutable: string,
  staged: boolean,
  meta?: GitTaskMeta
): Promise<string> {
  const args = ['-c', 'core.quotepath=false', 'diff', '--numstat', '-z']
  if (staged) args.push('--cached')
  args.push('--')
  const { stdout } = await execFileAsync(gitExecutable, args, {
    cwd,
    timeout: EXEC_TIMEOUT,
    env: getExecEnv(),
    maxBuffer: MAX_DIFF_OUTPUT
  }, meta)
  return typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
}

async function getGitStatusPorcelainV2(
  cwd: string,
  gitExecutable: string,
  meta?: GitTaskMeta
): Promise<string> {
  const { stdout } = await execFileAsync(gitExecutable, [
    '-c',
    'core.quotepath=false',
    'status',
    '--porcelain=2',
    '-z',
    '--find-renames=50',
    '--untracked-files=all'
  ], {
    cwd,
    timeout: EXEC_TIMEOUT,
    env: getExecEnv(),
    maxBuffer: MAX_DIFF_OUTPUT
  }, meta)
  return typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
}

async function isGitPathStaged(
  cwd: string,
  gitExecutable: string,
  gitPath: string,
  meta?: GitTaskMeta
): Promise<boolean> {
  const output = await getGitDiffNameStatus(cwd, gitExecutable, true, meta)
  const entries = parseNameStatusZ(output)
  return entries.some((entry) => entry.filename === gitPath || entry.originalFilename === gitPath)
}

async function getGitRangeNameStatus(
  cwd: string,
  gitExecutable: string,
  base: string,
  head: string,
  hideWhitespace: boolean,
  meta?: GitTaskMeta
): Promise<string> {
  const args = ['-c', 'core.quotepath=false', 'diff', '--name-status', '-z']
  if (hideWhitespace) args.push('-w')
  args.push(base, head, '--')
  const { stdout } = await execFileAsync(gitExecutable, args, {
    cwd,
    timeout: EXEC_TIMEOUT,
    env: getExecEnv(),
    maxBuffer: MAX_DIFF_OUTPUT
  }, meta)
  return typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
}

async function getGitRangeNumstat(
  cwd: string,
  gitExecutable: string,
  base: string,
  head: string,
  hideWhitespace: boolean,
  meta?: GitTaskMeta
): Promise<string> {
  const args = ['-c', 'core.quotepath=false', 'diff', '--numstat', '-z']
  if (hideWhitespace) args.push('-w')
  args.push(base, head, '--')
  const { stdout } = await execFileAsync(gitExecutable, args, {
    cwd,
    timeout: EXEC_TIMEOUT,
    env: getExecEnv(),
    maxBuffer: MAX_DIFF_OUTPUT
  }, meta)
  return typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
}

async function getGitRangePatch(
  cwd: string,
  gitExecutable: string,
  base: string,
  head: string,
  filePath: string | undefined,
  hideWhitespace: boolean,
  meta?: GitTaskMeta
): Promise<string> {
  const args = ['-c', 'core.quotepath=false', 'diff', '--patch', '--no-color']
  if (hideWhitespace) args.push('-w')
  args.push(base, head)
  if (filePath) {
    args.push('--', filePath)
  }
  const { stdout } = await execFileAsync(gitExecutable, args, {
    cwd,
    timeout: EXEC_TIMEOUT,
    env: getExecEnv(),
    maxBuffer: MAX_DIFF_OUTPUT
  }, meta)
  return typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
}

function cloneGitFileStatuses(files: GitFileStatus[]): GitFileStatus[] {
  return files.map((file) => ({ ...file }))
}

function cloneGitDiffResult(result: GitDiffResult): GitDiffResult {
  return {
    ...result,
    files: cloneGitFileStatuses(result.files),
    repos: result.repos?.map((repo) => ({ ...repo }))
  }
}

function getGitDiffRequestKey(cwd: string, options?: GitDiffLoadOptions): string {
  const scope = options?.scope === 'root-only' ? 'root-only' : 'full'
  return `${resolve(cwd)}::${scope}`
}

function getGitDiffRequestCacheController(): GitDiffRequestCacheController<GitDiffResult> {
  if (!gitDiffRequestCacheController) {
    gitDiffRequestCacheController = new GitDiffRequestCacheController<GitDiffResult>({
      ttlMs: GIT_DIFF_REQUEST_CACHE_TTL,
      maxEntries: 64,
      clone: cloneGitDiffResult
    })
  }
  return gitDiffRequestCacheController
}

function invalidateGitDiffRequestKey(key: string): boolean {
  return getGitDiffRequestCacheController().invalidateKey(key)
}

/**
 * Snapshot of the list-level (`getDiff`) request cache. Exposed to the
 * in-app debug panel so users can see entries / hit-rate / in-flight
 * dedupe activity for the layer that sits in front of the worker's
 * `git status -z` + `git diff` call chain.
 */
export function getGitDiffRequestCacheStats() {
  return getGitDiffRequestCacheController().inspectStats()
}

function isGitPathAtOrInside(pathValue: string, parentPath: string): boolean {
  return pathValue === parentPath || pathValue.startsWith(`${parentPath}/`)
}

function buildChildSubmodulePathsByParent(submodules: GitSubmoduleInfo[]): Map<string, string[]> {
  const pathsByParent = new Map<string, string[]>()
  for (const submodule of submodules) {
    const parentRoot = resolve(submodule.parentRoot)
    const relativePath = normalizeGitPath(relative(submodule.parentRoot, submodule.repoRoot)) || submodule.name
    if (!relativePath || relativePath.startsWith('../')) {
      continue
    }
    const existing = pathsByParent.get(parentRoot) ?? []
    existing.push(relativePath)
    pathsByParent.set(parentRoot, existing)
  }
  for (const [parentRoot, paths] of pathsByParent) {
    pathsByParent.set(parentRoot, Array.from(new Set(paths)).sort((a, b) => b.length - a.length))
  }
  return pathsByParent
}

function filterFilesOwnedByRepo(files: GitFileStatus[], childSubmodulePaths: string[]): GitFileStatus[] {
  if (childSubmodulePaths.length === 0) return files
  return files.filter((file) => {
    const childPath = childSubmodulePaths.find((pathValue) => isGitPathAtOrInside(file.filename, pathValue))
    if (!childPath) return true
    return file.filename === childPath && Boolean(file.isSubmoduleEntry)
  })
}

// Bug 1 — submodule false-positive filter.
//
// A parent repo's `git status --porcelain=2` surfaces a submodule entry when
// any of c (commit pointer changed in the parent's index), m (submodule work
// tree dirty), or u (submodule has untracked content) is set. Only c is a
// change the user made TO THE PARENT; m/u are internal to the submodule and
// already get a dedicated section in the diff result. Dropping m/u-only
// entries from the parent's file list eliminates the duplicate "submodule
// directory shows as modified" effect that prompted Bug 1.
//
// Emits one MAIN_GIT_DIFF_SUBMODULE_FILTER event per submodule entry decision
// (kept or dropped) so a trace makes the filter outcome observable for SQL.
function filterMeaninglessSubmoduleEntries(
  files: GitFileStatus[],
  repoRoot: string,
  repoLabel: string
): GitFileStatus[] {
  const out: GitFileStatus[] = []
  for (const file of files) {
    if (!file.isSubmoduleEntry) {
      out.push(file)
      continue
    }
    const flags = file.submoduleFlags
    const commitChanged = Boolean(flags?.commitChanged)
    // After `git add modules/sub`, the parent index records the new submodule
    // pointer and the submodule worktree HEAD now matches the index, so
    // porcelain v2 reports `<c>=.` while X is non-`.` (the parent's index has
    // the staged gitlink change). Drop those rows would hide a real
    // parent-side change the user just staged — they could no longer review
    // or unstage it from Git Diff. Keep submodule entries when EITHER the
    // c-flag is set (HEAD diverged from index) OR the row carries a staged
    // parent change. We still drop entries whose only signal is internal
    // submodule noise (m=M / u=U with c=. and changeType !== 'staged') —
    // those belong to the submodule's own diff section.
    const stagedParentChange = file.changeType === 'staged'
    const keep = commitChanged || stagedParentChange
    const flagsLabel = flags
      ? `${flags.commitChanged ? 'C' : '.'}${flags.workTreeModified ? 'M' : '.'}${flags.untrackedContent ? 'U' : '.'}`
      : '???'
    perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_SUBMODULE_FILTER, {
      repoRoot,
      repoLabel,
      path: file.filename,
      flags: flagsLabel,
      changeType: file.changeType,
      kept: keep
    })
    if (keep) out.push(file)
  }
  return out
}

function clearSingleRepoDiffCache(repoRoot: string): void {
  const prefix = `${resolve(repoRoot)}::`
  for (const key of Array.from(singleRepoDiffCache.keys())) {
    if (key.startsWith(prefix)) {
      singleRepoDiffCache.delete(key)
    }
  }
}

async function getWorktreeAwareDiffFingerprint(
  gitDir: string | null,
  repoRoot: string,
  parsedFiles: GitFileStatus[]
): Promise<string> {
  const baseFingerprint = await getGitRepoFingerprint(gitDir, repoRoot)
  if (parsedFiles.length === 0) {
    return baseFingerprint
  }

  const worktreePaths = Array.from(new Set(
    parsedFiles.flatMap((file) => {
      const paths = [file.filename]
      if (file.originalFilename) {
        paths.push(file.originalFilename)
      }
      return paths
    })
  )).sort()

  const statTokens = await Promise.all(
    worktreePaths.map(async (filePath) => `${filePath}:${await getStatToken(resolve(repoRoot, filePath))}`)
  )

  const hash = createHash('sha1')
  hash.update(baseFingerprint)
  for (const file of parsedFiles) {
    hash.update('\0')
    hash.update(file.changeType)
    hash.update('\0')
    hash.update(file.status)
    hash.update('\0')
    hash.update(file.filename)
    hash.update('\0')
    hash.update(file.originalFilename || '')
  }
  for (const token of statTokens) {
    hash.update('\0')
    hash.update(token)
  }
  return hash.digest('hex')
}

async function getSingleRepoDiff(
  repoRoot: string,
  gitExecutable: string,
  repoLabel: string,
  gitDirHint?: string | null
): Promise<{ files: GitFileStatus[]; error?: string }> {
  const normalizedRoot = resolve(repoRoot)
  let gitDir = gitDirHint ?? null
  if (!gitDir) {
    const repoMeta = await getGitRepoMeta(repoRoot)
    gitDir = repoMeta.gitDir
  }

  const inFlightKey = `${normalizedRoot}::${repoLabel}`
  const inFlight = singleRepoDiffInFlight.get(inFlightKey)
  if (inFlight) {
    const result = await inFlight
    return {
      files: cloneGitFileStatuses(result.files),
      error: result.error
    }
  }

  const task = (async () => {
    const diffMeta: GitTaskMeta = { repoKey: repoRoot, repoConcurrencyLimit: 1, priority: 'normal' }

    let statusOutput = ''
    try {
      statusOutput = await getGitStatusPorcelainV2(repoRoot, gitExecutable, diffMeta)
    } catch (error) {
      return {
        files: [],
        error: `Failed to run git status: ${formatGitError(error) || String(error)}`
      }
    }

    const parsedFiles = parseStatusPorcelainV2Z(statusOutput)
    const fingerprint = await getWorktreeAwareDiffFingerprint(gitDir, repoRoot, parsedFiles)
    const cacheKey = `${normalizedRoot}::${repoLabel}::${fingerprint}`
    const cached = singleRepoDiffCache.get(cacheKey)
    if (cached) {
      return {
        files: cloneGitFileStatuses(cached.value.files),
        error: cached.value.error
      }
    }

    const [unstagedNumstatResult, stagedNumstatResult] = await Promise.allSettled([
      getGitDiffNumstat(repoRoot, gitExecutable, false, diffMeta),
      getGitDiffNumstat(repoRoot, gitExecutable, true, diffMeta)
    ])

    if (unstagedNumstatResult.status === 'rejected') {
      console.warn('Failed to get unstaged git diff stats:', unstagedNumstatResult.reason)
    }
    if (stagedNumstatResult.status === 'rejected') {
      console.warn('Failed to get staged git diff stats:', stagedNumstatResult.reason)
    }

    const unstagedFiles = attachDiffStats(
      parsedFiles.filter((file) => file.changeType === 'unstaged'),
      parseNumstatZ(unstagedNumstatResult.status === 'fulfilled' ? unstagedNumstatResult.value : '')
    )
    const stagedFiles = attachDiffStats(
      parsedFiles.filter((file) => file.changeType === 'staged'),
      parseNumstatZ(stagedNumstatResult.status === 'fulfilled' ? stagedNumstatResult.value : '')
    )
    const untrackedFiles = parsedFiles.filter((file) => file.changeType === 'untracked')

    const value = {
      files: [...unstagedFiles, ...stagedFiles, ...untrackedFiles].map((file) => ({
        ...file,
        repoRoot,
        repoLabel
      }))
    }
    clearSingleRepoDiffCache(repoRoot)
    singleRepoDiffCache.set(cacheKey, { value, at: Date.now() })
    return value
  })()

  singleRepoDiffInFlight.set(inFlightKey, task)
  try {
    const result = await task
    return {
      files: cloneGitFileStatuses(result.files)
    }
  } finally {
    singleRepoDiffInFlight.delete(inFlightKey)
  }
}

/**
 * Get Git Diff information
 */
export async function getGitDiff(cwd: string, options?: GitDiffLoadOptions): Promise<GitDiffResult> {
  // Watcher registration happens in the main-process IPC handler; here we
  // only wire the local listener (no-op when called inside the worker
  // thread, since the worker's invalidator never receives FS events — but
  // the listener wiring is still useful when getGitDiff is invoked from
  // the main-process side for non-IPC callers).
  wireGitDiffCacheInvalidatorOnce()

  const cacheKey = getGitDiffRequestKey(cwd, options)
  const scope = options?.scope === 'root-only' ? 'root-only' : 'full'
  const force = Boolean(options?.force)
  return getGitDiffRequestCacheController().get(cacheKey, {
    force,
    load: () => loadGitDiff(cwd, options),
    onCacheHit: (ageMs) => {
      perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CACHE_HIT, {
        cwd: resolve(cwd),
        scope,
        ageMs
      })
    },
    onForceInvalidate: (entriesCleared) => {
      perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CACHE_INVALIDATE, {
        cwd: resolve(cwd),
        reason: 'force',
        entriesCleared
      })
    }
  })
}

async function loadGitDiff(cwd: string, options?: GitDiffLoadOptions): Promise<GitDiffResult> {
  // Use getGitRepoMeta (single git process) for install + repo + root checks
  const meta = await getGitRepoMeta(cwd)
  if (!meta.gitExecutable) {
    return {
      success: false,
      cwd,
      isGitRepo: false,
      gitInstalled: false,
      files: [],
      error: 'Git is not installed. Install Git first.'
    }
  }
  if (!meta.isRepo || !meta.repoRoot) {
    return {
      success: false,
      cwd,
      isGitRepo: false,
      gitInstalled: true,
      files: [],
      error: 'The current directory is not a Git repository.'
    }
  }
  const gitExecutable = meta.gitExecutable

  try {
    const repoRoot = meta.repoRoot
    const repoName = basename(repoRoot)
    const loadScope = options?.scope === 'root-only' ? 'root-only' : 'full'
    // Phase 1 of the lesson #13 follow-up: discovery now goes through the
    // snapshot service. The service owns ".gitmodules + git submodule
    // status + getGitRepoMeta validation" as a single atomic structural
    // answer. We pull the legacy `GitSubmoduleInfo[]` shape from the
    // snapshot for downstream code (which still expects that shape) until
    // History / Editor scope / Quick Open are migrated in subsequent
    // phases. The `force` flag from the request flows into the snapshot
    // capture too — when the user explicitly bypasses the diff request
    // cache (subpage entry, etc.), they also want a fresh structural
    // snapshot, not a 5-second-old one.
    const [snapshot, superprojectRoot] = await Promise.all([
      gitRepositorySnapshotService.getSnapshot(repoRoot, { force: options?.force === true }),
      detectSuperproject(repoRoot, gitExecutable)
    ])
    const submodules = snapshotToLegacySubmoduleInfos(snapshot)

    const allRepos = [
      { root: repoRoot, gitDir: meta.gitDir, label: repoName, isSubmodule: false, depth: 0, parentRoot: undefined },
      ...submodules.map((submodule) => ({
        root: submodule.repoRoot,
        gitDir: null,
        label: submodule.path,
        isSubmodule: true,
        depth: submodule.depth,
        parentRoot: submodule.parentRoot
      }))
    ]

    const reposToLoad = loadScope === 'full'
      ? allRepos
      : allRepos.filter((repo) => !repo.isSubmodule)
    const results = await Promise.allSettled(
      reposToLoad.map((repo) => getSingleRepoDiff(repo.root, gitExecutable, repo.label, repo.gitDir))
    )
    const resultByRepoRoot = new Map(reposToLoad.map((repo, index) => [repo.root, results[index]]))

    const childSubmodulePathsByParent = buildChildSubmodulePathsByParent(submodules)
    const files: GitFileStatus[] = []
    const repos: GitRepoContext[] = []

    for (const repo of allRepos) {
      if (loadScope !== 'full' && repo.isSubmodule) {
        repos.push({
          root: repo.root,
          label: repo.label,
          isSubmodule: repo.isSubmodule,
          depth: repo.depth,
          parentRoot: repo.parentRoot,
          changeCount: 0,
          loading: true
        })
        continue
      }

      const result = resultByRepoRoot.get(repo.root)
      if (!result) {
        repos.push({
          root: repo.root,
          label: repo.label,
          isSubmodule: repo.isSubmodule,
          depth: repo.depth,
          parentRoot: repo.parentRoot,
          changeCount: 0
        })
        continue
      }

      if (result.status === 'fulfilled' && !result.value.error) {
        let repoFiles = result.value.files
        repoFiles = filterFilesOwnedByRepo(
          repoFiles,
          childSubmodulePathsByParent.get(resolve(repo.root)) ?? []
        )
        repoFiles = filterMeaninglessSubmoduleEntries(repoFiles, repo.root, repo.label)
        files.push(...repoFiles)
        repos.push({
          root: repo.root,
          label: repo.label,
          isSubmodule: repo.isSubmodule,
          depth: repo.depth,
          parentRoot: repo.parentRoot,
          changeCount: repoFiles.length
        })
      } else {
        const errorMessage = result.status === 'rejected'
          ? String(result.reason)
          : result.value.error
        console.warn(`Submodule diff failed for ${repo.label}:`, errorMessage)
        repos.push({
          root: repo.root,
          label: repo.label,
          isSubmodule: repo.isSubmodule,
          depth: repo.depth,
          parentRoot: repo.parentRoot,
          changeCount: 0
        })
      }
    }

    return {
      success: true,
      cwd: repoRoot,
      isGitRepo: true,
      gitInstalled: true,
      files,
      repos: repos.length > 1 ? repos : undefined,
      superprojectRoot: superprojectRoot || undefined,
      // submodulesLoading reflects "there ARE submodules but we're only
      // showing the root-level diff so far". The snapshot already knows
      // whether any submodules exist (declared OR initialized) — we use
      // its derived count rather than re-reading `.gitmodules`.
      submodulesLoading: snapshot.submodules.length > 0 && loadScope !== 'full'
    }
  } catch (error) {
    console.error('Failed to get git diff:', error)
    const message = formatGitError(error) || String(error)
    return {
      success: false,
      cwd,
      isGitRepo: true,
      gitInstalled: true,
      files: [],
      error: `Failed to load Git Diff: ${message}`
    }
  }
}

export async function getGitHistory(
  cwd: string,
  limit = 50,
  skip = 0
): Promise<GitHistoryResult> {
  // Use getGitRepoMeta (single git process) for install + repo + root checks
  const repoMeta = await getGitRepoMeta(cwd)
  if (!repoMeta.gitExecutable) {
    return {
      success: false,
      cwd,
      isGitRepo: false,
      gitInstalled: false,
      commits: [],
      error: 'Git is not installed. Install Git first.'
    }
  }
  if (!repoMeta.isRepo || !repoMeta.repoRoot) {
    return {
      success: false,
      cwd,
      isGitRepo: false,
      gitInstalled: true,
      commits: [],
      error: 'The current directory is not a Git repository.'
    }
  }
  const gitExecutable = repoMeta.gitExecutable

  try {
    const repoRoot = repoMeta.repoRoot
    const meta: GitTaskMeta = { repoKey: repoRoot, priority: 'high' }

    const format = [
      '%H',
      '%h',
      '%P',
      '%an',
      '%ae',
      '%ad',
      '%D',
      '%s',
      '%b'
    ].join(HISTORY_FIELD_SEPARATOR) + HISTORY_RECORD_SEPARATOR

    const logArgs = [
      '-c',
      'core.quotepath=false',
      'log',
      '--date=iso-strict',
      `--pretty=format:${format}`,
      `-n`,
      `${Math.max(1, Math.min(limit, 500))}`,
      `--skip=${Math.max(0, skip)}`
    ]

    const [countResult, logResult] = await Promise.all([
      execFileAsync(gitExecutable, ['rev-list', '--count', 'HEAD'], {
        cwd: repoRoot,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      }, meta).catch(() => null),
      execFileAsync(gitExecutable, logArgs, {
        cwd: repoRoot,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv(),
        maxBuffer: MAX_DIFF_OUTPUT
      }, meta)
    ])

    let totalCount: number | undefined
    if (countResult) {
      const count = parseInt(typeof countResult.stdout === 'string' ? countResult.stdout.trim() : countResult.stdout.toString('utf-8').trim(), 10)
      if (Number.isFinite(count)) {
        totalCount = count
      }
    }

    const output = typeof logResult.stdout === 'string' ? logResult.stdout : logResult.stdout.toString('utf-8')
    const commits = parseGitLogOutput(output)
    const repoName = basename(repoRoot)
    // Phase 2 of the lesson #13 follow-up: read the structural snapshot
    // directly instead of going through the `detectSubmodulesRecursive`
    // compatibility wrapper. History only needs (path, absolutePath,
    // depth, parentRoot) for each valid submodule — those map 1:1 to
    // snapshot fields, so we skip the legacy `GitSubmoduleInfo` shape
    // and one indirection. No `force` flag here: History reads are not
    // user-input-blocking and the snapshot's TTL + watcher invalidation
    // handle freshness correctly.
    const [snapshot, superprojectRoot] = await Promise.all([
      gitRepositorySnapshotService.getSnapshot(repoRoot),
      detectSuperproject(repoRoot, gitExecutable)
    ])
    const validSubmodules = snapshot.submodules.filter((sub) => sub.isValidRepo)

    let repos: GitRepoContext[] | undefined
    if (validSubmodules.length > 0) {
      repos = [
        { root: repoRoot, label: repoName, isSubmodule: false, depth: 0, changeCount: -1 },
        ...validSubmodules.map((submodule) => ({
          root: submodule.absolutePath,
          label: submodule.path,
          isSubmodule: true,
          depth: submodule.depth,
          parentRoot: submodule.parentRoot,
          changeCount: -1
        }))
      ]
    }

    return {
      success: true,
      cwd: repoRoot,
      isGitRepo: true,
      gitInstalled: true,
      commits,
      totalCount,
      repos,
      superprojectRoot: superprojectRoot || undefined
    }
  } catch (error) {
    const message = formatGitError(error) || String(error)
    return {
      success: false,
      cwd,
      isGitRepo: true,
      gitInstalled: true,
      commits: [],
      error: `Failed to load Git History: ${message}`
    }
  }
}

export async function getGitHistoryDiff(
  cwd: string,
  options: GitHistoryDiffOptions
): Promise<GitHistoryDiffResult> {
  const gitInstalled = await checkGitInstalled()
  const gitExecutable = await resolveGitExecutable()
  if (!gitInstalled || !gitExecutable) {
    return {
      success: false,
      cwd,
      isGitRepo: false,
      gitInstalled: false,
      base: options.base,
      head: options.head,
      patch: '',
      files: [],
      error: 'Git is not installed. Install Git first.'
    }
  }

  const repoCheck = await checkGitRepository(cwd, gitExecutable)
  if (!repoCheck.isRepo) {
    return {
      success: false,
      cwd,
      isGitRepo: false,
      gitInstalled: true,
      base: options.base,
      head: options.head,
      patch: '',
      files: [],
      error: repoCheck.error || 'The current directory is not a Git repository.'
    }
  }

  const { base, head, filePath, hideWhitespace = false, includeFiles = true } = options
  if (!base || !head) {
    return {
      success: false,
      cwd,
      isGitRepo: true,
      gitInstalled: true,
      base: base || '',
      head: head || '',
      patch: '',
      files: [],
      error: 'Missing commit range.'
    }
  }

  try {
    const repoRoot = (await getGitRoot(cwd, gitExecutable)) || cwd
    const meta: GitTaskMeta = { repoKey: repoRoot, priority: 'high' }
    let files: GitHistoryFile[] = []
    if (includeFiles) {
      const [nameOutput, numstatOutput] = await Promise.all([
        getGitRangeNameStatus(repoRoot, gitExecutable, base, head, hideWhitespace, meta),
        getGitRangeNumstat(repoRoot, gitExecutable, base, head, hideWhitespace, meta)
      ])
      const entries = parseNameStatusZ(nameOutput)
      const stats = parseNumstatZ(numstatOutput)
      files = entries.map((entry) => {
        const stat = stats.get(entry.filename)
        const isImage = isSupportedImageFile(entry.filename) || Boolean(entry.originalFilename && isSupportedImageFile(entry.originalFilename))
        const isSvg = entry.filename.toLowerCase().endsWith('.svg') || Boolean(entry.originalFilename && entry.originalFilename.toLowerCase().endsWith('.svg'))
        const isPdf = isPdfFilename(entry.filename) || isPdfFilename(entry.originalFilename)
        const isEpub = isEpubFilename(entry.filename) || isEpubFilename(entry.originalFilename)
        return {
          filename: entry.filename,
          originalFilename: entry.originalFilename,
          status: entry.status,
          additions: stat?.additions ?? 0,
          deletions: stat?.deletions ?? 0,
          ...(isImage ? { isImage: true } : {}),
          ...(isSvg ? { isSvg: true } : {}),
          ...(isPdf ? { isPdf: true } : {}),
          ...(isEpub ? { isEpub: true } : {})
        }
      })
    }

    const patch = filePath
      ? await getGitRangePatch(repoRoot, gitExecutable, base, head, filePath, hideWhitespace, meta)
      : ''

    return {
      success: true,
      cwd: repoRoot,
      isGitRepo: true,
      gitInstalled: true,
      base,
      head,
      patch,
      files
    }
  } catch (error) {
    const message = formatGitError(error) || String(error)
    return {
      success: false,
      cwd,
      isGitRepo: true,
      gitInstalled: true,
      base: options.base,
      head: options.head,
      patch: '',
      files: [],
      error: `Failed to load Git History diff: ${message}`
    }
  }
}

type GitReaderResult = {
  content: string
  isBinary: boolean
  imageDataUrl?: string
  imageSize?: number
  isSvg?: boolean
  isPdf?: boolean
  isEpub?: boolean
  previewData?: string
  previewSize?: number
}

async function readWorkingFile(fullPath: string, filename?: string): Promise<GitReaderResult> {
  const isImage = filename ? isSupportedImageFile(filename) : false
  const isSvg = filename ? filename.toLowerCase().endsWith('.svg') : false
  const isPdf = isPdfFilename(filename)
  const isEpub = isEpubFilename(filename)
  const sizeLimit = isPdf
    ? MAX_PDF_DIFF_FILE_SIZE
    : isEpub
      ? MAX_EPUB_DIFF_FILE_SIZE
      : isImage
        ? MAX_IMAGE_FILE_SIZE
        : MAX_FILE_SIZE
  const fileStat = await stat(fullPath)
  if (fileStat.size > sizeLimit) {
    throw new Error(`File is too large to load (>${Math.floor(sizeLimit / 1024)}KB).`)
  }
  const buffer = await readFile(fullPath)
  const isBinary = buffer.includes(0)
  if (isPdf || isEpub) {
    return {
      content: '',
      isBinary: true,
      isPdf: isPdf || undefined,
      isEpub: isEpub || undefined,
      previewData: buffer.toString('base64'),
      previewSize: buffer.length
    }
  }
  if (isBinary) {
    if (isImage && filename) {
      const imageSize = buffer.length
      return { content: '', isBinary: true, imageDataUrl: bufferToImageDataUrl(buffer, filename), imageSize }
    }
    return { content: '', isBinary: true }
  }
  if (isSvg) {
    const textContent = buffer.toString('utf-8')
    const imageSize = buffer.length
    const imageDataUrl = `data:image/svg+xml;base64,${buffer.toString('base64')}`
    return { content: textContent, isBinary: false, imageDataUrl, imageSize, isSvg: true }
  }
  return { content: buffer.toString('utf-8'), isBinary: false }
}

async function readGitFileByRef(
  cwd: string,
  gitExecutable: string,
  ref: string,
  filename?: string
): Promise<GitReaderResult> {
  const isImage = filename ? isSupportedImageFile(filename) : false
  const isSvg = filename ? filename.toLowerCase().endsWith('.svg') : false
  const isPdf = isPdfFilename(filename)
  const isEpub = isEpubFilename(filename)
  const sizeLimit = isPdf
    ? MAX_PDF_DIFF_FILE_SIZE
    : isEpub
      ? MAX_EPUB_DIFF_FILE_SIZE
      : isImage
        ? MAX_IMAGE_FILE_SIZE
        : MAX_FILE_SIZE

  try {
    const sizeResult = await execFileAsync(gitExecutable, ['cat-file', '-s', ref], {
      cwd,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    const sizeText = typeof sizeResult.stdout === 'string' ? sizeResult.stdout : sizeResult.stdout.toString('utf-8')
    const size = parseInt(sizeText.trim(), 10)
    if (Number.isFinite(size) && size > sizeLimit) {
      throw new Error(`File is too large to load (>${Math.floor(sizeLimit / 1024)}KB).`)
    }
  } catch (error) {
    throw new Error(`Failed to read Git file metadata: ${String(error)}`)
  }

  if (isSvg) {
    const blobResult = await execFileAsync(gitExecutable, ['cat-file', 'blob', ref], {
      cwd,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv(),
      maxBuffer: MAX_IMAGE_FILE_SIZE * 2,
      encoding: 'buffer' as BufferEncoding
    })
    const buffer = Buffer.isBuffer(blobResult.stdout)
      ? blobResult.stdout
      : Buffer.from(blobResult.stdout as unknown as ArrayBufferLike)
    const textContent = buffer.toString('utf-8')
    const imageSize = buffer.length
    const imageDataUrl = `data:image/svg+xml;base64,${buffer.toString('base64')}`
    return { content: textContent, isBinary: false, imageDataUrl, imageSize, isSvg: true }
  }

  if (isImage && filename) {
    const blobResult = await execFileAsync(gitExecutable, ['cat-file', 'blob', ref], {
      cwd,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv(),
      maxBuffer: MAX_IMAGE_FILE_SIZE * 2,
      encoding: 'buffer' as BufferEncoding
    })
    const buffer = Buffer.isBuffer(blobResult.stdout)
      ? blobResult.stdout
      : Buffer.from(blobResult.stdout as unknown as ArrayBufferLike)
    const imageSize = buffer.length
    return { content: '', isBinary: true, imageDataUrl: bufferToImageDataUrl(buffer, filename), imageSize }
  }

  if (isPdf || isEpub) {
    const blobResult = await execFileAsync(gitExecutable, ['cat-file', 'blob', ref], {
      cwd,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv(),
      maxBuffer: sizeLimit * 2,
      encoding: 'buffer' as BufferEncoding
    })
    const buffer = Buffer.isBuffer(blobResult.stdout)
      ? blobResult.stdout
      : Buffer.from(blobResult.stdout as unknown as ArrayBufferLike)
    return {
      content: '',
      isBinary: true,
      isPdf: isPdf || undefined,
      isEpub: isEpub || undefined,
      previewData: buffer.toString('base64'),
      previewSize: buffer.length
    }
  }

  const contentResult = await execFileAsync(gitExecutable, ['-c', 'core.quotepath=false', 'show', ref], {
    cwd,
    timeout: EXEC_TIMEOUT,
    env: getExecEnv(),
    maxBuffer: MAX_FILE_SIZE * 2
  })
  const contentText = typeof contentResult.stdout === 'string' ? contentResult.stdout : contentResult.stdout.toString('utf-8')
  const isBinary = hasNullByte(contentText)
  if (isBinary) {
    return { content: '', isBinary: true }
  }
  return { content: contentText, isBinary: false }
}

async function readGitHeadFile(
  cwd: string,
  gitExecutable: string,
  gitPath: string,
  filename?: string
): Promise<GitReaderResult> {
  return readGitFileByRef(cwd, gitExecutable, `HEAD:${gitPath}`, filename)
}

async function readGitIndexFile(
  cwd: string,
  gitExecutable: string,
  gitPath: string,
  filename?: string
): Promise<GitReaderResult> {
  return readGitFileByRef(cwd, gitExecutable, `:${gitPath}`, filename)
}

async function readGitRevisionFile(
  cwd: string,
  gitExecutable: string,
  revision: string,
  gitPath: string,
  filename?: string
): Promise<GitReaderResult> {
  return readGitFileByRef(cwd, gitExecutable, `${revision}:${gitPath}`, filename)
}

export async function getGitHistoryFileContent(
  cwd: string,
  options: GitHistoryFileContentOptions
): Promise<GitHistoryFileContentResult> {
  const gitInstalled = await checkGitInstalled()
  const gitExecutable = await resolveGitExecutable()
  const filename = options.file.filename
  if (!gitInstalled || !gitExecutable) {
    return {
      success: false,
      cwd,
      base: options.base,
      head: options.head,
      filename,
      originalContent: '',
      modifiedContent: '',
      isBinary: false,
      error: 'Git is not installed. Install Git first.'
    }
  }

  const repoCheck = await checkGitRepository(cwd, gitExecutable)
  if (!repoCheck.isRepo) {
    return {
      success: false,
      cwd,
      base: options.base,
      head: options.head,
      filename,
      originalContent: '',
      modifiedContent: '',
      isBinary: false,
      error: repoCheck.error || 'The current directory is not a Git repository.'
    }
  }

  const { base, head, file } = options
  if (!base || !head) {
    return {
      success: false,
      cwd,
      base: base || '',
      head: head || '',
      filename,
      originalContent: '',
      modifiedContent: '',
      isBinary: false,
      error: 'Missing commit range.'
    }
  }

  const repoRoot = (await getGitRoot(cwd, gitExecutable)) || cwd
  const originalTarget = file.originalFilename || filename
  const isImage = isSupportedImageFile(filename) || isSupportedImageFile(originalTarget)
  const isPdf = isPdfFilename(filename) || isPdfFilename(originalTarget)
  const isEpub = isEpubFilename(filename) || isEpubFilename(originalTarget)
  let originalContent = ''
  let modifiedContent = ''
  let isBinary = false
  let isSvg = false
  let originalImageUrl: string | undefined
  let modifiedImageUrl: string | undefined
  let originalImageSize: number | undefined
  let modifiedImageSize: number | undefined
  let originalPreviewData: string | undefined
  let modifiedPreviewData: string | undefined
  let originalPreviewSize: number | undefined
  let modifiedPreviewSize: number | undefined

  try {
    if (file.status !== 'A' && file.status !== '?') {
      const gitPath = toGitPath(repoRoot, originalTarget)
      if (!gitPath) {
        return {
          success: false,
          cwd: repoRoot,
          base,
          head,
          filename,
          originalContent: '',
          modifiedContent: '',
          isBinary: false,
          error: 'Invalid file path.'
        }
      }
      const originalResult = await readGitRevisionFile(repoRoot, gitExecutable, base, gitPath, originalTarget)
      originalContent = originalResult.content
      if (originalResult.isBinary) {
        isBinary = true
      }
      if (originalResult.isSvg) {
        isSvg = true
      }
      if (originalResult.imageDataUrl) {
        originalImageUrl = originalResult.imageDataUrl
      }
      if (originalResult.imageSize !== undefined) {
        originalImageSize = originalResult.imageSize
      }
      if (originalResult.previewData !== undefined) {
        originalPreviewData = originalResult.previewData
      }
      if (originalResult.previewSize !== undefined) {
        originalPreviewSize = originalResult.previewSize
      }
    }

    if (file.status !== 'D') {
      const gitPath = toGitPath(repoRoot, filename)
      if (!gitPath) {
        return {
          success: false,
          cwd: repoRoot,
          base,
          head,
          filename,
          originalContent,
          modifiedContent: '',
          isBinary,
          error: 'Invalid file path.'
        }
      }
      const modifiedResult = await readGitRevisionFile(repoRoot, gitExecutable, head, gitPath, filename)
      modifiedContent = modifiedResult.content
      if (modifiedResult.isBinary) {
        isBinary = true
      }
      if (modifiedResult.isSvg) {
        isSvg = true
      }
      if (modifiedResult.imageDataUrl) {
        modifiedImageUrl = modifiedResult.imageDataUrl
      }
      if (modifiedResult.imageSize !== undefined) {
        modifiedImageSize = modifiedResult.imageSize
      }
      if (modifiedResult.previewData !== undefined) {
        modifiedPreviewData = modifiedResult.previewData
      }
      if (modifiedResult.previewSize !== undefined) {
        modifiedPreviewSize = modifiedResult.previewSize
      }
    }

    return {
      success: true,
      cwd: repoRoot,
      base,
      head,
      filename,
      originalContent,
      modifiedContent,
      isBinary,
      ...(isImage ? { isImage: true } : {}),
      ...(isSvg ? { isSvg: true } : {}),
      ...(isPdf ? { isPdf: true } : {}),
      ...(isEpub ? { isEpub: true } : {}),
      ...(originalImageUrl ? { originalImageUrl } : {}),
      ...(modifiedImageUrl ? { modifiedImageUrl } : {}),
      ...(originalImageSize !== undefined ? { originalImageSize } : {}),
      ...(modifiedImageSize !== undefined ? { modifiedImageSize } : {}),
      ...(originalPreviewData !== undefined ? { originalPreviewData } : {}),
      ...(modifiedPreviewData !== undefined ? { modifiedPreviewData } : {}),
      ...(originalPreviewSize !== undefined ? { originalPreviewSize } : {}),
      ...(modifiedPreviewSize !== undefined ? { modifiedPreviewSize } : {})
    }
  } catch (error) {
    return {
      success: false,
      cwd: repoRoot,
      base,
      head,
      filename,
      originalContent: '',
      modifiedContent: '',
      isBinary,
      error: `Failed to read file: ${String(error)}`
    }
  }
}

async function getSubmoduleEntryContent(
  repoRoot: string,
  gitExecutable: string,
  submodulePath: string,
  status: GitStatusCode,
  changeType: GitChangeType
): Promise<GitFileContentResult> {
  const gitPath = toGitPath(repoRoot, submodulePath)
  if (!gitPath) {
    return {
      success: false, cwd: repoRoot, filename: submodulePath,
      originalContent: '', modifiedContent: '', isBinary: false,
      error: 'Invalid submodule path.'
    }
  }

  try {
    let originalHash = ''
    let modifiedHash = ''

    if (status === 'A') {
      // Newly added submodule — no original
      if (changeType === 'staged') {
        const indexResult = await execFileAsync(gitExecutable, ['ls-files', '--stage', '--', gitPath], {
          cwd: repoRoot, timeout: EXEC_TIMEOUT, env: getExecEnv()
        })
        const indexOut = typeof indexResult.stdout === 'string' ? indexResult.stdout : indexResult.stdout.toString('utf-8')
        modifiedHash = indexOut.split(/\s+/)[1] || ''
      } else {
        const subFullPath = resolve(repoRoot, gitPath)
        try {
          const headResult = await execFileAsync(gitExecutable, ['rev-parse', 'HEAD'], {
            cwd: subFullPath, timeout: EXEC_TIMEOUT, env: getExecEnv()
          })
          modifiedHash = (typeof headResult.stdout === 'string' ? headResult.stdout : headResult.stdout.toString('utf-8')).trim()
        } catch {
          modifiedHash = '(unknown)'
        }
      }
    } else if (status === 'D') {
      // Deleted submodule — no modified
      // For staged deletes, the base is HEAD; for unstaged deletes (e.g., AD/MD), the base is the index
      if (changeType === 'staged') {
        try {
          const headResult = await execFileAsync(gitExecutable, ['ls-tree', 'HEAD', '--', gitPath], {
            cwd: repoRoot, timeout: EXEC_TIMEOUT, env: getExecEnv()
          })
          const headOut = typeof headResult.stdout === 'string' ? headResult.stdout : headResult.stdout.toString('utf-8')
          originalHash = headOut.split(/\s+/)[2] || ''
        } catch {
          originalHash = '(unknown)'
        }
      } else {
        try {
          const indexResult = await execFileAsync(gitExecutable, ['ls-files', '--stage', '--', gitPath], {
            cwd: repoRoot, timeout: EXEC_TIMEOUT, env: getExecEnv()
          })
          const indexOut = typeof indexResult.stdout === 'string' ? indexResult.stdout : indexResult.stdout.toString('utf-8')
          originalHash = indexOut.split(/\s+/)[1] || ''
        } catch {
          originalHash = '(unknown)'
        }
      }
    } else {
      // Modified submodule (commit changed, modified content, etc.)
      if (changeType === 'staged') {
        // Original = HEAD, Modified = index
        try {
          const headResult = await execFileAsync(gitExecutable, ['ls-tree', 'HEAD', '--', gitPath], {
            cwd: repoRoot, timeout: EXEC_TIMEOUT, env: getExecEnv()
          })
          const headOut = typeof headResult.stdout === 'string' ? headResult.stdout : headResult.stdout.toString('utf-8')
          originalHash = headOut.split(/\s+/)[2] || ''
        } catch {
          originalHash = '(unknown)'
        }
        try {
          const indexResult = await execFileAsync(gitExecutable, ['ls-files', '--stage', '--', gitPath], {
            cwd: repoRoot, timeout: EXEC_TIMEOUT, env: getExecEnv()
          })
          const indexOut = typeof indexResult.stdout === 'string' ? indexResult.stdout : indexResult.stdout.toString('utf-8')
          modifiedHash = indexOut.split(/\s+/)[1] || ''
        } catch {
          modifiedHash = '(unknown)'
        }
      } else {
        // Original = index, Modified = worktree submodule HEAD
        try {
          const indexResult = await execFileAsync(gitExecutable, ['ls-files', '--stage', '--', gitPath], {
            cwd: repoRoot, timeout: EXEC_TIMEOUT, env: getExecEnv()
          })
          const indexOut = typeof indexResult.stdout === 'string' ? indexResult.stdout : indexResult.stdout.toString('utf-8')
          originalHash = indexOut.split(/\s+/)[1] || ''
        } catch {
          originalHash = '(unknown)'
        }
        const subFullPath = resolve(repoRoot, gitPath)
        try {
          const headResult = await execFileAsync(gitExecutable, ['rev-parse', 'HEAD'], {
            cwd: subFullPath, timeout: EXEC_TIMEOUT, env: getExecEnv()
          })
          modifiedHash = (typeof headResult.stdout === 'string' ? headResult.stdout : headResult.stdout.toString('utf-8')).trim()
          // Check if submodule working tree is dirty
          const statusResult = await execFileAsync(gitExecutable, ['status', '--porcelain'], {
            cwd: subFullPath, timeout: EXEC_TIMEOUT, env: getExecEnv()
          })
          const statusOut = typeof statusResult.stdout === 'string' ? statusResult.stdout : statusResult.stdout.toString('utf-8')
          if (statusOut.trim()) {
            modifiedHash += '-dirty'
          }
        } catch {
          modifiedHash = '(unknown)'
        }
      }
    }

    const originalContent = originalHash ? `Subproject commit ${originalHash}\n` : ''
    const modifiedContent = modifiedHash ? `Subproject commit ${modifiedHash}\n` : ''

    return {
      success: true, cwd: repoRoot, filename: submodulePath,
      originalContent, modifiedContent, isBinary: false
    }
  } catch (error) {
    return {
      success: false, cwd: repoRoot, filename: submodulePath,
      originalContent: '', modifiedContent: '', isBinary: false,
      error: `Failed to read submodule content: ${String(error)}`
    }
  }
}

export async function getGitFileContent(
  cwd: string,
  file: Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType' | 'isSubmoduleEntry'>,
  overrideRepoRoot?: string
): Promise<GitFileContentResult> {
  const gitInstalled = await checkGitInstalled()
  const gitExecutable = await resolveGitExecutable()
  if (!gitInstalled || !gitExecutable) {
    return {
      success: false,
      cwd,
      filename: file.filename,
      originalContent: '',
      modifiedContent: '',
      isBinary: false,
      error: 'Git is not installed. Install Git first.'
    }
  }

  const effectiveCwd = overrideRepoRoot || cwd
  const repoCheck = await checkGitRepository(effectiveCwd, gitExecutable)
  if (!repoCheck.isRepo) {
    return {
      success: false,
      cwd: effectiveCwd,
      filename: file.filename,
      originalContent: '',
      modifiedContent: '',
      isBinary: false,
      error: repoCheck.error || 'The current directory is not a Git repository.'
    }
  }

  const repoRoot = overrideRepoRoot || (await getGitRoot(cwd, gitExecutable)) || cwd
  const filename = file.filename
  const changeType: GitChangeType = file.changeType || 'unstaged'
  const originalTarget = file.status === 'R' && file.originalFilename ? file.originalFilename : filename

  // Handle submodule entries: show Subproject commit hash diff
  if (file.isSubmoduleEntry) {
    return getSubmoduleEntryContent(repoRoot, gitExecutable, filename, file.status, changeType)
  }

  let originalContent = ''
  let modifiedContent = ''
  let isBinary = false
  const isImage = isSupportedImageFile(filename)
  const isSvg = filename.toLowerCase().endsWith('.svg')
  const isPdf = isPdfFilename(filename)
  const isEpub = isEpubFilename(filename)
  let originalImageUrl: string | undefined
  let modifiedImageUrl: string | undefined
  let originalImageSize: number | undefined
  let modifiedImageSize: number | undefined
  let originalPreviewData: string | undefined
  let modifiedPreviewData: string | undefined
  let originalPreviewSize: number | undefined
  let modifiedPreviewSize: number | undefined

  const captureOriginal = (r: GitReaderResult) => {
    if (r.imageDataUrl) originalImageUrl = r.imageDataUrl
    if (r.imageSize !== undefined) originalImageSize = r.imageSize
    if (r.previewData !== undefined) originalPreviewData = r.previewData
    if (r.previewSize !== undefined) originalPreviewSize = r.previewSize
  }
  const captureModified = (r: GitReaderResult) => {
    if (r.imageDataUrl) modifiedImageUrl = r.imageDataUrl
    if (r.imageSize !== undefined) modifiedImageSize = r.imageSize
    if (r.previewData !== undefined) modifiedPreviewData = r.previewData
    if (r.previewSize !== undefined) modifiedPreviewSize = r.previewSize
  }

  try {
    if (changeType === 'staged') {
      if (file.status !== 'A' && file.status !== '?') {
        const gitPath = toGitPath(repoRoot, originalTarget)
        if (!gitPath) {
          return {
            success: false,
            cwd: repoRoot,
            filename,
            originalContent: '',
            modifiedContent: '',
            isBinary: false,
            error: 'Invalid file path.'
          }
        }
        const originalResult = await readGitHeadFile(repoRoot, gitExecutable, gitPath, originalTarget)
        originalContent = originalResult.content
        if (originalResult.isBinary) {
          isBinary = true
        }
        captureOriginal(originalResult)
      }

      if (file.status !== 'D') {
        const gitPath = toGitPath(repoRoot, filename)
        if (!gitPath) {
          return {
            success: false,
            cwd: repoRoot,
            filename,
            originalContent,
            modifiedContent: '',
            isBinary,
            error: 'Invalid file path.'
          }
        }
        const modifiedResult = await readGitIndexFile(repoRoot, gitExecutable, gitPath, filename)
        modifiedContent = modifiedResult.content
        if (modifiedResult.isBinary) {
          isBinary = true
        }
        captureModified(modifiedResult)
      }
    } else if (changeType === 'unstaged') {
      if (file.status !== 'A' && file.status !== '?') {
        const gitPath = toGitPath(repoRoot, originalTarget)
        if (!gitPath) {
          return {
            success: false,
            cwd: repoRoot,
            filename,
            originalContent: '',
            modifiedContent: '',
            isBinary: false,
            error: 'Invalid file path.'
          }
        }
        const originalResult = await readGitIndexFile(repoRoot, gitExecutable, gitPath, originalTarget)
        originalContent = originalResult.content
        if (originalResult.isBinary) {
          isBinary = true
        }
        captureOriginal(originalResult)
      }

      if (file.status !== 'D') {
        const fullPath = resolvePathInRepo(repoRoot, filename)
        if (!fullPath) {
          return {
            success: false,
            cwd: repoRoot,
            filename,
            originalContent,
            modifiedContent: '',
            isBinary,
            error: 'Invalid file path.'
          }
        }
        const workingResult = await readWorkingFile(fullPath, filename)
        modifiedContent = workingResult.content
        if (workingResult.isBinary) {
          isBinary = true
        }
        captureModified(workingResult)
      }
    } else {
      if (file.status !== 'D') {
        const fullPath = resolvePathInRepo(repoRoot, filename)
        if (!fullPath) {
          return {
            success: false,
            cwd: repoRoot,
            filename,
            originalContent,
            modifiedContent: '',
            isBinary,
            error: 'Invalid file path.'
          }
        }
        const workingResult = await readWorkingFile(fullPath, filename)
        modifiedContent = workingResult.content
        if (workingResult.isBinary) {
          isBinary = true
        }
        captureModified(workingResult)
      }
    }

    return {
      success: true,
      cwd: repoRoot,
      filename,
      originalContent,
      modifiedContent,
      isBinary,
      ...(isImage ? { isImage: true } : {}),
      ...(isSvg ? { isSvg: true } : {}),
      ...(isPdf ? { isPdf: true } : {}),
      ...(isEpub ? { isEpub: true } : {}),
      ...(originalImageUrl ? { originalImageUrl } : {}),
      ...(modifiedImageUrl ? { modifiedImageUrl } : {}),
      ...(originalImageSize !== undefined ? { originalImageSize } : {}),
      ...(modifiedImageSize !== undefined ? { modifiedImageSize } : {}),
      ...(originalPreviewData !== undefined ? { originalPreviewData } : {}),
      ...(modifiedPreviewData !== undefined ? { modifiedPreviewData } : {}),
      ...(originalPreviewSize !== undefined ? { originalPreviewSize } : {}),
      ...(modifiedPreviewSize !== undefined ? { modifiedPreviewSize } : {})
    }
  } catch (error) {
    return {
      success: false,
      cwd: repoRoot,
      filename,
      originalContent: '',
      modifiedContent: '',
      isBinary,
      error: `Failed to read file: ${String(error)}`
    }
  }
}

export async function saveGitFileContent(
  cwd: string,
  filename: string,
  content: string
): Promise<GitFileSaveResult> {
  let repoRoot = cwd
  const gitExecutable = await resolveGitExecutable()
  if (gitExecutable) {
    repoRoot = (await getGitRoot(cwd, gitExecutable)) || cwd
  }
  const fullPath = resolvePathInRepo(repoRoot, filename)
  if (!fullPath) {
    return {
      success: false,
      filename,
      error: 'Invalid file path.'
    }
  }

  try {
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, 'utf-8')
    return { success: true, filename }
  } catch (error) {
    return {
      success: false,
      filename,
      error: `Failed to save file: ${String(error)}`
    }
  }
}

async function resolveIndexFileMode(
  repoRoot: string,
  gitExecutable: string,
  gitPath: string,
  filename: string
): Promise<string> {
  try {
    const lsResult = await execFileAsync(gitExecutable, ['ls-files', '-s', '--', gitPath], {
      cwd: repoRoot,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    const text = typeof lsResult.stdout === 'string'
      ? lsResult.stdout
      : lsResult.stdout.toString('utf-8')
    const line = text.trim()
    if (line) {
      const mode = line.split(/\s+/)[0]
      if (mode) return mode
    }
  } catch {
    // ignore
  }

  if (platform() !== 'win32') {
    try {
      const fullPath = resolvePathInRepo(repoRoot, filename)
      if (fullPath) {
        const fileStat = await stat(fullPath)
        return (fileStat.mode & 0o111) !== 0 ? '100755' : '100644'
      }
    } catch {
      // ignore
    }
  }

  return '100644'
}

export async function updateGitIndexContent(
  cwd: string,
  filename: string,
  content: string
): Promise<GitFileActionResult> {
  const gitExecutable = await resolveGitExecutable()
  if (!gitExecutable) {
    return { success: false, filename, error: 'Git is not installed. Install Git first.' }
  }
  const repoRoot = (await getGitRoot(cwd, gitExecutable)) || cwd
  const gitPath = toGitPath(repoRoot, filename)
  if (!gitPath) {
    return { success: false, filename, error: 'Invalid file path.' }
  }

  const mode = await resolveIndexFileMode(repoRoot, gitExecutable, gitPath, filename)
  const tempDir = await mkdtemp(resolve(tmpdir(), 'onward-git-'))
  const tempFile = resolve(tempDir, 'index-content')

  try {
    await writeFile(tempFile, content, 'utf-8')
    const hashResult = await execFileAsync(gitExecutable, ['hash-object', '-w', '--', tempFile], {
      cwd: repoRoot,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    const hash = typeof hashResult.stdout === 'string'
      ? hashResult.stdout.trim()
      : hashResult.stdout.toString('utf-8').trim()
    if (!hash) {
      throw new Error('Failed to create Git object.')
    }
    await execFileAsync(gitExecutable, ['update-index', '--add', '--cacheinfo', mode, hash, gitPath], {
      cwd: repoRoot,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    return { success: true, filename }
  } catch (error) {
    return { success: false, filename, error: `Failed to update the Git index: ${formatGitError(error) || String(error)}` }
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

export async function stageGitFile(
  cwd: string,
  filename: string,
  overrideRepoRoot?: string
): Promise<GitFileActionResult> {
  const gitExecutable = await resolveGitExecutable()
  if (!gitExecutable) {
    return { success: false, filename, error: 'Git is not installed. Install Git first.' }
  }
  const repoRoot = overrideRepoRoot || (await getGitRoot(cwd, gitExecutable)) || cwd
  const gitPath = toGitPath(repoRoot, filename)
  if (!gitPath) {
    return { success: false, filename, error: 'Invalid file path.' }
  }

  try {
    await execFileAsync(gitExecutable, ['add', '--', gitPath], {
      cwd: repoRoot,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    let staged = await isGitPathStaged(repoRoot, gitExecutable, gitPath, { repoKey: repoRoot, priority: 'high' })
    if (!staged) {
      await execFileAsync(gitExecutable, ['add', '-A', '--', gitPath], {
        cwd: repoRoot,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      })
      staged = await isGitPathStaged(repoRoot, gitExecutable, gitPath, { repoKey: repoRoot, priority: 'high' })
    }
    if (!staged) {
      try {
        await execFileAsync(gitExecutable, ['add', '-f', '--', gitPath], {
          cwd: repoRoot,
          timeout: EXEC_TIMEOUT,
          env: getExecEnv()
        })
        staged = await isGitPathStaged(repoRoot, gitExecutable, gitPath, { repoKey: repoRoot, priority: 'high' })
      } catch {
        // Ignore fallback failures and report the verification result below.
      }
    }
    if (!staged) {
      return { success: false, filename, error: 'Failed to stage file: Git did not report the file as staged.' }
    }
    return { success: true, filename }
  } catch (error) {
    return { success: false, filename, error: `Failed to stage file: ${formatGitError(error) || String(error)}` }
  }
}

export async function unstageGitFile(
  cwd: string,
  filename: string,
  overrideRepoRoot?: string
): Promise<GitFileActionResult> {
  const gitExecutable = await resolveGitExecutable()
  if (!gitExecutable) {
    return { success: false, filename, error: 'Git is not installed. Install Git first.' }
  }
  const repoRoot = overrideRepoRoot || (await getGitRoot(cwd, gitExecutable)) || cwd
  const gitPath = toGitPath(repoRoot, filename)
  if (!gitPath) {
    return { success: false, filename, error: 'Invalid file path.' }
  }

  try {
    await execFileAsync(gitExecutable, ['reset', 'HEAD', '--', gitPath], {
      cwd: repoRoot,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    return { success: true, filename }
  } catch (error) {
    return { success: false, filename, error: `Failed to unstage file: ${formatGitError(error) || String(error)}` }
  }
}

export async function discardGitFile(
  cwd: string,
  file: Pick<GitFileStatus, 'filename' | 'changeType' | 'status' | 'isSubmoduleEntry'>,
  overrideRepoRoot?: string
): Promise<GitFileActionResult> {
  const gitExecutable = await resolveGitExecutable()
  if (!gitExecutable) {
    return { success: false, filename: file.filename, error: 'Git is not installed. Install Git first.' }
  }
  const repoRoot = overrideRepoRoot || (await getGitRoot(cwd, gitExecutable)) || cwd
  const gitPath = toGitPath(repoRoot, file.filename)
  if (!gitPath) {
    return { success: false, filename: file.filename, error: 'Invalid file path.' }
  }

  try {
    if (file.changeType === 'staged') {
      await execFileAsync(gitExecutable, ['reset', 'HEAD', '--', gitPath], {
        cwd: repoRoot,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      })
      return { success: true, filename: file.filename }
    }

    if (file.changeType === 'untracked' || file.status === '?') {
      await execFileAsync(gitExecutable, ['clean', '-f', '--', gitPath], {
        cwd: repoRoot,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      })
      return { success: true, filename: file.filename }
    }

    // Submodule entries need git submodule update --force instead of git checkout
    if (file.isSubmoduleEntry) {
      await execFileAsync(gitExecutable, ['submodule', 'update', '--init', '--force', '--', gitPath], {
        cwd: repoRoot,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      })
      return { success: true, filename: file.filename }
    }

    await execFileAsync(gitExecutable, ['checkout', '--', gitPath], {
      cwd: repoRoot,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    return { success: true, filename: file.filename }
  } catch (error) {
    return {
      success: false,
      filename: file.filename,
      error: `Failed to discard changes: ${formatGitError(error) || String(error)}`
    }
  }
}
