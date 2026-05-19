/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git State Mirror functional gate suite.
 *
 * The suite deliberately gates on observable behaviour, not absolute
 * wall-clock latency. Every cwd switch or filesystem mutation must reach the
 * expected Task header state within a generous timeout. The measured timings
 * are still recorded in assertion detail so traces and CI logs can show
 * regression trends without failing on a busy developer machine.
 */

import type { AutotestContext, TestResult } from './types'
import type { GitStateMirrorSnapshot } from '../types/electron'
import {
  loadMirrorFixtureManifest,
  resolveFixtureRepo,
  captureColorClass,
  captureBranchText,
  captureCwdTitle,
  mutate,
  pushOscCwd,
  getMirror
} from './probe-utils'

type MirrorColour = 'clean' | 'modified' | 'added' | 'unknown'

interface ExpectedHeaderState {
  branch: string | null
  colour: MirrorColour | null
  cwd: string
}

function summarizeMirror(snapshot: unknown | null): Record<string, unknown> | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const typed = snapshot as Partial<GitStateMirrorSnapshot>
  return {
    cwd: typed.cwd ?? null,
    repoRoot: typed.repoRoot ?? null,
    repoName: typed.repoName ?? null,
    branch: typed.branch ?? null,
    status: typed.status ?? null,
    fileCount: Array.isArray(typed.files) ? typed.files.length : null,
    capturedAt: typed.capturedAt ?? null,
    generation: typed.generation ?? null
  }
}

function normalizePathForAssert(value: string | null): string | null {
  if (!value) return value
  let normalized = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (normalized.startsWith('/private/')) normalized = normalized.slice('/private'.length)
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

export async function testGitStateMirrorLatency(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []

  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const observedHeader = () => ({
    branch: captureBranchText(terminalId),
    colour: captureColorClass(terminalId),
    cwd: captureCwdTitle(terminalId)
  })

  const waitForHeaderState = async (
    id: string,
    cwd: string,
    expected: ExpectedHeaderState,
    description: string
  ): Promise<boolean> => {
    if (cancelled()) return false
    const startedAt = performance.now()
    await pushOscCwd(terminalId, cwd)
    const ok = await waitFor(`${id}-header`, () => {
      const observed = observedHeader()
      const branchOk = expected.branch === null
        ? observed.branch === null
        : observed.branch === expected.branch
      const colourOk = expected.colour === null || expected.colour === 'unknown'
        ? observed.colour === null || observed.colour === 'unknown'
        : observed.colour === expected.colour
      const cwdOk = normalizePathForAssert(observed.cwd) === normalizePathForAssert(expected.cwd)
      return branchOk && colourOk && cwdOk
    }, 5000, 20)
    const elapsedMs = Math.round(performance.now() - startedAt)
    const mirror = await getMirror(cwd).catch(() => null)
    record(id, ok, {
      description,
      expected,
      observed: observedHeader(),
      mirror: summarizeMirror(mirror),
      perf: { elapsedMs, hardTimeoutMs: 5000 }
    })
    return ok
  }

  const waitForMirrorStatus = async (
    cwd: string,
    expectedStatus: MirrorColour,
    timeoutMs = 5000
  ): Promise<unknown | null> => {
    const start = performance.now()
    while (performance.now() - start < timeoutMs) {
      if (cancelled()) return null
      const snapshot = await getMirror(cwd)
      const status = (snapshot as Partial<GitStateMirrorSnapshot> | null)?.status ?? null
      if (status === expectedStatus) return snapshot
      await sleep(50)
    }
    return null
  }

  const waitForMirrorGenerationAbove = async (
    cwd: string,
    generation: number,
    timeoutMs = 5000
  ): Promise<unknown | null> => {
    const start = performance.now()
    while (performance.now() - start < timeoutMs) {
      if (cancelled()) return null
      const snapshot = await getMirror(cwd)
      const nextGeneration = (snapshot as Partial<GitStateMirrorSnapshot> | null)?.generation ?? 0
      if (nextGeneration > generation) return snapshot
      await sleep(50)
    }
    return null
  }

  log('git-state-mirror-latency:start', { terminalId })

  const manifest = await loadMirrorFixtureManifest()
  if (!manifest) {
    record('GSM-00-fixture-loaded', false, { reason: 'manifest absent or unparseable' })
    return results
  }

  const repoA = resolveFixtureRepo(manifest, 'repo-A')
  const repoB = resolveFixtureRepo(manifest, 'repo-B')
  const repoModified = resolveFixtureRepo(manifest, 'repo-modified')
  const repoUntracked = resolveFixtureRepo(manifest, 'repo-untracked')
  const repoMixed = resolveFixtureRepo(manifest, 'repo-mixed')
  const nonGitDir = resolveFixtureRepo(manifest, 'non-git-dir')
  const allResolved = repoA && repoB && repoModified && repoUntracked && repoMixed && nonGitDir

  record('GSM-00-fixture-loaded', Boolean(allResolved), {
    tempRoot: manifest.tempRoot,
    repoCount: manifest.repos.length,
    missing: [
      !repoA && 'repo-A',
      !repoB && 'repo-B',
      !repoModified && 'repo-modified',
      !repoUntracked && 'repo-untracked',
      !repoMixed && 'repo-mixed',
      !nonGitDir && 'non-git-dir'
    ].filter(Boolean)
  })
  if (!allResolved) return results

  const watcherErrors: Array<{ cwd: string; message: string; at: number }> = []
  const disposeWatcherError = window.electronAPI.git.onMirrorWatcherError?.((cwd, message) => {
    watcherErrors.push({ cwd, message, at: performance.now() })
  })

  await waitForHeaderState('GSM-01-repo-a-clean-header', repoA.abs, {
    branch: repoA.entry.branch,
    colour: 'clean',
    cwd: repoA.abs
  }, 'Task header shows repo-A path, branch, and clean status')

  await waitForHeaderState('GSM-02-warm-cd-repo-b-clean-header', repoB.abs, {
    branch: repoB.entry.branch,
    colour: 'clean',
    cwd: repoB.abs
  }, 'Warm cwd switch updates branch and keeps clean status')

  await waitForHeaderState('GSM-03-modified-status-header', repoModified.abs, {
    branch: repoModified.entry.branch,
    colour: 'modified',
    cwd: repoModified.abs
  }, 'Modified tracked file maps to the modified colour bucket')

  await waitForHeaderState('GSM-04-untracked-status-header', repoUntracked.abs, {
    branch: repoUntracked.entry.branch,
    colour: 'added',
    cwd: repoUntracked.abs
  }, 'Untracked file maps to the added colour bucket')

  await waitForHeaderState('GSM-05-added-wins-over-modified', repoMixed.abs, {
    branch: repoMixed.entry.branch,
    colour: 'added',
    cwd: repoMixed.abs
  }, 'Added wins when staged or untracked changes coexist with modified files')

  await waitForHeaderState('GSM-06-non-git-hides-chip-keeps-cwd', nonGitDir.abs, {
    branch: null,
    colour: 'unknown',
    cwd: nonGitDir.abs
  }, 'Non-git cwd keeps the path visible and hides the Git chip')

  if (!cancelled()) {
    const beforeErrorCount = watcherErrors.length
    for (let trial = 0; trial < 5; trial += 1) {
      const filename = `gsm-06b-non-git-churn-${trial}.txt`
      await mutate.createUntrackedFile(nonGitDir.abs, filename, `non-git churn ${trial}\n`)
      await mutate.deleteFile(nonGitDir.abs, filename)
    }
    await sleep(250)
    const nonGitErrors = watcherErrors
      .slice(beforeErrorCount)
      .filter((error) => normalizePathForAssert(error.cwd) === normalizePathForAssert(nonGitDir.abs))
    record('GSM-06b-non-git-cwd-does-not-surface-watcher-error', nonGitErrors.length === 0, {
      description: 'Non-git cwd must not arm a filesystem watcher or surface watcher-error noise',
      cwd: nonGitDir.abs,
      watcherErrors: nonGitErrors
    })
  }

  await waitForHeaderState('GSM-07-non-git-to-repo-restores-chip', repoA.abs, {
    branch: repoA.entry.branch,
    colour: 'clean',
    cwd: repoA.abs
  }, 'Returning from non-git cwd restores the repo chip')

  if (!cancelled()) {
    await waitForHeaderState('GSM-08a-active-repo-clean-before-untracked', repoA.abs, {
      branch: repoA.entry.branch,
      colour: 'clean',
      cwd: repoA.abs
    }, 'Precondition for untracked watcher transition')

    const startedAt = performance.now()
    await mutate.createUntrackedFile(repoA.abs, 'gsm-08-untracked.txt', 'created by GSM-08\n')
    const ok = await waitFor('GSM-08-untracked-watch-flip', () => captureColorClass(terminalId) === 'added', 5000, 20)
    const mirror = await waitForMirrorStatus(repoA.abs, 'added')
    record('GSM-08-untracked-file-flips-clean-to-added', ok && Boolean(mirror), {
      description: 'Worker watcher updates the Task chip when an untracked file appears',
      observed: observedHeader(),
      mirror: summarizeMirror(mirror),
      perf: { elapsedMs: Math.round(performance.now() - startedAt), hardTimeoutMs: 5000 }
    })

    const deleteResult = await window.electronAPI.project.deletePath(repoA.abs, 'gsm-08-untracked.txt').catch((error) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }))
    await pushOscCwd(terminalId, repoA.abs)
    const restored = await waitFor('GSM-08-clean-restored', () => captureColorClass(terminalId) === 'clean', 5000, 20)
    record('GSM-08b-clean-restored-after-untracked-delete', restored, {
      deleteResult,
      observed: observedHeader(),
      mirror: summarizeMirror(await waitForMirrorStatus(repoA.abs, 'clean'))
    })
  }

  if (!cancelled()) {
    await waitForHeaderState('GSM-09a-active-repo-b-clean-before-edit', repoB.abs, {
      branch: repoB.entry.branch,
      colour: 'clean',
      cwd: repoB.abs
    }, 'Precondition for tracked-file watcher transition')

    const startedAt = performance.now()
    await mutate.modifyFile(repoB.abs, 'app.ts', 'export const REPO = "B-modified-by-GSM-09"\n')
    const ok = await waitFor('GSM-09-modified-watch-flip', () => captureColorClass(terminalId) === 'modified', 5000, 20)
    const mirror = await waitForMirrorStatus(repoB.abs, 'modified')
    record('GSM-09-tracked-file-flips-clean-to-modified', ok && Boolean(mirror), {
      description: 'Worker watcher updates the Task chip when a tracked file changes',
      observed: observedHeader(),
      mirror: summarizeMirror(mirror),
      perf: { elapsedMs: Math.round(performance.now() - startedAt), hardTimeoutMs: 5000 }
    })

    await mutate.modifyFile(repoB.abs, 'app.ts', 'export const REPO = "B"\n')
    const restored = await waitFor('GSM-09-clean-restored', () => captureColorClass(terminalId) === 'clean', 5000, 20)
    record('GSM-09b-clean-restored-after-tracked-edit', restored, {
      observed: observedHeader(),
      mirror: summarizeMirror(await waitForMirrorStatus(repoB.abs, 'clean'))
    })
  }

  await waitForHeaderState('GSM-10-trailing-slash-cwd-canonicalized', `${repoA.abs}/`, {
    branch: repoA.entry.branch,
    colour: 'clean',
    cwd: repoA.abs
  }, 'Renderer lookup canonicalizes trailing separators')

  if (!cancelled()) {
    const startedAt = performance.now()
    const observedBranches = new Set<string>()
    for (const cwd of [repoB.abs, repoModified.abs, repoUntracked.abs, repoMixed.abs, repoA.abs]) {
      await pushOscCwd(terminalId, cwd)
      const branch = captureBranchText(terminalId)
      if (branch) observedBranches.add(branch)
    }
    const settled = await waitFor('GSM-11-burst-final-state', () => {
      const branch = captureBranchText(terminalId)
      const colour = captureColorClass(terminalId)
      if (branch) observedBranches.add(branch)
      return branch === repoA.entry.branch && colour === 'clean'
    }, 5000, 20)
    record('GSM-11-cd-burst-settles-on-final-cwd', settled, {
      description: 'Five rapid cwd pushes must settle on the last repo without stale final state',
      observed: observedHeader(),
      distinctBranchesObserved: Array.from(observedBranches),
      perf: { elapsedMs: Math.round(performance.now() - startedAt), hardTimeoutMs: 5000 }
    })
  }

  if (!cancelled()) {
    const mirror = await waitForMirrorStatus(repoMixed.abs, 'added')
    const typed = mirror as Partial<GitStateMirrorSnapshot> | null
    record('GSM-12-mirror-snapshot-exposes-file-list', Boolean(
      typed &&
      typed.branch === repoMixed.entry.branch &&
      typed.status === 'added' &&
      Array.isArray(typed.files) &&
      typed.files.length >= 2
    ), {
      description: 'Mirror snapshot carries branch, status, and changed-file list for downstream Diff reuse',
      mirror: summarizeMirror(mirror),
      files: typed?.files?.map((f) => f.filename) ?? null
    })
  }

  if (!cancelled()) {
    await pushOscCwd(terminalId, repoA.abs)
    const before = await waitForMirrorStatus(repoA.abs, 'clean')
    const beforeGeneration = (before as Partial<GitStateMirrorSnapshot> | null)?.generation ?? 0
    const refreshOk = await window.electronAPI.git.forceRefresh(repoA.abs).catch(() => false)
    const after = refreshOk ? await waitForMirrorGenerationAbove(repoA.abs, beforeGeneration) : null
    const afterGeneration = (after as Partial<GitStateMirrorSnapshot> | null)?.generation ?? 0
    record('GSM-14-force-refresh-bumps-generation', Boolean(refreshOk && after && afterGeneration > beforeGeneration), {
      description: 'Manual refresh must bump Mirror generation even when branch/status/files are unchanged',
      before: summarizeMirror(before),
      after: summarizeMirror(after)
    })
  }

  if (!cancelled()) {
    const traceInfo = await window.electronAPI.debug.getPerfTraceInfo()
    record('GSM-13-trace-marker-mirror-events-expected', Boolean(traceInfo?.logPath), {
      tracePath: traceInfo?.logPath ?? null,
      enabled: traceInfo?.enabled ?? null,
      eventsToVerify: [
        'renderer:terminal.osc-cwd-detected',
        'main:git-state-mirror.cwd-switched',
        'worker:git-state-mirror.recompute-status-done',
        'main:git-state-mirror.fanout',
        'renderer:terminal-title.branch-rendered',
        'renderer:terminal-title.color-rendered'
      ]
    })
  }

  log('git-state-mirror-latency:done', {
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    total: results.length
  })

  disposeWatcherError?.()

  return results
}
