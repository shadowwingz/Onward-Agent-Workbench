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
