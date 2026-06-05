/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decideTaskNameAutoFollow,
  type TaskNameAutoFollowInput
} from '../../src/components/TerminalGrid/auto-follow-name.ts'

// Locks the auto-follow keep / clear / adopt decision table AND the boot-time
// hydration barrier. Pairs with terminal-manual-name-roundtrip.test.mts: that
// test proves the marker survives persistence; this one proves the marker (and
// the barrier) actually protect the user's customName from clobber.

function input(over: Partial<TaskNameAutoFollowInput> = {}): TaskNameAutoFollowInput {
  return {
    autoFollowEnabled: true,
    terminalVisible: true,
    currentCustomName: null,
    currentManualRepoRoot: null,
    newRepoRoot: '/repo',
    newBranch: 'main',
    isInitialPass: false,
    ...over
  }
}

test('auto-follow disabled → skip, never renames', () => {
  const d = decideTaskNameAutoFollow(input({ autoFollowEnabled: false }))
  assert.equal(d.source, 'skipped-disabled')
  assert.equal(d.rename, false)
})

test('terminal not visible → skip, never renames', () => {
  const d = decideTaskNameAutoFollow(input({ terminalVisible: false }))
  assert.equal(d.source, 'not-visible')
  assert.equal(d.rename, false)
})

test('(a) manual override in same repo → KEEP the user name even on a branch change (THE fix)', () => {
  const d = decideTaskNameAutoFollow(input({
    currentCustomName: 'my-feature',
    currentManualRepoRoot: '/repo',
    newRepoRoot: '/repo',
    newBranch: 'some-other-branch'
  }))
  assert.equal(d.source, 'manual')
  assert.equal(d.rename, false, 'a manually-renamed Task must not be auto-renamed')
})

test('(b) manual override but cwd moved to a different repo → adopt new branch + clear override', () => {
  const d = decideTaskNameAutoFollow(input({
    currentCustomName: 'my-feature',
    currentManualRepoRoot: '/repo/old',
    newRepoRoot: '/repo/new',
    newBranch: 'develop'
  }))
  assert.equal(d.source, 'cleared-by-repo-switch')
  assert.equal(d.rename, true)
  assert.equal(d.clearedManualOverride, true)
  assert.equal(d.branch, 'develop')
})

test('(b2) HYDRATION BARRIER: first pass must NOT overwrite a loaded name even with a null marker', () => {
  const d = decideTaskNameAutoFollow(input({
    currentCustomName: 'loaded-from-disk',
    currentManualRepoRoot: null, // marker transiently null (e.g. stamped before repoRoot resolved)
    newRepoRoot: '/repo',
    newBranch: 'main',
    isInitialPass: true
  }))
  assert.equal(d.source, 'skipped-initial-hydration')
  assert.equal(d.rename, false)
})

test('hydration barrier does NOT block a fresh, unnamed Task (auto-follow still names it on first sync)', () => {
  const d = decideTaskNameAutoFollow(input({
    currentCustomName: null,
    currentManualRepoRoot: null,
    newBranch: 'main',
    isInitialPass: true
  }))
  assert.equal(d.source, 'auto-branch')
  assert.equal(d.rename, true)
  assert.equal(d.branch, 'main')
})

test('(c) after the initial pass, a no-marker Task tracks the branch normally', () => {
  const d = decideTaskNameAutoFollow(input({
    currentCustomName: 'old-branch',
    currentManualRepoRoot: null,
    newBranch: 'new-branch',
    isInitialPass: false
  }))
  assert.equal(d.source, 'auto-branch')
  assert.equal(d.rename, true)
  assert.equal(d.branch, 'new-branch')
})

test('branch already equals customName → no-change, no rename', () => {
  const d = decideTaskNameAutoFollow(input({
    currentCustomName: 'main',
    currentManualRepoRoot: null,
    newBranch: 'main',
    isInitialPass: false
  }))
  assert.equal(d.source, 'no-change')
  assert.equal(d.rename, false)
})

test('null branch (non-repo cwd) never clobbers an existing name', () => {
  const d = decideTaskNameAutoFollow(input({
    currentCustomName: 'kept',
    currentManualRepoRoot: null,
    newRepoRoot: null,
    newBranch: null,
    isInitialPass: false
  }))
  assert.equal(d.rename, false)
  assert.equal(d.source, 'no-change')
})

test('barrier only fires on the FIRST pass: a later real branch switch is honoured', () => {
  // Same inputs as the barrier test but isInitialPass=false → adopts the branch.
  const d = decideTaskNameAutoFollow(input({
    currentCustomName: 'loaded-from-disk',
    currentManualRepoRoot: null,
    newBranch: 'feature-x',
    isInitialPass: false
  }))
  assert.equal(d.source, 'auto-branch')
  assert.equal(d.rename, true)
})
