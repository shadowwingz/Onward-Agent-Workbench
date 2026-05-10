/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Project Editor close-retention gate. The paired
 * autotest is `run-project-editor-markdown-session-restore-autotest.sh`,
 * which verifies that a cached Markdown preview does not flash the
 * "select file" empty state after ESC -> reopen.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  shouldRetainProjectEditorViewOnClose,
  type ProjectEditorCloseRetentionInput
} from '../../src/components/ProjectEditor/utils/projectEditorCloseRetention.ts'

const cleanActiveState: ProjectEditorCloseRetentionInput = {
  hasActiveFile: true,
  hasRootPath: true,
  hasUnsavedChanges: false,
  hasMissingFileNotice: false
}

test('PECR-U-01 retains a clean active file for fast reopen', () => {
  assert.equal(shouldRetainProjectEditorViewOnClose(cleanActiveState), true)
})

test('PECR-U-02 does not retain when no file is active', () => {
  assert.equal(shouldRetainProjectEditorViewOnClose({
    ...cleanActiveState,
    hasActiveFile: false
  }), false)
})

test('PECR-U-03 does not retain without a root path', () => {
  assert.equal(shouldRetainProjectEditorViewOnClose({
    ...cleanActiveState,
    hasRootPath: false
  }), false)
})

test('PECR-U-04 does not retain unsaved edits', () => {
  assert.equal(shouldRetainProjectEditorViewOnClose({
    ...cleanActiveState,
    hasUnsavedChanges: true
  }), false)
})

test('PECR-U-05 does not retain a missing-file notice state', () => {
  assert.equal(shouldRetainProjectEditorViewOnClose({
    ...cleanActiveState,
    hasMissingFileNotice: true
  }), false)
})

test('PECR-U-06 input object is not mutated', () => {
  const input = { ...cleanActiveState }
  const snapshot = { ...input }
  shouldRetainProjectEditorViewOnClose(input)
  assert.deepEqual(input, snapshot)
})
