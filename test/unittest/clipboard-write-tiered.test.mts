/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/clipboard-write-tiered.test.mts
 *
 * Locks the tiered clipboard-write fallback order behind usePathCopy: native
 * (focus-independent Electron clipboard) -> async (focus-gated browser API) ->
 * legacy (execCommand). The end-to-end wiring is locked by
 * run-working-directory-copy (WDC-01/02/03).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { writeTextTiered } from '../../src/hooks/clipboardWrite.ts'

test('native succeeds first — async/legacy not consulted', async () => {
  const calls: string[] = []
  const tier = await writeTextTiered('x', {
    native: async () => { calls.push('native'); return true },
    async: async () => { calls.push('async') },
    legacy: () => { calls.push('legacy'); return true }
  })
  assert.equal(tier, 'native')
  assert.deepEqual(calls, ['native'])
})

test('native rejects (window unfocused) -> falls to async', async () => {
  const calls: string[] = []
  const tier = await writeTextTiered('x', {
    native: async () => { calls.push('native'); throw new Error('no native') },
    async: async () => { calls.push('async') },
    legacy: () => { calls.push('legacy'); return true }
  })
  assert.equal(tier, 'async')
  assert.deepEqual(calls, ['native', 'async'])
})

test('native false AND async rejects -> falls to legacy', async () => {
  const calls: string[] = []
  const tier = await writeTextTiered('x', {
    native: async () => { calls.push('native'); return false },
    async: async () => { calls.push('async'); throw new Error('Document is not focused') },
    legacy: () => { calls.push('legacy'); return true }
  })
  assert.equal(tier, 'legacy')
  assert.deepEqual(calls, ['native', 'async', 'legacy'])
})

test('every tier fails -> none', async () => {
  const tier = await writeTextTiered('x', {
    native: async () => { throw new Error() },
    async: async () => { throw new Error() },
    legacy: () => false
  })
  assert.equal(tier, 'none')
})

test('missing tiers are skipped (only async present, succeeds)', async () => {
  const tier = await writeTextTiered('x', { async: async () => { /* ok */ } })
  assert.equal(tier, 'async')
})
