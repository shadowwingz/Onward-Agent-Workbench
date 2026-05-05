/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitRepositorySnapshotService — the single canonical answer to
 * "given a working-tree path, what are the parent + submodule structural
 * facts I need to honor?"
 *
 * # Why this exists
 *
 * Before this module the read-side surface had three independent code
 * paths each carrying partial submodule semantics:
 *   1. `parseStatusPorcelainV2Z`            — parses parent-side rows
 *   2. `collectSubmodulesFromGitmodules`    — discovers via `.gitmodules`
 *   3. `filterMeaninglessSubmoduleEntries`  — filters parent rows by c/m/u
 *
 * That fragmentation produced two real bugs in this codebase: a deinit-ed
 * submodule (Project_Forward repro — declared in `.gitmodules`, path on
 * disk is empty + not-a-repo) leaked into the file list because (2) only
 * checked `existsSync`; and a staged-but-c=. submodule pointer was hidden
 * because (3) only kept rows whose `<c>` flag was `C`. Each fix patched a
 * different node in the same conceptual graph; nothing forced them to
 * agree on what "is this row a submodule and is it valid?" means.
 *
 * The snapshot service consolidates that decision into one structural
 * model:
 *   - `declaredInGitmodules`   — does `.gitmodules` mention it?
 *   - `initialized`            — does `git submodule status --recursive`
 *                                report it with a non-`-` prefix?
 *   - `isValidRepo`            — does `getGitRepoMeta(path)` validate the
 *                                path as a repo whose toplevel resolves
 *                                to itself (rejects empty deinit-ed
 *                                paths whose resolved root is the parent)?
 *
 * Downstream consumers (Diff today; History / Editor scope / Quick Open
 * later) ask the service rather than re-implementing the discovery.
 *
 * # Cache & invalidation
 *
 * The service caches one snapshot per resolved repo root. Cache entries
 * are invalidated by the SAME watcher path that drives `gitDiffRequestCache`
 * — `invalidateGitDiffCache(cwd)` calls `invalidateSnapshot(cwd)` so a
 * single FS-event fan-out clears every read-side cache for that cwd. This
 * keeps "watcher fired → next read returns fresh data" as the only
 * freshness invariant the codebase has to maintain.
 *
 * Cache lives in BOTH main and the git-ipc-worker (each module instance
 * has its own Map). The watcher fires in main; `gitIpcWorkerClient
 * .invalidateDiffCache` already postMessages a control envelope that
 * triggers `invalidateGitDiffCache` in the worker, which now also
 * invalidates the worker's snapshot cache.
 *
 * # Migration scope (lesson #13 phases 1-3)
 *
 * - Phase 1: `loadGitDiff` migrated (Diff path).
 * - Phase 2: `getGitHistory` migrated (History path).
 * - Phase 3: `getSubmodules` IPC handler migrated (preserves the
 *            preload-bridged API surface for any external consumers).
 *
 * Editor scope and Quick Open intentionally have no submodule-aware
 * logic in the current codebase — they index every file under the
 * working tree without crossing-or-not-crossing decisions. If a future
 * feature needs them to consult submodule structure (e.g. "exclude
 * files inside un-initialized submodules from Quick Open"), the
 * snapshot service is the canonical answer-owner and migration is one
 * import + one call.
 *
 * The legacy `detectSubmodulesRecursive` compatibility wrapper has been
 * deleted now that no caller remains.
 */

import { access, constants } from 'fs/promises'
import { resolve } from 'path'
import { isMainThread } from 'worker_threads'

import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

import {
  EXEC_TIMEOUT,
  MAX_DIFF_OUTPUT,
  execFileAsync,
  getExecEnv,
  getGitRepoMeta,
  parseSubmoduleStatusOutput,
  readGitmodulesSubmodulePaths,
  type GitSubmoduleInfo
} from './git-utils'

/**
 * Structural facts about ONE submodule of a parent repo. This is the
 * service's atomic unit; consumers compose / filter as needed.
 */
export interface GitSubmoduleSnapshot {
  /** Path relative to the parent repo root, forward-slash separated. */
  path: string
  /** Resolved absolute path on disk. */
  absolutePath: string
  /**
   * True iff the parent repo's `.gitmodules` file declares this path.
   * Set independently of `initialized` — both can be true (normal),
   * both false (impossible — we wouldn't see it), or only one.
   */
  declaredInGitmodules: boolean
  /**
   * True iff `git submodule status --recursive` reports this path with a
   * status flag other than `-`. `-` indicates the submodule is NOT
   * initialized in the parent's working tree (no .git pointer file, no
   * checked-out worktree). Project_Forward's repro shape is
   * `declaredInGitmodules=true, initialized=false`.
   */
  initialized: boolean
  /**
   * True iff `getGitRepoMeta(absolutePath)` reports `isRepo===true` AND
   * the resolved `repoRoot` equals `absolutePath` (i.e. the path is the
   * toplevel of its OWN repo, not just somewhere inside the parent's
   * repo). Empty deinit-ed dirs fail this check because their
   * `rev-parse --show-toplevel` returns the PARENT's toplevel.
   */
  isValidRepo: boolean
  /** Recursion depth: 0 for direct submodules of the parent repo. */
  depth: number
  /**
   * Absolute path of this submodule's parent (the parent repo or another
   * submodule when nested ≥ 2 levels deep).
   */
  parentRoot: string
}

/**
 * Immutable structural snapshot of a working-tree path's git world.
 */
export interface GitRepositorySnapshot {
  /** The cwd as supplied to `getSnapshot()`. */
  cwd: string
  /**
   * Resolved repo root (output of `rev-parse --show-toplevel`). null
   * when cwd is not inside a git repo.
   */
  resolvedRepoRoot: string | null
  /** True iff git is on PATH. */
  gitInstalled: boolean
  /** True iff cwd resolves to a real repo. */
  isRepo: boolean
  /**
   * All recursive submodules — declared, initialized, or both. Consumers
   * that want only the "real" set filter by `s.isValidRepo`.
   */
  submodules: GitSubmoduleSnapshot[]
  /**
   * Stable hash of (resolvedRepoRoot + sorted submodule paths + their
   * (initialized, isValidRepo) flags). Cache key so a callback receiving
   * a snapshot can compare-by-identity to detect "same shape" without
   * walking the array.
   */
  fingerprint: string
  /** UNIX ms when the snapshot was captured. */
  capturedAt: number
}

interface CacheEntry {
  snapshot: GitRepositorySnapshot
  /** Pre-computed cache key (= `resolve(cwd)`) for fast invalidation. */
  key: string
}

const SNAPSHOT_CACHE_TTL_MS = 5_000
const SNAPSHOT_CACHE_MAX_ENTRIES = 32

class GitRepositorySnapshotServiceImpl {
  private cache = new Map<string, CacheEntry>()
  private inFlight = new Map<string, Promise<GitRepositorySnapshot>>()

  /**
   * Return a snapshot for `cwd`. By default uses the per-key cache when
   * the entry is fresher than `SNAPSHOT_CACHE_TTL_MS`; pass `force: true`
   * to bypass the cache (Diff's force-on-entry path uses this).
   */
  async getSnapshot(cwd: string, opts?: { force?: boolean }): Promise<GitRepositorySnapshot> {
    const key = resolve(cwd)
    const force = opts?.force === true

    if (!force) {
      const cached = this.cache.get(key)
      if (cached && (Date.now() - cached.snapshot.capturedAt) < SNAPSHOT_CACHE_TTL_MS) {
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_SNAPSHOT_CACHE_HIT, {
          cwd: key,
          fingerprint: cached.snapshot.fingerprint,
          ageMs: Date.now() - cached.snapshot.capturedAt,
          submoduleCount: cached.snapshot.submodules.length
        })
        return cached.snapshot
      }
    }

    const inFlight = this.inFlight.get(key)
    if (inFlight) return inFlight

    const promise = this.captureAndStore(cwd, key)
    this.inFlight.set(key, promise)
    try {
      return await promise
    } finally {
      this.inFlight.delete(key)
    }
  }

  /**
   * Drop the cached snapshot for `cwd`. Called from
   * `invalidateGitDiffCache` so a single watcher fan-out clears every
   * read-side cache (request, single-repo, snapshot) at once.
   */
  invalidate(cwd: string): number {
    const key = resolve(cwd)
    const had = this.cache.delete(key)
    if (had) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_SNAPSHOT_INVALIDATE, {
        cwd: key
      })
      return 1
    }
    return 0
  }

  /**
   * Test / debug hook. Production code should never need to clear all
   * snapshots; surfaced here so a future "force reload everything"
   * action has a deterministic entry point.
   */
  clearAll(): void {
    this.cache.clear()
  }

  private async captureAndStore(cwd: string, key: string): Promise<GitRepositorySnapshot> {
    const snapshot = await captureGitRepositorySnapshot(cwd)
    this.cache.set(key, { snapshot, key })
    this.evictLRU()
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_SNAPSHOT_CAPTURE, {
      cwd: key,
      isRepo: snapshot.isRepo,
      submoduleCount: snapshot.submodules.length,
      validSubmoduleCount: snapshot.submodules.filter((s) => s.isValidRepo).length,
      fingerprint: snapshot.fingerprint
    })
    return snapshot
  }

  /** Trim the cache to {@link SNAPSHOT_CACHE_MAX_ENTRIES} via insertion-order eviction. */
  private evictLRU(): void {
    if (this.cache.size <= SNAPSHOT_CACHE_MAX_ENTRIES) return
    const overflow = this.cache.size - SNAPSHOT_CACHE_MAX_ENTRIES
    let dropped = 0
    for (const key of Array.from(this.cache.keys())) {
      if (dropped >= overflow) break
      this.cache.delete(key)
      dropped += 1
    }
  }
}

/**
 * Build a snapshot from scratch — no caching. Exported because some
 * test scenarios want to bypass the singleton's cache without going
 * through the `force: true` path.
 */
export async function captureGitRepositorySnapshot(cwd: string): Promise<GitRepositorySnapshot> {
  const meta = await getGitRepoMeta(cwd)
  // GitRepoMeta uses `gitExecutable: string | null` as the
  // git-installed signal — a null value means git wasn't found on PATH.
  const gitInstalled = Boolean(meta.gitExecutable)
  if (!gitInstalled || !meta.isRepo || !meta.repoRoot || !meta.gitExecutable) {
    return {
      cwd,
      resolvedRepoRoot: null,
      gitInstalled,
      isRepo: false,
      submodules: [],
      fingerprint: 'no-repo',
      capturedAt: Date.now()
    }
  }

  const repoRoot = meta.repoRoot
  const submodules = await collectSubmoduleSnapshots(repoRoot, meta.gitExecutable)
  return {
    cwd,
    resolvedRepoRoot: repoRoot,
    gitInstalled: true,
    isRepo: true,
    submodules,
    fingerprint: computeFingerprint(repoRoot, submodules),
    capturedAt: Date.now()
  }
}

/**
 * Discover every recursive submodule of `repoRoot`, validating each via
 * `getGitRepoMeta`, and return a structured list with the meta-flags
 * required by downstream consumers.
 *
 * Strategy:
 *   1. Read `.gitmodules` to get the DECLARED set.
 *   2. Run `git submodule status --recursive` to get the INITIALIZED set
 *      (filtering out lines that begin with `-`).
 *   3. Take the UNION; for each entry, validate via getGitRepoMeta to
 *      compute `isValidRepo`.
 *   4. Compute depth + parentRoot by walking the union's path tree.
 */
async function collectSubmoduleSnapshots(
  repoRoot: string,
  gitExecutable: string
): Promise<GitSubmoduleSnapshot[]> {
  const hasGitmodules = await access(`${repoRoot}/.gitmodules`, constants.F_OK)
    .then(() => true)
    .catch(() => false)
  if (!hasGitmodules) return []

  const [declaredRelPaths, statusInfos] = await Promise.all([
    readGitmodulesSubmodulePaths(repoRoot),
    runSubmoduleStatusRecursive(repoRoot, gitExecutable).catch(() => [] as GitSubmoduleInfo[])
  ])

  // Union by relative path. Status output uses the same path representation
  // as `.gitmodules` (forward-slash, relative to parent), so a string-key
  // Set is sufficient.
  const unionPaths = new Set<string>(declaredRelPaths)
  for (const info of statusInfos) unionPaths.add(info.path)

  // Sort for stable fingerprint computation downstream.
  const sortedPaths = Array.from(unionPaths).sort()

  const declaredSet = new Set(declaredRelPaths)
  const initializedSet = new Set(statusInfos.map((s) => s.path))

  // Validation pass — `getGitRepoMeta` cache makes this cheap on repeat.
  const enriched = await Promise.all(sortedPaths.map(async (subPath) => {
    const absolutePath = resolve(repoRoot, subPath)
    const declaredInGitmodules = declaredSet.has(subPath)
    const initialized = initializedSet.has(subPath)

    let isValidRepo = false
    try {
      // Skip the meta check when the path doesn't exist — saves a fork.
      await access(absolutePath, constants.F_OK)
      const subMeta = await getGitRepoMeta(absolutePath)
      isValidRepo = Boolean(
        subMeta.isRepo
        && subMeta.repoRoot
        && resolve(subMeta.repoRoot) === resolve(absolutePath)
      )
    } catch {
      isValidRepo = false
    }

    return {
      path: subPath,
      absolutePath,
      declaredInGitmodules,
      initialized,
      isValidRepo,
      // depth + parentRoot computed below in a second pass once the
      // sorted list lets us walk the path tree deterministically.
      depth: 0,
      parentRoot: repoRoot
    } satisfies GitSubmoduleSnapshot
  }))

  // Second pass: depth + parentRoot. For each entry, depth = number of
  // existing entries that are a strict prefix of this one (with a
  // trailing `/`). parentRoot = the absolute path of the closest such
  // prefix entry, or repoRoot if there is none.
  for (let i = 0; i < enriched.length; i += 1) {
    const me = enriched[i]
    let depth = 0
    let parentAbs = repoRoot
    for (let j = 0; j < i; j += 1) {
      const candidate = enriched[j]
      if (me.path.startsWith(`${candidate.path}/`)) {
        depth += 1
        parentAbs = candidate.absolutePath
      }
    }
    me.depth = depth
    me.parentRoot = parentAbs
  }

  return enriched
}

async function runSubmoduleStatusRecursive(
  repoRoot: string,
  gitExecutable: string
): Promise<GitSubmoduleInfo[]> {
  const { stdout } = await execFileAsync(
    gitExecutable,
    ['-c', 'core.quotepath=false', 'submodule', 'status', '--recursive'],
    {
      cwd: repoRoot,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv(),
      maxBuffer: MAX_DIFF_OUTPUT
    },
    {
      repoKey: repoRoot,
      priority: 'normal',
      dedupeKey: `repo:snapshot:status:${resolve(repoRoot)}`,
      label: 'git submodule status --recursive (snapshot)'
    }
  )
  const output = typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
  return parseSubmoduleStatusOutput(output, repoRoot)
}

function computeFingerprint(repoRoot: string, submodules: GitSubmoduleSnapshot[]): string {
  // Deliberately stable: only the structural facts that make
  // re-discovery worthwhile. We don't include the submodule's HEAD sha
  // here because that would require an extra git call per submodule and
  // is irrelevant to the "shape of the repo" question this fingerprint
  // answers. Diff's own fingerprint cache (`singleRepoDiffCache`) handles
  // content-level freshness via mtime tokens.
  const parts: string[] = [resolve(repoRoot)]
  for (const sub of submodules) {
    parts.push(`${sub.path}|${sub.declaredInGitmodules ? 'd' : '.'}|${sub.initialized ? 'i' : '.'}|${sub.isValidRepo ? 'v' : '.'}`)
  }
  return parts.join(';')
}

/**
 * Map a snapshot's valid submodule list to the legacy `GitSubmoduleInfo`
 * shape that the rest of the codebase still expects. Used by the
 * compatibility wrapper inside `detectSubmodulesRecursive`.
 */
export function snapshotToLegacySubmoduleInfos(snapshot: GitRepositorySnapshot): GitSubmoduleInfo[] {
  // Only the valid-repo set is exposed to legacy callers — that mirrors
  // the previous behavior of `detectSubmodulesRecursive` after the codex
  // fix that rejected deinit-ed paths.
  return snapshot.submodules
    .filter((sub) => sub.isValidRepo)
    .map((sub) => ({
      // `name` is just the last path segment for display purposes — the
      // legacy interface keeps it for History / Editor scope tab labels.
      name: sub.path.split('/').filter(Boolean).pop() ?? sub.path,
      path: sub.path,
      repoRoot: sub.absolutePath,
      depth: sub.depth,
      parentRoot: sub.parentRoot
    }))
}

/**
 * Process-wide singleton. Lives in BOTH main and the git-ipc-worker —
 * each module instance owns its own cache. Cross-instance invalidation
 * is handled by `invalidateGitDiffCache` which calls `invalidate()`
 * here in whichever process loaded this module.
 *
 * `isMainThread` gating is intentional NOT done here because the
 * snapshot service has no main-process-only side effects (no IPC, no
 * BrowserWindow refs). Both threads can capture and cache snapshots
 * independently — the only requirement is that they get the SAME
 * invalidation signal, which the watcher → IPC bridge already provides.
 */
export const gitRepositorySnapshotService = new GitRepositorySnapshotServiceImpl()

// Mark the singleton's hosting thread so logs / future debug surfaces
// can distinguish "snapshot captured in main" from "snapshot captured
// in worker" without a separate flag plumbed through.
if (process.env.ONWARD_DEBUG === '1') {
  // eslint-disable-next-line no-console
  console.log(
    `[GitRepositorySnapshotService] hosted in ${isMainThread ? 'main' : 'worker'} thread`
  )
}
