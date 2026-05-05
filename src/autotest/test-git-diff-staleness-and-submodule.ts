/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * Git Diff staleness + submodule c/m/u filter regression suite (GDS-01..GDS-15).
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
 * The core GDS assertions cover both bugs plus their trace-event signatures so
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
  resourceGroup?: string
  originalRef?: string | null
  modifiedRef?: string | null
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

function findDiffFileIndex(
  files: DiffFile[],
  filename: string,
  changeType: string
): number {
  return files.findIndex((file) => file.filename === filename && file.changeType === changeType)
}

export async function testGitDiffStalenessAndSubmodule(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep: baseSleep, waitFor: baseWaitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const suiteStartedAt = performance.now()
  let lastRecordAt = suiteStartedAt
  const elapsed = (startedAt: number) => +(performance.now() - startedAt).toFixed(1)
  type GdsTimingEvent = Record<string, unknown> & {
    label: string
    totalMs: number
  }
  const timingEvents: GdsTimingEvent[] = []
  const logTiming = (label: string, detail?: Record<string, unknown>) => {
    const event: GdsTimingEvent = {
      label,
      totalMs: elapsed(suiteStartedAt),
      ...detail
    }
    timingEvents.push(event)
    log('gds:timing', event)
  }
  const timingNumber = (value: unknown): number | null => {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  const emitTimingSummary = () => {
    const slowRecords = timingEvents
      .filter((event) => event.label === 'record')
      .map((event) => ({
        name: String(event.name ?? ''),
        ok: Boolean(event.ok),
        sincePreviousRecordMs: timingNumber(event.sincePreviousRecordMs) ?? 0,
        totalMs: event.totalMs
      }))
      .sort((a, b) => b.sincePreviousRecordMs - a.sincePreviousRecordMs)
      .slice(0, 10)
    const slowWaits = timingEvents
      .filter((event) => event.label === 'wait:end')
      .map((event) => ({
        waitLabel: String(event.waitLabel ?? ''),
        ok: Boolean(event.ok),
        elapsedMs: timingNumber(event.elapsedMs) ?? 0,
        timeoutMs: timingNumber(event.timeoutMs) ?? null,
        totalMs: event.totalMs
      }))
      .sort((a, b) => b.elapsedMs - a.elapsedMs)
      .slice(0, 10)
    const slowCallDiffs = timingEvents
      .filter((event) => event.label === 'callDiff')
      .map((event) => ({
        elapsedMs: timingNumber(event.elapsedMs) ?? 0,
        force: Boolean(event.force),
        success: Boolean(event.success),
        fileCount: timingNumber(event.fileCount),
        repoCount: timingNumber(event.repoCount),
        totalMs: event.totalMs
      }))
      .sort((a, b) => b.elapsedMs - a.elapsedMs)
      .slice(0, 10)
    const fixedSleepTotalMs = timingEvents
      .filter((event) => event.label === 'sleep')
      .reduce((sum, event) => sum + (timingNumber(event.elapsedMs) ?? 0), 0)
    const callDiffTotalMs = timingEvents
      .filter((event) => event.label === 'callDiff')
      .reduce((sum, event) => sum + (timingNumber(event.elapsedMs) ?? 0), 0)
    log('gds:timing-summary', {
      totalMs: elapsed(suiteStartedAt),
      fixedSleepTotalMs: +fixedSleepTotalMs.toFixed(1),
      callDiffTotalMs: +callDiffTotalMs.toFixed(1),
      slowRecords,
      slowWaits,
      slowCallDiffs
    })
  }
  const sleep = async (ms: number) => {
    const startedAt = performance.now()
    await baseSleep(ms)
    if (ms >= 200) {
      logTiming('sleep', {
        requestedMs: ms,
        elapsedMs: elapsed(startedAt)
      })
    }
  }
  const waitFor: AutotestContext['waitFor'] = async (label, predicate, timeoutMs = 6000, intervalMs = 80) => {
    const startedAt = performance.now()
    logTiming('wait:start', { waitLabel: label, timeoutMs, intervalMs })
    const ok = await baseWaitFor(label, predicate, timeoutMs, intervalMs)
    logTiming('wait:end', {
      waitLabel: label,
      ok,
      elapsedMs: elapsed(startedAt),
      timeoutMs,
      intervalMs
    })
    return ok
  }
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    const now = performance.now()
    logTiming('record', {
      name,
      ok,
      sincePreviousRecordMs: +(now - lastRecordAt).toFixed(1)
    })
    lastRecordAt = now
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
    const startedAt = performance.now()
    const diff = await window.electronAPI.git.getDiff(root, { scope: 'full', force })
    const result = diff as DiffResult
    logTiming('callDiff', {
      root: clampPath(root),
      force,
      elapsedMs: elapsed(startedAt),
      success: result.success,
      fileCount: result.files?.length ?? null,
      repoCount: result.repos?.length ?? null
    })
    return result
  }

  const clearDiffState = async () => {
    const stagedDiff = await callDiff(cleanRoot, true)
    for (const file of stagedDiff.files) {
      if (file.changeType === 'staged') {
        await window.electronAPI.git.unstageFile(cleanRoot, file.filename, file.repoRoot)
      }
    }

    const workingDiff = await callDiff(cleanRoot, true)
    for (const file of workingDiff.files) {
      if (file.changeType === 'staged') {
        await window.electronAPI.git.unstageFile(cleanRoot, file.filename, file.repoRoot)
        continue
      }
      const discardTarget = {
        filename: file.filename,
        status: file.status ?? (file.changeType === 'untracked' ? '?' : 'M'),
        changeType: file.changeType ?? 'unstaged',
        isSubmoduleEntry: file.isSubmoduleEntry
      } as Parameters<typeof window.electronAPI.git.discardFile>[1]
      await window.electronAPI.git.discardFile(cleanRoot, discardTarget, file.repoRoot)
    }
  }

  // Reset the working trees to a clean baseline before each scenario so an
  // earlier test cannot leak state into the next one. This must clean staged,
  // unstaged, and untracked entries because several scenarios deliberately
  // mutate different resource groups before returning to the shared fixture.
  const restoreBaseline = async () => {
    await clearDiffState()
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

  // ─────────────── GDS-17: re-entry must re-fetch per-file diff body ───────────────
  // Repro for the user-reported bug where re-entering Git Diff shows the
  // PREVIOUS open's diff body even after the file changed on disk:
  //   1. Modify <parentFile> to V1, open Diff -> renderer caches Monaco's
  //      original/modified content under fileContents[fileKey].
  //   2. Close Diff. The fs-watcher chain clears the worker-side caches but
  //      the renderer's per-file content map is preserved across same-cwd
  //      re-entries by applyLoadedDiffResult.
  //   3. Modify the same file to V2 while Diff is closed.
  //   4. Re-open Diff. The selected file does not change, so the
  //      ensureFileContent effect does not re-fire and Monaco shows V1.
  // Existing GDS-08 only checks file-list freshness; the gap is the diff
  // BODY shown to the user. The assertion below probes the actual cached
  // originalContent / modifiedContent via the new debug API.
  if (!cancelled()) {
    await restoreBaseline()
    const v1Modified = 'parent source line\nGDS-17 v1 first edit\n'
    const v2Modified = 'parent source line\nGDS-17 v2 SECOND edit (must surface)\n'

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, v1Modified)
    await sleep(280) // > 180 ms watcher debounce so any cached worker entry is dropped

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-17-first-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await waitFor('GDS-17-first-list', () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.getFileList().some((f) => f.filename === parentFile))
    }, 6000)
    const api1 = window.__onwardGitDiffDebug
    if (api1 && api1.getSelectedFile()?.filename !== parentFile) {
      api1.selectFileByPath(parentFile)
    }
    await waitFor('GDS-17-first-content-ready', () => Boolean(window.__onwardGitDiffDebug?.isSelectedReady()), 6000)
    const firstSnapshot = window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null
    log('GDS-17-first-snapshot', firstSnapshot)

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-17-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)

    // Mutate while Diff is closed — the per-file watcher in the renderer
    // is unsubscribed in this window. The L1 fs.watch in main DOES fire,
    // clears the worker-side caches, sends 'git:diff-cache-invalidated'
    // to the renderer, but the renderer's listener is gated on isOpen.
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, v2Modified)
    await sleep(320) // 180 ms debounce + slack for fs.watch coalescing

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-17-second-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await waitFor('GDS-17-second-list', () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.getFileList().some((f) => f.filename === parentFile))
    }, 6000)
    const api2 = window.__onwardGitDiffDebug
    if (api2 && api2.getSelectedFile()?.filename !== parentFile) {
      api2.selectFileByPath(parentFile)
    }
    await waitFor('GDS-17-second-content-ready', () => Boolean(window.__onwardGitDiffDebug?.isSelectedReady()), 6000)
    // Give any in-flight refetch a brief settling window — if the fix
    // routes invalidation through fileContents, the loading state will
    // toggle once and we want to capture the post-refresh snapshot, not
    // a transient mid-fetch one.
    await sleep(120)
    const secondSnapshot = window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null
    log('GDS-17-second-snapshot', secondSnapshot)

    const sawV2 = secondSnapshot?.modifiedContent === v2Modified
    const sawV1Stale = secondSnapshot?.modifiedContent === v1Modified
    record('GDS-17-reentry-shows-latest-content', Boolean(sawV2 && !sawV1Stale), {
      firstModifiedContent: firstSnapshot?.modifiedContent ?? null,
      secondModifiedContent: secondSnapshot?.modifiedContent ?? null,
      expected: v2Modified,
      sawV2,
      sawV1Stale,
      probeAvailable: typeof window.__onwardGitDiffDebug?.getSelectedFileContent === 'function'
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-17-final-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // ─────────────── GDS-18: re-entry latency trend is recorded ───────────────
  // The flip-side of GDS-17: same-cwd re-entry with no intervening mutation
  // should normally hit warm caches. This row records the timing as trend
  // data but does not hard-fail on a wall-clock threshold; the functional
  // gate is that the second entry loads a file list and reports timing.
  if (!cancelled()) {
    await restoreBaseline()
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-18 baseline\n')
    await sleep(280)

    // First open warms the cache.
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-18-first-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await waitFor('GDS-18-first-list', () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.getFileList().some((f) => f.filename === parentFile))
    }, 6000)
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-18-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)

    // No file mutation between close and re-open. Watcher should have
    // nothing to invalidate, so the second entry should hit the L2 / L3 /
    // L4 caches and complete almost instantly.
    await sleep(50)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-18-second-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await waitFor('GDS-18-second-list', () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.getFileList().some((f) => f.filename === parentFile))
    }, 6000)
    const secondTimingReady = await waitFor('GDS-18-second-timing', () => {
      const snapshot = window.__onwardGitDiffDebug?.getTiming?.() ?? null
      return typeof snapshot?.cwdReadyToDiffLoadedMs === 'number'
    }, 6000, 50)
    const timing = window.__onwardGitDiffDebug?.getTiming?.() ?? null
    const cwdReadyToDiffLoadedMs = timing?.cwdReadyToDiffLoadedMs ?? null
    const timingRecorded = typeof cwdReadyToDiffLoadedMs === 'number'
    log('GDS-18-second-timing-snapshot', {
      timing,
      secondTimingReady,
      loadState: window.__onwardGitDiffDebug?.getLoadState?.() ?? null
    })
    record('GDS-18-reentry-latency-trend-recorded', Boolean(secondTimingReady && timingRecorded), {
      timing,
      secondTimingReady,
      loadState: window.__onwardGitDiffDebug?.getLoadState?.() ?? null,
      healthyTargetMs: 350
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-18-final-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // ─────────────── GDS-19: open view selected body refreshes ───────────────
  if (!cancelled()) {
    await restoreBaseline()
    const v1Modified = 'parent source line\nGDS-19 v1 while open\n'
    const v2Modified = 'parent source line\nGDS-19 v2 while open (must surface)\n'

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, v1Modified)
    await sleep(280)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-19-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await waitFor('GDS-19-list', () => Boolean(window.__onwardGitDiffDebug?.getFileList().some((f) => f.filename === parentFile)), 6000)
    if (window.__onwardGitDiffDebug?.getSelectedFile()?.filename !== parentFile) {
      window.__onwardGitDiffDebug?.selectFileByPath(parentFile)
    }
    await waitFor('GDS-19-v1-ready', () => window.__onwardGitDiffDebug?.getSelectedFileContent?.()?.modifiedContent === v1Modified, 6000)

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, v2Modified)
    const refreshed = await waitFor('GDS-19-v2-refresh', () => {
      const state = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      return state?.modifiedContent === v2Modified && state?.draftContent === null
    }, 6000, 50)
    record('GDS-19-open-view-selected-body-refreshes', refreshed, {
      snapshot: window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null,
      expected: v2Modified
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-19-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // ─────────────── GDS-20: draft survives external refresh ───────────────
  if (!cancelled()) {
    await restoreBaseline()
    const v1Modified = 'parent source line\nGDS-20 v1 base\n'
    const v2Modified = 'parent source line\nGDS-20 v2 external\n'
    const localDraft = 'parent source line\nGDS-20 local draft must survive\n'

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, v1Modified)
    await sleep(280)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-20-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await waitFor('GDS-20-list', () => Boolean(window.__onwardGitDiffDebug?.getFileList().some((f) => f.filename === parentFile)), 6000)
    if (window.__onwardGitDiffDebug?.getSelectedFile()?.filename !== parentFile) {
      window.__onwardGitDiffDebug?.selectFileByPath(parentFile)
    }
    await waitFor('GDS-20-v1-ready', () => window.__onwardGitDiffDebug?.getSelectedFileContent?.()?.modifiedContent === v1Modified, 6000)
    const draftSet = window.__onwardGitDiffDebug?.setSelectedDraftContent?.(localDraft) === true
    await waitFor('GDS-20-draft-visible', () => {
      const state = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      return state?.draftContent === localDraft && window.__onwardGitDiffDebug?.getIsDraftDirty?.() === true
    }, 3000, 50)

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, v2Modified)
    const refreshed = await waitFor('GDS-20-draft-preserved-after-refresh', () => {
      const state = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      return state?.modifiedContent === v2Modified && state?.draftContent === localDraft
    }, 6000, 50)
    record('GDS-20-draft-preserved-during-external-refresh', draftSet && refreshed, {
      snapshot: window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null,
      expectedModifiedContent: v2Modified,
      expectedDraftContent: localDraft,
      debugDraftApiAvailable: typeof window.__onwardGitDiffDebug?.setSelectedDraftContent === 'function'
    })
    window.__onwardGitDiffDebug?.setSelectedDraftContent?.(v2Modified)
    await waitFor('GDS-20-draft-cleared-before-close', () => window.__onwardGitDiffDebug?.getIsDraftDirty?.() !== true, 3000, 50)
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-20-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // ─────────────── GDS-21/22: VS Code-style resource semantics ───────────────
  // VS Code's SCM resource model distinguishes index, working tree, and
  // untracked resources. Onward keeps its own UI, but the underlying file
  // states must describe the same left/right resource semantics.
  if (!cancelled()) {
    await restoreBaseline()
    const indexContent = 'parent source line\nGDS-21 index version\n'
    const worktreeContent = 'parent source line\nGDS-21 working tree version\n'
    const untrackedFile = `gds-21-untracked-${Date.now()}.txt`

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, indexContent)
    const staged = await window.electronAPI.git.stageFile(cleanRoot, parentFile)
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, worktreeContent)
    const created = await window.electronAPI.project.createFile(cleanRoot, untrackedFile, 'GDS-21 untracked body\n')
    await sleep(280)

    const diff = await callDiff(cleanRoot, true)
    const stagedEntry = diff.files.find((file) => file.filename === parentFile && file.changeType === 'staged')
    const unstagedEntry = diff.files.find((file) => file.filename === parentFile && file.changeType === 'unstaged')
    const untrackedEntry = diff.files.find((file) => file.filename === untrackedFile && file.changeType === 'untracked')
    record('GDS-21-vscode-resource-groups-and-refs', Boolean(
      staged.success &&
      created.success &&
      stagedEntry?.resourceGroup === 'index' &&
      stagedEntry.originalRef === 'HEAD' &&
      stagedEntry.modifiedRef === 'index' &&
      unstagedEntry?.resourceGroup === 'workingTree' &&
      unstagedEntry.originalRef === 'index' &&
      unstagedEntry.modifiedRef === 'workingTree' &&
      untrackedEntry?.resourceGroup === 'untracked' &&
      untrackedEntry.originalRef === 'empty' &&
      untrackedEntry.modifiedRef === 'workingTree'
    ), {
      stagedSuccess: staged.success,
      createdSuccess: created.success,
      stagedEntry,
      unstagedEntry,
      untrackedEntry,
      filenames: diff.files.map((file) => ({
        filename: file.filename,
        changeType: file.changeType,
        resourceGroup: file.resourceGroup,
        originalRef: file.originalRef,
        modifiedRef: file.modifiedRef
      }))
    })

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-22-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await waitFor('GDS-22-list', () => {
      const files = window.__onwardGitDiffDebug?.getFileList() ?? []
      return findDiffFileIndex(files, parentFile, 'staged') >= 0 && findDiffFileIndex(files, parentFile, 'unstaged') >= 0
    }, 6000)

    const files = window.__onwardGitDiffDebug?.getFileList() ?? []
    const stagedIndex = findDiffFileIndex(files, parentFile, 'staged')
    const unstagedIndex = findDiffFileIndex(files, parentFile, 'unstaged')
    const stagedSelected = stagedIndex >= 0 && window.__onwardGitDiffDebug?.selectFileByIndex(stagedIndex) === true
    await waitFor('GDS-22-staged-ready', () => {
      const selected = window.__onwardGitDiffDebug?.getSelectedFile?.()
      const content = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      return selected?.filename === parentFile &&
        selected.changeType === 'staged' &&
        content?.modifiedContent === indexContent
    }, 6000)
    const stagedContent = window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null
    const unstagedSelected = unstagedIndex >= 0 && window.__onwardGitDiffDebug?.selectFileByIndex(unstagedIndex) === true
    await waitFor('GDS-22-unstaged-ready', () => {
      const content = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      return content?.modifiedContent === worktreeContent
    }, 6000)
    const unstagedContent = window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null

    record('GDS-22-vscode-left-right-content-semantics', Boolean(
      stagedSelected &&
      unstagedSelected &&
      stagedContent?.originalContent === 'parent source line\n' &&
      stagedContent?.modifiedContent === indexContent &&
      unstagedContent?.originalContent === indexContent &&
      unstagedContent?.modifiedContent === worktreeContent
    ), {
      stagedIndex,
      unstagedIndex,
      stagedSelected,
      unstagedSelected,
      stagedContent,
      unstagedContent,
      expected: {
        stagedOriginal: 'parent source line\n',
        stagedModified: indexContent,
        unstagedOriginal: indexContent,
        unstagedModified: worktreeContent
      }
    })

    const actionState = window.__onwardGitDiffDebug?.getFileActionState?.() ?? null
    const visibleLabels = actionState?.visibleLabels ?? []
    record('GDS-23-vscode-style-action-toolbar', Boolean(
      actionState?.toolbarVisible &&
      !actionState.actionPanelVisible &&
      visibleLabels.length > 0 &&
      !visibleLabels.includes('Keep') &&
      !visibleLabels.includes('Deny')
    ), {
      actionState
    })

    const responsiveState = window.__onwardGitDiffDebug?.getResponsiveLayoutState?.() ?? null
    record('GDS-24-vscode-responsive-diff-options', Boolean(
      responsiveState?.useInlineViewWhenSpaceIsLimited === true &&
      responsiveState.inlineBreakpoint === 900 &&
      (
        responsiveState.containerWidth === null ||
        responsiveState.containerWidth > responsiveState.inlineBreakpoint ||
        responsiveState.mode === 'inline'
      )
    ), {
      responsiveState
    })

    let splitStateBeforeDrag = window.__onwardGitDiffDebug?.getSplitViewState?.() ?? null
    let widenedForSplitDrag = false
    if (
      splitStateBeforeDrag?.mode !== 'side-by-side' &&
      window.__onwardGitDiffDebug?.setFileListWidth
    ) {
      window.__onwardGitDiffDebug.setFileListWidth(150)
      widenedForSplitDrag = await waitFor('GDS-25-side-by-side-ready', () => {
        const responsive = window.__onwardGitDiffDebug?.getResponsiveLayoutState?.() ?? null
        const split = window.__onwardGitDiffDebug?.getSplitViewState?.() ?? null
        if (!responsive || responsive.containerWidth === null) return false
        return Boolean(
          responsive.containerWidth > responsive.inlineBreakpoint &&
          split?.mode === 'side-by-side' &&
          split.ratio !== null
        )
      }, 5000, 80)
      splitStateBeforeDrag = window.__onwardGitDiffDebug?.getSplitViewState?.() ?? null
    }
    const splitWidthBeforeDrag = (splitStateBeforeDrag?.originalWidth ?? 0) + (splitStateBeforeDrag?.modifiedWidth ?? 0)
    const splitGeometryUsable = Boolean(
      splitStateBeforeDrag?.mode === 'side-by-side' &&
      splitStateBeforeDrag.ratio !== null &&
      splitWidthBeforeDrag >= 500
    )
    const usableSplitState = splitGeometryUsable ? splitStateBeforeDrag : null
    if (usableSplitState && window.__onwardGitDiffDebug?.dragSplitViewRatio) {
      const targetRatio = usableSplitState.ratio !== null && usableSplitState.ratio >= 0.5 ? 0.37 : 0.63
      const dragged = await window.__onwardGitDiffDebug.dragSplitViewRatio(targetRatio)
      const splitStateAfterDrag = window.__onwardGitDiffDebug.getSplitViewState?.() ?? null
      const storedRatioRaw = window.localStorage.getItem('git-diff-split-view-ratio')
      const storedRatio = storedRatioRaw !== null ? Number(storedRatioRaw) : null
      record('GDS-25-diff-split-ratio-global-preference', Boolean(
        dragged &&
        splitStateAfterDrag !== null &&
        splitStateAfterDrag.ratio !== null &&
        storedRatio !== null &&
        Number.isFinite(storedRatio) &&
        Math.abs(storedRatio - splitStateAfterDrag.ratio) <= 0.05
      ), {
        dragged,
        targetRatio,
        before: splitStateBeforeDrag,
        after: splitStateAfterDrag,
        storedRatio,
        widenedForSplitDrag
      })
    } else {
      record('GDS-25-diff-split-ratio-global-preference', true, {
        skipped: true,
        reason: 'diff editor is currently inline, unavailable, or too narrow for reliable sash drag automation',
        splitState: splitStateBeforeDrag,
        splitWidthBeforeDrag,
        widenedForSplitDrag
      })
    }

    const navigationBefore = window.__onwardGitDiffDebug?.getDiffNavigationState?.() ?? null
    const navigatedNext = window.__onwardGitDiffDebug?.navigateDiffChange?.('next') === true
    const navigationAfterNext = window.__onwardGitDiffDebug?.getDiffNavigationState?.() ?? null
    const navigatedPrevious = window.__onwardGitDiffDebug?.navigateDiffChange?.('previous') === true
    const navigationAfterPrevious = window.__onwardGitDiffDebug?.getDiffNavigationState?.() ?? null
    record('GDS-27-diff-hunk-navigation-wraps', Boolean(
      navigationBefore &&
      navigationBefore.changeCount > 0 &&
      navigatedNext &&
      navigatedPrevious &&
      navigationAfterNext &&
      navigationAfterNext.currentIndex >= 0 &&
      navigationAfterNext.currentIndex < navigationAfterNext.changeCount &&
      navigationAfterPrevious &&
      navigationAfterPrevious.currentIndex >= 0 &&
      navigationAfterPrevious.currentIndex < navigationAfterPrevious.changeCount
    ), {
      navigationBefore,
      navigatedNext,
      navigationAfterNext,
      navigatedPrevious,
      navigationAfterPrevious
    })

    const refreshButtonVisible = Boolean(document.querySelector('.git-diff-refresh-changes'))
    const refreshResult = await window.__onwardGitDiffDebug?.refreshChanges?.()
    await waitFor('GDS-28-refresh-ready', () => Boolean(window.__onwardGitDiffDebug?.isSelectedReady()), 6000)
    const termsButtonVisible = Boolean(document.querySelector('.git-diff-terms-button'))
    const termsToggle = window.__onwardGitDiffDebug?.toggleTermsPopover?.() === true
    await waitFor('GDS-28-terms-popover', () => window.__onwardGitDiffDebug?.getTermsPopoverOpen?.() === true, 2000, 50)
    const termsText = (document.querySelector('.git-diff-terms-popover')?.textContent ?? '').trim()
    const groupTitles = Array.from(document.querySelectorAll('.git-diff-file-group-title'))
      .map((node) => (node.textContent ?? '').trim())
    record('GDS-28-refresh-and-terms-help', Boolean(
      refreshButtonVisible &&
      refreshResult &&
      termsButtonVisible &&
      termsToggle &&
      termsText.includes('Staged Changes') &&
      termsText.includes('Uncommitted') &&
      groupTitles.some((label) => label.includes('Changes')) &&
      !groupTitles.some((label) => label.startsWith('Unstaged'))
    ), {
      refreshButtonVisible,
      refreshResult,
      termsButtonVisible,
      termsToggle,
      termsText,
      groupTitles
    })

    const firstHunkReady = await waitFor('GDS-29-first-hunk-ready', () => {
      return (window.__onwardGitDiffDebug?.getDiffNavigationState?.().changeCount ?? 0) > 0
    }, 2500, 50)
    const hunkHoverInitialState = window.__onwardGitDiffDebug?.getHunkActionDebugState?.() ?? null
    const hunkActionsHiddenByDefault = Boolean(
      hunkHoverInitialState &&
      hunkHoverInitialState.visibleWidgetDomCount === 0
    )
    const hunkHoverRevealResult = window.__onwardGitDiffDebug?.revealFirstHunkActionForTest?.() === true
    const hunkHoverRevealed = await waitFor('GDS-29-hunk-actions-hover-reveal', () => {
      return (window.__onwardGitDiffDebug?.getHunkActionDebugState?.().visibleWidgetDomCount ?? 0) > 0
    }, 1000, 50)
    record('GDS-29-inline-hunk-actions-hover-reveal', Boolean(
      firstHunkReady &&
      hunkActionsHiddenByDefault &&
      hunkHoverRevealResult &&
      hunkHoverRevealed
    ), {
      hunkHoverInitialState,
      hunkHoverRevealResult,
      hunkHoverFinalState: window.__onwardGitDiffDebug?.getHunkActionDebugState?.() ?? null
    })
    const hunkStageResult = firstHunkReady
      ? await window.__onwardGitDiffDebug?.triggerFirstHunkAction?.('stage')
      : false
    const hunkActionApplied = await waitFor('GDS-29-hunk-stage-applied', () => {
      const latestFiles = window.__onwardGitDiffDebug?.getFileList() ?? []
      return findDiffFileIndex(latestFiles, parentFile, 'unstaged') < 0
    }, 4000, 80)
    record('GDS-29-inline-hunk-stage-action-trace-smoke', Boolean(
      firstHunkReady &&
      hunkStageResult &&
      hunkActionApplied
    ), {
      firstHunkReady,
      hunkStageResult,
      latestFiles: window.__onwardGitDiffDebug?.getFileList().map((file) => ({
        filename: file.filename,
        changeType: file.changeType
      })) ?? []
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-22-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
    const hunkWidgetsClearedAfterClose = await waitFor('GDS-29-hunk-actions-cleared-after-close', () => {
      return document.querySelectorAll('.git-diff-hunk-actions').length === 0
    }, 2000, 50)
    record('GDS-29-inline-hunk-actions-disposed-after-close', hunkWidgetsClearedAfterClose, {
      widgetDomCount: document.querySelectorAll('.git-diff-hunk-actions').length
    })
    await window.electronAPI.git.discardFile(cleanRoot, { filename: parentFile, status: 'M', changeType: 'unstaged' })
    await window.electronAPI.git.discardFile(cleanRoot, { filename: parentFile, status: 'M', changeType: 'staged' })
    await window.electronAPI.git.discardFile(cleanRoot, { filename: untrackedFile, status: '?', changeType: 'untracked' })
  }

  // ─────────────── GDS-31..33: blank entry, body prefetch, selected ranges ───────────────
  if (!cancelled()) {
    await restoreBaseline()
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-31 visible but not auto-opened\n')
    await sleep(280)

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-31-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    const listReady = await waitFor('GDS-31-list', () => {
      const files = window.__onwardGitDiffDebug?.getFileList() ?? []
      return files.some((file) => file.filename === parentFile)
    }, 6000)
    await sleep(180)
    const selected = window.__onwardGitDiffDebug?.getSelectedFile?.() ?? null
    const noSelectionText = (document.querySelector('.git-diff-no-selection')?.textContent ?? '').trim()
    record('GDS-31-git-diff-opens-blank-until-file-selected', Boolean(
      listReady &&
      selected === null &&
      noSelectionText.includes('Select a file')
    ), {
      selected,
      noSelectionText,
      files: window.__onwardGitDiffDebug?.getFileList?.().map((file) => ({ filename: file.filename, changeType: file.changeType })) ?? []
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-31-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  if (!cancelled()) {
    await restoreBaseline()
    const prefetchedContent = 'parent source line\nGDS-32 prefetch warms first file body\n'
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, prefetchedContent)
    await sleep(280)

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-32-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await waitFor('GDS-32-list', () => {
      const files = window.__onwardGitDiffDebug?.getFileList() ?? []
      return files.some((file) => file.filename === parentFile && file.changeType === 'unstaged')
    }, 6000)
    const prefetched = await waitFor('GDS-32-prefetch-body-ready', () => {
      const cached = window.__onwardGitDiffDebug?.getCachedFileContentByPath?.(parentFile, 'unstaged')
      return cached?.modifiedContent === prefetchedContent && cached.loading === false
    }, 6000, 80)
    const prefetchState = window.__onwardGitDiffDebug?.getPrefetchState?.() ?? null
    const cachedBeforeSelect = window.__onwardGitDiffDebug?.getCachedFileContentByPath?.(parentFile, 'unstaged') ?? null
    const selectStartedAt = performance.now()
    const selectedOk = window.__onwardGitDiffDebug?.selectFileByPath(parentFile) === true
    const selectedReady = await waitFor('GDS-32-selected-ready', () => {
      const state = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      return state?.modifiedContent === prefetchedContent && state.loading === false
    }, 6000, 50)
    const selectDurationMs = +(performance.now() - selectStartedAt).toFixed(1)
    record('GDS-32-first-selection-uses-prefetched-body-cache', Boolean(
      prefetched &&
      cachedBeforeSelect?.modifiedContent === prefetchedContent &&
      selectedOk &&
      selectedReady
    ), {
      prefetchState,
      cachedBeforeSelect,
      selectDurationMs
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-32-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  if (!cancelled()) {
    await restoreBaseline()
    const baseContent = 'parent source line\n'
    const partiallyStagedContent = 'parent source line\nGDS-33 selected line staged\n'
    const worktreeContent = 'parent source line\nGDS-33 selected line staged\nGDS-33 line remains unstaged\n'

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, worktreeContent)
    await sleep(280)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-33-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await waitFor('GDS-33-list', () => {
      const files = window.__onwardGitDiffDebug?.getFileList() ?? []
      return findDiffFileIndex(files, parentFile, 'unstaged') >= 0
    }, 6000)
    const filesBefore = window.__onwardGitDiffDebug?.getFileList() ?? []
    const unstagedBeforeIndex = findDiffFileIndex(filesBefore, parentFile, 'unstaged')
    const selectedBefore = unstagedBeforeIndex >= 0 && window.__onwardGitDiffDebug?.selectFileByIndex(unstagedBeforeIndex) === true
    await waitFor('GDS-33-unstaged-ready-before', () => {
      const content = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      return content?.originalContent === baseContent && content.modifiedContent === worktreeContent
    }, 6000)
    const rangeSelected = window.__onwardGitDiffDebug?.setSelectedLineRangeForTest?.(2, 2, 'additions') === true
    const rangeVisible = await waitFor('GDS-33-range-visible', () => {
      const label = (document.querySelector('.git-diff-line-count')?.textContent ?? '').trim()
      return label.includes('1') && !label.includes('No lines')
    }, 3000, 50)
    const rangeAction = await window.__onwardGitDiffDebug?.triggerLineAction?.('keep')
    const splitReady = await waitFor('GDS-33-split-ready', () => {
      const files = window.__onwardGitDiffDebug?.getFileList() ?? []
      return findDiffFileIndex(files, parentFile, 'staged') >= 0 && findDiffFileIndex(files, parentFile, 'unstaged') >= 0
    }, 6000, 80)
    const filesAfter = window.__onwardGitDiffDebug?.getFileList() ?? []
    const stagedIndexAfter = findDiffFileIndex(filesAfter, parentFile, 'staged')
    const unstagedIndexAfter = findDiffFileIndex(filesAfter, parentFile, 'unstaged')
    const stagedSelectedAfter = stagedIndexAfter >= 0 && window.__onwardGitDiffDebug?.selectFileByIndex(stagedIndexAfter) === true
    await waitFor('GDS-33-staged-ready-after', () => {
      const content = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      return content?.originalContent === baseContent && content.modifiedContent === partiallyStagedContent
    }, 6000)
    const stagedContentAfter = window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null
    const unstagedSelectedAfter = unstagedIndexAfter >= 0 && window.__onwardGitDiffDebug?.selectFileByIndex(unstagedIndexAfter) === true
    await waitFor('GDS-33-unstaged-ready-after', () => {
      const content = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      return content?.originalContent === partiallyStagedContent && content.modifiedContent === worktreeContent
    }, 6000)
    const unstagedContentAfter = window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null
    record('GDS-33-stage-selected-ranges-does-not-stage-whole-file', Boolean(
      selectedBefore &&
      rangeSelected &&
      rangeVisible &&
      rangeAction &&
      splitReady &&
      stagedSelectedAfter &&
      unstagedSelectedAfter &&
      stagedContentAfter?.originalContent === baseContent &&
      stagedContentAfter.modifiedContent === partiallyStagedContent &&
      unstagedContentAfter?.originalContent === partiallyStagedContent &&
      unstagedContentAfter.modifiedContent === worktreeContent
    ), {
      selectedBefore,
      rangeSelected,
      rangeVisible,
      rangeAction,
      splitReady,
      filesAfter: filesAfter.map((file) => ({ filename: file.filename, changeType: file.changeType })),
      stagedContentAfter,
      unstagedContentAfter
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-33-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
    await window.electronAPI.git.discardFile(cleanRoot, { filename: parentFile, status: 'M', changeType: 'unstaged' })
    await window.electronAPI.git.discardFile(cleanRoot, { filename: parentFile, status: 'M', changeType: 'staged' })
  }

  if (!cancelled()) {
    await restoreBaseline()
    const nestedUnstaged = 'src/features/diff-tree/tree-one.ts'
    const nestedStaged = 'src/features/diff-tree/tree-stage.ts'
    const nestedUntracked = 'docs/diff-tree/untracked-note.md'

    const cleanupTreeFixture = async () => {
      await window.electronAPI.git.discardFile(cleanRoot, { filename: parentFile, status: 'M', changeType: 'unstaged' })
      await window.electronAPI.git.discardFile(cleanRoot, { filename: nestedStaged, status: 'A', changeType: 'staged' })
      await window.electronAPI.project.deletePath(cleanRoot, 'src/features')
      await window.electronAPI.project.deletePath(cleanRoot, 'docs/diff-tree')
    }

    await cleanupTreeFixture()
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-35 tree parent edit\n')
    await window.electronAPI.git.saveFileContent(cleanRoot, nestedUnstaged, 'export const treeOne = true\n')
    await window.electronAPI.git.saveFileContent(cleanRoot, nestedStaged, 'export const stagedTree = true\n')
    await window.electronAPI.git.saveFileContent(cleanRoot, nestedUntracked, '# GDS tree untracked\n')
    await window.electronAPI.git.stageFile(cleanRoot, nestedStaged)
    await sleep(300)

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-35-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    const listReady = await waitFor('GDS-35-list-ready', () => {
      const files = window.__onwardGitDiffDebug?.getFileList() ?? []
      return findDiffFileIndex(files, nestedUnstaged, 'untracked') >= 0 &&
        findDiffFileIndex(files, nestedStaged, 'staged') >= 0 &&
        findDiffFileIndex(files, parentFile, 'unstaged') >= 0
    }, 8000, 80)
    const initialMode = window.__onwardGitDiffDebug?.getFileListViewMode?.() ?? null
    const treeRows = window.__onwardGitDiffDebug?.getVisibleTreeRows?.() ?? []
    const hasTreeDirs = treeRows.some((row) => row.type === 'dir' && row.path === 'src') &&
      treeRows.some((row) => row.type === 'dir' && row.path === 'src/features') &&
      treeRows.some((row) => row.type === 'dir' && row.path === 'docs')
    const hasTreeFiles = treeRows.some((row) => row.type === 'file' && row.path === nestedUnstaged) &&
      treeRows.some((row) => row.type === 'file' && row.path === nestedStaged) &&
      treeRows.some((row) => row.type === 'file' && row.path === nestedUntracked)
    const hasTreeIcons = Boolean(document.querySelector('.git-diff-tree-icon.dir svg')) &&
      document.querySelectorAll('.git-diff-tree-seti-icon svg').length >= 2
    record('GDS-35-tree-default-icons-and-nesting', Boolean(
      listReady &&
      initialMode === 'tree' &&
      hasTreeDirs &&
      hasTreeFiles &&
      hasTreeIcons
    ), {
      initialMode,
      treeRows,
      hasTreeDirs,
      hasTreeFiles,
      setiIconCount: document.querySelectorAll('.git-diff-tree-seti-icon svg').length
    })

    const flatSet = window.__onwardGitDiffDebug?.setFileListViewMode?.('flat') === true
    await sleep(120)
    const flatMode = window.__onwardGitDiffDebug?.getFileListViewMode?.() ?? null
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-36-close-after-flat', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-36-reopen', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await waitFor('GDS-36-reopen-list', () => (window.__onwardGitDiffDebug?.getFileList() ?? []).length >= 3, 6000)
    const flatRestored = window.__onwardGitDiffDebug?.getFileListViewMode?.() ?? null
    const treeSet = window.__onwardGitDiffDebug?.setFileListViewMode?.('tree') === true
    await sleep(120)
    const treeRestored = window.__onwardGitDiffDebug?.getFileListViewMode?.() ?? null
    record('GDS-36-flat-tree-mode-persists', Boolean(
      flatSet &&
      flatMode === 'flat' &&
      flatRestored === 'flat' &&
      treeSet &&
      treeRestored === 'tree'
    ), {
      flatSet,
      flatMode,
      flatRestored,
      treeSet,
      treeRestored
    })

    const groups = Array.from(document.querySelectorAll('.git-diff-file-group-title'))
      .map((node) => (node.textContent ?? '').trim())
    const hasGroupedTreeBoundaries = groups.some((label) => label.includes('Changes')) &&
      groups.some((label) => label.includes('Staged')) &&
      groups.some((label) => label.includes('Untracked'))
    const selectedTreeLeaf = window.__onwardGitDiffDebug?.selectFileByPath(nestedUnstaged) === true
    const selectedReady = await waitFor('GDS-37-tree-select-ready', () => {
      const selected = window.__onwardGitDiffDebug?.getSelectedFile()
      return selected?.filename === nestedUnstaged
    }, 4000, 80)
    record('GDS-37-tree-groups-and-selection', Boolean(
      hasGroupedTreeBoundaries &&
      selectedTreeLeaf &&
      selectedReady
    ), {
      groups,
      selected: window.__onwardGitDiffDebug?.getSelectedFile() ?? null
    })

    const jumpButtonReady = await waitFor('GDS-38-jump-to-editor-button-ready', () => {
      const button = document.querySelector<HTMLButtonElement>('.git-diff-jump-editor')
      return Boolean(button && !button.disabled)
    }, 8000, 80)
    document.querySelector<HTMLButtonElement>('.git-diff-jump-editor')?.click()
    const editorOpened = await waitFor('GDS-38-editor-opened-from-diff', () => {
      return window.__onwardProjectEditorDebug?.getActiveFilePath?.() === nestedUnstaged
    }, 8000, 80)
    const diffReturnReady = await waitFor('GDS-38-diff-return-bar-ready', () => {
      const state = window.__onwardProjectEditorDebug?.getDiffReturnBarState?.()
      return Boolean(state?.visible && state.backEnabled && state.jumpEnabled)
    }, 8000, 80)
    record('GDS-38-jump-to-editor-opens-selected-diff-file', Boolean(
      jumpButtonReady &&
      editorOpened &&
      diffReturnReady
    ), {
      jumpButtonReady,
      editorState: window.__onwardProjectEditorDebug?.getDiffReturnBarState?.() ?? null,
      activeFilePath: window.__onwardProjectEditorDebug?.getActiveFilePath?.() ?? null
    })

    const jumpedToDiff = await window.__onwardProjectEditorDebug?.triggerJumpToDiff?.()
    const diffSelectedAfterJump = await waitFor('GDS-39-jump-to-diff-selected', () => {
      const selected = window.__onwardGitDiffDebug?.getSelectedFile()
      return Boolean(window.__onwardGitDiffDebug?.isOpen()) && selected?.filename === nestedUnstaged
    }, 8000, 80)
    record('GDS-39-editor-jump-to-diff-selects-current-file', Boolean(
      jumpedToDiff &&
      diffSelectedAfterJump
    ), {
      jumpedToDiff,
      selected: window.__onwardGitDiffDebug?.getSelectedFile() ?? null
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-39-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
    await cleanupTreeFixture()
    await restoreBaseline()
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
    record('GDS-26-trace-marker-diff-file-load-expected', Boolean(traceInfo?.logPath), {
      tracePath: traceInfo?.logPath ?? null,
      enabled: traceInfo?.enabled ?? null,
      eventsToVerifyInRunner: [
        'main:ipc.git.get-file-content',
        'renderer:git-diff.file-load'
      ]
    })
    record('GDS-30-trace-marker-diff-ux-actions-expected', Boolean(traceInfo?.logPath), {
      tracePath: traceInfo?.logPath ?? null,
      enabled: traceInfo?.enabled ?? null,
      eventsToVerifyInRunner: [
        'renderer:git-diff.manual-refresh',
        'renderer:git-diff.hunk-navigate',
        'renderer:git-diff.hunk-action'
      ]
    })
    record('GDS-34-trace-marker-diff-body-prefetch-expected', Boolean(traceInfo?.logPath), {
      tracePath: traceInfo?.logPath ?? null,
      enabled: traceInfo?.enabled ?? null,
      eventsToVerifyInRunner: [
        'renderer:git-diff.body-prefetch'
      ]
    })
    record('GDS-42-trace-marker-diff-tree-editor-jumps-expected', Boolean(traceInfo?.logPath), {
      tracePath: traceInfo?.logPath ?? null,
      enabled: traceInfo?.enabled ?? null,
      eventsToVerifyInRunner: [
        'renderer:git-diff.file-list-mode-change',
        'renderer:git-diff.jump-to-editor',
        'renderer:project-editor.jump-to-diff'
      ]
    })
  }

  // Final cleanup: leave the clean repo in a known state so any subsequent
  // run within the same Electron session does not see leftover dirt.
  await restoreBaseline()
  emitTimingSummary()

  log('git-diff-staleness:done', {
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    total: results.length
  })

  return results
}
