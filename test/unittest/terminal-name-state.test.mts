/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { findTerminalNameState } from '../../src/utils/terminal-name-state.ts'

// Locks the authoritative name/marker lookup that the auto-follow ref-lag
// hardening relies on: auto-follow reads customName + manualNameRepoRoot through
// this (over the synchronous stateRef) instead of the lagging visibleTerminals
// copy, so a git sync right after a rename cannot read a stale null marker.

const tabs = [
  { terminals: [
    { id: 'a', customName: 'Alpha', manualNameRepoRoot: '/repo/a' },
    { id: 'b', customName: null, manualNameRepoRoot: null }
  ] },
  { terminals: [
    { id: 'c', customName: 'Gamma', manualNameRepoRoot: '/repo/c' }
  ] }
]

test('finds a terminal in the first tab', () => {
  assert.deepEqual(findTerminalNameState(tabs, 'a'), { customName: 'Alpha', manualNameRepoRoot: '/repo/a' })
})

test('finds a terminal in a later tab (cross-tab lookup)', () => {
  assert.deepEqual(findTerminalNameState(tabs, 'c'), { customName: 'Gamma', manualNameRepoRoot: '/repo/c' })
})

test('returns nulls for an unknown terminal id', () => {
  assert.deepEqual(findTerminalNameState(tabs, 'zzz'), { customName: null, manualNameRepoRoot: null })
})

test('a Task with no marker reads marker=null (so auto-follow may name it)', () => {
  assert.deepEqual(findTerminalNameState(tabs, 'b'), { customName: null, manualNameRepoRoot: null })
})

test('missing customName / marker fields coerce to null (not undefined)', () => {
  const out = findTerminalNameState([{ terminals: [{ id: 'x' }] }], 'x')
  assert.equal(out.customName, null)
  assert.equal(out.manualNameRepoRoot, null)
})

test('handles empty / null / malformed inputs without throwing', () => {
  assert.deepEqual(findTerminalNameState([], 'a'), { customName: null, manualNameRepoRoot: null })
  assert.deepEqual(findTerminalNameState(null, 'a'), { customName: null, manualNameRepoRoot: null })
  assert.deepEqual(findTerminalNameState(undefined, 'a'), { customName: null, manualNameRepoRoot: null })
  assert.deepEqual(findTerminalNameState([{ terminals: null }], 'a'), { customName: null, manualNameRepoRoot: null })
  assert.deepEqual(findTerminalNameState(tabs, ''), { customName: null, manualNameRepoRoot: null })
})

test('first match wins (terminal ids are globally unique)', () => {
  const dup = [
    { terminals: [{ id: 'dup', customName: 'first', manualNameRepoRoot: '/r1' }] },
    { terminals: [{ id: 'dup', customName: 'second', manualNameRepoRoot: '/r2' }] }
  ]
  assert.equal(findTerminalNameState(dup, 'dup').customName, 'first')
})
