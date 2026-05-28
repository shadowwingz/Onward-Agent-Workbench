/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GitStateMirrorSnapshot } from '../../src/types/electron.d.ts'
import {
  mergeMirrorAlias,
  mergeMirrorDeltaSnapshot,
  mergeMirrorSnapshot,
  normalizeTerminalGitPath,
  removeMirrorAlias,
  resolveMirrorSnapshotForCwd,
  resolveTerminalGitDisplayState
} from '../../src/components/TerminalGrid/gitStatusIdentity.ts'

function snapshot(cwd: string, status: GitStateMirrorSnapshot['status']): GitStateMirrorSnapshot {
  return {
    cwd,
    repoRoot: cwd,
    repoName: 'repo',
    branch: 'feature/status',
    status,
    files: [],
    capturedAt: 100,
    changeFingerprint: status ?? 'none',
    generation: 1
  }
}

test('normalizes renderer Git cwd keys across equivalent path spellings', () => {
  assert.equal(
    normalizeTerminalGitPath('/private/var/tmp//repo-A/./nested/../'),
    '/var/tmp/repo-A'
  )
  assert.equal(
    normalizeTerminalGitPath('C:\\Temp\\repo-A\\.\\nested\\..\\'),
    'c:/Temp/repo-A'
  )
  assert.equal(normalizeTerminalGitPath('/'), '/')
  assert.equal(normalizeTerminalGitPath('C:\\'), 'c:/')
})

test('resolves raw cwd aliases to canonical mirror snapshots', () => {
  let snapshots = mergeMirrorSnapshot({}, snapshot('/private/var/tmp/repo-A', 'modified'))
  let aliases = mergeMirrorAlias({}, '/Volumes/link-to-repo-A', '/private/var/tmp/repo-A')

  assert.equal(resolveMirrorSnapshotForCwd(snapshots, aliases, '/Volumes/link-to-repo-A')?.status, 'modified')

  snapshots = mergeMirrorDeltaSnapshot(snapshots, '/private/var/tmp/repo-A', {
    status: 'clean',
    files: [],
    changeFingerprint: 'clean',
    capturedAt: 200,
    generation: 2
  })

  assert.equal(resolveMirrorSnapshotForCwd(snapshots, aliases, '/Volumes/link-to-repo-A')?.status, 'clean')

  aliases = removeMirrorAlias(aliases, '/Volumes/link-to-repo-A')
  assert.equal(resolveMirrorSnapshotForCwd(snapshots, aliases, '/Volumes/link-to-repo-A'), null)
})

test('prefers mirror state over stale legacy terminal info for equivalent cwd aliases', () => {
  const snapshots = mergeMirrorSnapshot({}, snapshot('/private/var/tmp/repo-A', 'added'))
  const aliases = mergeMirrorAlias({}, '/var/tmp/repo-A/.', '/private/var/tmp/repo-A')
  const resolved = resolveTerminalGitDisplayState({
    cwd: '/var/tmp/repo-A/.',
    terminalInfo: {
      cwd: '/private/var/tmp/repo-A',
      repoRoot: '/private/var/tmp/repo-A',
      branch: 'feature/status',
      repoName: 'repo',
      status: 'clean'
    },
    mirrorSnapshots: snapshots,
    mirrorAliases: aliases
  })

  assert.equal(resolved.branch, 'feature/status')
  assert.equal(resolved.repoName, 'repo')
  assert.equal(resolved.status, 'added')
})

test('canonical-key invariant: multiple raw cwds collapse to one mirrorSnapshots entry', () => {
  // This invariant is the load-bearing contract for the renderer's
  // subscription bookkeeping. The mirror map stores ONE entry per
  // canonical key, regardless of how many raw forms produced it.
  // The subscribe/unsubscribe machinery in TerminalGrid must therefore
  // also book-keep by canonical key, not raw cwd — otherwise a single
  // unsubscribe IPC tears down the SAME canonical that multiple
  // raw-form subscriptions were keeping alive (the cross-tab phantom
  // staleness root cause locked in by GSM-17/18). The renderer-side
  // dedupe by `normalizeTerminalGitPath` plus the router-side per-
  // (wcId, canonical) refCount are the two halves of this contract.
  const rawForms = [
    '/var/tmp/repo-A',
    '/private/var/tmp/repo-A',
    '/var/tmp/repo-A/.',
    '/var/tmp/repo-A/',
    '/private/var/tmp/repo-A/nested/..',
    '/var/tmp//repo-A'
  ]
  const canonical = '/var/tmp/repo-A'
  for (const raw of rawForms) {
    assert.equal(normalizeTerminalGitPath(raw), canonical, `expected ${raw} to normalize to ${canonical}`)
  }

  // Subscribing each raw form via mergeMirrorSnapshot collapses to ONE map entry.
  let snapshots: Record<string, GitStateMirrorSnapshot> = {}
  for (const raw of rawForms) {
    snapshots = mergeMirrorSnapshot(snapshots, snapshot(raw, 'clean'))
  }
  assert.equal(Object.keys(snapshots).length, 1)
  assert.equal(Object.keys(snapshots)[0], canonical)

  // The delta merge path keys identically — a worker emit with the
  // canonical form writes back into the same entry the renderer
  // populated via the legacy `/var/...` form (and vice versa).
  const post = mergeMirrorDeltaSnapshot(snapshots, '/private/var/tmp/repo-A', {
    status: 'modified',
    files: [],
    changeFingerprint: 'modified',
    capturedAt: 300,
    generation: 7
  })
  assert.equal(Object.keys(post).length, 1)
  assert.equal(post[canonical].status, 'modified')
  assert.equal(post[canonical].generation, 7)
})

test('does not fall back to legacy info when cwd identity differs and mirror is absent', () => {
  const resolved = resolveTerminalGitDisplayState({
    cwd: '/var/tmp/repo-B',
    terminalInfo: {
      cwd: '/var/tmp/repo-A',
      repoRoot: '/var/tmp/repo-A',
      branch: 'feature/status',
      repoName: 'repo',
      status: 'modified'
    },
    mirrorSnapshots: {},
    mirrorAliases: {}
  })

  assert.equal(resolved.branch, null)
  assert.equal(resolved.repoName, null)
  assert.equal(resolved.status, null)
  assert.equal(resolved.legacyMatchesCwd, false)
})
