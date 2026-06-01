/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { appStateContentChanged, deepEqualJson } from '../../src/utils/app-state-diff.ts'
import type { AppState } from '../../src/types/tab.d.ts'

// Minimal AppState-shaped fixture. appStateContentChanged only walks the
// top-level keys structurally, so a plain object covers the contract.
function makeState(overrides: Record<string, unknown> = {}): AppState {
  return {
    activeTabId: 'tab-1',
    tabs: [
      { id: 'tab-1', terminals: [], localPrompts: [], promptPanelWidth: 320 }
    ],
    globalPrompts: [],
    promptCleanup: { autoEnabled: false, autoKeepDays: 30, autoDeleteColored: false, lastAutoCleanupAt: null },
    lastFocusedTerminalId: null,
    projectEditorStates: {},
    promptSchedules: [],
    uiPreferences: { promptInputMode: 'default' },
    customLayoutPresets: [],
    updatedAt: 1000,
    ...overrides
  } as unknown as AppState
}

test('deepEqualJson handles primitives, arrays, objects, null, type mismatch', () => {
  assert.equal(deepEqualJson(1, 1), true)
  assert.equal(deepEqualJson('a', 'a'), true)
  assert.equal(deepEqualJson(null, null), true)
  assert.equal(deepEqualJson(null, {}), false)
  assert.equal(deepEqualJson(1, '1'), false)
  assert.equal(deepEqualJson([1, 2, 3], [1, 2, 3]), true)
  assert.equal(deepEqualJson([1, 2], [1, 2, 3]), false)
  assert.equal(deepEqualJson({ a: 1, b: [2] }, { a: 1, b: [2] }), true)
  assert.equal(deepEqualJson({ a: 1 }, { a: 2 }), false)
  assert.equal(deepEqualJson({ a: 1 }, { a: 1, b: 2 }), false) // extra key
  assert.equal(deepEqualJson([], {}), false) // array vs object
})

test('appStateContentChanged: identical reference is not a change', () => {
  const s = makeState()
  assert.equal(appStateContentChanged(s, s), false)
})

test('appStateContentChanged: shallow clone (no-op updater {...prev}) is not a change', () => {
  // This is the exact shape of the no-op updates that drove the idle render
  // storm: a new top-level object whose nested refs are all reused.
  const prev = makeState()
  const next = { ...prev } as AppState
  assert.notEqual(prev, next) // genuinely a different object reference
  assert.equal(appStateContentChanged(prev, next), false)
})

test('appStateContentChanged: rebuilt-but-content-equal subtree is not a change', () => {
  // cleanupPrompts-style: tabs.map(t => ({...t})) rebuilds every tab object
  // (new references) with identical content. Must still bail out.
  const prev = makeState()
  const next = {
    ...prev,
    tabs: (prev.tabs as unknown[]).map((t) => ({ ...(t as object) }))
  } as AppState
  assert.notEqual(prev.tabs, (next as AppState).tabs)
  assert.equal(appStateContentChanged(prev, next), false)
})

test('appStateContentChanged: a differing updatedAt alone is NOT a change', () => {
  const prev = makeState({ updatedAt: 1000 })
  const next = makeState({ updatedAt: 9999 })
  // every other key is structurally equal; updatedAt is excluded by design.
  assert.equal(appStateContentChanged(prev, next), false)
})

test('appStateContentChanged: a real top-level value change is detected', () => {
  const prev = makeState({ activeTabId: 'tab-1' })
  const next = makeState({ activeTabId: 'tab-2' })
  assert.equal(appStateContentChanged(prev, next), true)
})

test('appStateContentChanged: a deep nested change is detected', () => {
  const prev = makeState()
  const next = {
    ...prev,
    tabs: [{ id: 'tab-1', terminals: [], localPrompts: [{ id: 'p1' }], promptPanelWidth: 320 }]
  } as unknown as AppState
  assert.equal(appStateContentChanged(prev, next), true)
})

test('appStateContentChanged: adding/removing a top-level key is detected', () => {
  const prev = makeState()
  const added = { ...prev, brandNewKey: 1 } as unknown as AppState
  assert.equal(appStateContentChanged(prev, added), true)
})
