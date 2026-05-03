/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for transformVirtualPaddingForSend(): the pure send-side
 * transform that strips per-line trailing whitespace and pops trailing
 * empty lines, so that virtual-cursor placements which received no input
 * do not leak into the terminal.
 *
 * Pair with the Electron-side runner `run-prompt-editor-context-menu`
 * (assertions PECM-17..22) which covers the click handler, IME guard,
 * undo, paste, and end-to-end submit-time stripping.
 *
 * Usage: node --experimental-strip-types --test test/unittest/prompt-virtual-padding.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { transformVirtualPaddingForSend } from '../../src/utils/prompt-io.ts'

// ─────────────── PVP-U-01..08 send-transform table ───────────────

test('PVP-U-01 leading-pad on a single row is preserved as indent', () => {
  assert.equal(transformVirtualPaddingForSend('   hello'), '   hello')
})

test('PVP-U-02 two real rows with virtual indent on row 2 stay intact', () => {
  assert.equal(transformVirtualPaddingForSend('foo\n   bar'), 'foo\n   bar')
})

test('PVP-U-03 trailing virtual rows + trailing spaces are stripped', () => {
  assert.equal(transformVirtualPaddingForSend('hi\n\n\n   '), 'hi')
})

test('PVP-U-04 row-trailing whitespace is stripped from the last row', () => {
  assert.equal(transformVirtualPaddingForSend('last line   '), 'last line')
})

test('PVP-U-05 single character at (0,0) round-trips', () => {
  assert.equal(transformVirtualPaddingForSend('a'), 'a')
})

test('PVP-U-06 empty input returns empty', () => {
  assert.equal(transformVirtualPaddingForSend(''), '')
})

test('PVP-U-07 interior empty rows from user-typed \\n\\n\\n are preserved', () => {
  assert.equal(transformVirtualPaddingForSend('a\n\n\nb'), 'a\n\n\nb')
})

test('PVP-U-08 mixed leading/trailing pad + interior whitespace-only row collapses correctly', () => {
  // Row 0 has leading + trailing pad, row 1 is whitespace-only (becomes empty
  // after trimEnd but is preserved as a real interior empty row), row 2 has
  // leading pad and one trailing space.
  assert.equal(transformVirtualPaddingForSend('  foo  \n   \n  bar '), '  foo\n\n  bar')
})

// ─────────────── PVP-U-10..13 edge-case guards ───────────────

test('PVP-U-10 tab characters at line end are stripped (not just U+0020)', () => {
  assert.equal(transformVirtualPaddingForSend('hi\t\t\t'), 'hi')
})

test('PVP-U-11 a value of only whitespace and newlines collapses to empty', () => {
  assert.equal(transformVirtualPaddingForSend('   \n   \n\n'), '')
})

test('PVP-U-12 leading empty rows before the first real row are preserved', () => {
  // A user who clicks at row 3 col 0 and types "x" produces "\n\n\nx".
  // The leading three empty rows ARE meaningful — they encode "press Enter
  // three times before typing x" and must reach the terminal verbatim.
  assert.equal(transformVirtualPaddingForSend('\n\n\nx'), '\n\n\nx')
})

test('PVP-U-13 a single trailing newline is dropped (it is one trailing empty row)', () => {
  assert.equal(transformVirtualPaddingForSend('hello\n'), 'hello')
})
