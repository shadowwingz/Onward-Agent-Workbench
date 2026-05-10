/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-diff-cache-layer-states.test.mts
 *
 * Locks down the two-layer taxonomy: every legacy (cacheState, cacheSource)
 * pair maps to exactly one (renderState, mainCacheState) pair the panel
 * displays. The four legitimate production combinations are exercised plus
 * the defensive null-source case.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveCacheLayerStates } from '../../src/components/GitDiffViewer/cacheLayerStates.ts'

test('renderer-memory short-circuit: render=loaded, main=not-consulted (IPC was skipped)', () => {
  // The renderer's React state already had the file body — the click
  // resolved without sending IPC, so the main cache never got a question.
  assert.deepEqual(
    deriveCacheLayerStates('hit', 'renderer-memory'),
    { renderState: 'loaded', mainCacheState: 'not-consulted' }
  )
})

test('main cache hit: render=unloaded, main=hit (IPC happened, main answered)', () => {
  assert.deepEqual(
    deriveCacheLayerStates('hit', 'main-content-cache'),
    { renderState: 'unloaded', mainCacheState: 'hit' }
  )
})

test('worker rebuild: render=unloaded, main=miss (both layers empty, worker fetched)', () => {
  assert.deepEqual(
    deriveCacheLayerStates('miss', 'worker-rebuild'),
    { renderState: 'unloaded', mainCacheState: 'miss' }
  )
})

test('miss with null source: defensive — render=unloaded, main=miss', () => {
  // Some defensive code paths leave source unset on a miss. The legacy
  // pair was (miss, null); the new pair must still produce a sensible
  // unloaded/miss read so the panel never shows blank pills.
  assert.deepEqual(
    deriveCacheLayerStates('miss', null),
    { renderState: 'unloaded', mainCacheState: 'miss' }
  )
})

test('hit with null source: degenerate — treats as main hit, NOT renderer-memory', () => {
  // Theoretically not produced in production, but if it ever is, "main
  // cache hit" is the safer label (it's still a hit, just no source info).
  // Importantly, the renderer-memory branch is gated explicitly on
  // source === 'renderer-memory', so a null source can never be silently
  // upgraded to "render loaded".
  assert.deepEqual(
    deriveCacheLayerStates('hit', null),
    { renderState: 'unloaded', mainCacheState: 'hit' }
  )
})

test('hit with worker-rebuild source: theoretical only — same as main hit', () => {
  // worker-rebuild pairs with miss in production; here we make sure the
  // mapping doesn't silently misclassify it as renderer-memory if some
  // future refactor produces this odd pair.
  assert.deepEqual(
    deriveCacheLayerStates('hit', 'worker-rebuild'),
    { renderState: 'unloaded', mainCacheState: 'hit' }
  )
})
