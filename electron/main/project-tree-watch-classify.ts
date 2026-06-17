/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure classification of a @parcel/watcher event type into the action the
 * project-tree watcher should take. Kept dependency-free so it can be
 * unit-tested without Electron's main-process imports (mirrors
 * `project-tree-watch-ignore.ts`).
 *
 *   - 'delete' → 'remove': the path is gone. We can drop it (and cascade prefix
 *     removals) WITHOUT a stat — more accurate than the old fs.watch
 *     stat→ENOENT inference, which raced a delete-then-recreate.
 *   - 'create' | 'update' → 'classify': the path exists; the caller stats it to
 *     decide file (add) vs directory (walk). 'update' is treated like 'create'
 *     on purpose: it is idempotent for the filename index (re-adding a known
 *     file is a no-op) and guards the case where a rapid create-then-update
 *     coalesced the 'create' away.
 */
export type ParcelEventType = 'create' | 'update' | 'delete'
export type ParcelEventAction = 'remove' | 'classify'

export function parcelEventAction(type: ParcelEventType): ParcelEventAction {
  return type === 'delete' ? 'remove' : 'classify'
}
