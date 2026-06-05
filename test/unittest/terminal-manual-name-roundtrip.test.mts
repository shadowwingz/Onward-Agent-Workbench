/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizePersistedTerminal,
  normalizePersistedTerminals
} from '../../electron/main/persisted-terminal.ts'

// Regression lock for the auto-update-restart "renames reverted" bug:
// migrateTerminalData (via normalizePersistedTerminal) used to rebuild every
// terminal as { id, customName, lastCwd } and silently DROP manualNameRepoRoot
// — the "this name is a manual override, do not auto-rename it" marker. With
// the marker gone, every manually-renamed Task hydrated as marker=null and the
// auto-follow engine overwrote the user's name with the live git branch on the
// next git-info sync. These tests pin the round-trip at the serialization layer.

test('manualNameRepoRoot round-trips when present (THE regression)', () => {
  const out = normalizePersistedTerminal({
    id: 't1',
    customName: 'Rive 动画设计',
    manualNameRepoRoot: '/Users/me/Projects/animation',
    lastCwd: null
  })
  assert.equal(out.id, 't1')
  assert.equal(out.customName, 'Rive 动画设计')
  assert.equal(out.manualNameRepoRoot, '/Users/me/Projects/animation')
})

test('manualNameRepoRoot defaults to null when absent', () => {
  const out = normalizePersistedTerminal({ id: 't2', customName: 'master', lastCwd: null })
  assert.equal(out.customName, 'master')
  assert.equal(out.manualNameRepoRoot, null)
})

test('manualNameRepoRoot coerces non-string values to null', () => {
  for (const bad of [undefined, 123, {}, [], true]) {
    const out = normalizePersistedTerminal({
      id: 't3',
      customName: 'x',
      // @ts-expect-error intentionally invalid input shapes
      manualNameRepoRoot: bad,
      lastCwd: null
    })
    assert.equal(out.manualNameRepoRoot, null, `expected null for ${JSON.stringify(bad)}`)
  }
})

test('an explicit-null customName still carries the marker through', () => {
  const out = normalizePersistedTerminal({
    id: 't4',
    customName: null,
    manualNameRepoRoot: '/repo',
    lastCwd: null
  })
  assert.equal(out.customName, null)
  assert.equal(out.manualNameRepoRoot, '/repo')
})

test('legacy "Agent N: name" title migration preserves a passed-through marker', () => {
  // Legacy records have no customName field; the marker (if any) still rides along.
  const out = normalizePersistedTerminal({
    id: 't5',
    title: 'Agent 2: my-feature',
    manualNameRepoRoot: '/repo/x',
    lastCwd: null
  })
  assert.equal(out.customName, 'my-feature')
  assert.equal(out.manualNameRepoRoot, '/repo/x')
})

test('legacy "Agent N" (no custom name) → null customName, null marker by default', () => {
  const out = normalizePersistedTerminal({ id: 't6', title: 'Agent 3', lastCwd: null })
  assert.equal(out.customName, null)
  assert.equal(out.manualNameRepoRoot, null)
})

test('the persisted shape always has exactly the four fields (no field dropped)', () => {
  const out = normalizePersistedTerminal({
    id: 't7',
    customName: 'name',
    manualNameRepoRoot: '/r',
    lastCwd: null
  })
  assert.deepEqual(Object.keys(out).sort(), ['customName', 'id', 'lastCwd', 'manualNameRepoRoot'])
})

test('normalizePersistedTerminals maps an array and keeps every marker', () => {
  const out = normalizePersistedTerminals([
    { id: 'a', customName: 'A', manualNameRepoRoot: '/ra', lastCwd: null },
    { id: 'b', customName: 'B', manualNameRepoRoot: null, lastCwd: null },
    { id: 'c', customName: 'C', manualNameRepoRoot: '/rc', lastCwd: null }
  ])
  assert.equal(out.length, 3)
  assert.deepEqual(out.map(t => t.manualNameRepoRoot), ['/ra', null, '/rc'])
  assert.deepEqual(out.map(t => t.customName), ['A', 'B', 'C'])
})

test('normalizePersistedTerminals returns [] for non-array input', () => {
  assert.deepEqual(normalizePersistedTerminals(undefined), [])
  assert.deepEqual(normalizePersistedTerminals(null), [])
  assert.deepEqual(normalizePersistedTerminals('nope'), [])
})

test('a full save→load round-trip preserves the marker (idempotent, no drift)', () => {
  const once = normalizePersistedTerminals([
    { id: 'x', customName: 'kept', manualNameRepoRoot: '/repo/root', lastCwd: null }
  ])
  // Feeding the output back in (as a reload would) must not lose the marker.
  const twice = normalizePersistedTerminals(once)
  assert.deepEqual(twice, once)
  assert.equal(twice[0].manualNameRepoRoot, '/repo/root')
})
