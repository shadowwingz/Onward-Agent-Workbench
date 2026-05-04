/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for computePaneVisibility(): the pure-logic decision that
 * picks one or two PDF panes for the GitPdfCompare component based on
 * the file's git status. Pair with the autotest suite
 * `run-pdf-epub-diff` (assertions `git-diff-pdf-{added,deleted}-single-pane`,
 * `git-{diff,history}-pdf-modified-two-panes`) which covers the
 * end-to-end DOM render against a real repo.
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-pdf-compare-pane-visibility.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { computePaneVisibility } from '../../src/components/GitPdfCompare/computePaneVisibility.ts'

// ─────────────── GPV-U-01..05 status × pane visibility table ───────────────

test('GPV-U-01 added → modified pane only, single-pane mode', () => {
  const v = computePaneVisibility('added')
  assert.equal(v.showOriginalPane, false)
  assert.equal(v.showModifiedPane, true)
  assert.equal(v.isSinglePane, true)
})

test('GPV-U-02 deleted → original pane only, single-pane mode', () => {
  const v = computePaneVisibility('deleted')
  assert.equal(v.showOriginalPane, true)
  assert.equal(v.showModifiedPane, false)
  assert.equal(v.isSinglePane, true)
})

test('GPV-U-03 modified → both panes, two-pane mode', () => {
  const v = computePaneVisibility('modified')
  assert.equal(v.showOriginalPane, true)
  assert.equal(v.showModifiedPane, true)
  assert.equal(v.isSinglePane, false)
})

test('GPV-U-04 isSinglePane is the negation of (both panes shown)', () => {
  // Cross-check: isSinglePane must match the boolean expression it derives
  // from, so a future refactor that breaks this contract fails here loudly.
  for (const status of ['added', 'deleted', 'modified'] as const) {
    const v = computePaneVisibility(status)
    assert.equal(v.isSinglePane, !(v.showOriginalPane && v.showModifiedPane), `status=${status}`)
  }
})

test('GPV-U-05 added and deleted produce mutually-exclusive sides', () => {
  const a = computePaneVisibility('added')
  const d = computePaneVisibility('deleted')
  // Whichever side 'added' shows, 'deleted' must hide, and vice versa.
  // This locks in the semantic that each status keeps the *present* file's
  // side, not the empty side.
  assert.equal(a.showOriginalPane, !d.showOriginalPane)
  assert.equal(a.showModifiedPane, !d.showModifiedPane)
})
