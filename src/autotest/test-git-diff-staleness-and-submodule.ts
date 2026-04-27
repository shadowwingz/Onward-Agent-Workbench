/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * Git Diff staleness + submodule c/m/u filter regression suite (GDS-01..GDS-12).
 *
 * The fixture builder (test/autotest/create-git-diff-staleness-fixture.mjs) creates two
 * sibling repos under one tempRoot:
 *   - clean/root              parent + clean submodule, both work trees clean
 *   - pointer-changed/root    same shape but with the submodule HEAD advanced
 *                             past what the parent's index records (c flag = C)
 *
 * The path to the JSON manifest is delivered via
 * `window.electronAPI.debug.autotestFixtureExtra`. The autotest reads it through
 * the existing project.readFile IPC (the renderer has no direct fs access).
 *
 * Bug 1 (submodule false-positive): the parent's file list must NOT surface a
 * submodule entry whose only flags are m / u. Only c (commit pointer changed)
 * counts as a parent-side change.
 *
 * Bug 2 (staleness): a request-cache hit followed by an FS mutation must yield
 * fresh data on the next call, driven by the file-watcher cache invalidator
 * and a force-on-entry hop emitted as `renderer:subpage.freshness-check`.
 *
 * The 12 GDS assertions cover both bugs plus their trace-event signatures so
 * regressions land both in the visible behavior and the observable surface.
 */

interface FixtureManifest {
  tempRoot: string
  cleanRoot: string
  pointerChangedRoot: string
  // Same shape as pointer-changed but the user has run `git add modules/sub`,
  // so the parent index records the new pointer and porcelain v2 reports
  // `<c>=.` while X is non-`.`. The filter must surface this row in Git Diff
  // so the user can review or unstage it.
  stagedPointerRoot: string
  // Project_Forward repro: parent + .gitmodules-declared submodule that has
  // been deinit-ed; the path exists on disk but is NOT a git repository.
  uninitializedRoot: string
  submoduleRelPath: string
  parentEditableFile: string
  submoduleEditableFile: string
  submoduleUntrackedRelPath: string
}

interface DiffFile {
  filename: string
  status?: string
  changeType?: string
  isSubmoduleEntry?: boolean
  submoduleFlags?: {
    commitChanged: boolean
    workTreeModified: boolean
    untrackedContent: boolean
  }
  repoRoot?: string
  repoLabel?: string
}

interface DiffRepoCtx {
  root: string
  label: string
  isSubmodule: boolean
  changeCount: number
  loading?: boolean
}

interface DiffResult {
  success: boolean
  files: DiffFile[]
  repos?: DiffRepoCtx[]
  submodulesLoading?: boolean
}

function lastSegment(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned
}

function dirname(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx >= 0 ? cleaned.slice(0, idx) : cleaned
}

async function loadManifest(extraPath: string | null): Promise<FixtureManifest | null> {
  if (!extraPath) return null
  const root = dirname(extraPath)
  const file = lastSegment(extraPath)
  const result = await window.electronAPI.project.readFile(root, file)
  if (!result.success || typeof result.content !== 'string') return null
  try {
    return JSON.parse(result.content) as FixtureManifest
  } catch {
    return null
  }
}

function clampPath(value: string): string {
  // macOS realpath maps /var/folders -> /private/var/folders for tmpdir, so
  // the main process's resolve(cwd) emits the /private/... form while the
  // test holds the /var/... form. Strip the /private prefix so equality
  // checks work regardless of which side normalised the path.
  return value
    .replace(/\\/g, '/')
    .replace(/^\/private\/var\//, '/var/')
}

function repoChangeCount(diff: DiffResult, repoRoot: string): number {
  if (!diff.repos) return diff.files.length
  const target = clampPath(repoRoot)
  for (const repo of diff.repos) {
    if (clampPath(repo.root) === target) return repo.changeCount
  }
  return 0
}

function parentSubmoduleEntries(diff: DiffResult, parentRoot: string, submoduleRel: string): DiffFile[] {
  const target = clampPath(parentRoot)
  const repoFiltered = diff.files.filter((file) => {
    if (!file.repoRoot) return true
    return clampPath(file.repoRoot) === target
  })
  return repoFiltered.filter((file) => file.isSubmoduleEntry || file.filename === submoduleRel)
}

export async function testGitDiffStalenessAndSubmodule(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('git-diff-staleness:start', { terminalId })

  const extraPath = window.electronAPI.debug.autotestFixtureExtra
  const manifest = await loadManifest(extraPath)
  if (!manifest) {
    record('GDS-00-fixture-loaded', false, { extraPath })
    return results
  }
  log('git-diff-staleness:manifest', manifest)
  record('GDS-00-fixture-loaded', true, {
    cleanRoot: manifest.cleanRoot,
    pointerChangedRoot: manifest.pointerChangedRoot
  })

  const cleanRoot = manifest.cleanRoot
  const pointerRoot = manifest.pointerChangedRoot
  const subPath = manifest.submoduleRelPath
  const parentFile = manifest.parentEditableFile
  const subFile = `${subPath}/${manifest.submoduleEditableFile}`
  const subUntracked = manifest.submoduleUntrackedRelPath

  // Helper: capture trace-event names emitted since this point. Implemented via
  // the debug bridge on the main side which exposes a counter snapshot.
  const callDiff = async (root: string, force = false): Promise<DiffResult> => {
    const diff = await window.electronAPI.git.getDiff(root, { scope: 'full', force })
    return diff as DiffResult
  }

  // Reset the working trees to a clean baseline before each scenario so an
  // earlier test cannot leak state into the next one. Using saveFileContent +
  // deletePath via the existing project IPC keeps the test renderer-only.
  const restoreBaseline = async () => {
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\n')
    await window.electronAPI.git.saveFileContent(cleanRoot, subFile, '# Submodule\n\nbaseline content\n')
    await window.electronAPI.project.deletePath(cleanRoot, subUntracked)
    // Drop the request-level cache for the clean root so the next call is
    // guaranteed to re-stat the work tree. The watcher should also invalidate
    // soon, but force=true is the deterministic path inside the test.
    await callDiff(cleanRoot, true)
  }

  // ─────────────── GDS-01..GDS-05: submodule c/m/u filter ───────────────

  if (!cancelled()) {
    await restoreBaseline()
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-01\n')
    await sleep(200)
    const diff = await callDiff(cleanRoot, true)
    const subEntries = parentSubmoduleEntries(diff, cleanRoot, subPath)
    const parentChange = diff.files.find((f) => f.repoRoot && clampPath(f.repoRoot) === clampPath(cleanRoot) && f.filename === parentFile)
    record('GDS-01-parent-modified-submodule-clean', (
      diff.success &&
      Boolean(parentChange) &&
      subEntries.length === 0 &&
      repoChangeCount(diff, cleanRoot) === 1
    ), {
      submoduleEntries: subEntries.map((f) => ({ filename: f.filename, flags: f.submoduleFlags })),
      parentChangeCount: repoChangeCount(diff, cleanRoot),
      filenames: diff.files.map((f) => clampPath(f.filename))
    })
  }

  if (!cancelled()) {
    await restoreBaseline()
    await window.electronAPI.git.saveFileContent(cleanRoot, subFile, '# Submodule\n\nGDS-02 mutation\n')
    await sleep(200)
    const diff = await callDiff(cleanRoot, true)
    const subEntries = parentSubmoduleEntries(diff, cleanRoot, subPath)
    const subRepoRoot = `${cleanRoot}/${subPath}`
    const submoduleSection = diff.repos?.find((r) => clampPath(r.root) === clampPath(subRepoRoot))
    record('GDS-02-submodule-modified-parent-clean', (
      diff.success &&
      subEntries.length === 0 &&
      Boolean(submoduleSection) &&
      (submoduleSection?.changeCount ?? 0) >= 1
    ), {
      parentSubEntries: subEntries.length,
      submoduleSectionChangeCount: submoduleSection?.changeCount ?? null
    })
  }

  if (!cancelled()) {
    await restoreBaseline()
    await window.electronAPI.project.createFile(cleanRoot, subUntracked, 'gds-03 untracked\n')
    await sleep(200)
    const diff = await callDiff(cleanRoot, true)
    const subEntries = parentSubmoduleEntries(diff, cleanRoot, subPath)
    record('GDS-03-submodule-untracked-parent-clean', (
      diff.success && subEntries.length === 0
    ), {
      parentSubEntries: subEntries.length
    })
  }

  if (!cancelled()) {
    const diff = await callDiff(pointerRoot, true)
    const subEntries = parentSubmoduleEntries(diff, pointerRoot, subPath)
    const flags = subEntries[0]?.submoduleFlags
    record('GDS-04-submodule-pointer-changed-surfaces-in-parent', (
      diff.success &&
      subEntries.length === 1 &&
      Boolean(flags?.commitChanged)
    ), {
      submoduleEntryCount: subEntries.length,
      flags: flags ?? null
    })
  }

  if (!cancelled()) {
    await restoreBaseline()
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-05 parent\n')
    await window.electronAPI.git.saveFileContent(cleanRoot, subFile, '# Submodule\n\nGDS-05 sub\n')
    await sleep(200)
    const diff = await callDiff(cleanRoot, true)
    const parentChange = diff.files.find((f) => f.repoRoot && clampPath(f.repoRoot) === clampPath(cleanRoot) && f.filename === parentFile)
    const subEntries = parentSubmoduleEntries(diff, cleanRoot, subPath)
    const subRepoRoot = `${cleanRoot}/${subPath}`
    const submoduleSection = diff.repos?.find((r) => clampPath(r.root) === clampPath(subRepoRoot))
    record('GDS-05-mixed-parent-and-submodule-internal', (
      diff.success &&
      Boolean(parentChange) &&
      subEntries.length === 0 &&
      (submoduleSection?.changeCount ?? 0) >= 1
    ), {
      parentChange: Boolean(parentChange),
      submoduleEntries: subEntries.length,
      submoduleSectionChangeCount: submoduleSection?.changeCount ?? null
    })
  }

  // ─────────────── GDS-14: staged submodule pointer change must stay visible ───────────────
  // After `git add modules/sub`, the parent's index records the new pointer
  // and the submodule worktree HEAD now matches the index. Porcelain v2
  // reports `<c>=.` (no commit divergence) but X is non-`.` (parent index
  // changed). The filter must keep this row by `changeType === 'staged'` —
  // otherwise the user can no longer see / unstage the gitlink change from
  // Git Diff.
  if (!cancelled() && manifest.stagedPointerRoot) {
    const stagedPointerRoot = manifest.stagedPointerRoot
    const diff = await callDiff(stagedPointerRoot, true)
    const subEntries = parentSubmoduleEntries(diff, stagedPointerRoot, subPath)
    const flags = subEntries[0]?.submoduleFlags
    record('GDS-14-staged-submodule-pointer-surfaces-in-parent', (
      diff.success &&
      subEntries.length === 1 &&
      subEntries[0].changeType === 'staged' &&
      // Filter must NOT rely on `<c>=C` for this case — that's the whole
      // point of the bug. Asserting commitChanged === false lets the test
      // fail loudly if a future change accidentally re-introduces the
      // c-flag-only filter.
      flags?.commitChanged === false
    ), {
      submoduleEntryCount: subEntries.length,
      changeType: subEntries[0]?.changeType ?? null,
      flags: flags ?? null
    })
  }

  // ─────────────── GDS-13: uninitialized submodule (Project_Forward repro) ───────────────
  // The fixture's `uninitialized/root` has `.gitmodules` declaring `modules/sub`
  // but the directory has been `git submodule deinit`-ed — it exists on disk
  // but is NOT a git repository. The previous code path's `.gitmodules`
  // fallback (when `git submodule status --recursive` returns no initialized
  // entries) would treat the empty path as a submodule and downstream
  // `getSingleRepoDiff` would either fail or surface noise. The fix in
  // `collectSubmodulesFromGitmodules` calls `getGitRepoMeta(subRepoRoot)` and
  // requires the resolved toplevel to BE the submodule path itself; an empty
  // subdir resolves to its parent's toplevel, so it gets filtered out.
  if (!cancelled() && manifest.uninitializedRoot) {
    const uninitializedRoot = manifest.uninitializedRoot
    // Modify a parent-only file; nothing else should appear.
    await window.electronAPI.git.saveFileContent(uninitializedRoot, parentFile, 'parent source line\nGDS-13\n')
    await sleep(200)
    const diff = await callDiff(uninitializedRoot, true)
    const subEntries = parentSubmoduleEntries(diff, uninitializedRoot, subPath)
    // The uninitialized submodule MUST NOT show up in the repos outline at all
    // (it's not a real repo), and MUST NOT appear as a submodule entry in the
    // parent's file list.
    const phantomRepo = (diff.repos ?? []).some((r) => clampPath(r.root).endsWith(`/${subPath}`))
    const parentChange = diff.files.find((f) => f.filename === parentFile)
    record('GDS-13-uninitialized-submodule-not-surfaced', (
      diff.success &&
      Boolean(parentChange) &&
      subEntries.length === 0 &&
      !phantomRepo
    ), {
      parentChangeSeen: Boolean(parentChange),
      submoduleEntriesInParent: subEntries.length,
      phantomRepoInOutline: phantomRepo,
      reposCount: diff.repos?.length ?? 0,
      filenames: diff.files.map((f) => clampPath(f.filename))
    })
  }

  // ─────────────── GDS-06..GDS-10: staleness + cache ───────────────

  if (!cancelled()) {
    await restoreBaseline()
    await callDiff(cleanRoot, true)
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-06\n')
    // Intentionally NOT passing force on the second call — relying on watcher.
    // 250 ms gives the 180 ms debounce inside the invalidator a window to fire.
    await sleep(280)
    const diff = await callDiff(cleanRoot)
    const seen = diff.files.find((f) => f.filename === parentFile)
    record('GDS-06-watcher-invalidates-cache-on-fs-change', (
      diff.success && Boolean(seen)
    ), {
      sawNewParentChange: Boolean(seen),
      filenames: diff.files.map((f) => clampPath(f.filename))
    })
  }

  if (!cancelled()) {
    await restoreBaseline()
    await callDiff(cleanRoot, true)
    await sleep(50)
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-07\n')
    await sleep(280)
    const diff = await callDiff(cleanRoot)
    const seen = diff.files.find((f) => f.filename === parentFile)
    record('GDS-07-watcher-invalidates-after-debounce', (
      diff.success && Boolean(seen)
    ), { sawNewParentChange: Boolean(seen) })
  }

  if (!cancelled()) {
    await restoreBaseline()
    // Pre-populate cache via UI open, then close, then mutate, then re-open.
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-08-first-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await sleep(400)
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-08-first-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-08\n')
    await sleep(50)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    const reopenedFresh = await waitFor('GDS-08-second-open', () => {
      const api = window.__onwardGitDiffDebug
      if (!api?.isOpen()) return false
      return api.getFileList().some((f) => f.filename === parentFile)
    }, 6000)
    record('GDS-08-subpage-entry-shows-fresh-data', reopenedFresh, {
      visibleFiles: window.__onwardGitDiffDebug?.getFileList()?.map((f) => f.filename) ?? null
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-08-final-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  if (!cancelled()) {
    await restoreBaseline()
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-09-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await sleep(400)
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-09 external\n')
    const sawExternal = await waitFor('GDS-09-external-change-reflected', () => {
      return Boolean(window.__onwardGitDiffDebug?.getFileList().some((f) => f.filename === parentFile))
    }, 5000, 100)
    record('GDS-09-open-view-reflects-external-change', sawExternal, {
      visibleFiles: window.__onwardGitDiffDebug?.getFileList()?.map((f) => f.filename) ?? null
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-09-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  if (!cancelled()) {
    await restoreBaseline()
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-10 concurrent\n')
    await sleep(50)
    const [forceResult, cachedResult] = await Promise.all([
      callDiff(cleanRoot, true),
      callDiff(cleanRoot, false)
    ])
    const forceFile = forceResult.files.find((f) => f.filename === parentFile)
    const cachedFile = cachedResult.files.find((f) => f.filename === parentFile)
    record('GDS-10-concurrent-force-and-cached-converge', (
      forceResult.success &&
      cachedResult.success &&
      Boolean(forceFile) &&
      Boolean(cachedFile)
    ), {
      forceFileSeen: Boolean(forceFile),
      cachedFileSeen: Boolean(cachedFile)
    })
  }

  // ─────────────── GDS-15: subdir entry watches the resolved repo root ───────────────
  // When the user opens Git Diff from a subdirectory (e.g.
  // `cleanRoot/src/components/`), getGitDiff resolves up to `cleanRoot` and
  // returns a diff covering the WHOLE repo. The watcher must be registered
  // on the resolved repoRoot — not the subdir — otherwise an external edit
  // to a sibling path under the same repo would be silently missed.
  // Sequence: open Diff with `cwd=cleanRoot/src` (a subdir), wait for it to
  // load, then mutate `cleanRoot/<parentFile>` (a path NOT under `src/`),
  // and verify the watcher-driven cache invalidation eventually surfaces
  // that file. If the watcher were scoped to `cleanRoot/src/`, the
  // assertion would time out.
  if (!cancelled()) {
    await restoreBaseline()
    const subdirCwd = `${cleanRoot}/src`
    // First call: register watcher (P3 fix means it watches `cleanRoot`,
    // not `subdirCwd`).
    await callDiff(subdirCwd, true)
    await sleep(250)
    // Mutate a path NOT under `src/` — README.md lives at the parent root.
    await window.electronAPI.git.saveFileContent(cleanRoot, 'README.md', '# Clean parent\n\nGDS-15 root-level edit\n')
    await sleep(450) // 180 ms watcher debounce + slack for fs.watch coalescing
    const followup = await callDiff(subdirCwd, false)
    const sawRootEdit = followup.success && followup.files.some((f) => f.filename === 'README.md')
    record('GDS-15-subdir-entry-watches-resolved-repo-root', sawRootEdit, {
      subdirCwd,
      mutatedFile: 'README.md',
      visibleFiles: followup.files.map((f) => clampPath(f.filename))
    })
  }

  // ─────────────── GDS-11/12: trace-event coverage ───────────────
  // The actual JSON inspection happens runner-side after the app exits — we
  // emit a marker assertion here that records the trace info path so the bash
  // wrapper has a deterministic anchor to grep for. The PASS/FAIL of the trace
  // assertions is the runner's job; we still emit the marker so the test log
  // shows whether trace was enabled.

  if (!cancelled()) {
    const traceInfo = await window.electronAPI.debug.getPerfTraceInfo()
    record('GDS-11-trace-marker-submodule-filter-expected', Boolean(traceInfo?.logPath), {
      tracePath: traceInfo?.logPath ?? null,
      enabled: traceInfo?.enabled ?? null,
      eventsToVerifyInRunner: [
        'main:git.diff.submodule-filter'
      ]
    })
    record('GDS-12-trace-marker-watcher-and-freshness-expected', Boolean(traceInfo?.logPath), {
      tracePath: traceInfo?.logPath ?? null,
      enabled: traceInfo?.enabled ?? null,
      eventsToVerifyInRunner: [
        'main:git.diff.fs-watch-event',
        'renderer:subpage.freshness-check'
      ]
    })
    // GDS-16: Snapshot service migration (lesson #13 phase 1). Every
    // `loadGitDiff` call now routes through the snapshot service, so a
    // healthy session MUST produce at least one `capture` event. We do
    // not assert `cache-hit` here because the request and snapshot
    // caches share an invalidation fan-out, so an in-test cache-hit
    // requires a precise timing window not worth defending in CI. The
    // runner asserts only the capture event.
    record('GDS-16-trace-marker-snapshot-service-expected', Boolean(traceInfo?.logPath), {
      tracePath: traceInfo?.logPath ?? null,
      enabled: traceInfo?.enabled ?? null,
      eventsToVerifyInRunner: [
        'main:git.snapshot.capture'
      ]
    })
  }

  // Final cleanup: leave the clean repo in a known state so any subsequent
  // run within the same Electron session does not see leftover dirt.
  await restoreBaseline()

  log('git-diff-staleness:done', {
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    total: results.length
  })

  return results
}
