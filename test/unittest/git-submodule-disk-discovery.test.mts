/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-submodule-disk-discovery.test.mts
 *
 * Pins the pure, filesystem-only submodule discovery that replaced the
 * fork-heavy `git submodule status --recursive` on the Git-Diff hot path.
 * This locks the structural math (which submodules exist, initialized vs
 * deinit-ed, depth / parentRoot nesting) without spawning git or building
 * Electron — its autotest counterpart (run-git-diff-submodules /
 * run-git-diff-recursive-submodules) proves the end-to-end wiring against a
 * real git repo.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  collectSubmoduleSnapshotsFromDisk,
  isGitWorktreeRoot,
  readGitmodulesSubmodulePaths
} from '../../electron/main/git-submodule-disk-discovery.ts'

/** Forward-slash normalize, matching the discovery's cross-platform output contract. */
const norm = (p: string): string => p.replace(/\\/g, '/')

function gitmodules(...entries: Array<{ name: string; path: string }>): string {
  return entries
    .map((e) => `[submodule "${e.name}"]\n\tpath = ${e.path}\n\turl = https://example.invalid/${e.name}.git\n`)
    .join('')
}

/**
 * Build a fixture repo tree on disk:
 *   root/.gitmodules               -> declares sub-a, sub-b
 *   root/sub-a/.git (gitfile)      -> initialized submodule
 *   root/sub-a/.gitmodules         -> declares nested
 *   root/sub-a/nested/.git (dir)   -> initialized nested submodule
 *   root/sub-b/                    -> declared but NOT initialized (deinit shape)
 */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'onward-submodule-disc-'))
  writeFileSync(join(root, '.gitmodules'), gitmodules(
    { name: 'sub-a', path: 'sub-a' },
    { name: 'sub-b', path: 'sub-b' }
  ))

  // sub-a: initialized via a gitfile (the standard submodule layout).
  mkdirSync(join(root, 'sub-a'), { recursive: true })
  writeFileSync(join(root, 'sub-a', '.git'), 'gitdir: ../.git/modules/sub-a\n')
  writeFileSync(join(root, 'sub-a', '.gitmodules'), gitmodules(
    { name: 'nested', path: 'nested' }
  ))

  // sub-a/nested: initialized via a real .git directory (legacy layout).
  mkdirSync(join(root, 'sub-a', 'nested', '.git'), { recursive: true })

  // sub-b: declared in .gitmodules but the working tree is empty (deinit).
  mkdirSync(join(root, 'sub-b'), { recursive: true })

  return root
}

// ---------------------------------------------------------------------------
// readGitmodulesSubmodulePaths
// ---------------------------------------------------------------------------

test('readGitmodulesSubmodulePaths parses paths, skips comments, normalizes separators', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-gitmodules-'))
  try {
    writeFileSync(join(root, '.gitmodules'),
      '# a comment\n; another\n[submodule "x"]\n\tpath = vendor\\x\n\turl = u\n[submodule "y"]\n\tpath = y\n')
    const paths = await readGitmodulesSubmodulePaths(root)
    assert.deepEqual(paths, ['vendor/x', 'y'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readGitmodulesSubmodulePaths returns [] when .gitmodules is absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-gitmodules-none-'))
  try {
    assert.deepEqual(await readGitmodulesSubmodulePaths(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// isGitWorktreeRoot
// ---------------------------------------------------------------------------

test('isGitWorktreeRoot: true for .git directory, true for gitfile, false otherwise', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-worktree-'))
  try {
    const dirCase = join(root, 'dir-case')
    mkdirSync(join(dirCase, '.git'), { recursive: true })
    assert.equal(await isGitWorktreeRoot(dirCase), true)

    const fileCase = join(root, 'file-case')
    mkdirSync(fileCase, { recursive: true })
    writeFileSync(join(fileCase, '.git'), 'gitdir: ../.git/modules/file-case\n')
    assert.equal(await isGitWorktreeRoot(fileCase), true)

    const plainFile = join(root, 'plain-case')
    mkdirSync(plainFile, { recursive: true })
    writeFileSync(join(plainFile, '.git'), 'this is not a gitfile\n')
    assert.equal(await isGitWorktreeRoot(plainFile), false)

    const emptyCase = join(root, 'empty-case')
    mkdirSync(emptyCase, { recursive: true })
    assert.equal(await isGitWorktreeRoot(emptyCase), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// collectSubmoduleSnapshotsFromDisk
// ---------------------------------------------------------------------------

test('collectSubmoduleSnapshotsFromDisk discovers direct + nested, flags deinit, computes depth/parent', async () => {
  const root = makeFixture()
  try {
    const snaps = await collectSubmoduleSnapshotsFromDisk(root)
    const byPath = new Map(snaps.map((s) => [s.path, s]))

    // Three submodules discovered, sorted lexicographically.
    assert.deepEqual(snaps.map((s) => s.path), ['sub-a', 'sub-a/nested', 'sub-b'])

    const subA = byPath.get('sub-a')!
    assert.equal(subA.initialized, true)
    assert.equal(subA.isValidRepo, true)
    assert.equal(subA.depth, 0)
    // Output paths are forward-slash normalized on every platform.
    assert.equal(subA.parentRoot, norm(resolve(root)))
    assert.equal(subA.absolutePath, norm(resolve(root, 'sub-a')))
    assert.ok(!subA.absolutePath.includes('\\'), 'absolutePath must not contain a backslash')
    assert.equal(subA.declaredInGitmodules, true)

    const nested = byPath.get('sub-a/nested')!
    assert.equal(nested.initialized, true)
    assert.equal(nested.isValidRepo, true)
    assert.equal(nested.depth, 1)
    assert.equal(nested.parentRoot, norm(resolve(root, 'sub-a')))
    assert.equal(nested.absolutePath, norm(resolve(root, 'sub-a', 'nested')))

    // Deinit-ed submodule: declared, but empty working tree → not valid.
    const subB = byPath.get('sub-b')!
    assert.equal(subB.initialized, false)
    assert.equal(subB.isValidRepo, false)
    assert.equal(subB.depth, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectSubmoduleSnapshotsFromDisk returns [] for a repo with no .gitmodules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-no-subs-'))
  try {
    assert.deepEqual(await collectSubmoduleSnapshotsFromDisk(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectSubmoduleSnapshotsFromDisk does not recurse into a deinit-ed submodule', async () => {
  // Even if a deinit-ed path somehow carries a .gitmodules, it has no .git so
  // we must not descend into it (it is not a checked-out repo).
  const root = mkdtempSync(join(tmpdir(), 'onward-no-recurse-'))
  try {
    writeFileSync(join(root, '.gitmodules'), gitmodules({ name: 'ghost', path: 'ghost' }))
    mkdirSync(join(root, 'ghost'), { recursive: true })
    // .gitmodules present but NO .git → not initialized.
    writeFileSync(join(root, 'ghost', '.gitmodules'), gitmodules({ name: 'inner', path: 'inner' }))
    const snaps = await collectSubmoduleSnapshotsFromDisk(root)
    assert.deepEqual(snaps.map((s) => s.path), ['ghost'])
    assert.equal(snaps[0].initialized, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
