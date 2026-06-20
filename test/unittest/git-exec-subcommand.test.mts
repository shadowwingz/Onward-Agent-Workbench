/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-exec-subcommand.test.mts
 *
 * Pins extractGitSubcommand: the perf-trace de-masking helper that recovers the
 * REAL git subcommand from an argv array whose leading tokens are global option
 * pairs (`-c core.quotepath=false`, etc.). Before this, the trace recorded
 * args[0] and collapsed every diff/status/log/cat-file spawn into a single `-c`
 * bucket. Each case mirrors how a real call site builds its args.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { extractGitSubcommand } from '../../electron/main/git-exec-subcommand.ts'

test('bare subcommand (no leading options) is returned as-is', () => {
  assert.equal(extractGitSubcommand(['rev-parse', '--is-inside-work-tree', '--show-toplevel']), 'rev-parse')
  assert.equal(extractGitSubcommand(['rev-parse', '--abbrev-ref', 'HEAD']), 'rev-parse')
  assert.equal(extractGitSubcommand(['--version']), null) // pure flag, no subcommand
})

test('single leading `-c name=value` pair is skipped (the dominant masked shape)', () => {
  // status builder: ['-c','core.quotepath=false','status','--porcelain=2',...]
  assert.equal(extractGitSubcommand(['-c', 'core.quotepath=false', 'status', '--porcelain=2', '--branch']), 'status')
  // diff builder
  assert.equal(extractGitSubcommand(['-c', 'core.quotepath=false', 'diff', '--numstat']), 'diff')
  // cat-file --batch
  assert.equal(extractGitSubcommand(['-c', 'core.quotepath=false', 'cat-file', '--batch']), 'cat-file')
  // A2 history batch
  assert.equal(
    extractGitSubcommand(['-c', 'core.quotepath=false', 'log', '--raw', '--numstat', '--format=%x1e%H%x1f%P', '-n', '50']),
    'log'
  )
})

test('multiple leading `-c` pairs are all skipped', () => {
  assert.equal(
    extractGitSubcommand(['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', 'diff', '--cached']),
    'diff'
  )
})

test('`-C <path>` global option pair is skipped', () => {
  assert.equal(extractGitSubcommand(['-C', '/some/repo', 'status']), 'status')
  assert.equal(extractGitSubcommand(['-C', '/some/repo', '-c', 'core.quotepath=false', 'log']), 'log')
})

test('other single-token global flags are skipped', () => {
  assert.equal(extractGitSubcommand(['--no-pager', 'log', '--oneline']), 'log')
  assert.equal(extractGitSubcommand(['--git-dir=/x/.git', 'status']), 'status')
  assert.equal(extractGitSubcommand(['-c', 'core.quotepath=false', '--no-pager', 'show', 'HEAD']), 'show')
})

test('degenerate inputs return null (never throw)', () => {
  assert.equal(extractGitSubcommand([]), null)
  assert.equal(extractGitSubcommand(['-c', 'core.quotepath=false']), null) // trailing pair, no subcommand
  assert.equal(extractGitSubcommand(['-c']), null) // malformed dangling -c
  assert.equal(extractGitSubcommand(['--all', '--flags']), null)
})

test('the config value (which has no leading dash) is never mistaken for the subcommand', () => {
  // Regression guard: if `-c` were skipped by 1 instead of 2, the value
  // 'core.quotepath=false' (no leading '-') would wrongly be returned.
  assert.notEqual(extractGitSubcommand(['-c', 'core.quotepath=false', 'status']), 'core.quotepath=false')
})
