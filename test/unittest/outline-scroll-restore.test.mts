/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldCaptureOutlineScrollTop } from '../../src/components/ProjectEditor/Outline/outlineScrollRestore.ts'

test('OSR-U-01 ignores a transient zero capture while restoring a positive outline scroll', () => {
  assert.equal(
    shouldCaptureOutlineScrollTop({
      captureKey: 'project:docs/large.md',
      pendingRestoreKey: 'project:docs/large.md',
      previousScrollTop: 3200,
      nextScrollTop: 0
    }),
    false
  )
})

test('OSR-U-02 accepts positive captures during an outline restore', () => {
  assert.equal(
    shouldCaptureOutlineScrollTop({
      captureKey: 'project:docs/large.md',
      pendingRestoreKey: 'project:docs/large.md',
      previousScrollTop: 3200,
      nextScrollTop: 3188
    }),
    true
  )
})

test('OSR-U-03 accepts user scroll-to-top when no restore is pending', () => {
  assert.equal(
    shouldCaptureOutlineScrollTop({
      captureKey: 'project:docs/large.md',
      pendingRestoreKey: null,
      previousScrollTop: 3200,
      nextScrollTop: 0
    }),
    true
  )
})

test('OSR-U-04 accepts zero captures for unrelated files', () => {
  assert.equal(
    shouldCaptureOutlineScrollTop({
      captureKey: 'project:docs/current.md',
      pendingRestoreKey: 'project:docs/other.md',
      previousScrollTop: 3200,
      nextScrollTop: 0
    }),
    true
  )
})
