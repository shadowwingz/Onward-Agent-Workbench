/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-status-classify.test.mts
 *
 * Locks the pure five-state classification for the Task status-bar Git badge:
 *
 *   clean (emerald) / added (purple) / deleted (red) / modified (yellow) /
 *   mixed (blue) / unknown (slate, owned by callers).
 *
 * This is the single source of truth shared by all three porcelain parsers
 * (GitStateMirror worker, legacy git-utils RPC path, standalone git-status
 * worker), so this test is the contract that keeps the badge colour identical
 * regardless of which path produced it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  categorizeGitStatusCode,
  collectXyCategories,
  deriveTerminalGitStatus
} from '../../electron/main/git-status-classify.ts'

type GitChangeCategory = 'add' | 'del' | 'mod'
function xyCategories(code: string): GitChangeCategory[] {
  const into = new Set<GitChangeCategory>()
  collectXyCategories(code, into)
  return Array.from(into).sort()
}

// ---------------------------------------------------------------------------
// categorizeGitStatusCode — one porcelain code → one change category
// ---------------------------------------------------------------------------

test('categorizeGitStatusCode maps the untracked sentinel to add', () => {
  assert.equal(categorizeGitStatusCode('??'), 'add')
})

test('categorizeGitStatusCode maps add codes (A, single + combined) to add', () => {
  for (const code of ['A', 'A.', '.A', 'AM', 'MA', 'AD']) {
    assert.equal(categorizeGitStatusCode(code), 'add', `code ${code}`)
  }
})

test('categorizeGitStatusCode maps rename/copy (R/C) to add (the path is new)', () => {
  for (const code of ['R', 'R.', '.R', 'RM', 'C', 'C.', 'CM']) {
    assert.equal(categorizeGitStatusCode(code), 'add', `code ${code}`)
  }
})

test('categorizeGitStatusCode maps delete codes (D, no A) to del', () => {
  for (const code of ['D', 'D.', '.D', 'MD', 'DM']) {
    assert.equal(categorizeGitStatusCode(code), 'del', `code ${code}`)
  }
})

test('categorizeGitStatusCode maps modify codes (M, no add/del) to mod', () => {
  for (const code of ['M', 'M.', '.M', 'MM']) {
    assert.equal(categorizeGitStatusCode(code), 'mod', `code ${code}`)
  }
})

test('categorizeGitStatusCode forces any U-bearing code to mod (conflict = edit)', () => {
  for (const code of ['U', 'UU', 'AU', 'UA', 'DU', 'UD']) {
    assert.equal(categorizeGitStatusCode(code), 'mod', `code ${code}`)
  }
})

test('categorizeGitStatusCode treats a raw AA / DD (no U) as add / del — callers must special-case u records', () => {
  // Documents WHY parsers route `u ` records to 'mod' directly instead of
  // classifying their XY: a bare 'AA' looks like an add to this function.
  assert.equal(categorizeGitStatusCode('AA'), 'add')
  assert.equal(categorizeGitStatusCode('DD'), 'del')
})

test('categorizeGitStatusCode returns null for clean / empty codes', () => {
  for (const code of ['', '.', '..', '  ']) {
    assert.equal(categorizeGitStatusCode(code), null, `code "${code}"`)
  }
})

test('categorizeGitStatusCode precedence: add beats delete beats modify', () => {
  assert.equal(categorizeGitStatusCode('AD'), 'add', 'A wins over D')
  assert.equal(categorizeGitStatusCode('AM'), 'add', 'A wins over M')
  assert.equal(categorizeGitStatusCode('DM'), 'del', 'D wins over M')
})

// ---------------------------------------------------------------------------
// collectXyCategories — combined XY → set of categories (two-sided aware)
// ---------------------------------------------------------------------------

test('collectXyCategories: untracked sentinel → add', () => {
  assert.deepEqual(xyCategories('??'), ['add'])
})

test('collectXyCategories: a NEW path (A/R/C) is a single add even with a second-side change', () => {
  // new-then-edited / new-then-deleted is fundamentally an addition, NOT mixed.
  assert.deepEqual(xyCategories('A.'), ['add'])
  assert.deepEqual(xyCategories('AM'), ['add'])
  assert.deepEqual(xyCategories('AD'), ['add'])
  assert.deepEqual(xyCategories('R.'), ['add'])
  assert.deepEqual(xyCategories('C.'), ['add'])
})

test('collectXyCategories: an unmerged conflict (U) is a single mod', () => {
  assert.deepEqual(xyCategories('UU'), ['mod'])
  assert.deepEqual(xyCategories('AU'), ['mod'])
})

test('collectXyCategories: a genuinely two-sided file unions BOTH kinds (the Codex MD case)', () => {
  // 'MD' = staged modify + worktree delete → contributes both mod and del, so a
  // repo whose only change is this file resolves to mixed, not just deleted.
  assert.deepEqual(xyCategories('MD'), ['del', 'mod'])
  assert.deepEqual(xyCategories('DM'), ['del', 'mod'])
})

test('collectXyCategories: single-sided codes map to one kind', () => {
  assert.deepEqual(xyCategories('.M'), ['mod'])
  assert.deepEqual(xyCategories('M.'), ['mod'])
  assert.deepEqual(xyCategories('MM'), ['mod'])
  assert.deepEqual(xyCategories('.D'), ['del'])
  assert.deepEqual(xyCategories('D.'), ['del'])
})

test('collectXyCategories: clean / empty codes contribute nothing', () => {
  assert.deepEqual(xyCategories('..'), [])
  assert.deepEqual(xyCategories(''), [])
  assert.deepEqual(xyCategories('  '), [])
})

test('collectXyCategories + derive: a lone two-sided MD file → mixed; a lone AM/AD file → added', () => {
  const md = new Set<GitChangeCategory>(); collectXyCategories('MD', md)
  assert.equal(deriveTerminalGitStatus(md), 'mixed')
  const am = new Set<GitChangeCategory>(); collectXyCategories('AM', am)
  assert.equal(deriveTerminalGitStatus(am), 'added')
  const ad = new Set<GitChangeCategory>(); collectXyCategories('AD', ad)
  assert.equal(deriveTerminalGitStatus(ad), 'added')
})

// ---------------------------------------------------------------------------
// deriveTerminalGitStatus — set of categories → five-state bucket
// ---------------------------------------------------------------------------

test('deriveTerminalGitStatus: no categories → clean', () => {
  assert.equal(deriveTerminalGitStatus([]), 'clean')
  assert.equal(deriveTerminalGitStatus(new Set()), 'clean')
})

test('deriveTerminalGitStatus: only add → added', () => {
  assert.equal(deriveTerminalGitStatus(['add']), 'added')
  assert.equal(deriveTerminalGitStatus(['add', 'add']), 'added')
})

test('deriveTerminalGitStatus: only del → deleted', () => {
  assert.equal(deriveTerminalGitStatus(['del']), 'deleted')
  assert.equal(deriveTerminalGitStatus(new Set(['del'])), 'deleted')
})

test('deriveTerminalGitStatus: only mod → modified', () => {
  assert.equal(deriveTerminalGitStatus(['mod']), 'modified')
})

test('deriveTerminalGitStatus: any two distinct categories → mixed', () => {
  assert.equal(deriveTerminalGitStatus(['add', 'mod']), 'mixed')
  assert.equal(deriveTerminalGitStatus(['add', 'del']), 'mixed')
  assert.equal(deriveTerminalGitStatus(['del', 'mod']), 'mixed')
  assert.equal(deriveTerminalGitStatus(['mod', 'add']), 'mixed', 'order-independent')
})

test('deriveTerminalGitStatus: all three categories → mixed', () => {
  assert.equal(deriveTerminalGitStatus(['add', 'del', 'mod']), 'mixed')
  assert.equal(deriveTerminalGitStatus(new Set(['add', 'del', 'mod'])), 'mixed')
})

test('deriveTerminalGitStatus: never returns unknown (that state is caller-owned)', () => {
  // Exhaustive over every reachable input shape: 0..3 distinct categories.
  const all = ['add', 'del', 'mod'] as const
  const subsets: Array<typeof all[number][]> = [
    [], ['add'], ['del'], ['mod'],
    ['add', 'del'], ['add', 'mod'], ['del', 'mod'],
    ['add', 'del', 'mod']
  ]
  for (const subset of subsets) {
    const result = deriveTerminalGitStatus(subset)
    assert.notEqual(result, 'unknown', `subset ${JSON.stringify(subset)}`)
    assert.ok(
      ['clean', 'added', 'deleted', 'modified', 'mixed'].includes(result),
      `subset ${JSON.stringify(subset)} → ${result}`
    )
  }
})

// ---------------------------------------------------------------------------
// End-to-end: code → category → status, the established-semantics guard
// ---------------------------------------------------------------------------

test('established semantics preserved: untracked-only → added (purple, unchanged)', () => {
  const categories = new Set([categorizeGitStatusCode('??')].filter(Boolean) as ('add' | 'del' | 'mod')[])
  assert.equal(deriveTerminalGitStatus(categories), 'added')
})

test('established semantics preserved: modify-only → modified (yellow, unchanged)', () => {
  const categories = new Set([categorizeGitStatusCode('.M')].filter(Boolean) as ('add' | 'del' | 'mod')[])
  assert.equal(deriveTerminalGitStatus(categories), 'modified')
})

test('new semantics: delete-only → deleted (red), split out of the old purple bucket', () => {
  const categories = new Set([categorizeGitStatusCode('.D')].filter(Boolean) as ('add' | 'del' | 'mod')[])
  assert.equal(deriveTerminalGitStatus(categories), 'deleted')
})

test('new semantics: add + modify across files → mixed (blue), split out of the old purple bucket', () => {
  const categories = new Set(
    [categorizeGitStatusCode('A.'), categorizeGitStatusCode('.M')].filter(Boolean) as ('add' | 'del' | 'mod')[]
  )
  assert.equal(deriveTerminalGitStatus(categories), 'mixed')
})
