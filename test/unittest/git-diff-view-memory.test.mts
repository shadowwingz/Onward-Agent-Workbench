/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { GitFileStatus } from '../../src/types/electron.ts'
import {
  buildGitDiffFileKey,
  resolveGitDiffRestoredSelection,
  type DiffViewMemory
} from '../../src/components/GitDiffViewer/diffViewMemory.ts'

function gitFile(
  filename: string,
  changeType: GitFileStatus['changeType'] = 'unstaged',
  status: GitFileStatus['status'] = 'M',
  repoRoot = '/repo'
): GitFileStatus {
  return {
    filename,
    status,
    changeType,
    repoRoot
  } as GitFileStatus
}

describe('git diff view memory', () => {
  it('keeps the current active selection when it is still present', () => {
    const files = [gitFile('a.md'), gitFile('b.md')]
    const restored = resolveGitDiffRestoredSelection(files, '/repo', null, gitFile('b.md'))
    assert.equal(restored?.filename, 'b.md')
  })

  it('restores the selected file from memory when the active selection was cleared', () => {
    const files = [gitFile('a.md'), gitFile('existing.md')]
    const key = buildGitDiffFileKey('/repo', files[1])
    const memory: DiffViewMemory = {
      selectedFileKey: key,
      entries: {
        [key]: {
          fileKey: key,
          filePath: 'existing.md',
          anchor: { line: 1, scrollTop: 0 },
          scrollTop: 0,
          signature: null,
          updatedAt: 1
        }
      }
    }

    const restored = resolveGitDiffRestoredSelection(files, '/repo', memory, null)
    assert.equal(restored?.filename, 'existing.md')
  })

  it('falls back to memory entry path matching when the stored key is stale', () => {
    const files = [gitFile('renamed.md', 'unstaged', 'R')]
    const memory: DiffViewMemory = {
      selectedFileKey: '/old-repo::unstaged::R::old.md::renamed.md',
      entries: {
        '/old-repo::unstaged::R::old.md::renamed.md': {
          fileKey: '/old-repo::unstaged::R::old.md::renamed.md',
          filePath: 'renamed.md',
          originalFilename: 'old.md',
          anchor: null,
          scrollTop: 0,
          signature: null,
          updatedAt: 1
        }
      }
    }

    const restored = resolveGitDiffRestoredSelection(files, '/repo', memory, null)
    assert.equal(restored?.filename, 'renamed.md')
  })

  it('returns null when no active or remembered selection matches', () => {
    const files = [gitFile('a.md')]
    const memory: DiffViewMemory = {
      selectedFileKey: '/repo::unstaged::M::::missing.md',
      entries: {}
    }

    const restored = resolveGitDiffRestoredSelection(files, '/repo', memory, null)
    assert.equal(restored, null)
  })
})
