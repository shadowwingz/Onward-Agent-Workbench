/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure, filesystem-only submodule discovery.
 *
 * This module is a deliberate LEAF: it imports only `fs/promises` and `path`,
 * with NO dependency on `git-utils`, the git runtime, Electron, or any process
 * spawn. That keeps it unit-testable in plain Node (see
 * `test/unittest/git-submodule-disk-discovery.test.mts`) and, more
 * importantly, makes structural submodule discovery cost ZERO git processes.
 *
 * # Why this exists
 *
 * The old `GitRepositorySnapshotService` discovered submodules with
 * `git submodule status --recursive`. On Git-for-Windows that subcommand is
 * still a POSIX shell script that forks ~15 helper processes; under a
 * corporate EDR minifilter that taxes every process creation (~1-3 s each) it
 * measured 8-10 s per call — and it ran on the Git-Diff-open hot path. But
 * everything `submodule status` reports is already on disk:
 *   - `.gitmodules` (one `fs.readFile`) lists a repo's DECLARED submodules;
 *     recurse into each initialized one to find nested submodules.
 *   - `<path>/.git` existing (a directory, or a `gitdir:` gitfile) means the
 *     submodule is INITIALIZED and is its own valid repo — one `fs.stat`.
 * So we replace the fork-storm with pure fs walking.
 *
 * # Cross-platform
 *
 * The submodule `gitfile` mechanism (`.git` is a file containing
 * `gitdir: ...`) is identical on macOS, Linux, and Windows, so no
 * `process.platform` branch is needed. `.gitmodules` always uses
 * forward-slash, relative-to-its-repo paths on every platform; we normalize
 * any stray backslashes when parsing.
 */

import { readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'

/**
 * Structural facts about ONE submodule of a parent repo — the atomic unit the
 * snapshot service composes / filters. Derived entirely from the filesystem.
 */
export interface GitSubmoduleSnapshot {
  /** Path relative to the TOP repo root, forward-slash separated. */
  path: string
  /** Resolved absolute path on disk. */
  absolutePath: string
  /**
   * True iff a `.gitmodules` along the discovery chain declares this path.
   * Everything we discover is declared (that is how the walk reached it), so
   * this is always `true` for returned entries — kept for the snapshot's
   * structural model / fingerprint compatibility.
   */
  declaredInGitmodules: boolean
  /**
   * True iff `<absolutePath>/.git` exists as a directory or a `gitdir:`
   * gitfile. A de-init-ed submodule (empty directory) reports `false`.
   */
  initialized: boolean
  /**
   * True iff the path is the working-tree root of its OWN git repo. Derived
   * purely from the filesystem (equivalent to the old `getGitRepoMeta`
   * toplevel-equals-self check, minus the `git rev-parse` fork): a checked-out
   * submodule has a `.git`; an empty deinit-ed dir does not.
   */
  isValidRepo: boolean
  /** Recursion depth: 0 for direct submodules of the top repo. */
  depth: number
  /**
   * Absolute path of this submodule's parent (the top repo or another
   * submodule when nested ≥ 2 levels deep).
   */
  parentRoot: string
}

/**
 * Parse the `path = ...` entries out of a repo's `.gitmodules`. Returns paths
 * relative to `repoRoot`, forward-slash normalized. Missing / unreadable
 * `.gitmodules` yields `[]`. Pure fs; no git.
 */
export async function readGitmodulesSubmodulePaths(repoRoot: string): Promise<string[]> {
  try {
    const content = await readFile(join(repoRoot, '.gitmodules'), 'utf-8')
    const paths: string[] = []
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#') || line.startsWith(';')) continue
      const match = line.match(/^path\s*=\s*(.+)$/)
      if (!match) continue
      const pathValue = match[1].trim()
      if (pathValue) paths.push(pathValue.replace(/\\/g, '/'))
    }
    return paths
  } catch {
    return []
  }
}

/**
 * Decide whether `absPath` is the working-tree root of its OWN git repo, using
 * ONLY the filesystem — zero git process spawns. See the module header for the
 * gitfile rationale.
 */
export async function isGitWorktreeRoot(absPath: string): Promise<boolean> {
  try {
    const dotGit = join(absPath, '.git')
    const info = await stat(dotGit)
    if (info.isDirectory()) return true
    if (info.isFile()) {
      const content = await readFile(dotGit, 'utf-8')
      return content.trimStart().startsWith('gitdir:')
    }
    return false
  } catch {
    return false
  }
}

/**
 * Discover every recursive submodule of `repoRoot` using ONLY the filesystem.
 * `path` is relative to the TOP `repoRoot` (matching the old
 * `submodule status --recursive` representation). Structural discovery costs
 * ZERO git processes.
 */
export async function collectSubmoduleSnapshotsFromDisk(
  repoRootRaw: string
): Promise<GitSubmoduleSnapshot[]> {
  // All emitted paths are forward-slash normalized, matching the rest of the
  // git read-side surface (`normalizeGitPath`). The diff path asserts repo
  // roots contain no `\` (DSM-01-paths-normalized), and the renderer keys its
  // per-repo loading state on the normalized root — a backslash here on
  // Windows makes that match fail and the submodule never clears "loading"
  // (DSM-04 / RSM-04 full-load timeout). `path.resolve` emits the platform
  // separator, so we normalize its output on every level.
  const repoRoot = repoRootRaw.replace(/\\/g, '/')
  const enriched: GitSubmoduleSnapshot[] = []
  const seen = new Set<string>()
  // DFS over the submodule tree. Each stack frame is a repo whose
  // `.gitmodules` we read, plus its path relative to the TOP repoRoot.
  const stack: Array<{ repoAbs: string; topRelPrefix: string }> = [
    { repoAbs: repoRoot, topRelPrefix: '' }
  ]
  while (stack.length > 0) {
    const { repoAbs, topRelPrefix } = stack.pop() as { repoAbs: string; topRelPrefix: string }
    const declaredRel = await readGitmodulesSubmodulePaths(repoAbs)
    for (const rel of declaredRel) {
      const topRelPath = topRelPrefix ? `${topRelPrefix}/${rel}` : rel
      if (seen.has(topRelPath)) continue
      seen.add(topRelPath)
      const absolutePath = resolve(repoRoot, topRelPath).replace(/\\/g, '/')
      const initialized = await isGitWorktreeRoot(absolutePath)
      enriched.push({
        path: topRelPath,
        absolutePath,
        declaredInGitmodules: true,
        initialized,
        isValidRepo: initialized,
        depth: 0,
        parentRoot: repoRoot
      })
      // Only recurse into initialized submodules — an un-checked-out path has
      // no `.gitmodules` of its own to read.
      if (initialized) {
        stack.push({ repoAbs: absolutePath, topRelPrefix: topRelPath })
      }
    }
  }

  // Stable order for fingerprint determinism (DFS order is stack-dependent).
  enriched.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  // Second pass: depth + parentRoot. The list is sorted lexicographically, so
  // every prefix of `me.path` appears at an index < i, and the LAST such
  // prefix in iteration order is the closest (longest) parent.
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
