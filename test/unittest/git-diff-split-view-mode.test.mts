/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_GIT_DIFF_SPLIT_VIEW_MODE,
  coerceGitDiffSplitViewMode,
  resolveGitDiffSplitViewMode
} from '../../src/components/GitDiffViewer/diffSplitViewMode.ts'

describe('git diff split view mode', () => {
  it('defaults to inline when no stored preference is valid', () => {
    assert.equal(resolveGitDiffSplitViewMode(undefined, null, 'bad'), DEFAULT_GIT_DIFF_SPLIT_VIEW_MODE)
    assert.equal(DEFAULT_GIT_DIFF_SPLIT_VIEW_MODE, 'inline')
  })

  it('accepts current auto, split, and inline mode names', () => {
    assert.equal(coerceGitDiffSplitViewMode('auto'), 'auto')
    assert.equal(coerceGitDiffSplitViewMode('split'), 'split')
    assert.equal(coerceGitDiffSplitViewMode('inline'), 'inline')
  })

  it('migrates legacy display mode values', () => {
    assert.equal(coerceGitDiffSplitViewMode('side-by-side'), 'split')
    assert.equal(coerceGitDiffSplitViewMode('unified'), 'inline')
  })

  it('respects the first valid stored preference', () => {
    assert.equal(resolveGitDiffSplitViewMode('bad', 'auto', 'inline'), 'auto')
    assert.equal(resolveGitDiffSplitViewMode('bad', 'split'), 'split')
  })
})
