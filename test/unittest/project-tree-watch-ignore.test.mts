/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Pin the ignore filter on `project-tree-watch-manager`. Without this filter
// the renderer used to chase `.git/index.lock`, `.git/objects/**` flicker
// from the app's own git-status polling and peg the renderer at ~71 % CPU
// while a markdown preview was open — see CPU investigation 2026-05-12.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  getIgnoredRelReason,
  isIgnoredRel
} from '../../electron/main/project-tree-watch-ignore.ts'

describe('project-tree-watch-manager isIgnoredRel', () => {
  it('drops .git children — the dominant noise source', () => {
    assert.equal(isIgnoredRel('.git/index.lock'), true)
    assert.equal(isIgnoredRel('.git/HEAD'), true)
    assert.equal(isIgnoredRel('.git/objects/aa/bbccdd'), true)
    assert.equal(isIgnoredRel('.git/FETCH_HEAD'), true)
    assert.equal(isIgnoredRel('.git/refs/heads/master'), true)
  })

  it('drops the .git directory entry itself', () => {
    assert.equal(isIgnoredRel('.git'), true)
  })

  it('drops node_modules subtree', () => {
    assert.equal(isIgnoredRel('node_modules'), true)
    assert.equal(isIgnoredRel('node_modules/react/index.js'), true)
    assert.equal(isIgnoredRel('node_modules/.cache/foo'), true)
  })

  it('drops .DS_Store at any depth', () => {
    assert.equal(isIgnoredRel('.DS_Store'), true)
    assert.equal(isIgnoredRel('src/.DS_Store'), true)
    assert.equal(isIgnoredRel('packages/foo/bar/.DS_Store'), true)
  })

  it('drops other build-cache directories', () => {
    assert.equal(isIgnoredRel('.cache/foo'), true)
    assert.equal(isIgnoredRel('.next/static/x.js'), true)
    assert.equal(isIgnoredRel('.turbo/run.log'), true)
    assert.equal(isIgnoredRel('.parcel-cache/abc'), true)
  })

  it('preserves real source files — these MUST surface in Cmd+P', () => {
    assert.equal(isIgnoredRel('src/index.ts'), false)
    assert.equal(isIgnoredRel('README.md'), false)
    assert.equal(isIgnoredRel('docs/architecture.md'), false)
    // A user file named `gitignore` (no dot) is a regular file, must not drop.
    assert.equal(isIgnoredRel('gitignore'), false)
    // A directory containing `git` substring but not exactly `.git`.
    assert.equal(isIgnoredRel('digital/blah.txt'), false)
    assert.equal(isIgnoredRel('packaging/recipe.yaml'), false)
  })

  it('does not over-match prefixes (e.g. .gitignore is NOT under .git/)', () => {
    // `.gitignore` is a top-level file, must surface in Cmd+P.
    assert.equal(isIgnoredRel('.gitignore'), false)
    assert.equal(isIgnoredRel('.gitattributes'), false)
    assert.equal(isIgnoredRel('.gitmodules'), false)
  })

  it('returns stable reasons for trace aggregation', () => {
    assert.equal(getIgnoredRelReason('.git/index.lock'), 'git')
    assert.equal(getIgnoredRelReason('node_modules/react/index.js'), 'nodeModules')
    assert.equal(getIgnoredRelReason('.cache/vite/deps.js'), 'cache')
    assert.equal(getIgnoredRelReason('src/.DS_Store'), 'dsStore')
    assert.equal(getIgnoredRelReason('src/index.ts'), null)
  })
})
