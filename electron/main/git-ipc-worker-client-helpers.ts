/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'path'

export type GitFileContentWorkerRequestOptions = {
  force?: boolean
  allowLargeFile?: boolean
  /**
   * Git-runtime scheduling priority. Foreground clicks omit this (treated as
   * 'high'); the background precompute passes 'low' so it runs in a separate
   * lane and never blocks a click. Part of the dedupe-key stringify, so a
   * 'low' precompute fetch and a 'high' click of the same file do not collide.
   */
  priority?: 'high' | 'normal' | 'low'
  /** Diagnostic miss-reason tag carried through to the worker; also part of the dedupe key. */
  missReason?: string
}

export type GitDiffWorkerRequestOptions = {
  force?: boolean
  scope?: string
}

export type GitFileContentWorkerKeyFile = {
  filename: string
  status: string
  originalFilename?: string
  changeType: string
  isSubmoduleEntry?: boolean
}

export function stableStringifyForWorkerKey(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringifyForWorkerKey).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringifyForWorkerKey(record[key])}`).join(',')}}`
}

export function repoKeyForWorker(cwd: string, repoRoot?: string | null): string {
  return resolve(repoRoot || cwd)
}

/**
 * Git-runtime lane suffixes. Each DISTINCT repoKey gets its own concurrency-1
 * slot in the worker's per-repo queue (`git-runtime-manager`), so appending a
 * suffix forks a NEW lane that runs concurrently with — and never FIFO-blocks —
 * the bare-repoKey foreground lane. Three lanes, locked in the prewarm-cache
 * design review (decision ⑨):
 *   1. foreground            → bare repoKey                     (priority 'high')
 *   2. prewarm diff list     → `${repoKey}::diff-precompute`    (priority 'low')
 *   3. prewarm content burst → `${repoKey}::precompute-burst`   (priority 'low')
 * Splitting (2) from (3) keeps a slow full-list recompute from holding the slot
 * the per-file content burst needs, and keeps BOTH off the foreground lane —
 * the fix for the measured 18-29s first-click latency on EDR-throttled hosts.
 */
export const GIT_LANE_SUFFIX = {
  diffPrecompute: '::diff-precompute',
  precomputeBurst: '::precompute-burst',
  historyPrecompute: '::history-precompute'
} as const

/**
 * Lane key for `getDiff`. Background prewarm (and the renderer-fallback warm)
 * forks the `::diff-precompute` lane; a foreground enter stays on the bare cwd
 * lane so it never queues behind a slow background recompute.
 */
export function diffListLaneKey(cwd: string, background: boolean): string {
  return background ? `${cwd}${GIT_LANE_SUFFIX.diffPrecompute}` : cwd
}

/**
 * Lane key for `getFileContent`. A 'low'-priority precompute fetch forks the
 * `::precompute-burst` lane off the file's BASE repoKey (which already routes
 * submodule files to their own per-repoRoot lane via `repoKeyForWorker`);
 * 'high' / 'normal' foreground clicks stay on the base lane. The burst lane is
 * deliberately distinct from `::diff-precompute` so the per-file content warm
 * and the full-list recompute do not contend for one slot.
 */
export function fileContentLaneKey(baseRepoKey: string, priority: 'high' | 'normal' | 'low'): string {
  return priority === 'low' ? `${baseRepoKey}${GIT_LANE_SUFFIX.precomputeBurst}` : baseRepoKey
}

/**
 * Lane key for `getHistory` / `getHistoryDiff`. The background History prewarm
 * forks the `::history-precompute` lane (low priority) so it never blocks a
 * foreground History open or a Diff enter for the same repo; foreground History
 * requests stay on the bare cwd lane.
 */
export function historyLaneKey(cwd: string, background: boolean): string {
  return background ? `${cwd}${GIT_LANE_SUFFIX.historyPrecompute}` : cwd
}

export function buildGitFileContentWorkerDedupeKey(
  cwd: string,
  file: GitFileContentWorkerKeyFile,
  repoRoot?: string,
  options?: GitFileContentWorkerRequestOptions
): string | undefined {
  if (options?.force) return undefined
  return `git-ipc:file-content:${repoKeyForWorker(cwd, repoRoot)}:${stableStringifyForWorkerKey(file)}:${stableStringifyForWorkerKey(options ?? {})}`
}

export function buildGitDiffWorkerDedupeKey(
  cwd: string,
  options?: GitDiffWorkerRequestOptions
): string | undefined {
  if (options?.force) return undefined
  return `git-ipc:diff:${resolve(cwd)}:${stableStringifyForWorkerKey(options ?? {})}`
}
