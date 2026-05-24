/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-large-file-policy.test.mts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GIT_FILE_READ_BUFFER_MARGIN,
  GIT_LARGE_FILE_CONFIRM_SIZE,
  gitLargeFileReadMaxBuffer,
  requiresGitLargeFileConfirmation
} from '../../electron/main/git-large-file-policy.ts'

test('Git Diff large-file prompt threshold is strictly above 3 MiB', () => {
  assert.equal(requiresGitLargeFileConfirmation(GIT_LARGE_FILE_CONFIRM_SIZE - 1), false)
  assert.equal(requiresGitLargeFileConfirmation(GIT_LARGE_FILE_CONFIRM_SIZE), false)
  assert.equal(requiresGitLargeFileConfirmation(GIT_LARGE_FILE_CONFIRM_SIZE + 1), true)
})

test('Git Diff large-file prompt can be bypassed after user confirmation', () => {
  assert.equal(
    requiresGitLargeFileConfirmation(GIT_LARGE_FILE_CONFIRM_SIZE + 1, { allowLargeFile: true }),
    false
  )
})

test('Git file reader maxBuffer stays finite when size metadata is invalid', () => {
  const fallback = GIT_LARGE_FILE_CONFIRM_SIZE + GIT_FILE_READ_BUFFER_MARGIN

  assert.equal(gitLargeFileReadMaxBuffer(null), fallback)
  assert.equal(gitLargeFileReadMaxBuffer(undefined), fallback)
  assert.equal(gitLargeFileReadMaxBuffer(Number.NaN), fallback)
  assert.equal(gitLargeFileReadMaxBuffer(-1), fallback)
  assert.equal(Number.isFinite(gitLargeFileReadMaxBuffer(Number.NaN)), true)
  assert.ok(gitLargeFileReadMaxBuffer(Number.NaN) < Number.MAX_SAFE_INTEGER)
})

test('Git file reader maxBuffer allows known finite sizes with a fixed margin', () => {
  assert.equal(
    gitLargeFileReadMaxBuffer(GIT_LARGE_FILE_CONFIRM_SIZE + 42),
    GIT_LARGE_FILE_CONFIRM_SIZE + 42 + GIT_FILE_READ_BUFFER_MARGIN
  )
  assert.equal(gitLargeFileReadMaxBuffer(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
})
