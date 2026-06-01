/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AppState } from '../types/tab.d.ts'

/**
 * Structural deep-equality for JSON-serialisable values.
 *
 * `AppState` is persisted to disk as JSON, so every value reachable from
 * it is a primitive, a plain object, or an array — never a function,
 * Map, Set, Date, or class instance. That lets us compare structurally
 * without worrying about prototypes or non-enumerable members.
 *
 * Pure: no side effects, no `Date.now()`, no `window`. Unit-tested in
 * `test/unittest/appstate-update-bailout.test.mts`.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object'
  ) {
    return false
  }
  const aIsArray = Array.isArray(a)
  if (aIsArray !== Array.isArray(b)) return false
  if (aIsArray) {
    const aa = a as unknown[]
    const bb = b as unknown[]
    if (aa.length !== bb.length) return false
    for (let i = 0; i < aa.length; i++) {
      if (!deepEqualJson(aa[i], bb[i])) return false
    }
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const aKeys = Object.keys(ao)
  const bKeys = Object.keys(bo)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, key)) return false
    if (!deepEqualJson(ao[key], bo[key])) return false
  }
  return true
}

/**
 * Decide whether an `updateState` result is a real change vs. a no-op.
 *
 * Root cause of the idle-CPU render storm (CLAUDE.md / `docs/lessons.md`):
 * `updateState` stamps `updatedAt: Date.now()` and spreads a fresh object
 * on every call, so `Object.is(prev, next)` was ALWAYS false. React could
 * never apply its documented bail-out ("identical next state ⇒ skip
 * re-render"), so any effect that — directly or transitively — called
 * `updateState` turned into an unbounded whole-tree render loop. Returning
 * `prev` unchanged when nothing actually changed restores the bail-out and
 * breaks the loop.
 *
 * `updatedAt` is intentionally excluded from the comparison: it is a
 * derived bookkeeping field written by `updateState` itself, not a
 * semantic input. Comparing it would defeat the entire purpose.
 *
 * Cost: top-level keys are compared by reference first (cheap); only keys
 * whose reference differs are compared structurally, bounding the deep
 * compare to the sub-tree an action creator actually rebuilt. The very
 * first bail-out also stops the loop, so the deep-compare cost is
 * transient even under a regressed caller.
 *
 * Pure: no side effects. Unit-tested.
 */
export function appStateContentChanged(prev: AppState, next: AppState): boolean {
  if (prev === next) return false
  const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)])
  for (const key of keys) {
    if (key === 'updatedAt') continue
    const a = (prev as unknown as Record<string, unknown>)[key]
    const b = (next as unknown as Record<string, unknown>)[key]
    if (a === b) continue
    if (!deepEqualJson(a, b)) return true
  }
  return false
}
