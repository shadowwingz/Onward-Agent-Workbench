/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-state-mirror-change-fingerprint.test.mts
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { parseStatusPorcelainV2Z } from '../../electron/main/git-porcelain-parse.ts'
import {
  buildMirrorChangeFingerprint,
  formatStatTokenForFingerprint
} from '../../electron/main/git-state-mirror-change-fingerprint.ts'

// --- ctime-exclusion invariant (the Windows invalidation-storm root cause) ---
test('formatStatTokenForFingerprint excludes ctime: a ctime-only change does not flip the token', () => {
  const base = { mtimeNs: 1000n, size: 42n, mode: 33188n }
  // Same content (mtime/size/mode) but a different ctime — what an NTFS
  // metadata touch (AV/EDR/Search) produces. Must hash identically.
  const ctimeTouched = { ...base, ctimeNs: 9999n } as unknown as { mtimeNs: bigint; size: bigint; mode: bigint }
  assert.equal(
    formatStatTokenForFingerprint(base),
    formatStatTokenForFingerprint(ctimeTouched),
    'ctime-only change must NOT change the fingerprint token'
  )
})

test('formatStatTokenForFingerprint still reacts to a real edit (mtime/size change)', () => {
  const base = { mtimeNs: 1000n, size: 42n, mode: 33188n }
  assert.notEqual(formatStatTokenForFingerprint(base), formatStatTokenForFingerprint({ ...base, mtimeNs: 1001n }), 'mtime change must flip token')
  assert.notEqual(formatStatTokenForFingerprint(base), formatStatTokenForFingerprint({ ...base, size: 43n }), 'size change must flip token')
})

const execFileAsync = promisify(execFile)

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024
  }) as { stdout: Buffer }
  return stdout.toString('utf8')
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'onward-git-fingerprint.'))
  await git(repo, ['init', '-q'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await git(repo, ['add', 'a.txt'])
  await git(repo, ['commit', '-q', '-m', 'init'])
  return repo
}

async function statusRaw(repo: string): Promise<string> {
  return await git(repo, ['status', '--porcelain=v2', '-z', '--branch'])
}

async function fingerprint(repo: string) {
  const raw = await statusRaw(repo)
  const parsed = parseStatusPorcelainV2Z(raw, repo)
  const result = await buildMirrorChangeFingerprint(repo, raw, parsed.files)
  return { raw, parsed, result }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

test('change fingerprint ignores git-status index stat churn', async () => {
  const repo = await createRepo()
  try {
    await writeFile(join(repo, 'a.txt'), 'two\n')
    const first = await fingerprint(repo)
    await delay(50)
    const second = await fingerprint(repo)

    assert.equal(first.raw, second.raw)
    assert.equal(first.result.fingerprint, second.result.fingerprint)
    assert.equal(first.result.statCount, 1)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('change fingerprint changes for repeated unstaged edits with stable porcelain shape', async () => {
  const repo = await createRepo()
  try {
    await writeFile(join(repo, 'a.txt'), 'two\n')
    const first = await fingerprint(repo)
    await delay(50)
    await writeFile(join(repo, 'a.txt'), 'TWO\n')
    const second = await fingerprint(repo)

    assert.equal(first.raw, second.raw)
    assert.notEqual(first.result.fingerprint, second.result.fingerprint)
    assert.equal(second.result.statCount, 1)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('change fingerprint changes for staged edits through porcelain index oid', async () => {
  const repo = await createRepo()
  try {
    await writeFile(join(repo, 'a.txt'), 'two\n')
    await git(repo, ['add', 'a.txt'])
    const first = await fingerprint(repo)
    await delay(50)
    await writeFile(join(repo, 'a.txt'), 'three\n')
    await git(repo, ['add', 'a.txt'])
    const second = await fingerprint(repo)

    assert.notEqual(first.raw, second.raw)
    assert.notEqual(first.result.fingerprint, second.result.fingerprint)
    assert.equal(first.result.statCount, 0)
    assert.equal(second.result.statCount, 0)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
