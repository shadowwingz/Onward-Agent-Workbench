/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-state-mirror-submodule-watcher-filter.test.mts
 *
 * END-TO-END regression lock for the Windows Git-Diff invalidation-storm bug
 * (2026-06-03). Reproduces the EXACT mechanism with the REAL @parcel/watcher
 * (the same watcher the GitStateMirror uses), the REAL `classifyEventPath`, and
 * the REAL `MIRROR_WATCHER_IGNORE` ignore list — on a fixture with a NESTED
 * submodule that has a real `.git` DIRECTORY (the shape kar-qemu's KAR submodule
 * has, which `perf-0022` showed firing `…/KAR/.git/index.lock` and invalidating
 * the parent's diff cache on every event).
 *
 * The bug: a recursive parent-worktree watcher also sees the submodule's
 * `.git/` internals; `classifyEventPath` only filtered the TOP-LEVEL `.git/`, so
 * `<sub>/.git/index.lock` slipped through as a "worktree change" → recompute →
 * diff-cache invalidation. The worker callback is a trivial
 * `if (classifyEventPath(path,root).drop) continue; else keep + recompute`, so
 * the kept-set produced here IS the recompute decision.
 *
 * This is a Node integration test (no Electron): @parcel/watcher ships Node
 * prebuilds, so the real watcher runs in `node --test`. It is timing-aware
 * (FS-watch delivery is async) — it waits for a sentinel worktree event, then
 * asserts on the full delivered batch.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import {
  classifyEventPath,
  MIRROR_WATCHER_IGNORE
} from '../../electron/main/git-state-mirror-worker-core.ts'
import { gitignoreToWatchIgnoreGlobs } from '../../electron/main/git-gitignore-watch-globs.ts'

const require = createRequire(import.meta.url)
const watcher = require('@parcel/watcher') as {
  subscribe: (
    dir: string,
    cb: (err: Error | null, events: Array<{ path: string; type: string }>) => void,
    opts?: { ignore?: string[] }
  ) => Promise<{ unsubscribe: () => Promise<void> }>
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Mirror the worker callback's decision: kept paths drive a recompute. */
function keptPaths(events: Array<{ path: string }>, root: string): string[] {
  return events.filter((e) => !classifyEventPath(e.path, root).drop).map((e) => e.path)
}

test('real @parcel/watcher + classifyEventPath: submodule .git churn does NOT survive the filter, real worktree edit does', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-submwatch-'))
  // Parent worktree with a nested submodule that has a REAL `.git` directory
  // (NOT a gitfile) — the kar-qemu/KAR shape that triggered the storm.
  const subGitDir = join(root, 'src', 'third_party', 'KAR', '.git')
  const subLibDir = join(root, 'src', 'third_party', 'KAR', 'lib')
  mkdirSync(subGitDir, { recursive: true })
  mkdirSync(subLibDir, { recursive: true })
  // Pre-create the worktree file so we touch (modify) it later — a modify event
  // is the clearest "real change" sentinel.
  const worktreeFile = join(subLibDir, 'widget.c')
  writeFileSync(worktreeFile, 'int main(){return 0;}\n')

  const events: Array<{ path: string; type: string }> = []
  let sub: { unsubscribe: () => Promise<void> } | null = null
  try {
    sub = await watcher.subscribe(root, (err, evs) => {
      if (err) return
      for (const e of evs) events.push(e)
    }, { ignore: [...MIRROR_WATCHER_IGNORE] })

    // Let the watcher settle before generating events.
    await sleep(600)

    // 1) Submodule .git/index.lock churn — what a `git status`/`git add` in the
    //    submodule (or the user's own git, or an IDE) produces.
    const subLock = join(subGitDir, 'index.lock')
    writeFileSync(subLock, '')
    await sleep(60)
    if (existsSync(subLock)) rmSync(subLock, { force: true })
    // 2) Submodule .git/objects churn (read/gc noise).
    mkdirSync(join(subGitDir, 'objects', 'ab'), { recursive: true })
    writeFileSync(join(subGitDir, 'objects', 'ab', 'deadbeef'), 'x')
    // 3) A REAL submodule worktree edit — the sentinel that MUST survive.
    await sleep(60)
    writeFileSync(worktreeFile, 'int main(){return 42;}\n')

    // Wait until the sentinel worktree edit is delivered (proves the watcher is
    // live), up to a generous deadline. FS-watch delivery is async.
    const deadline = Date.now() + 8000
    const sawWorktree = () => events.some((e) => e.path.replace(/\\/g, '/').endsWith('src/third_party/KAR/lib/widget.c'))
    while (Date.now() < deadline && !sawWorktree()) {
      await sleep(150)
    }
    // small drain for any trailing .git events
    await sleep(300)

    const kept = keptPaths(events, root).map((p) => p.replace(/\\/g, '/'))

    // The watcher must have been live (sentinel delivered + survived the filter).
    assert.ok(
      kept.some((p) => p.endsWith('src/third_party/KAR/lib/widget.c')),
      `real submodule worktree edit must survive the filter (recompute). delivered=${JSON.stringify(events.map(e => e.path))}`
    )
    // CORE REGRESSION ASSERTION: NOTHING under any `.git/` (the submodule's git
    // dir) may survive the filter — no recompute, no diff-cache invalidation.
    const leaked = kept.filter((p) => /(?:^|\/)\.git\//.test(p))
    assert.deepEqual(
      leaked, [],
      `submodule .git churn leaked past the filter (would invalidate the parent diff cache): ${JSON.stringify(leaked)}`
    )
  } finally {
    if (sub) { try { await sub.unsubscribe() } catch { /* ignore */ } }
    rmSync(root, { recursive: true, force: true })
  }
})

test('real @parcel/watcher + gitignore-derived globs: churning gitignored build/ files are NOT delivered, a real source edit is', async () => {
  // Regression lock for the kar-qemu running-emulator storm: a QEMU build writes
  // gitignored build/framebuffer.raw continuously. With the .gitignore `build/`
  // dir pattern converted to parcel ignore globs, those writes must produce NO
  // watcher events (so no `git status` recompute), while a real tracked-source
  // edit must still be delivered.
  const root = mkdtempSync(join(tmpdir(), 'onward-gitignore-watch-'))
  writeFileSync(join(root, '.gitignore'), 'build/\n*.raw\n')
  mkdirSync(join(root, 'build'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  const sourceFile = join(root, 'src', 'main.c')
  writeFileSync(sourceFile, 'int main(){return 0;}\n')

  const ignore = [...MIRROR_WATCHER_IGNORE, ...gitignoreToWatchIgnoreGlobs('build/\n*.raw\n')]
  // Sanity: the converter produced the build/ dir suppression (not the *.raw file pattern).
  assert.ok(ignore.includes('build/**') && ignore.includes('**/build/**'), `expected build globs, got ${JSON.stringify(ignore)}`)

  const events: Array<{ path: string; type: string }> = []
  let sub: { unsubscribe: () => Promise<void> } | null = null
  try {
    sub = await watcher.subscribe(root, (err, evs) => {
      if (err) return
      for (const e of evs) events.push(e)
    }, { ignore })
    await sleep(600)

    // 1) Churn the gitignored build artifact many times (the emulator pattern).
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(root, 'build', 'framebuffer.raw'), `frame ${i}\n`)
      writeFileSync(join(root, 'build', 'serial_output.txt'), `log ${i}\n`)
      await sleep(20)
    }
    // 2) A REAL source edit — the sentinel that MUST be delivered.
    await sleep(60)
    writeFileSync(sourceFile, 'int main(){return 42;}\n')

    const deadline = Date.now() + 8000
    const sawSource = () => events.some((e) => e.path.replace(/\\/g, '/').endsWith('src/main.c'))
    while (Date.now() < deadline && !sawSource()) {
      await sleep(150)
    }
    await sleep(300) // drain any trailing events

    const delivered = events.map((e) => e.path.replace(/\\/g, '/'))
    // The real source edit must survive.
    assert.ok(
      delivered.some((p) => p.endsWith('src/main.c')),
      `real source edit must be delivered. delivered=${JSON.stringify(delivered)}`
    )
    // CORE ASSERTION: nothing under build/ may be delivered (parcel pruned it).
    const buildLeaks = delivered.filter((p) => /(?:^|\/)build\//.test(p))
    assert.deepEqual(
      buildLeaks, [],
      `gitignored build/ churn leaked past the watcher ignore (would trigger recompute storm): ${JSON.stringify(buildLeaks)}`
    )
  } finally {
    if (sub) { try { await sub.unsubscribe() } catch { /* ignore */ } }
    rmSync(root, { recursive: true, force: true })
  }
})
