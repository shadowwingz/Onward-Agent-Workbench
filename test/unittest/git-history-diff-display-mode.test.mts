/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_GIT_HISTORY_DIFF_DISPLAY_MODE,
  coerceGitHistoryDiffDisplayMode,
  resolveGitHistoryDiffDisplayMode,
  toGitHistoryPatchDiffStyle
} from '../../src/components/GitHistoryViewer/diffDisplayMode.ts'

describe('git history diff display mode', () => {
  it('defaults to inline when no stored preference is valid', () => {
    assert.equal(resolveGitHistoryDiffDisplayMode(undefined, null, 'bad'), DEFAULT_GIT_HISTORY_DIFF_DISPLAY_MODE)
    assert.equal(DEFAULT_GIT_HISTORY_DIFF_DISPLAY_MODE, 'inline')
  })

  it('accepts current side-by-side and inline mode names', () => {
    assert.equal(coerceGitHistoryDiffDisplayMode('side-by-side'), 'side-by-side')
    assert.equal(coerceGitHistoryDiffDisplayMode('inline'), 'inline')
  })

  it('migrates legacy split and unified values', () => {
    assert.equal(coerceGitHistoryDiffDisplayMode('split'), 'side-by-side')
    assert.equal(coerceGitHistoryDiffDisplayMode('unified'), 'inline')
  })

  it('maps display mode to the diff renderer style', () => {
    assert.equal(toGitHistoryPatchDiffStyle('side-by-side'), 'split')
    assert.equal(toGitHistoryPatchDiffStyle('inline'), 'unified')
  })
})
