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
    capturedAt
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
