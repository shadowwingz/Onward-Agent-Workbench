/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-state-mirror-worker-core.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  beginMirrorRecompute,
  classifyEventPath,
  completeMirrorAttach,
  computeMirrorDelta,
  createMirrorWorkerEntry,
  finishMirrorRecomputeIfCurrent,
  requestMirrorAttach,
  requestMirrorDetach
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
