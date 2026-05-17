/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * IBD (Identical-Blob-OID Diff) regression suite.
 *
 * The fixture (test/autotest/create-git-diff-identical-blob-fixture.mjs)
 * creates a git repo with two files (AGENTS.md, CLAUDE.md) sharing
 * BOTH the same HEAD blob OID AND the same working-tree blob OID, each
 * carrying 5 modified non-adjacent hunks. Under that fixture the pre-
 * Phase-4 codebase exhibited a race: clicking the second file (the one
 * the user inevitably ran into first if they followed alphabetical
 * order with CLAUDE.md last) would observe `widgetDomCount=0` instead
 * of the expected 5, because the setTimeout-based hunk widget install
 * raced with React's model swap.
 *
 * Phase 4 structurally eliminated the race by binding install onto
 * Monaco's `onDidUpdateDiff` event and removing the defensive
 * `maxLineCount` clamp inside `normalizeLineSide`. This suite is the
 * regression gate.
 *
 * Protocol per trial (N = 5 trials):
 *   1. Open Git Diff
 *   2. Verify file list is exactly [AGENTS.md, CLAUDE.md]
 *   3. Click CLAUDE.md (the second file alphabetically — matches the
 *      original user-reported flow)
 *   4. Wait for hunk widgets to settle, snapshot debug state
 *   5. Click AGENTS.md
 *   6. Wait for hunk widgets to settle, snapshot debug state
 *   7. Close Git Diff (so the next trial begins with a fresh
 *      DiffEditor mount, not a setValue cycle)
 *
 * Asserts (one IBD-* row per trial slot):
 *   - IBD-00: fixture loaded, file list shape correct
 *   - IBD-10..13: CLAUDE.md (first click) lineChanges=5, widgetDomCount=5
 *   - IBD-20..23: AGENTS.md (second click) lineChanges=5, widgetDomCount=5
 *
 * The N=5 aggregate is captured at the end so a flake on a single trial
 * fails the suite — see CLAUDE.md "Timing-sensitive autotest authoring"
 * (Boolean correctness: assert "all N succeeded" for race coverage).
 */

const TRIAL_COUNT = 5
const LOAD_TIMEOUT_MS = 15000
const WIDGET_SETTLE_TIMEOUT_MS = 8000
const EXPECTED_LINE_CHANGES = 5
const EXPECTED_WIDGET_DOM_COUNT = 5

export async function testGitDiffIdenticalBlob(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getGitDiffApi = () => window.__onwardGitDiffDebug

  log('git-diff-identical-blob:start', {
    suite: 'GitDiffIdenticalBlob',
    trialCount: TRIAL_COUNT,
    terminalId
  })

  // ---------------------------------------------------------------------
  // IBD-00: fixture sanity — open Git Diff, file list shape
  // ---------------------------------------------------------------------
  // Autotest mode auto-opens the Project Editor at startup; that makes
  // the TerminalGrid `hidden` so its `git-diff:open` listener early-
  // returns. Close all subpages first so our dispatch lands.
  try {
    window.__onwardTerminalDebug?.closeAllSubpages?.()
  } catch {
    /* test-debug API may be unavailable in some startup paths */
  }
  await sleep(120)

  window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
  // Poll for the GitDiffViewer debug API to register AND the file list
  // to be populated. We don't gate on `isOpen()` because the `isOpenRef`
  // refresh lags one render cycle behind the actual mount under
  // autotest mode — it's safer to wait directly for what we actually
  // need (a 2-element file list).
  const filesReady = await waitFor('IBD-00-files-ready', () => {
    const api = getGitDiffApi()
    if (!api) return false
    const list = api.getFileList?.() ?? []
    return list.length === 2
  }, LOAD_TIMEOUT_MS)
  if (!filesReady) {
    _assert('IBD-00-fixture-loaded', false, {
      reason: 'Git Diff file list did not populate to 2 entries',
      gotApi: Boolean(getGitDiffApi()),
      gotList: getGitDiffApi()?.getFileList?.()?.length ?? null
    })
    return results
  }
  const initialList = (getGitDiffApi()?.getFileList?.() ?? []).map((f) => f.filename).sort()
  _assert('IBD-00-fixture-loaded', initialList[0] === 'AGENTS.md' && initialList[1] === 'CLAUDE.md', {
    files: initialList
  })

  const claudeLineChangesByTrial: number[] = []
  const claudeWidgetDomByTrial: number[] = []
  const agentsLineChangesByTrial: number[] = []
  const agentsWidgetDomByTrial: number[] = []

  for (let trial = 0; trial < TRIAL_COUNT; trial += 1) {
    if (cancelled()) break

    // Open Git Diff fresh for every trial after the first one. This
    // gives a clean DiffEditor mount so each trial exercises the same
    // initial-paint code path the user runs into, not a setValue churn.
    if (trial > 0) {
      // Fire the same custom events the user-facing close + open take
      // (the TerminalGrid listens for these in its useEffect plumbing).
      window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId, restoreFocus: false } }))
      await sleep(160)
      window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
      const reopened = await waitFor(`IBD-trial-${trial}-reopened`, () => {
        const a = getGitDiffApi()
        if (!a) return false
        return (a.getFileList?.() ?? []).length === 2
      }, LOAD_TIMEOUT_MS)
      if (!reopened) {
        log('git-diff-identical-blob:trial-reopen-failed', { trial })
        break
      }
    }

    // Click CLAUDE.md first — matches the original user flow where the
    // second file in alphabetical order was the one that failed.
    const claudeApi = getGitDiffApi()
    const claudeClicked = claudeApi?.selectFileByPath?.('CLAUDE.md') === true
    if (!claudeClicked) {
      _assert(`IBD-1${trial}-claude-clicked`, false, { trial, reason: 'selectFileByPath returned false' })
      continue
    }
    // Brief settle window: the diff content prop change → Monaco model
    // remount → diff compute → onDidUpdateDiff → widget install pipeline
    // has multiple frame boundaries. Give it a fair shot before waitFor
    // starts polling so we observe the steady state, not a half-built
    // intermediate (the original setTimeout-retry was papering over the
    // same window with 720ms of retries; this is the same accommodation
    // but tied to a single deterministic wait instead of a retry loop).
    await sleep(250)
    const claudeSettled = await waitFor(`IBD-1${trial}-claude-widgets-settled`, () => {
      const api = getGitDiffApi()
      const state = api?.getHunkActionDebugState?.()
      if (!state) return false
      // Boolean correctness criterion: BOTH lineChanges and widgetDomCount
      // hit their expected values. Either short of 5 means the race
      // surfaced (or fixture is broken upstream).
      return state.lineChanges === EXPECTED_LINE_CHANGES && state.widgetDomCount === EXPECTED_WIDGET_DOM_COUNT
    }, WIDGET_SETTLE_TIMEOUT_MS)
    const claudeState = getGitDiffApi()?.getHunkActionDebugState?.() ?? null
    claudeLineChangesByTrial.push(claudeState?.lineChanges ?? -1)
    claudeWidgetDomByTrial.push(claudeState?.widgetDomCount ?? -1)
    _assert(`IBD-1${trial}-claude-first-click-widgets-installed`, claudeSettled, {
      trial,
      lineChanges: claudeState?.lineChanges ?? null,
      widgetDomCount: claudeState?.widgetDomCount ?? null,
      visibleWidgetDomCount: claudeState?.visibleWidgetDomCount ?? null,
      installRetryPending: claudeState?.installRetryPending ?? null
    })

    // Then click AGENTS.md and verify it ALSO installs cleanly. The
    // same-blob-OID race used to alternate which file failed; asserting
    // both ensures we catch either direction.
    const agentsApi = getGitDiffApi()
    const agentsClicked = agentsApi?.selectFileByPath?.('AGENTS.md') === true
    if (!agentsClicked) {
      _assert(`IBD-2${trial}-agents-clicked`, false, { trial, reason: 'selectFileByPath returned false' })
      continue
    }
    await sleep(250)
    const agentsSettled = await waitFor(`IBD-2${trial}-agents-widgets-settled`, () => {
      const api = getGitDiffApi()
      const state = api?.getHunkActionDebugState?.()
      if (!state) return false
      return state.lineChanges === EXPECTED_LINE_CHANGES && state.widgetDomCount === EXPECTED_WIDGET_DOM_COUNT
    }, WIDGET_SETTLE_TIMEOUT_MS)
    const agentsState = getGitDiffApi()?.getHunkActionDebugState?.() ?? null
    agentsLineChangesByTrial.push(agentsState?.lineChanges ?? -1)
    agentsWidgetDomByTrial.push(agentsState?.widgetDomCount ?? -1)
    _assert(`IBD-2${trial}-agents-second-click-widgets-installed`, agentsSettled, {
      trial,
      lineChanges: agentsState?.lineChanges ?? null,
      widgetDomCount: agentsState?.widgetDomCount ?? null,
      visibleWidgetDomCount: agentsState?.visibleWidgetDomCount ?? null,
      installRetryPending: agentsState?.installRetryPending ?? null
    })
  }

  // Aggregate-N assertion (per CLAUDE.md timing-sensitive autotest
  // authoring rule: Boolean correctness needs N trials, assert "all N
  // succeeded"). The per-trial detail above is the diagnostic; this is
  // the regression gate.
  _assert('IBD-30-claude-all-trials-line-changes', claudeLineChangesByTrial.every((n) => n === EXPECTED_LINE_CHANGES), {
    trials: claudeLineChangesByTrial,
    expected: EXPECTED_LINE_CHANGES
  })
  _assert('IBD-31-claude-all-trials-widgets-installed', claudeWidgetDomByTrial.every((n) => n === EXPECTED_WIDGET_DOM_COUNT), {
    trials: claudeWidgetDomByTrial,
    expected: EXPECTED_WIDGET_DOM_COUNT
  })
  _assert('IBD-40-agents-all-trials-line-changes', agentsLineChangesByTrial.every((n) => n === EXPECTED_LINE_CHANGES), {
    trials: agentsLineChangesByTrial,
    expected: EXPECTED_LINE_CHANGES
  })
  _assert('IBD-41-agents-all-trials-widgets-installed', agentsWidgetDomByTrial.every((n) => n === EXPECTED_WIDGET_DOM_COUNT), {
    trials: agentsWidgetDomByTrial,
    expected: EXPECTED_WIDGET_DOM_COUNT
  })

  log('git-diff-identical-blob:done', {
    trialCount: TRIAL_COUNT,
    claudeLineChangesByTrial,
    claudeWidgetDomByTrial,
    agentsLineChangesByTrial,
    agentsWidgetDomByTrial
  })

  return results
}
