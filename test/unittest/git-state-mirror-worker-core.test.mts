/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-state-mirror-worker-core.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addMirrorWatcherGroupEntry,
  beginMirrorRecompute,
  beginMirrorPoll,
  classifyEventPath,
  computeMirrorWatcherBackoffMs,
  completeMirrorAttach,
  computeMirrorDelta,
  createMirrorWorkerEntry,
  finishMirrorPoll,
  finishMirrorRecomputeIfCurrent,
  isMirrorWatcherPathMissingError,
  MIRROR_WATCHER_IGNORE,
  requestMirrorAttach,
  requestMirrorDetach,
  normaliseMirrorRepoRootKey,
  resolveMirrorWatcherRoot
} from '../../electron/main/git-state-mirror-worker-core.ts'

import type { MirrorState } from '../../electron/main/git-state-mirror-types.ts'

function snapshot(cwd: string, status: MirrorState['status'], capturedAt: number): MirrorState {
  return {
    cwd,
    repoRoot: cwd,
    repoName: 'repo',
    branch: 'main',
    status,
    files: status === 'clean'
      ? []
      : [{
          filename: 'Cargo.lock',
          status: 'M',
          additions: 1,
          deletions: 0,
          changeType: 'unstaged',
          resourceGroup: 'workingTree',
          originalRef: 'index',
          modifiedRef: 'workingTree'
        }],
    capturedAt,
    generation: 1
  }
}

test('worktree lock files are allowed while git-internal lock files are filtered', () => {
  assert.deepEqual(classifyEventPath('/repo/Cargo.lock', '/repo'), {
    drop: false,
    reason: 'allowed'
  })
  assert.deepEqual(classifyEventPath('/repo/yarn.lock', '/repo'), {
    drop: false,
    reason: 'allowed'
  })
  assert.deepEqual(classifyEventPath('C:\\repo\\pnpm-lock.yaml', 'C:\\repo'), {
    drop: false,
    reason: 'allowed'
  })
  assert.deepEqual(classifyEventPath('/repo/.git/index.lock', '/repo'), {
    drop: true,
    reason: 'lockfile'
  })
  assert.deepEqual(classifyEventPath('C:\\repo\\.git\\index.lock', 'C:\\repo'), {
    drop: true,
    reason: 'lockfile'
  })
})

test('git watcher allowlist still permits durable git state files', () => {
  assert.deepEqual(classifyEventPath('/repo/.git/index', '/repo'), {
    drop: false,
    reason: 'allowed'
  })
  assert.deepEqual(classifyEventPath('/repo/.git/refs/heads/main', '/repo'), {
    drop: false,
    reason: 'allowed'
  })
  assert.deepEqual(classifyEventPath('/repo/.git/objects/ab/cdef', '/repo'), {
    drop: true,
    reason: 'gitObjects'
  })
})

test('Parcel ignore list keeps durable git state files visible', () => {
  const ignored = new Set<string>(MIRROR_WATCHER_IGNORE as readonly string[])
  assert.equal(ignored.has('.git/objects/**'), true)
  assert.equal(ignored.has('node_modules/**'), true)
  assert.equal(ignored.has('.git/index'), false)
  assert.equal(ignored.has('.git/HEAD'), false)
  assert.equal(ignored.has('.git/refs/**'), false)
  assert.equal(ignored.has('.git/packed-refs'), false)
})

test('watcher backoff uses 800/1600/3200/5000 cap', () => {
  assert.equal(computeMirrorWatcherBackoffMs(0), 800)
  assert.equal(computeMirrorWatcherBackoffMs(1), 800)
  assert.equal(computeMirrorWatcherBackoffMs(2), 1600)
  assert.equal(computeMirrorWatcherBackoffMs(3), 3200)
  assert.equal(computeMirrorWatcherBackoffMs(4), 5000)
  assert.equal(computeMirrorWatcherBackoffMs(99), 5000)
})

test('path missing errors are classified for suspended watcher state', () => {
  assert.equal(isMirrorWatcherPathMissingError(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })), true)
  assert.equal(isMirrorWatcherPathMissingError(new Error('watched path does not exist')), true)
  assert.equal(isMirrorWatcherPathMissingError(new Error('permission denied')), false)
})

test('watcher root is only armed for resolved git repositories', () => {
  const nonRepo: MirrorState = {
    cwd: '/Users/test/Projects',
    repoRoot: null,
    repoName: null,
    branch: null,
    status: null,
    files: [],
    capturedAt: 100,
    generation: 1
  }
  const subdirRepo: MirrorState = {
    cwd: '/Users/test/Projects/repo/packages/app',
    repoRoot: '/Users/test/Projects/repo',
    repoName: 'repo',
    branch: 'main',
    status: 'clean',
    files: [],
    capturedAt: 100,
    generation: 1
  }

  assert.equal(resolveMirrorWatcherRoot(nonRepo), null)
  assert.equal(resolveMirrorWatcherRoot(subdirRepo), '/Users/test/Projects/repo')
})

test('detach while attach is in flight disposes the late watcher handle', async () => {
  const entry = createMirrorWorkerEntry('/repo')
  const calls: string[] = []

  assert.equal(requestMirrorAttach(entry), 'start')
  assert.equal(await requestMirrorDetach(entry), 'pending-attach')
  assert.equal(entry.attachInFlight, true)
  assert.equal(entry.detachRequested, true)

  const completed = await completeMirrorAttach(entry, async () => {
    calls.push('unsubscribe')
  })

  assert.equal(completed, 'detached')
  assert.deepEqual(calls, ['unsubscribe'])
  assert.equal(entry.attachInFlight, false)
  assert.equal(entry.watcherDispose, null)
})

test('detach clears debounce/restart/poll/probe timers and pending paths', async () => {
  const entry = createMirrorWorkerEntry('/repo')
  entry.pendingPaths.add('/repo/file.txt')
  entry.pendingSince = 123
  entry.debounceTimer = setTimeout(() => {}, 10_000)
  entry.restartTimer = setTimeout(() => {}, 10_000)
  entry.pollTimer = setTimeout(() => {}, 10_000)
  entry.suspendedProbeTimer = setTimeout(() => {}, 10_000)

  const result = await requestMirrorDetach(entry)

  assert.equal(result, 'idle')
  assert.equal(entry.debounceTimer, null)
  assert.equal(entry.restartTimer, null)
  assert.equal(entry.pollTimer, null)
  assert.equal(entry.suspendedProbeTimer, null)
  assert.equal(entry.pendingSince, null)
  assert.equal(entry.pendingPaths.size, 0)
})

test('rapid resubscribe cancels a pending detach during attach', async () => {
  const entry = createMirrorWorkerEntry('/repo')
  const calls: string[] = []

  assert.equal(requestMirrorAttach(entry), 'start')
  assert.equal(await requestMirrorDetach(entry), 'pending-attach')
  assert.equal(requestMirrorAttach(entry), 'resume-in-flight')

  const completed = await completeMirrorAttach(entry, async () => {
    calls.push('unsubscribe')
  })

  assert.equal(completed, 'attached')
  assert.deepEqual(calls, [])
  assert.equal(entry.attachInFlight, false)
  assert.equal(entry.detachRequested, false)
  assert.equal(typeof entry.watcherDispose, 'function')
})

test('newer recompute wins over stale in-flight recompute completion', () => {
  const entry = createMirrorWorkerEntry('/repo')
  const oldGeneration = beginMirrorRecompute(entry)
  const newGeneration = beginMirrorRecompute(entry)

  const newDelta = finishMirrorRecomputeIfCurrent(entry, newGeneration, snapshot(entry.cwd, 'modified', 200))
  const oldDelta = finishMirrorRecomputeIfCurrent(entry, oldGeneration, snapshot(entry.cwd, 'clean', 100))

  assert.notEqual(newDelta, null)
  assert.equal(oldDelta, null)
  assert.equal(entry.state?.status, 'modified')
  assert.equal(entry.state?.capturedAt, 200)
})

test('poll in flight skips next tick until current poll finishes', () => {
  const entry = createMirrorWorkerEntry('/repo')
  assert.equal(beginMirrorPoll(entry), 'start')
  assert.equal(beginMirrorPoll(entry), 'skip-in-flight')
  finishMirrorPoll(entry)
  assert.equal(beginMirrorPoll(entry), 'start')
  finishMirrorPoll(entry)
})

test('repo root dedupe reuses one watcher for cwd and subdir', () => {
  const groups = new Map()
  const root = '/Users/test/Projects/repo'
  const first = addMirrorWatcherGroupEntry(groups, root, root)
  const second = addMirrorWatcherGroupEntry(groups, root, `${root}/packages/app`)

  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(groups.size, 1)
  assert.equal(first.group, second.group)
  assert.equal(second.group.entries.size, 2)
})

test('repo root key normalizes Windows drive letter and slashes', () => {
  assert.equal(normaliseMirrorRepoRootKey('C:\\Repo\\Project\\'), 'c:/Repo/Project')
  assert.equal(normaliseMirrorRepoRootKey('c:/Repo/Project'), 'c:/Repo/Project')
})

// ---------------------------------------------------------------------------
// computeMirrorDelta — Phase 2 generation propagation
// ---------------------------------------------------------------------------

function stateWithGen(cwd: string, status: MirrorState['status'], generation: number): MirrorState {
  return {
    cwd,
    repoRoot: cwd,
    repoName: 'repo',
    branch: 'main',
    status,
    files: [],
    capturedAt: Date.now(),
    generation
  }
}

test('computeMirrorDelta seeds generation on the first snapshot (prev === null)', () => {
  const next = stateWithGen('/repo', 'clean', 7)
  const delta = computeMirrorDelta(null, next)
  // First snapshot is treated as a full carry-through; generation must
  // be present so the renderer can seed its identity-key correctly.
  assert.equal((delta as MirrorState).generation, 7)
})

test('computeMirrorDelta carries generation only when it changed', () => {
  const prev = stateWithGen('/repo', 'clean', 5)
  const sameGen = stateWithGen('/repo', 'modified', 5)
  const bumpedGen = stateWithGen('/repo', 'modified', 6)

  const sameDelta = computeMirrorDelta(prev, sameGen)
  // status flipped clean → modified, but generation stayed the same:
  // the delta carries the status change without re-stating generation.
  assert.equal(sameDelta.status, 'modified')
  assert.equal((sameDelta as Partial<MirrorState>).generation, undefined)

  const bumpDelta = computeMirrorDelta(prev, bumpedGen)
  // Both status AND generation changed — both surface in the delta so
  // the renderer can both update branch chip AND remount the editor.
  assert.equal(bumpDelta.status, 'modified')
  assert.equal((bumpDelta as MirrorState).generation, 6)
})

test('computeMirrorDelta surfaces a pure-generation bump even when content is byte-identical', () => {
  // This is the "Refresh Changes" path. State is structurally the same
  // (same branch / status / files) — only generation incremented.
  // The delta MUST carry the new generation so the renderer's
  // DiffEditor key changes and the mount lifecycle resets.
  const prev = stateWithGen('/repo', 'modified', 3)
  const next = stateWithGen('/repo', 'modified', 4)
  const delta = computeMirrorDelta(prev, next)
  assert.equal((delta as MirrorState).generation, 4)
  // Other fields are unchanged and should NOT bloat the delta.
  assert.equal(delta.status, undefined)
  assert.equal(delta.repoRoot, undefined)
  assert.equal(delta.files, undefined)
})
