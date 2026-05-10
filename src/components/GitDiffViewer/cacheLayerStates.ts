/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Two-layer taxonomy for "what happened during this click":
//
//   Render-side state (renderState):
//     React state (`fileContents`) holds file bodies because Monaco needs
//     JS strings to render. This isn't a deliberate cache — it's the natural
//     consequence of "the diff has to be displayed". When the state already
//     has the file body, the click short-circuits and never sends an IPC.
//     We call this "loaded" / "unloaded".
//
//   Main-process cache (mainCacheState):
//     The real, deliberate cache layer in the main process
//     (`GitDiffContentCache`). Sized, eviction-aware, watcher-invalidated,
//     shared across windows. When IPC reaches main, this layer is consulted
//     and reports "hit" / "miss". When the click never reaches IPC (because
//     Render state short-circuited), main was simply not asked, so its
//     state for THIS click is "not-consulted".
//
// The pair (renderState, mainCacheState) is enough to describe every
// observable click outcome. The deprecated "cacheState" / "cacheSource"
// pair was equivalent in information content but conflated the two layers
// into a single 'hit'/'miss' label, which led to repeated user confusion
// (e.g. "why does a deleted file's first click show cache hit?").

import type { GitDiffContentCacheSource } from '../../types/electron'

export type RenderState = 'loaded' | 'unloaded'

export type MainCacheState = 'hit' | 'miss' | 'not-consulted'

export interface CacheLayerStates {
  renderState: RenderState
  mainCacheState: MainCacheState
}

/**
 * Derive the two-layer state pair from the legacy (cacheState, cacheSource)
 * pair recorded by `clickLatencyTracker`. Pure function — exported for
 * isolation testing.
 */
export function deriveCacheLayerStates(
  cacheState: 'hit' | 'miss',
  cacheSource: GitDiffContentCacheSource | null | undefined
): CacheLayerStates {
  // The renderer-memory short-circuit fired: React state already had the
  // body, so IPC was skipped and the main cache wasn't consulted at all.
  if (cacheSource === 'renderer-memory') {
    return { renderState: 'loaded', mainCacheState: 'not-consulted' }
  }
  // IPC happened. cacheState directly mirrors what the main cache reported.
  // (worker-rebuild source pairs with miss in production; main-content-cache
  // pairs with hit. The mapping is the same either way.)
  return {
    renderState: 'unloaded',
    mainCacheState: cacheState === 'hit' ? 'hit' : 'miss'
  }
}
