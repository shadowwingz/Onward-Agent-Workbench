/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/terminal-git-info-bridge-helpers.test.mts
 *
 * Covers the pure-function helpers that drive the bridge's dedup +
 * translation logic. The class itself (event-driven state machine
 * around router callbacks) is integration-tested by the
 * `run-terminal-title-rename-autotest.sh` suite (TTM-00..28); these
 * unit tests pin the translation contract so the autotest's surface
 * stays trustworthy even as the class internals evolve.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  emptyTerminalGitInfo,
  fingerprintTerminalGitInfo,
  mirrorStateToTerminalGitInfo
} from '../../electron/main/terminal-git-info-helpers.ts'

import type { MirrorState } from '../../electron/main/git-state-mirror-types.ts'

function snapshot(overrides: Partial<MirrorState> = {}): MirrorState {
  return {
    cwd: '/repo',
    repoRoot: '/repo',
    repoName: 'repo',
    branch: 'main',
    status: 'clean',
    files: [],
    capturedAt: 1_000,
    generation: 1,
    ...overrides
  }
}

test('mirrorStateToTerminalGitInfo copies all five user-visible fields', () => {
  const state = snapshot({
    repoRoot: '/the-repo',
    repoName: 'the-repo',
    branch: 'feature/x',
    status: 'modified'
  })
  const info = mirrorStateToTerminalGitInfo(state, '/cwd-override')
  assert.deepEqual(info, {
    cwd: '/cwd-override',
    repoRoot: '/the-repo',
    repoName: 'the-repo',
    branch: 'feature/x',
    status: 'modified'
  })
})

test('mirrorStateToTerminalGitInfo passes through null fields for non-repo cwd', () => {
  const state = snapshot({
    repoRoot: null,
    repoName: null,
    branch: null,
    status: null
  })
  const info = mirrorStateToTerminalGitInfo(state, '/some/tmp/dir')
  assert.equal(info.cwd, '/some/tmp/dir')
  assert.equal(info.repoRoot, null)
  assert.equal(info.repoName, null)
  assert.equal(info.branch, null)
  assert.equal(info.status, null)
})

test('mirrorStateToTerminalGitInfo prefers caller-supplied cwd over state.cwd', () => {
  // The bridge tracks per-terminal cwd separately from the mirror snapshot
  // (one mirror can serve N terminals at the same cwd). The translation
  // helper must therefore use the caller-supplied cwd, not state.cwd.
  const state = snapshot({ cwd: '/state-cwd' })
  const info = mirrorStateToTerminalGitInfo(state, '/different-cwd')
  assert.equal(info.cwd, '/different-cwd')
})

test('emptyTerminalGitInfo yields an all-null record with the supplied cwd', () => {
  assert.deepEqual(emptyTerminalGitInfo('/x'), {
    cwd: '/x',
    repoRoot: null,
    repoName: null,
    branch: null,
    status: null
  })
  assert.deepEqual(emptyTerminalGitInfo(null), {
    cwd: null,
    repoRoot: null,
    repoName: null,
    branch: null,
    status: null
  })
})

test('fingerprintTerminalGitInfo is stable for the same field values', () => {
  const a = mirrorStateToTerminalGitInfo(snapshot(), '/repo')
  const b = mirrorStateToTerminalGitInfo(snapshot(), '/repo')
  assert.equal(fingerprintTerminalGitInfo(a), fingerprintTerminalGitInfo(b))
})

test('fingerprintTerminalGitInfo distinguishes any single-field change', () => {
  const base = emptyTerminalGitInfo('/repo')
  const baseFp = fingerprintTerminalGitInfo(base)

  // Each of the 5 visible fields should produce a different fingerprint
  // when changed in isolation — that's the dedup contract that lets the
  // bridge skip identical emissions cheaply.
  assert.notEqual(fingerprintTerminalGitInfo({ ...base, cwd: '/other' }), baseFp)
  assert.notEqual(fingerprintTerminalGitInfo({ ...base, repoRoot: '/r' }), baseFp)
  assert.notEqual(fingerprintTerminalGitInfo({ ...base, branch: 'main' }), baseFp)
  assert.notEqual(fingerprintTerminalGitInfo({ ...base, repoName: 'r' }), baseFp)
  assert.notEqual(fingerprintTerminalGitInfo({ ...base, status: 'clean' }), baseFp)
})

test('fingerprintTerminalGitInfo treats null and undefined consistently', () => {
  // Bridge stores nulls; ipc payloads can send undefined. Both must map
  // to the same fingerprint or dedup would emit redundant frames.
  const withNulls = emptyTerminalGitInfo('/r')
  const withUndefined = {
    cwd: '/r',
    repoRoot: undefined as unknown as null,
    repoName: undefined as unknown as null,
    branch: undefined as unknown as null,
    status: undefined as unknown as null
  }
  assert.equal(fingerprintTerminalGitInfo(withNulls), fingerprintTerminalGitInfo(withUndefined))
})
