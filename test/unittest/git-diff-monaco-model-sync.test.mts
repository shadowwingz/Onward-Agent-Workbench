/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildGitDiffModelSyncPlan } from '../../src/components/GitDiffViewer/monacoModelSync.ts'

test('model sync plan is noop when both sides already match', () => {
  const plan = buildGitDiffModelSyncPlan({
    currentOriginalContent: 'base\n',
    currentModifiedContent: 'worktree\n',
    nextOriginalContent: 'base\n',
    nextModifiedContent: 'worktree\n'
  })

  assert.equal(plan.needsSync, false)
  assert.equal(plan.originalChanged, false)
  assert.equal(plan.modifiedChanged, false)
  assert.equal(plan.originalLen, 5)
  assert.equal(plan.modifiedLen, 9)
})

test('model sync plan detects a changed original side independently', () => {
  const plan = buildGitDiffModelSyncPlan({
    currentOriginalContent: 'old base\n',
    currentModifiedContent: 'worktree\n',
    nextOriginalContent: 'new base\n',
    nextModifiedContent: 'worktree\n'
  })

  assert.equal(plan.needsSync, true)
  assert.equal(plan.originalChanged, true)
  assert.equal(plan.modifiedChanged, false)
})

test('model sync plan detects repeated same-file modified content changes', () => {
  let current = 'line\ntrial-1\n'

  for (let i = 2; i <= 5; i += 1) {
    const next = `line\ntrial-${i}\n`
    const plan = buildGitDiffModelSyncPlan({
      currentOriginalContent: 'line\n',
      currentModifiedContent: current,
      nextOriginalContent: 'line\n',
      nextModifiedContent: next
    })

    assert.equal(plan.needsSync, true)
    assert.equal(plan.originalChanged, false)
    assert.equal(plan.modifiedChanged, true)
    assert.equal(plan.modifiedLen, next.length)
    current = next
  }
})
