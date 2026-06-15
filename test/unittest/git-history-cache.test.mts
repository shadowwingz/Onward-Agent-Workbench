/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-history-cache.test.mts
 *
 * Locks the pure History-cache key builders + prewarm-commit selection
 * (prewarm-cache decision ⑦): L8 list keyed on branchOid (freshness), L9
 * commit-diff keyed immutably, and the top-N ∪ last-week prewarm set.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import {
  EMPTY_TREE_HASH,
  buildHistoryCommitDiffCacheKey,
  buildHistoryFileContentCacheKey,
  buildHistoryListCacheKey,
  buildPrewarmCommitDiffTargets,
  selectPrewarmCommits
} from '../../electron/main/git-history-cache.ts'

const DAY_MS = 24 * 60 * 60 * 1000

// GitCommitInfo is wider than selection needs; build minimal records and cast.
function commit(sha: string, authorDate: string, parents: string[] = []) {
  return { sha, shortSha: sha.slice(0, 7), parents, authorDate } as never
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

test('buildHistoryListCacheKey embeds branchOid, limit, skip after resolve(cwd)', () => {
  const key = buildHistoryListCacheKey('/work/repo', 'abc123', 50, 0)
  assert.equal(key, `${resolve('/work/repo')}::abc123::50::0`)
})

test('buildHistoryListCacheKey falls back to nohead when branchOid is undefined', () => {
  const key = buildHistoryListCacheKey('/work/repo', undefined, 50, 10)
  assert.equal(key, `${resolve('/work/repo')}::nohead::50::10`)
})

test('buildHistoryListCacheKey: a new branchOid produces a DIFFERENT key (structural invalidation)', () => {
  const a = buildHistoryListCacheKey('/work/repo', 'oid-old', 50, 0)
  const b = buildHistoryListCacheKey('/work/repo', 'oid-new', 50, 0)
  assert.notEqual(a, b)
})

test('buildHistoryCommitDiffCacheKey is stable + immutable per (cwd, options)', () => {
  const opts = { base: 'P', head: 'H', includeFiles: true, hideWhitespace: false }
  const k1 = buildHistoryCommitDiffCacheKey('/work/repo', opts)
  // Same options, different key insertion order → same stable key.
  const k2 = buildHistoryCommitDiffCacheKey('/work/repo', { head: 'H', hideWhitespace: false, base: 'P', includeFiles: true })
  assert.equal(k1, k2)
  assert.ok(k1.startsWith(`${resolve('/work/repo')}::`))
})

test('buildHistoryCommitDiffCacheKey distinguishes different commit ranges', () => {
  const a = buildHistoryCommitDiffCacheKey('/r', { base: 'P1', head: 'H1' })
  const b = buildHistoryCommitDiffCacheKey('/r', { base: 'P2', head: 'H2' })
  assert.notEqual(a, b)
})

test('buildHistoryFileContentCacheKey is stable per (cwd, options)', () => {
  const opts = { base: 'P', head: 'H', file: { filename: 'a.ts', status: 'M' as const } }
  const k = buildHistoryFileContentCacheKey('/r', opts)
  assert.ok(k.startsWith(`${resolve('/r')}::`))
  assert.equal(k, buildHistoryFileContentCacheKey('/r', opts))
})

// ---------------------------------------------------------------------------
// selectPrewarmCommits — top-N ∪ last-week
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-06-09T00:00:00Z')

test('selectPrewarmCommits returns the first topN in log order when withinDays is 0', () => {
  const commits = [commit('c0', '2020-01-01T00:00:00Z'), commit('c1', '2020-01-02T00:00:00Z'), commit('c2', '2020-01-03T00:00:00Z')]
  const out = selectPrewarmCommits(commits, { topN: 2, withinDays: 0, nowMs: NOW })
  assert.deepEqual(out.map((c) => c.sha), ['c0', 'c1'])
})

test('selectPrewarmCommits adds commits within the recent window beyond topN', () => {
  const commits = [
    commit('old0', '2020-01-01T00:00:00Z'),
    commit('recentA', new Date(NOW - 2 * DAY_MS).toISOString()),
    commit('recentB', new Date(NOW - 6 * DAY_MS).toISOString()),
    commit('tooOld', new Date(NOW - 30 * DAY_MS).toISOString())
  ]
  const out = selectPrewarmCommits(commits, { topN: 1, withinDays: 7, nowMs: NOW }).map((c) => c.sha)
  assert.deepEqual(out, ['old0', 'recentA', 'recentB']) // top-1 first, then recents in log order; tooOld excluded
})

test('selectPrewarmCommits de-duplicates a commit that is both top-N and recent', () => {
  const commits = [commit('a', new Date(NOW - 1 * DAY_MS).toISOString()), commit('b', new Date(NOW - 2 * DAY_MS).toISOString())]
  const out = selectPrewarmCommits(commits, { topN: 1, withinDays: 7, nowMs: NOW }).map((c) => c.sha)
  assert.deepEqual(out, ['a', 'b']) // 'a' appears once even though it is both top-1 AND recent
})

test('selectPrewarmCommits excludes commits with an unparseable author date from the window', () => {
  const commits = [commit('a', 'not-a-date'), commit('b', new Date(NOW - 1 * DAY_MS).toISOString())]
  const out = selectPrewarmCommits(commits, { topN: 0, withinDays: 7, nowMs: NOW }).map((c) => c.sha)
  assert.deepEqual(out, ['b'])
})

test('selectPrewarmCommits handles topN larger than the list without error', () => {
  const commits = [commit('a', '2020-01-01T00:00:00Z')]
  const out = selectPrewarmCommits(commits, { topN: 10, withinDays: 0, nowMs: NOW }).map((c) => c.sha)
  assert.deepEqual(out, ['a'])
})

// ---------------------------------------------------------------------------
// buildPrewarmCommitDiffTargets — base/head matches the renderer's click
// ---------------------------------------------------------------------------

test('buildPrewarmCommitDiffTargets uses parents[0] as base, sha as head', () => {
  const targets = buildPrewarmCommitDiffTargets([commit('H', '2020-01-01T00:00:00Z', ['P'])])
  assert.deepEqual(targets, [{ base: 'P', head: 'H' }])
})

test('buildPrewarmCommitDiffTargets uses the empty-tree hash for a root commit (no parent)', () => {
  const targets = buildPrewarmCommitDiffTargets([commit('ROOT', '2020-01-01T00:00:00Z', [])])
  assert.deepEqual(targets, [{ base: EMPTY_TREE_HASH, head: 'ROOT' }])
})
