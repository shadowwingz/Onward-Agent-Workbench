/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-diff-hunk-actions.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDiffFromFile } from '@pierre/diffs'

import {
  buildContentWithChangeRange,
  buildHunkActionWidgetPlan,
  createHunkActionRange,
  findHunkContainingLine,
  getHunkActionWidgetEligibility,
  normalizeHunkActionLineChange
} from '../../src/components/GitDiffViewer/gitDiffHunkActions.ts'
import { translate } from '../../src/i18n/core.ts'

import type { GitFileStatus } from '../../src/types/electron.ts'

function file(overrides: Partial<GitFileStatus> = {}): GitFileStatus {
  return {
    filename: 'src/app.ts',
    status: 'M',
    additions: 1,
    deletions: 0,
    changeType: 'unstaged',
    resourceGroup: 'workingTree',
    originalRef: 'index',
    modifiedRef: 'workingTree',
    ...overrides
  }
}

const firstChange = {
  originalStartLineNumber: 2,
  originalEndLineNumber: 2,
  modifiedStartLineNumber: 2,
  modifiedEndLineNumber: 2
}

test('hunk widgets install for a normal worktree file and clamp anchor lines', () => {
  const plan = buildHunkActionWidgetPlan({
    file: file(),
    state: {},
    isDraftDirty: false,
    lineCount: 1,
    changes: [firstChange]
  })

  assert.equal(plan.eligibility.result, 'installed')
  assert.equal(plan.widgets.length, 1)
  assert.equal(plan.widgets[0].anchorLine, 1)
  assert.equal(plan.widgets[0].primaryAction, 'stage')
  assert.equal(plan.widgets[0].showRevert, true)
  assert.deepEqual(plan.widgets[0].range, createHunkActionRange({
    ...firstChange,
    modifiedStartLineNumber: 1,
    modifiedEndLineNumber: 1
  }, 0))
})

test('staged files expose unstage without a revert widget action', () => {
  const plan = buildHunkActionWidgetPlan({
    file: file({ changeType: 'staged', resourceGroup: 'index' }),
    state: {},
    isDraftDirty: false,
    lineCount: 10,
    changes: [firstChange]
  })

  assert.equal(plan.eligibility.result, 'installed')
  assert.equal(plan.widgets[0].primaryAction, 'unstage')
  assert.equal(plan.widgets[0].showRevert, false)
})

test('hunk widget eligibility rejects boundary inputs deterministically', () => {
  assert.deepEqual(getHunkActionWidgetEligibility({
    file: null,
    state: {},
    isDraftDirty: false,
    changeCount: 1
  }), { result: 'skipped', reason: 'no-file' })
  assert.deepEqual(getHunkActionWidgetEligibility({
    file: file({ isSubmoduleEntry: true }),
    state: {},
    isDraftDirty: false,
    changeCount: 1
  }), { result: 'skipped', reason: 'submodule' })
  assert.deepEqual(getHunkActionWidgetEligibility({
    file: file({ changeType: 'untracked', resourceGroup: 'untracked' }),
    state: {},
    isDraftDirty: false,
    changeCount: 1
  }), { result: 'skipped', reason: 'untracked' })
  assert.deepEqual(getHunkActionWidgetEligibility({
    file: file({ status: 'D' }),
    state: {},
    isDraftDirty: false,
    changeCount: 1
  }), { result: 'skipped', reason: 'deleted' })
  assert.deepEqual(getHunkActionWidgetEligibility({
    file: file(),
    state: { loading: true },
    isDraftDirty: false,
    changeCount: 1
  }), { result: 'retry', reason: 'loading' })
  assert.deepEqual(getHunkActionWidgetEligibility({
    file: file(),
    state: { error: 'failed' },
    isDraftDirty: false,
    changeCount: 1
  }), { result: 'skipped', reason: 'error' })
  assert.deepEqual(getHunkActionWidgetEligibility({
    file: file(),
    state: { isBinary: true },
    isDraftDirty: false,
    changeCount: 1
  }), { result: 'skipped', reason: 'binary' })
  assert.deepEqual(getHunkActionWidgetEligibility({
    file: file(),
    state: {},
    isDraftDirty: true,
    changeCount: 1
  }), { result: 'skipped', reason: 'dirty-draft' })
  assert.deepEqual(getHunkActionWidgetEligibility({
    file: file(),
    state: {},
    isDraftDirty: false,
    changeCount: 0
  }), { result: 'skipped', reason: 'no-changes' })
})

test('hunk widget plan caps rendered widgets to avoid DOM overload', () => {
  const changes = Array.from({ length: 120 }, (_, index) => ({
    originalStartLineNumber: index + 1,
    originalEndLineNumber: index + 1,
    modifiedStartLineNumber: index + 1,
    modifiedEndLineNumber: index + 1
  }))

  const plan = buildHunkActionWidgetPlan({
    file: file(),
    state: {},
    isDraftDirty: false,
    lineCount: 200,
    changes
  })

  assert.equal(plan.eligibility.result, 'installed')
  assert.equal(plan.widgets.length, 100)
})

test('hunk widget plan drops invalid Monaco line changes before widget creation', () => {
  const plan = buildHunkActionWidgetPlan({
    file: file(),
    state: {},
    isDraftDirty: false,
    lineCount: 20,
    changes: [
      {
        originalStartLineNumber: 10,
        originalEndLineNumber: 12,
        modifiedStartLineNumber: 30,
        modifiedEndLineNumber: 40
      },
      firstChange
    ]
  })

  assert.equal(plan.eligibility.result, 'installed')
  assert.equal(plan.widgets.length, 1)
  assert.deepEqual(plan.widgets[0].range, createHunkActionRange(firstChange, 1))
})

test('normalizeHunkActionLineChange rejects reversed ranges but preserves pure deletions', () => {
  assert.equal(normalizeHunkActionLineChange({
    originalStartLineNumber: 8,
    originalEndLineNumber: 3,
    modifiedStartLineNumber: 5,
    modifiedEndLineNumber: 6
  }, 10), null)

  assert.deepEqual(normalizeHunkActionLineChange({
    originalStartLineNumber: 10,
    originalEndLineNumber: 12,
    modifiedStartLineNumber: 99,
    modifiedEndLineNumber: 0
  }, 20), {
    originalStartLineNumber: 10,
    originalEndLineNumber: 12,
    modifiedStartLineNumber: 20,
    modifiedEndLineNumber: 0
  })
})

test('hunk action user-facing copy avoids implementation terminology', () => {
  const translatedChangeActionCopy = (['en', 'zh-CN'] as const).flatMap((locale) => [
    translate(locale, 'gitDiff.hunk.stageTitle'),
    translate(locale, 'gitDiff.hunk.revertTitle'),
    translate(locale, 'gitDiff.hunk.unstageTitle'),
    translate(locale, 'gitDiff.hunk.action.staged'),
    translate(locale, 'gitDiff.hunk.action.reverted'),
    translate(locale, 'gitDiff.hunk.action.unstaged')
  ])

  assert.equal(
    translatedChangeActionCopy.some((value) => /hunk|change block|\u5dee\u5f02\u5757/i.test(value)),
    false
  )
})

test('findHunkContainingLine: line inside any hunk modified range matches', () => {
  const ranges = [
    createHunkActionRange({
      originalStartLineNumber: 5,
      originalEndLineNumber: 7,
      modifiedStartLineNumber: 5,
      modifiedEndLineNumber: 8
    }, 0),
    createHunkActionRange({
      originalStartLineNumber: 20,
      originalEndLineNumber: 20,
      modifiedStartLineNumber: 21,
      modifiedEndLineNumber: 21
    }, 1)
  ]

  // Inside first hunk.
  assert.equal(findHunkContainingLine(5, ranges)?.index, 0)
  assert.equal(findHunkContainingLine(6, ranges)?.index, 0)
  assert.equal(findHunkContainingLine(8, ranges)?.index, 0)
  // Just outside first hunk.
  assert.equal(findHunkContainingLine(4, ranges), null)
  assert.equal(findHunkContainingLine(9, ranges), null)
  // Second hunk.
  assert.equal(findHunkContainingLine(21, ranges)?.index, 1)
  // Far away.
  assert.equal(findHunkContainingLine(50, ranges), null)
})

test('findHunkContainingLine: pure deletion accepts either neighbouring line', () => {
  // Monaco encodes pure deletion with modifiedEnd=0 and modifiedStart=line
  // before the deletion in modified.
  const deletion = createHunkActionRange({
    originalStartLineNumber: 10,
    originalEndLineNumber: 12,
    modifiedStartLineNumber: 9,
    modifiedEndLineNumber: 0
  }, 0)

  assert.equal(findHunkContainingLine(9, [deletion])?.index, 0)
  assert.equal(findHunkContainingLine(10, [deletion])?.index, 0)
  assert.equal(findHunkContainingLine(8, [deletion]), null)
  assert.equal(findHunkContainingLine(11, [deletion]), null)
})

test('findHunkContainingLine: defends against bogus inputs', () => {
  const range = createHunkActionRange({
    originalStartLineNumber: 1,
    originalEndLineNumber: 1,
    modifiedStartLineNumber: 1,
    modifiedEndLineNumber: 1
  }, 0)

  assert.equal(findHunkContainingLine(0, [range]), null)
  assert.equal(findHunkContainingLine(-3, [range]), null)
  assert.equal(findHunkContainingLine(Number.NaN, [range]), null)
  assert.equal(findHunkContainingLine(1, []), null)
})

test('buildContentWithChangeRange can apply or exclude a single changed range', () => {
  const oldContent = 'one\nold-a\nsame\nold-b\n'
  const newContent = 'one\nnew-a\nsame\nnew-b\n'
  const diff = parseDiffFromFile(
    { name: 'src/app.ts', contents: oldContent },
    { name: 'src/app.ts', contents: newContent }
  )
  const first = createHunkActionRange({
    originalStartLineNumber: 2,
    originalEndLineNumber: 2,
    modifiedStartLineNumber: 2,
    modifiedEndLineNumber: 2
  }, 0)

  assert.equal(
    buildContentWithChangeRange(diff, first, true, oldContent, newContent),
    'one\nnew-a\nsame\nold-b\n'
  )
  assert.equal(
    buildContentWithChangeRange(diff, first, false, oldContent, newContent),
    'one\nold-a\nsame\nnew-b\n'
  )
})

test('buildContentWithChangeRange falls back to the hunk index for EOF line drift', () => {
  const oldContent = '# Clean parent\n\nbaseline parent content\n'
  const newContent = '# Clean parent\n\nGDS-29 hunk switch file\n'
  const diff = parseDiffFromFile(
    { name: 'README.md', contents: oldContent },
    { name: 'README.md', contents: newContent }
  )
  const eofDriftRange = createHunkActionRange({
    originalStartLineNumber: 4,
    originalEndLineNumber: 4,
    modifiedStartLineNumber: 4,
    modifiedEndLineNumber: 4
  }, 0)

  assert.equal(
    buildContentWithChangeRange(diff, eofDriftRange, false, oldContent, newContent),
    oldContent
  )
})
