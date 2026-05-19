/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'path'

import type { MirrorDelta, MirrorState } from './git-state-mirror-types'

export type MirrorWatcherFilterReason = 'gitObjects' | 'lockfile' | 'tmpfile' | 'gitInternal' | 'allowed'

export interface MirrorWorkerEntryCore {
  cwd: string
  watchedRoot: string
  state: MirrorState | null
  watcherDispose: (() => Promise<void>) | null
  attachInFlight: boolean
  detachRequested: boolean
  debounceTimer: NodeJS.Timeout | null
  pendingSince: number | null
  pendingPaths: Set<string>
  recomputeGeneration: number
}

export function createMirrorWorkerEntry(cwd: string): MirrorWorkerEntryCore {
  const key = resolve(cwd)
  return {
    cwd: key,
    watchedRoot: key,
    state: null,
    watcherDispose: null,
    attachInFlight: false,
    detachRequested: false,
    debounceTimer: null,
    pendingSince: null,
    pendingPaths: new Set(),
    recomputeGeneration: 0
  }
}

export function resolveMirrorWatcherRoot(state: MirrorState | null): string | null {
  if (!state?.repoRoot) return null
  return resolve(state.repoRoot)
}

/**
 * .git event filter used by the worker watcher.
 *
 * Worktree files such as Cargo.lock, pnpm-lock.yaml, and yarn.lock are real
 * project inputs and must trigger recompute. Only transient files inside
 * .git/ are filtered.
 */
export function classifyEventPath(eventPath: string, watchedRoot: string): {
  drop: boolean
  reason: MirrorWatcherFilterReason
} {
  const normWatched = watchedRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const normEvent = eventPath.replace(/\\/g, '/')
  const rel = normEvent.startsWith(normWatched + '/')
    ? normEvent.slice(normWatched.length + 1)
    : normEvent

  if (rel === '.git' || rel.startsWith('.git/')) {
    if (rel.endsWith('.lock')) return { drop: true, reason: 'lockfile' }
    if (/(?:^|\/)\.tmp_/.test(rel)) return { drop: true, reason: 'tmpfile' }
    if (/~\d+$/.test(rel)) return { drop: true, reason: 'tmpfile' }
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

export function cleanupMirrorWorkerEntry(entry: MirrorWorkerEntryCore): void {
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer)
    entry.debounceTimer = null
  }
  entry.pendingPaths.clear()
  entry.pendingSince = null
}

export function requestMirrorAttach(entry: MirrorWorkerEntryCore): 'start' | 'already-attached' | 'already-in-flight' | 'resume-in-flight' {
  if (entry.watcherDispose) {
    entry.detachRequested = false
    return 'already-attached'
  }
  if (entry.attachInFlight) {
    if (entry.detachRequested) {
      entry.detachRequested = false
      return 'resume-in-flight'
    }
    return 'already-in-flight'
  }
  entry.detachRequested = false
  entry.attachInFlight = true
  return 'start'
}

export async function completeMirrorAttach(
  entry: MirrorWorkerEntryCore,
  dispose: () => Promise<void>
): Promise<'attached' | 'detached'> {
  entry.attachInFlight = false
  if (entry.detachRequested) {
    try {
      await dispose()
    } finally {
      entry.watcherDispose = null
      cleanupMirrorWorkerEntry(entry)
    }
    return 'detached'
  }
  entry.watcherDispose = dispose
  return 'attached'
}

export async function requestMirrorDetach(entry: MirrorWorkerEntryCore): Promise<'detached' | 'pending-attach' | 'idle'> {
  entry.detachRequested = true
  cleanupMirrorWorkerEntry(entry)
  if (entry.attachInFlight && !entry.watcherDispose) {
    return 'pending-attach'
  }
  if (!entry.watcherDispose) {
    return 'idle'
  }
  const dispose = entry.watcherDispose
  entry.watcherDispose = null
  try {
    await dispose()
  } finally {
    cleanupMirrorWorkerEntry(entry)
  }
  return 'detached'
}

export function beginMirrorRecompute(entry: MirrorWorkerEntryCore): number {
  entry.recomputeGeneration += 1
  return entry.recomputeGeneration
}

export function finishMirrorRecomputeIfCurrent(
  entry: MirrorWorkerEntryCore,
  generation: number,
  next: MirrorState
): MirrorDelta | null {
  if (entry.detachRequested || generation !== entry.recomputeGeneration) {
    return null
  }
  const delta = computeMirrorDelta(entry.state, next)
  entry.state = next
  return delta
}

export function computeMirrorDelta(prev: MirrorState | null, next: MirrorState): MirrorDelta {
  const out: MirrorDelta = { capturedAt: next.capturedAt }
  if (!prev) {
    out.repoRoot = next.repoRoot
    out.repoName = next.repoName
    out.branch = next.branch
    out.status = next.status
    out.files = next.files
    out.repos = next.repos
    out.submodulesLoading = next.submodulesLoading
    out.generation = next.generation
    return out
  }
  if (prev.repoRoot !== next.repoRoot) out.repoRoot = next.repoRoot
  if (prev.repoName !== next.repoName) out.repoName = next.repoName
  if (prev.branch !== next.branch) out.branch = next.branch
  if (prev.status !== next.status) out.status = next.status
  if (prev.submodulesLoading !== next.submodulesLoading) out.submodulesLoading = next.submodulesLoading
  if (!sameFileList(prev.files, next.files)) out.files = next.files
  if (!sameRepos(prev.repos, next.repos)) out.repos = next.repos
  // Generation is always included when it changed — Refresh Changes
  // is the trigger that bumps generation even when underlying data
  // (branch/status/files) is byte-identical.
  if (prev.generation !== next.generation) out.generation = next.generation
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
