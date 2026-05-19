/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  formatHtmlPreviewZoomPercent,
  getHtmlFileExtension,
  isHtmlPath,
  normalizeHtmlPreviewScrollState,
  normalizeHtmlPreviewZoomFactor,
  stepHtmlPreviewZoomFactor,
  withHtmlPreviewReloadKey
} from '../../src/utils/html-file.ts'

test('PEHTML-U-01 detects supported HTML extensions case-insensitively', () => {
  assert.equal(isHtmlPath('index.html'), true)
  assert.equal(isHtmlPath('INDEX.HTM'), true)
  assert.equal(isHtmlPath('docs/page.xhtml'), true)
  assert.equal(isHtmlPath('docs/page.md'), false)
  assert.equal(isHtmlPath('docs/html'), false)
})

test('PEHTML-U-02 extracts extensions across slash styles', () => {
  assert.equal(getHtmlFileExtension('docs/page.HTML'), 'html')
  assert.equal(getHtmlFileExtension('docs\\page.htm'), 'htm')
  assert.equal(getHtmlFileExtension('docs/page'), '')
  assert.equal(getHtmlFileExtension(null), '')
})

test('PEHTML-U-03 adds a reload key while preserving existing query params', () => {
  const next = withHtmlPreviewReloadKey('file:///tmp/page.html?mtime=123', 456)
  assert.equal(next, 'file:///tmp/page.html?mtime=123&onwardHtmlReload=456')
})

test('PEHTML-U-04 adds a reload key to plain URLs', () => {
  const next = withHtmlPreviewReloadKey('file:///tmp/page.html', 7)
  assert.equal(next, 'file:///tmp/page.html?onwardHtmlReload=7')
})

test('PEHTML-U-05 normalizes HTML preview scroll state from browser data', () => {
  assert.deepEqual(normalizeHtmlPreviewScrollState({
    x: 12.5,
    y: 480,
    scrollWidth: 900,
    scrollHeight: 1800,
    clientWidth: 700,
    clientHeight: 500
  }), {
    x: 12.5,
    y: 480,
    scrollWidth: 900,
    scrollHeight: 1800,
    clientWidth: 700,
    clientHeight: 500
  })
})

test('PEHTML-U-06 clamps invalid HTML preview scroll state fields', () => {
  assert.equal(normalizeHtmlPreviewScrollState(null), null)
  assert.deepEqual(normalizeHtmlPreviewScrollState({
    x: -10,
    y: Number.POSITIVE_INFINITY,
    scrollWidth: 'bad',
    scrollHeight: 200,
    clientWidth: undefined,
    clientHeight: 120
  }), {
    x: 0,
    y: 0,
    scrollWidth: 0,
    scrollHeight: 200,
    clientWidth: 0,
    clientHeight: 120
  })
})

test('PEHTML-U-07 normalizes HTML preview zoom factor', () => {
  assert.equal(normalizeHtmlPreviewZoomFactor(1.234), 1.23)
  assert.equal(normalizeHtmlPreviewZoomFactor(0.1), 0.5)
  assert.equal(normalizeHtmlPreviewZoomFactor(3), 2)
  assert.equal(normalizeHtmlPreviewZoomFactor(Number.NaN), 1)
  assert.equal(normalizeHtmlPreviewZoomFactor('bad'), 1)
})

test('PEHTML-U-08 steps HTML preview zoom factor within bounds', () => {
  assert.equal(stepHtmlPreviewZoomFactor(1, 'in'), 1.1)
  assert.equal(stepHtmlPreviewZoomFactor(1, 'out'), 0.9)
  assert.equal(stepHtmlPreviewZoomFactor(1.95, 'in'), 2)
  assert.equal(stepHtmlPreviewZoomFactor(0.55, 'out'), 0.5)
  assert.equal(stepHtmlPreviewZoomFactor(1.5, 'reset'), 1)
})

test('PEHTML-U-09 formats HTML preview zoom percent', () => {
  assert.equal(formatHtmlPreviewZoomPercent(1), '100%')
  assert.equal(formatHtmlPreviewZoomPercent(1.25), '125%')
  assert.equal(formatHtmlPreviewZoomPercent(0.5), '50%')
})
