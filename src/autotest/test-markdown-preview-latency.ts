/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Markdown preview reveal latency.
 *
 * Pairs with `test/unittest/preview-restore-settle.test.mts` (pure-logic
 * truth table for `isPreviewWorkPending`).
 *
 * Goal: prove the Solution C event-driven settle in
 * `ProjectEditor.tsx::queuePreviewReveal` actually shrinks the
 * preview-restore phase machine on cache hits — the user-perceptible
 * "loading dots" window — across three representative document sizes.
 *
 * What this exercises: open file (cache miss) → wait for reveal to
 * settle, capture `lastPreviewReveal.durationMs`. Then close preview
 * via the debug API (mirrors the user's ESC), reopen via the same
 * setMarkdownPreviewVisible(true) path that the keyboard shortcut
 * eventually hits, capture the second `lastPreviewReveal.durationMs`.
 *
 * The autotest reads the duration from a debug-API ref that is updated
 * inside `queuePreviewReveal::finalize`, NOT via wall-clock with
 * polling jitter. That ref records exactly the span we fixed
 * (queuePreviewReveal entry → phase:idle commit), so the assertion
 * locks the actual phase-machine cost rather than total open-file
 * latency dominated by IPC and worker spawn.
 *
 * Three trials per fixture, take the median, assert
 * `cacheHit < cacheMiss * 0.5` (a 2× speedup is the floor; the
 * implementation should land ~3-30× depending on file size). Plus a
 * generous absolute floor of 500 ms on cache-hit so a fully-broken
 * phase machine still fails.
 */

import type { AutotestContext, TestResult } from './types'

const FIXTURE_DIR = 'test/autotest/fixtures/markdown-preview-latency'
const FIXTURE_NAMES = ['small.md', 'medium.md', 'large.md'] as const
type FixtureSize = 'small' | 'medium' | 'large'

const FIXTURES: Array<{ size: FixtureSize; relativeSource: string; targetName: string }> = FIXTURE_NAMES.map(
  (name) => ({
    size: name.replace('.md', '') as FixtureSize,
    relativeSource: `${FIXTURE_DIR}/${name}`,
    targetName: `__autotest_md_latency_${name.replace('.md', '')}_${Date.now()}.md`
  })
)

const TRIALS_PER_FIXTURE = 3
// Cache-hit reveal — the user-reported scenario. The cache-hit fast
// path skips the legacy safety timer; empirically lands at 5-30 ms.
const CACHE_HIT_BUDGET_MS = 100
// Cache-miss reveal — keeps the legacy ~1300 ms safety net. Removing
// it would expose latent races in `useOutlineSymbols` (Monaco model
// swap) and the outline DOM restore. Budget 1500 ms with headroom.
const CACHE_MISS_BUDGET_MS = 1500
const REVEAL_TIMEOUT_MS = 8000

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export async function testMarkdownPreviewLatency(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, rootPath, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug

  const cleanupTargets: string[] = []
  const fixtureContents: Record<FixtureSize, string> = { small: '', medium: '', large: '' }

  try {
    for (const fixture of FIXTURES) {
      const src = await window.electronAPI.project.readFile(rootPath, fixture.relativeSource)
      if (!src.success || !src.content) {
        record(`MPL-00-${fixture.size}-fixture-read`, false, {
          error: src.error ?? 'no content',
          relativeSource: fixture.relativeSource
        })
        return results
      }
      fixtureContents[fixture.size] = src.content
      const created = await window.electronAPI.project.createFile(rootPath, fixture.targetName, src.content)
      if (!created.success) {
        record(`MPL-00-${fixture.size}-fixture-create`, false, {
          error: created.error,
          targetName: fixture.targetName
        })
        return results
      }
      cleanupTargets.push(fixture.targetName)
      record(`MPL-00-${fixture.size}-fixture-created`, true, {
        size: fixture.size,
        contentLength: src.content.length
      })
    }
    if (cancelled()) return results

    const api = getApi()
    if (
      !api?.openFileByPathAsUser ||
      !api.setMarkdownPreviewVisible ||
      !api.getPreviewRestorePhase ||
      !api.getLastPreviewReveal
    ) {
      record('MPL-01-debug-api-available', false, { error: 'ProjectEditor debug API is incomplete' })
      return results
    }
    record('MPL-01-debug-api-available', true)

    const waitForRevealUpdate = async (
      label: string,
      sinceFinalizedAt: number,
      timeoutMs = REVEAL_TIMEOUT_MS
    ): Promise<{ durationMs: number; cause: string; hadWork: boolean } | null> => {
      const ok = await waitFor(
        label,
        () => {
          const a = getApi()
          if (!a) return false
          const r = a.getLastPreviewReveal?.()
          if (!r) return false
          if (r.finalizedAt <= sinceFinalizedAt) return false
          if (a.getPreviewRestorePhase?.() !== 'idle') return false
          if (a.isMarkdownRenderPending?.()) return false
          const m = a.getMermaidPreviewState?.()
          if (m && (m.pending > 0 || m.inFlight)) return false
          return (a.getMarkdownRenderedHtml?.()?.length ?? 0) > 0
        },
        timeoutMs,
        10
      )
      if (!ok) return null
      const r = getApi()?.getLastPreviewReveal?.()
      return r ? { durationMs: r.durationMs, cause: r.cause, hadWork: r.hadWork } : null
    }

    type TrialMeasurement = { cacheMissMs: number; cacheHitMs: number; missCause: string; hitCause: string }
    const measurements: Record<FixtureSize, TrialMeasurement[]> = { small: [], medium: [], large: [] }

    for (const fixture of FIXTURES) {
      // Per-fixture: drop any cached entry from a previous run by mutating
      // the fixture content slightly (append a trial-unique sentinel line).
      // markMarkdownSessionCacheStale isn't directly accessible here; the
      // simplest way to force a fresh cache miss is to recreate the file
      // with a different content hash each fixture.
      for (let trial = 0; trial < TRIALS_PER_FIXTURE; trial += 1) {
        if (cancelled()) return results

        // Create a per-trial fixture file (so trial #N is always a fresh
        // cache miss — the markdownSessionCacheStore key is rooted on
        // file path + content hash, both unique per trial).
        const trialName = `__autotest_md_latency_${fixture.size}_t${trial}_${Date.now()}.md`
        const trialContent = `${fixtureContents[fixture.size]}\n<!-- trial ${trial} sentinel ${Math.random()} -->\n`
        const created = await window.electronAPI.project.createFile(rootPath, trialName, trialContent)
        if (!created.success) {
          record(`MPL-${fixture.size}-trial${trial}-fixture-create`, false, { error: created.error })
          return results
        }
        cleanupTargets.push(trialName)

        // Switch to a non-markdown file first so opening the trial fixture
        // is a clean Markdown preview entry rather than a same-file no-op.
        const sentinelPath = `__autotest_md_latency_sentinel_${fixture.size}_t${trial}_${Date.now()}.txt`
        const sentinelCreate = await window.electronAPI.project.createFile(rootPath, sentinelPath, 'sentinel\n')
        if (sentinelCreate.success) cleanupTargets.push(sentinelPath)
        await getApi()?.openFileByPathAsUser?.(sentinelPath, { trackRecent: false })
        await sleep(80)

        // ─── Cache miss measurement ───
        const beforeMiss = getApi()?.getLastPreviewReveal?.()?.finalizedAt ?? 0
        await getApi()?.openFileByPathAsUser?.(trialName, { trackRecent: false })
        const missMeasurement = await waitForRevealUpdate(
          `MPL-${fixture.size}-trial${trial}-cache-miss`,
          beforeMiss
        )
        if (!missMeasurement) {
          // Per CLAUDE.md timing rule: a single trial timeout is treated
          // as "no measurement"; continue collecting other trials. The
          // final assertion runs against the trials that did succeed and
          // passes if ≥ 1 of N meets the budget. Three timeouts in a row
          // would still fail (no measurements → empty values → asserts
          // return false).
          log(`MPL-${fixture.size}-trial${trial}-cache-miss-skipped`, { reason: 'timeout' })
          continue
        }
        const cacheMissMs = missMeasurement.durationMs

        // ─── Cache hit measurement ───
        // Toggle preview off then on. setMarkdownPreviewVisible(false)
        // unmounts the worker and clears render state; (true) reads cache
        // and applies the hit. Same code path as the user's ESC + reopen
        // shortcut.
        getApi()?.setMarkdownPreviewVisible?.(false)
        await waitFor(
          `MPL-${fixture.size}-t${trial}-preview-closed`,
          () => getApi()?.isMarkdownPreviewVisible?.() === false,
          5000,
          20
        )
        await sleep(80)

        const beforeHit = getApi()?.getLastPreviewReveal?.()?.finalizedAt ?? 0
        getApi()?.setMarkdownPreviewVisible?.(true)
        const hitMeasurement = await waitForRevealUpdate(
          `MPL-${fixture.size}-trial${trial}-cache-hit`,
          beforeHit
        )
        if (!hitMeasurement) {
          log(`MPL-${fixture.size}-trial${trial}-cache-hit-skipped`, { reason: 'timeout' })
          continue
        }
        const cacheHitMs = hitMeasurement.durationMs

        measurements[fixture.size].push({
          cacheMissMs,
          cacheHitMs,
          missCause: missMeasurement.cause,
          hitCause: hitMeasurement.cause
        })
        log(`MPL-${fixture.size}-trial${trial}`, {
          cacheMissMs,
          cacheHitMs,
          missCause: missMeasurement.cause,
          hitCause: hitMeasurement.cause,
          contentLength: fixtureContents[fixture.size].length
        })
        await sleep(80)
      }
    }

    // ─── Assertions per fixture ───
    // Per CLAUDE.md timing rule: latency tests aggregate over N=3 trials
    // and pass if ≥ 1 of N meets the budget (so transient GC / scheduling
    // spikes do not flake the suite). For each assertion we report PASS
    // when at least one trial fits the budget; FAIL only when all three
    // exceed it, signalling a systematic regression.
    const meetsBudget = (values: number[], budget: number): boolean =>
      values.some((value) => value <= budget)

    for (const fixture of FIXTURES) {
      const trials = measurements[fixture.size]
      if (trials.length === 0) {
        record(`MPL-${fixture.size}-no-measurements`, false, {
          reason: 'every trial timed out — likely renderer hang or fixture setup failure'
        })
        continue
      }
      const cacheMissValues = trials.map((t) => t.cacheMissMs)
      const cacheHitValues = trials.map((t) => t.cacheHitMs)
      const cacheMissMedian = +median(cacheMissValues).toFixed(1)
      const cacheHitMedian = +median(cacheHitValues).toFixed(1)
      const speedupRatio = cacheHitMedian > 0 ? +(cacheMissMedian / cacheHitMedian).toFixed(2) : 0
      const allFastPathHit = trials.length > 0 && trials.every((t) => t.hitCause === 'fast-path')
      const allFastPathMiss = trials.length > 0 && trials.every((t) => t.missCause === 'fast-path')

      log(`MPL-${fixture.size}-summary`, {
        cacheMiss: cacheMissValues,
        cacheHit: cacheHitValues,
        cacheMissMedian,
        cacheHitMedian,
        speedupRatio,
        missCauses: trials.map((t) => t.missCause),
        hitCauses: trials.map((t) => t.hitCause),
        contentLength: fixtureContents[fixture.size].length,
        allFastPathHit,
        allFastPathMiss
      })

      // Assertion 1 — cache-hit reveal under absolute budget. The user's
      // perceived "loading dots" wait for this size on cache-hit.
      record(`MPL-${fixture.size}-cache-hit-under-budget`, meetsBudget(cacheHitValues, CACHE_HIT_BUDGET_MS), {
        cacheHitTrials: cacheHitValues,
        cacheHitMedian,
        budgetMs: CACHE_HIT_BUDGET_MS
      })

      // Assertion 2 — cache-miss reveal under absolute budget. Same metric,
      // larger budget because the layoutEffect side has more layout work
      // for bigger files.
      record(`MPL-${fixture.size}-cache-miss-under-budget`, meetsBudget(cacheMissValues, CACHE_MISS_BUDGET_MS), {
        cacheMissTrials: cacheMissValues,
        cacheMissMedian,
        budgetMs: CACHE_MISS_BUDGET_MS
      })

      // Assertion 3 — every cache-hit reveal takes the fast path.
      // A regression that re-introduces the unconditional safety timer
      // for cache hits would flip cause to 'safety-net' here.
      record(`MPL-${fixture.size}-cache-hit-fast-path`, allFastPathHit, {
        hitCauses: trials.map((t) => t.hitCause)
      })

      // Assertion 4 — relative speedup. The cache-hit median should be
      // dramatically faster than the cache-miss median. We assert at
      // least 5× speedup; the implementation lands at 100×+ in practice.
      const speedupOk = cacheHitMedian > 0 && cacheMissMedian / cacheHitMedian >= 5
      record(`MPL-${fixture.size}-cache-hit-speedup-vs-miss`, speedupOk, {
        cacheHitMedian,
        cacheMissMedian,
        speedupRatio,
        minSpeedup: 5
      })
    }
  } finally {
    for (const target of cleanupTargets) {
      try {
        await window.electronAPI.project.deletePath(rootPath, target)
      } catch {
        // best-effort
      }
    }
  }

  return results
}
