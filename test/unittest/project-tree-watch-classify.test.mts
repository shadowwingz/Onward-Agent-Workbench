/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { parcelEventAction } from '../../electron/main/project-tree-watch-classify.ts'

test('delete events map to a removal (no stat needed)', () => {
  assert.equal(parcelEventAction('delete'), 'remove')
})

test('create and update events map to classify (stat file vs dir)', () => {
  assert.equal(parcelEventAction('create'), 'classify')
  // 'update' is deliberately treated like 'create' — idempotent for the
  // filename index, and covers a coalesced create-then-update.
  assert.equal(parcelEventAction('update'), 'classify')
})

test('the mapping is total over the three @parcel/watcher event types', () => {
  const seen = new Set(['create', 'update', 'delete'].map((t) => parcelEventAction(t as 'create' | 'update' | 'delete')))
  assert.deepEqual([...seen].sort(), ['classify', 'remove'])
})
