/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'
import type { FeedbackDebugRemoteIssue } from '../types/feedback'

function queryElement<T extends Element>(selector: string): T | null {
  return document.querySelector(selector) as T | null
}

function queryElements<T extends Element>(selector: string): T[] {
  return Array.from(document.querySelectorAll(selector)) as T[]
}

function clickElement(element: HTMLElement | null): boolean {
  if (!element) {
    return false
  }
  element.click()
  return true
}

function setTextInputValue(element: HTMLInputElement | HTMLTextAreaElement | null, value: string): boolean {
  if (!element) {
    return false
  }
  element.focus()
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) {
    return false
  }
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

function setSelectValue(element: HTMLSelectElement | null, value: string): boolean {
  if (!element) {
    return false
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  if (!setter) {
    return false
  }
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

function queryHistoryItem(): HTMLDivElement | null {
  return queryElement<HTMLDivElement>('[data-testid="feedback-history-item"]')
}

function getHistoryStatus(): string | null {
  return queryHistoryItem()?.dataset.feedbackStatus ?? null
}

function getHistoryTitle(): string | null {
  return queryElement<HTMLElement>('[data-testid="feedback-history-title"]')?.textContent?.trim() ?? null
}

export async function testFeedbackUi(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const sidebarButtonSelector = '[data-testid="sidebar-feedback-button"]'
  const modalSelector = '[data-testid="feedback-modal"]'
  const submitButtonSelector = '[data-testid="feedback-submit-button"]'
  const historyRefreshSelector = '[data-testid="feedback-history-refresh"]'
  const formErrorSelector = '[data-testid="feedback-form-error"]'
  const submitNoticeSelector = '[data-testid="feedback-history-notice"], [data-testid="feedback-submit-notice"]'

  const openFeedbackModal = async () => {
    const button = queryElement<HTMLButtonElement>(sidebarButtonSelector)
    if (!button) {
      return { opened: false, elapsedMs: null as number | null }
    }
    const startedAt = performance.now()
    clickElement(button)
    const opened = await waitFor(
      'feedback-ui-open-modal',
      () => queryElement<HTMLElement>(modalSelector)?.dataset.feedbackOpen === 'true',
      4000,
      40
    )
    return {
      opened,
      elapsedMs: opened ? Math.round(performance.now() - startedAt) : null
    }
  }

  const waitForRefreshAvailable = async () => {
    return await waitFor(
      'feedback-ui-refresh-available',
      () => queryElement<HTMLButtonElement>(historyRefreshSelector)?.disabled === false,
      4000,
      40
    )
  }

  log('feedback-ui:start')

  await window.electronAPI.debug.feedbackReset()
  await window.electronAPI.debug.feedbackSetMockIssues([])
  await sleep(60)

  try {
    const preRendered = queryElement<HTMLElement>(modalSelector)?.dataset.feedbackOpen === 'false'
    record('FBU-00-feedback-modal-pre-rendered', preRendered, {
      feedbackOpen: queryElement<HTMLElement>(modalSelector)?.dataset.feedbackOpen ?? null
    })
    if (cancelled()) {
      return results
    }

    const { opened, elapsedMs } = await openFeedbackModal()
    record('FBU-01-open-feedback-modal', opened, {
      sidebarButtonFound: Boolean(queryElement(sidebarButtonSelector)),
      openElapsedMs: elapsedMs
    })
    if (!opened || cancelled()) {
      return results
    }

    const feedbackTypeSelect = queryElement<HTMLSelectElement>('[data-testid="feedback-type-select"]')
    const feedbackTypeStyle = feedbackTypeSelect ? window.getComputedStyle(feedbackTypeSelect) : null
    record('FBU-01b-feedback-select-uses-shared-shell', Boolean(feedbackTypeSelect) &&
      feedbackTypeSelect?.classList.contains('onward-select') === true &&
      Boolean(feedbackTypeSelect.closest('.onward-select-shell')) &&
      feedbackTypeStyle?.appearance === 'none' &&
      Number.parseFloat(feedbackTypeStyle?.paddingRight ?? '0') >= 30, {
      hasSelect: Boolean(feedbackTypeSelect),
      sharedSelectClass: feedbackTypeSelect?.classList.contains('onward-select') ?? false,
      shellWrapped: Boolean(feedbackTypeSelect?.closest('.onward-select-shell')),
      appearance: feedbackTypeStyle?.appearance ?? null,
      paddingRight: feedbackTypeStyle?.paddingRight ?? null
    })
    if (cancelled()) {
      return results
    }

    const blankSubmitClicked = clickElement(queryElement<HTMLButtonElement>(submitButtonSelector))
    const validationShown = await waitFor(
      'feedback-ui-validation',
      () => Boolean(queryElement(formErrorSelector)?.textContent?.trim()),
      1200,
      40
    )
    record('FBU-02-submit-validation', blankSubmitClicked && validationShown, {
      errorText: queryElement(formErrorSelector)?.textContent?.trim() ?? null
    })
    if (cancelled()) {
      return results
    }

    const typeSet = setSelectValue(queryElement<HTMLSelectElement>('[data-testid="feedback-type-select"]'), 'feature')
    const titleSet = setTextInputValue(
      queryElement<HTMLInputElement>('[data-testid="feedback-title-input"]'),
      'Feedback modal UI automation'
    )
    const descriptionSet = setTextInputValue(
      queryElement<HTMLTextAreaElement>('[data-testid="feedback-description-input"]'),
      'This autotest validates the in-app feedback flow, browser handoff, and GitHub status refresh.'
    )
    const consentSet = clickElement(queryElement<HTMLInputElement>('[data-testid="feedback-public-consent"]'))
    await sleep(120)

    record('FBU-03-fill-feedback-form', typeSet && titleSet && descriptionSet && consentSet, {
      typeSet,
      titleSet,
      descriptionSet,
      consentSet
    })
    if (cancelled()) {
      return results
    }

    const submitted = clickElement(queryElement<HTMLButtonElement>(submitButtonSelector))
    const historyVisible = await waitFor(
      'feedback-ui-history-visible',
      () => getHistoryStatus() === 'pending_submission' &&
        getHistoryTitle() === 'Feedback modal UI automation',
      6000,
      40
    )
    const openedUrl = await window.electronAPI.debug.feedbackGetLastOpenedUrl()
    const issueUrl = openedUrl ? new URL(openedUrl) : null
    const issueBody = issueUrl?.searchParams.get('body') || ''
    const feedbackIdMatch = issueBody.match(/Feedback ID:\s*([^\n]+)/)
    const feedbackId = feedbackIdMatch?.[1]?.trim() || null

    record('FBU-04-submit-opens-browser-draft', submitted &&
      historyVisible &&
      issueUrl?.searchParams.get('template') === 'feedback-feature.md' &&
      issueUrl?.searchParams.get('title') === 'Feedback modal UI automation' &&
      issueBody.includes('Type: Feature Request') &&
      issueBody.includes('Rating: 0/5 (not provided)') &&
      issueBody.includes('Locale: en') &&
      Boolean(feedbackId), {
      openedUrl,
      historyStatus: getHistoryStatus(),
      historyTitle: getHistoryTitle(),
      submitNoticeVisible: Boolean(queryElement(submitNoticeSelector)),
      feedbackId
    })
    if (!feedbackId || cancelled()) {
      return results
    }

    const remoteIssueBase: FeedbackDebugRemoteIssue = {
      number: 321,
      url: 'https://github.com/OPPO-PersonalAI/Onward/issues/321',
      state: 'open',
      labels: [],
      body: issueBody
    }

    await window.electronAPI.debug.feedbackSetMockIssues([remoteIssueBase])
    await sleep(40)
    const refreshAvailable = await waitForRefreshAvailable()
    const refreshClicked = clickElement(queryElement<HTMLButtonElement>(historyRefreshSelector))
    const submittedResolved = await waitFor(
      'feedback-ui-submitted-status',
      () => getHistoryStatus() === 'submitted',
      3000,
      40
    )
    record('FBU-05-history-resolves-to-submitted', refreshAvailable && refreshClicked && submittedResolved, {
      historyStatus: getHistoryStatus(),
      issueUrlVisible: Boolean(queryElement('[data-testid="feedback-open-issue"]'))
    })
    if (cancelled()) {
      return results
    }

    await window.electronAPI.debug.feedbackSetMockIssues([{
      ...remoteIssueBase,
      labels: ['feedback:accepted']
    }])
    await waitForRefreshAvailable()
    clickElement(queryElement<HTMLButtonElement>(historyRefreshSelector))
    const acceptedResolved = await waitFor(
      'feedback-ui-accepted-status',
      () => getHistoryStatus() === 'accepted',
      3000,
      40
    )
    record('FBU-06-history-resolves-to-accepted', acceptedResolved, {
      historyStatus: getHistoryStatus()
    })
    if (cancelled()) {
      return results
    }

    await window.electronAPI.debug.feedbackSetMockIssues([{
      ...remoteIssueBase,
      labels: ['feedback:in-progress']
    }])
    await waitForRefreshAvailable()
    clickElement(queryElement<HTMLButtonElement>(historyRefreshSelector))
    const inProgressResolved = await waitFor(
      'feedback-ui-in-progress-status',
      () => getHistoryStatus() === 'in_progress',
      3000,
      40
    )
    record('FBU-07-history-resolves-to-in-progress', inProgressResolved, {
      historyStatus: getHistoryStatus()
    })
    if (cancelled()) {
      return results
    }

    await window.electronAPI.debug.feedbackSetMockIssues([{
      ...remoteIssueBase,
      state: 'closed',
      stateReason: 'completed',
      labels: []
    }])
    await waitForRefreshAvailable()
    clickElement(queryElement<HTMLButtonElement>(historyRefreshSelector))
    const completedResolved = await waitFor(
      'feedback-ui-completed-status',
      () => getHistoryStatus() === 'completed',
      3000,
      40
    )
    record('FBU-08-history-resolves-to-completed', completedResolved, {
      historyStatus: getHistoryStatus()
    })
    if (cancelled()) {
      return results
    }

    await window.electronAPI.debug.feedbackSetMockIssues([])
    await waitForRefreshAvailable()
    clickElement(queryElement<HTMLButtonElement>(historyRefreshSelector))
    const unavailableResolved = await waitFor(
      'feedback-ui-unavailable-status',
      () => getHistoryStatus() === 'unavailable_on_github',
      3000,
      40
    )
    record('FBU-09-deleted-issue-becomes-unavailable', unavailableResolved, {
      historyStatus: getHistoryStatus(),
      historyError: queryElement('[data-testid="feedback-history-error"]')?.textContent?.trim() ?? null
    })

    const extraSubmissionCount = 8
    for (let index = 0; index < extraSubmissionCount; index += 1) {
      await window.electronAPI.feedback.createSubmission({
        rating: 0,
        type: 'bug',
        title: `Scroll record ${index + 1}`,
        description: `Feedback history scroll coverage record ${index + 1}.`,
        publicConsentAccepted: true,
        locale: 'en'
      })
    }

    await waitForRefreshAvailable()
    clickElement(queryElement<HTMLButtonElement>(historyRefreshSelector))
    const scrollReady = await waitFor(
      'feedback-ui-history-scroll-ready',
      () => queryElements('[data-testid="feedback-history-item"]').length >= extraSubmissionCount + 1,
      4000,
      40
    )
    const historyList = queryElement<HTMLDivElement>('[data-testid="feedback-history-list"]')
    if (historyList) {
      historyList.scrollTop = 180
      historyList.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
    const listIsScrollable = historyList
      ? historyList.scrollHeight > historyList.clientHeight &&
        historyList.scrollTop > 0 &&
        window.getComputedStyle(historyList).overflowY === 'auto'
      : false

    record('FBU-10-history-list-scrolls', scrollReady && listIsScrollable, {
      itemCount: queryElements('[data-testid="feedback-history-item"]').length,
      clientHeight: historyList?.clientHeight ?? null,
      scrollHeight: historyList?.scrollHeight ?? null,
      scrollTop: historyList?.scrollTop ?? null,
      overflowY: historyList ? window.getComputedStyle(historyList).overflowY : null
    })

    const removeButtons = queryElements<HTMLButtonElement>('[data-testid="feedback-remove-record"]')
    const countBeforeRemove = queryElements('[data-testid="feedback-history-item"]').length
    const removeClicked = clickElement(removeButtons[0] ?? null)
    const removeResolved = await waitFor(
      'feedback-ui-remove-local-record',
      () => queryElements('[data-testid="feedback-history-item"]').length === Math.max(0, countBeforeRemove - 1),
      3000,
      40
    )
    const stateAfterRemove = await window.electronAPI.feedback.load()
    record('FBU-11-remove-local-record', removeClicked && removeResolved, {
      countBeforeRemove,
      countAfterRemove: queryElements('[data-testid="feedback-history-item"]').length,
      storedCountAfterRemove: stateAfterRemove.records.length
    })

    // FB-DB-01 — Diagnostic bundle export. The button now lives in the
    // tab bar (right-aligned), so it is reachable from any tab; we
    // don't need to switch tabs first. We verify the button is
    // rendered with the right testid, then drive the IPC directly
    // with `forceOutputPath` so the showSaveDialog path is bypassed.
    // The IPC handler enforces this override only when
    // `ONWARD_AUTOTEST=1`, which the runner sets.
    const bundleButton = queryElement<HTMLButtonElement>(
      '[data-testid="feedback-diagnostic-bundle-button"]'
    )
    const noticeNode = queryElement<HTMLElement>(
      '[data-testid="feedback-diagnostic-bundle-notice"]'
    )

    type BundleIpcResult = {
      success?: boolean
      canceled?: boolean
      path?: string
      bytes?: number
      error?: string
      manifest?: { chunkCount: number; chunkBytes: number; stateFiles: string[]; missingFiles: string[] }
      verification?: { ok: boolean; checks: Array<{ name: string; passed: boolean; detail?: string }> }
    }

    let bundleIpcResult: BundleIpcResult | null = null
    if (bundleButton) {
      const cwdHint = window.electronAPI.debug.autotestCwd ?? '/tmp'
      const forcedPath = `${cwdHint}/__autotest_feedback_diagnostic_${Date.now()}.zip`
      try {
        bundleIpcResult = await window.electronAPI.feedback.exportDiagnosticBundle(forcedPath) as BundleIpcResult
      } catch (error) {
        bundleIpcResult = { success: false, error: String(error) }
      }
    }

    // Pass condition for FB-DB-01:
    //   - button + privacy notice both rendered (the new tab-bar layout)
    //   - IPC reported success
    //   - produced a non-empty file (bytes > 0)
    //   - **closed-loop verification.ok === true** — every V* check
    //     passed: V1 zip-opens, V2 entries-present (incl. AGENT-GUIDE.md),
    //     V4 ndjson-parse, V7 chunk-bytes-equal, V8 state-files-bytes-equal,
    //     V9 generated-content-bytes-equal (README + system-info +
    //     AGENT-GUIDE byte-equal), V10 autotest-marker (skipped here —
    //     FB-DB-03 covers it). Hard-rule byte-equivalence; no `>0`
    //     tolerance allowed.
    //   - V9 explicitly passed — protects against a future regression
    //     that renames / drops V9 without dropping the AGENT-GUIDE
    //     coverage too. Unit test DB-08 already locks in the byte-flip
    //     case; this gate ensures the live packaged binary still wires
    //     V9 into the verification list.
    const v9Check = bundleIpcResult?.verification?.checks.find((c) => c.name === 'V9-generated-content-bytes-equal')
    record(
      'FB-DB-01-bundle-export',
      Boolean(bundleButton)
        && Boolean(noticeNode)
        && bundleIpcResult?.success === true
        && (bundleIpcResult?.bytes ?? 0) > 0
        && bundleIpcResult?.verification?.ok === true
        && v9Check?.passed === true,
      {
        buttonRendered: Boolean(bundleButton),
        noticeRendered: Boolean(noticeNode),
        ipcSuccess: bundleIpcResult?.success ?? null,
        canceled: bundleIpcResult?.canceled ?? null,
        path: bundleIpcResult?.path ?? null,
        bytes: bundleIpcResult?.bytes ?? null,
        chunkCount: bundleIpcResult?.manifest?.chunkCount ?? null,
        stateFileCount: bundleIpcResult?.manifest?.stateFiles?.length ?? null,
        verificationOk: bundleIpcResult?.verification?.ok ?? null,
        v9Passed: v9Check?.passed ?? null,
        v9Detail: v9Check?.detail ?? null,
        verificationFailedChecks: (bundleIpcResult?.verification?.checks ?? [])
          .filter((c) => !c.passed)
          .map((c) => `${c.name}: ${c.detail ?? ''}`),
        error: bundleIpcResult?.error ?? null
      }
    )

    // FB-DB-02 — repeated bundle. Click the button a SECOND time with
    // a different output path. The IPC handler calls
    // `traceStore.rotate()` before each bundle, so the chunks captured
    // between FB-DB-01 and FB-DB-02 are an independent set. Both
    // bundles must succeed; both must verify ok. Catches yazl race
    // regressions that only show up under repeated calls + catches
    // store-state corruption from the rotate.
    let bundleIpcResult2: BundleIpcResult | null = null
    if (bundleButton) {
      const cwdHint2 = window.electronAPI.debug.autotestCwd ?? '/tmp'
      const forcedPath2 = `${cwdHint2}/__autotest_feedback_diagnostic_${Date.now()}_2.zip`
      try {
        bundleIpcResult2 = await window.electronAPI.feedback.exportDiagnosticBundle(forcedPath2) as BundleIpcResult
      } catch (error) {
        bundleIpcResult2 = { success: false, error: String(error) }
      }
    }
    record(
      'FB-DB-02-bundle-export-repeat',
      bundleIpcResult2?.success === true
        && (bundleIpcResult2?.bytes ?? 0) > 0
        && bundleIpcResult2?.verification?.ok === true
        && bundleIpcResult?.path !== bundleIpcResult2?.path,
      {
        firstPath: bundleIpcResult?.path ?? null,
        secondPath: bundleIpcResult2?.path ?? null,
        secondBytes: bundleIpcResult2?.bytes ?? null,
        secondVerificationOk: bundleIpcResult2?.verification?.ok ?? null,
        secondVerificationFailedChecks: (bundleIpcResult2?.verification?.checks ?? [])
          .filter((c) => !c.passed)
          .map((c) => `${c.name}: ${c.detail ?? ''}`),
        secondError: bundleIpcResult2?.error ?? null
      }
    )

    // FB-DB-03 — semantic closed-loop with V10 marker. The user's hard-
    // rule contract: "perform an operation, see it land in the local
    // trace, then bundle, then verify the same event is in the bundle
    // — args byte-equal."
    //   1. Generate a unique uuid + label.
    //   2. await debug.emitBundleMarker(uuid, label) — IPC returns once
    //      `traceStore.writeSync` has flushed the line into the kernel
    //      buffer of the active chunk fd. So we know the marker is
    //      already on disk before the next IPC call runs.
    //   3. await exportDiagnosticBundle(forcedPath, expectedMarker)
    //      where the IPC handler internally calls `traceStore.rotate()`
    //      (sealing the chunk that holds our marker) → reads it →
    //      writes the ZIP → opens the ZIP via yauzl → searches for
    //      `name === 'autotest:bundle-marker'` with matching uuid+label
    //      → V10 passes iff that exact event round-tripped.
    //   4. The whole rotate→write→ZIP→yauzl→parse pipeline is a hard
    //      rule: any layer dropping/corrupting the marker → V10 fail.
    const markerUuid = `db03-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const markerLabel = 'FB-DB-03-semantic-loop'
    let markerEmitResult: { success: boolean; chunkPath?: string | null; error?: string } | null = null
    try {
      markerEmitResult = await window.electronAPI.debug.emitBundleMarker(markerUuid, markerLabel)
    } catch (error) {
      markerEmitResult = { success: false, error: String(error) }
    }
    let bundleIpcResult3: BundleIpcResult | null = null
    if (markerEmitResult?.success && bundleButton) {
      const cwdHint3 = window.electronAPI.debug.autotestCwd ?? '/tmp'
      const forcedPath3 = `${cwdHint3}/__autotest_feedback_diagnostic_${Date.now()}_marker.zip`
      try {
        bundleIpcResult3 = await window.electronAPI.feedback.exportDiagnosticBundle(
          forcedPath3,
          { uuid: markerUuid, label: markerLabel }
        ) as BundleIpcResult
      } catch (error) {
        bundleIpcResult3 = { success: false, error: String(error) }
      }
    }
    const v10Check = bundleIpcResult3?.verification?.checks.find((c) => c.name === 'V10-autotest-marker')
    record(
      'FB-DB-03-semantic-loop-marker',
      markerEmitResult?.success === true
        && bundleIpcResult3?.success === true
        && bundleIpcResult3?.verification?.ok === true
        && v10Check?.passed === true,
      {
        markerUuid,
        markerLabel,
        markerEmitOk: markerEmitResult?.success ?? null,
        markerEmitError: markerEmitResult?.error ?? null,
        markerChunkPath: markerEmitResult?.chunkPath ?? null,
        bundlePath: bundleIpcResult3?.path ?? null,
        bundleSuccess: bundleIpcResult3?.success ?? null,
        verificationOk: bundleIpcResult3?.verification?.ok ?? null,
        v10Passed: v10Check?.passed ?? null,
        v10Detail: v10Check?.detail ?? null,
        verificationFailedChecks: (bundleIpcResult3?.verification?.checks ?? [])
          .filter((c) => !c.passed)
          .map((c) => `${c.name}: ${c.detail ?? ''}`),
        bundleError: bundleIpcResult3?.error ?? null
      }
    )
  } finally {
    const sidebarButton = queryElement<HTMLButtonElement>(sidebarButtonSelector)
    if (sidebarButton && queryElement<HTMLElement>(modalSelector)?.dataset.feedbackOpen === 'true') {
      clickElement(sidebarButton)
      await sleep(120)
    }
    await window.electronAPI.debug.feedbackReset()
  }

  return results
}
