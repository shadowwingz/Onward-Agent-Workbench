/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const HARNESS_MARKDOWN_PATH = 'harness_engineering_comprehensive.md'
const TARGET_HEADING_TOPIC = `${String.fromCharCode(21452)} Agent ${String.fromCharCode(36328, 20250, 35805, 26550, 26500)}`
const TARGET_HEADING = `4.2 Anthropic: ${TARGET_HEADING_TOPIC}`
const TARGET_HEADING_SLUG = `42-anthropic-${String.fromCharCode(21452)}-agent-${String.fromCharCode(36328, 20250, 35805, 26550, 26500)}`
const TARGET_MIN_LINE = 260
const FALLBACK_TARGET_LINE = 70
const SHORTCUT_REOPEN_TRIALS = 5
const SHORTCUT_REOPEN_SAMPLE_MS = 500
const MIN_REOPEN_SAMPLE_COUNT = 5
const MIN_SUBPAGE_RETURN_SAMPLE_COUNT = 5

type ProjectEditorReopenRestore = {
  durationMs: number
  cause: 'retained-view' | 'persisted-state'
  filePath: string | null
  markdownCacheMode: 'hit' | 'miss' | 'stale' | 'disabled' | null
  finalizedAt: number
} | null

interface ShortcutReopenObservation {
  trial: number
  triggered: boolean
  reopened: boolean
  previewReady: boolean
  selectFileEmptyStateSamples: number
  bodyBeforeShellSamples: number
  bodyVisibleSamples: number
  shellVisibleSamples: number
  totalSamples: number
  reopenRestore: ProjectEditorReopenRestore
  nonIdlePhaseSamplesDuringReopen: number
  opacityFadedSamplesDuringReopen: number
  observedPhasesDuringReopen: string[]
  htmlLengthAfterReopen: number
  overlayMidOpacitySamples: number
  overlayMinOpacityDuringReopen: number
  overlayMaxOpacityDuringReopen: number
}

function buildFallbackMarkdownContent(): string {
  const lines: string[] = [
    '# Harness Engineering Comprehensive',
    '',
    '## 1. Overview'
  ]

  for (let index = 1; index <= 70; index += 1) {
    lines.push(`Overview filler line ${index} with enough text to create a stable preview scroll range.`)
  }

  lines.push(`### ${TARGET_HEADING}`)
  lines.push('')
  lines.push('The target section should remain visible after leaving and reopening Project Editor.')
  lines.push('')
  lines.push('```mermaid')
  lines.push('sequenceDiagram')
  lines.push('  participant U as User')
  lines.push('  participant E as Editor')
  lines.push('  U->>E: Open preview section')
  lines.push('  E-->>U: Restore editor and preview')
  lines.push('```')

  for (let index = 1; index <= 180; index += 1) {
    lines.push(`Target and trailing filler line ${index} keeps the document long enough for restore assertions.`)
  }

  return lines.join('\n')
}

export async function testProjectEditorMarkdownSessionRestore(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, rootPath, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug
  const readPreviewState = () => ({
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
    previewVisible: getApi()?.isMarkdownPreviewVisible?.() ?? null,
    editorVisible: getApi()?.isMarkdownEditorVisible?.() ?? null,
    renderPending: getApi()?.isMarkdownRenderPending?.() ?? null,
    restorePhase: getApi()?.getPreviewRestorePhase?.() ?? null,
    htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0,
    mermaidState: getApi()?.getMermaidPreviewState?.() ?? null
  })
  const dispatchEscape = () => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true
    }))
  }

  const waitForPreviewReady = async (label: string, filePath: string) => {
    return await waitFor(
      label,
      () => {
        const api = getApi()
        if (!api?.isOpen?.()) return false
        if (api.getActiveFilePath?.() !== filePath) return false
        if (!api.isMarkdownPreviewVisible?.()) return false
        if (api.isMarkdownRenderPending?.()) return false
        if (api.getPreviewRestorePhase?.() !== 'idle') return false
        const mermaidState = api.getMermaidPreviewState?.()
        if (mermaidState && (mermaidState.pending > 0 || mermaidState.inFlight)) return false
        return api.getMarkdownRenderedHtml?.().includes(TARGET_HEADING) === true
      },
      20000,
      120
    )
  }

  const closeProjectEditor = async (label: string) => {
    dispatchEscape()
    return await waitFor(
      label,
      () => !getApi()?.isOpen?.(),
      8000,
      100
    )
  }
  const sampleShortcutReopenFrames = async (durationMs: number) => {
    const samples: Array<{
      selectFileEmptyStateVisible: boolean
      shellVisible: boolean
      bodyVisible: boolean
      htmlLength: number
      previewRestorePhase: string | null
      previewContentOpacityZero: boolean
      overlayOpacity: number
    }> = []
    const waitForSampleTick = () => new Promise<void>((resolve) => {
      let resolved = false
      const finish = () => {
        if (resolved) return
        resolved = true
        resolve()
      }
      requestAnimationFrame(finish)
      window.setTimeout(finish, 32)
    })
    const startedAt = performance.now()
    const maxSampleMs = durationMs + 4000
    let sawBodyVisible = false
    while (
      performance.now() - startedAt < durationMs ||
      samples.length < MIN_REOPEN_SAMPLE_COUNT ||
      (!sawBodyVisible && performance.now() - startedAt < maxSampleMs)
    ) {
      const host = document.querySelector('.terminal-grid-subpage-host.is-open')
      const shellVisible = Boolean(host?.querySelector('[data-subpage-panel-shell="true"]'))
      const bodyVisible = Boolean(host?.querySelector('.project-editor-overlay.panel.is-open .project-editor-body'))
      const previewBody = host?.querySelector('.project-editor-preview-body') as HTMLElement | null
      const previewContent = previewBody?.querySelector('.project-editor-preview-content') as HTMLElement | null
      const opacity = previewContent ? Number(window.getComputedStyle(previewContent).opacity) : 1
      // The panel overlay (`.project-editor-overlay.panel`) used to fade in/out
      // over 0.16s — that produced the user-visible "afterimage" on every
      // shortcut toggle. We now sample its computed opacity directly: with the
      // fade removed, every frame must read either 0 (closed) or 1 (open),
      // never a fractional value.
      const overlay = document.querySelector('.project-editor-overlay.panel') as HTMLElement | null
      const overlayOpacity = overlay ? Number(window.getComputedStyle(overlay).opacity) : 0
      sawBodyVisible = sawBodyVisible || bodyVisible
      samples.push({
        selectFileEmptyStateVisible: Boolean(getApi()?.isSelectFileEmptyStateVisible?.()),
        shellVisible,
        bodyVisible,
        htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? -1,
        previewRestorePhase: getApi()?.getPreviewRestorePhase?.() ?? null,
        previewContentOpacityZero: opacity < 0.99,
        overlayOpacity
      })
      await waitForSampleTick()
    }
    return samples
  }
  const reopenProjectEditorViaShortcut = async (trial: number): Promise<ShortcutReopenObservation> => {
    const samplesPromise = sampleShortcutReopenFrames(SHORTCUT_REOPEN_SAMPLE_MS)
    const triggered = window.__onwardAppDebug?.triggerShortcutAction?.({ type: 'terminalProjectEditor' }) === true
    const reopened = await waitFor(
      `pmsr-project-editor-shortcut-reopen-${trial}`,
      () => Boolean(getApi()?.isOpen?.()),
      8000,
      80
    )
    const samples = await samplesPromise
    const previewReady = reopened
      ? await waitForPreviewReady(`pmsr-preview-ready-after-shortcut-reopen-${trial}`, targetPath)
      : false
    const selectFileEmptyStateSamples = samples.filter(sample => sample.selectFileEmptyStateVisible).length
    const bodyBeforeShellSamples = samples.filter(sample => sample.bodyVisible && !sample.shellVisible).length
    const bodyVisibleSamples = samples.filter(sample => sample.bodyVisible).length
    const shellVisibleSamples = samples.filter(sample => sample.shellVisible).length
    // Track preview-restore phase inside the reopen window. Pre-fix the
    // owner-switch effect clears `markdownRenderedHtmlRef` so the reopen
    // path falls into `applyMarkdownSessionCacheHit` → `beginPreviewRestore`,
    // toggling phase to 'waiting-html' / 'restoring-layout'. Those phases
    // drive `.project-editor-preview-content` to `opacity: 0` (CSS rule in
    // ProjectEditor.css ~L1324), giving the user-visible "screen refreshes
    // again" effect even though the rendered HTML is identical. Post-fix the
    // ref is mirrored on capture, the cache-hit branch is skipped, and the
    // phase remains 'idle' for the entire reopen.
    const reopenIndex = samples.findIndex((sample) => sample.bodyVisible)
    const reopenWindowSamples = reopenIndex === -1 ? [] : samples.slice(reopenIndex)
    const phasesDuringReopen = reopenWindowSamples
      .map((sample) => sample.previewRestorePhase)
      .filter((phase): phase is string => Boolean(phase))
    const nonIdlePhaseSamplesDuringReopen = phasesDuringReopen.filter((phase) => phase !== 'idle').length
    const opacityFadedSamplesDuringReopen = reopenWindowSamples.filter((sample) => sample.previewContentOpacityZero).length
    const observedPhasesDuringReopen = Array.from(new Set(phasesDuringReopen))
    // PMSR-13b: across the whole sampling window (close-frames included)
    // every overlay opacity reading must be exactly 0 (closed) or exactly 1
    // (open). Pre-fix the panel overlay had `transition: opacity 0.16s ease`
    // which guarantees that an rAF-paced sampler catches at least one frame
    // with `0 < opacity < 1` during a 160ms ease curve. Post-fix the
    // transition is removed and opacity flips instantly.
    const overlayOpacities = samples.map((sample) => sample.overlayOpacity)
    const overlayMidOpacitySamples = overlayOpacities.filter((opacity) => opacity > 0 && opacity < 1).length
    const overlayMinOpacityDuringReopen = overlayOpacities.length === 0 ? -1 : Math.min(...overlayOpacities)
    const overlayMaxOpacityDuringReopen = overlayOpacities.length === 0 ? -1 : Math.max(...overlayOpacities)
    return {
      trial,
      triggered,
      reopened,
      previewReady,
      selectFileEmptyStateSamples,
      bodyBeforeShellSamples,
      bodyVisibleSamples,
      shellVisibleSamples,
      totalSamples: samples.length,
      reopenRestore: getApi()?.getLastProjectEditorReopenRestore?.() ?? null,
      nonIdlePhaseSamplesDuringReopen,
      opacityFadedSamplesDuringReopen,
      observedPhasesDuringReopen,
      htmlLengthAfterReopen: getApi()?.getMarkdownRenderedHtml?.().length ?? 0,
      overlayMidOpacitySamples,
      overlayMinOpacityDuringReopen,
      overlayMaxOpacityDuringReopen
    }
  }

  let targetPath = HARNESS_MARKDOWN_PATH
  let expectedMinLine = TARGET_MIN_LINE
  const cleanupPaths: string[] = []
  const switchPath = `onward-autotest-markdown-session-switch-${Date.now()}.txt`
  cleanupPaths.push(switchPath)
  const harnessFixture = await window.electronAPI.project.readFile(rootPath, HARNESS_MARKDOWN_PATH)
  if (!harnessFixture.success || !harnessFixture.content?.includes(TARGET_HEADING)) {
    targetPath = `onward-autotest-markdown-session-restore-${Date.now()}.md`
    expectedMinLine = FALLBACK_TARGET_LINE
    cleanupPaths.push(targetPath)
    const created = await window.electronAPI.project.createFile(rootPath, targetPath, buildFallbackMarkdownContent())
    record('PMSR-00-fallback-fixture-created', created.success, {
      rootPath,
      targetPath,
      sourceError: harnessFixture.success ? null : harnessFixture.error,
      usedFallback: true
    })
    if (!created.success || cancelled()) return results
  } else {
    record('PMSR-00-harness-fixture-found', true, {
      rootPath,
      targetPath
    })
  }

  try {
    const api = getApi()
    if (!api?.openFileByPathAsUser || !api.setMarkdownPreviewVisible || !api.setMarkdownEditorVisible) {
      record('PMSR-01-debug-api-available', false, { error: 'ProjectEditor debug API is incomplete' })
      return results
    }

    const switchCreated = await window.electronAPI.project.createFile(
      rootPath,
      switchPath,
      'Project Editor Markdown session restore switch file.\n'
    )
    record('PMSR-01-switch-fixture-created', switchCreated.success, {
      switchPath,
      error: switchCreated.success ? null : switchCreated.error
    })
    if (!switchCreated.success || cancelled()) return results

    await api.openFileByPathAsUser(switchPath, { trackRecent: true })
    const switchedAway = await waitFor(
      'pmsr-switch-file-opened',
      () => getApi()?.getActiveFilePath?.() === switchPath,
      8000,
      100
    )
    record('PMSR-02-switch-file-opened', switchedAway, {
      activeFilePath: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!switchedAway || cancelled()) return results

    api.setMarkdownPreviewVisible(true)
    api.setMarkdownEditorVisible(false)
    api.setOutlineVisible?.(true)
    api.setOutlineTarget?.('preview')
    await sleep(180)

    await api.openFileByPathAsUser(targetPath, { trackRecent: true })
    const openedPreviewOnly = await waitForPreviewReady('pmsr-preview-only-opened', targetPath)
    record('PMSR-03-preview-only-target-opened', openedPreviewOnly, readPreviewState())
    if (!openedPreviewOnly || cancelled()) return results

    const outlineReady = await waitFor(
      'pmsr-outline-ready',
      () => (getApi()?.getOutlineSymbolCount?.() ?? 0) > 0,
      10000,
      120
    )
    record('PMSR-04-outline-ready', outlineReady, {
      symbolCount: getApi()?.getOutlineSymbolCount?.() ?? null
    })
    if (!outlineReady || cancelled()) return results

    const clickedHeading = Boolean(getApi()?.clickOutlineItemByName?.(TARGET_HEADING))
    await sleep(500)
    const previewSlug = getApi()?.debugScanPreviewHeadings?.().nearest ?? getApi()?.getPreviewActiveSlug?.() ?? null
    const previewScrollTop = getApi()?.getPreviewScrollTop?.() ?? 0
    record('PMSR-05-preview-section-opened', clickedHeading && previewSlug === TARGET_HEADING_SLUG && previewScrollTop > 100, {
      clickedHeading,
      previewSlug,
      expectedSlug: TARGET_HEADING_SLUG,
      previewScrollTop: Math.round(previewScrollTop)
    })
    if (!clickedHeading || cancelled()) return results

    getApi()?.setMarkdownEditorVisible?.(true)
    const editorAligned = await waitFor(
      'pmsr-editor-aligned-after-enter-edit',
      () => {
        const apiNow = getApi()
        if (apiNow?.isMarkdownEditorVisible?.() !== true) return false
        return (apiNow.getFirstVisibleLine?.() ?? 1) >= expectedMinLine
      },
      6000,
      120
    )
    const savedFirstVisibleLine = getApi()?.getFirstVisibleLine?.() ?? 1
    const savedPreviewScrollTop = getApi()?.getPreviewScrollTop?.() ?? 0
    record('PMSR-06-edit-mode-keeps-section-context', editorAligned, {
      firstVisibleLine: savedFirstVisibleLine,
      expectedMinLine,
      previewScrollTop: Math.round(savedPreviewScrollTop),
      editorVisible: getApi()?.isMarkdownEditorVisible?.() ?? null
    })
    if (!editorAligned || cancelled()) return results

    const closed = await closeProjectEditor('pmsr-project-editor-closed')
    record('PMSR-07-project-editor-closed-to-terminal', closed, {
      isOpen: getApi()?.isOpen?.() ?? false
    })
    if (!closed || cancelled()) return results

    const canUseShortcutDebug = Boolean(window.__onwardAppDebug?.triggerShortcutAction)
    record('PMSR-07a-shortcut-debug-api-available', canUseShortcutDebug, {
      hasAppDebug: Boolean(window.__onwardAppDebug),
      hasTriggerShortcutAction: Boolean(window.__onwardAppDebug?.triggerShortcutAction)
    })
    if (!canUseShortcutDebug || cancelled()) return results

    const shortcutReopenObservations: ShortcutReopenObservation[] = []
    const firstShortcutReopen = await reopenProjectEditorViaShortcut(1)
    shortcutReopenObservations.push(firstShortcutReopen)
    record('PMSR-08-project-editor-reopened-by-shortcut', firstShortcutReopen.triggered && firstShortcutReopen.reopened, {
      isOpen: getApi()?.isOpen?.() ?? false,
      observation: firstShortcutReopen
    })
    if (!firstShortcutReopen.reopened || cancelled()) return results
    const reopenRestore = firstShortcutReopen.reopenRestore
    record('PMSR-08a-no-select-file-empty-state-during-shortcut-reopen', firstShortcutReopen.selectFileEmptyStateSamples === 0, {
      selectFileEmptyStateSamples: firstShortcutReopen.selectFileEmptyStateSamples,
      totalSamples: firstShortcutReopen.totalSamples,
      activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
      reopenRestore
    })
    record('PMSR-08b-shortcut-reopen-used-retained-markdown-view', reopenRestore?.cause === 'retained-view' && reopenRestore.filePath === targetPath, {
      reopenRestore,
      expectedFilePath: targetPath
    })
    record('PMSR-08c-shortcut-reopen-shell-before-body', firstShortcutReopen.bodyVisibleSamples > 0 && firstShortcutReopen.bodyBeforeShellSamples === 0, {
      bodyBeforeShellSamples: firstShortcutReopen.bodyBeforeShellSamples,
      bodyVisibleSamples: firstShortcutReopen.bodyVisibleSamples,
      shellVisibleSamples: firstShortcutReopen.shellVisibleSamples,
      totalSamples: firstShortcutReopen.totalSamples
    })

    const restoredPreview = await waitForPreviewReady('pmsr-preview-restored-after-reopen', targetPath)
    record('PMSR-09-target-file-and-mode-restored', restoredPreview && getApi()?.isMarkdownEditorVisible?.() === true, {
      activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
      previewVisible: getApi()?.isMarkdownPreviewVisible?.() ?? null,
      editorVisible: getApi()?.isMarkdownEditorVisible?.() ?? null,
      previewRestorePhase: getApi()?.getPreviewRestorePhase?.() ?? null
    })
    const restoredSectionAligned = await waitFor(
      'pmsr-section-aligned-after-reopen',
      () => {
        const apiNow = getApi()
        const currentSlug = apiNow?.debugScanPreviewHeadings?.().nearest ?? apiNow?.getPreviewActiveSlug?.() ?? null
        const currentPreviewScrollTop = apiNow?.getPreviewScrollTop?.() ?? 0
        const currentPreviewDiff = Math.abs(currentPreviewScrollTop - savedPreviewScrollTop)
        const currentFirstVisibleLine = apiNow?.getFirstVisibleLine?.() ?? 1
        return currentSlug === TARGET_HEADING_SLUG &&
          currentPreviewDiff <= 80 &&
          currentFirstVisibleLine >= expectedMinLine
      },
      8000,
      120
    )
    const restoredFirstVisibleLine = getApi()?.getFirstVisibleLine?.() ?? 1
    const restoredPreviewScrollTop = getApi()?.getPreviewScrollTop?.() ?? 0
    const restoredSlug = getApi()?.debugScanPreviewHeadings?.().nearest ?? getApi()?.getPreviewActiveSlug?.() ?? null
    const previewDiff = Math.abs(restoredPreviewScrollTop - savedPreviewScrollTop)
    record('PMSR-10-preview-section-restored-after-reopen', restoredPreview && restoredSlug === TARGET_HEADING_SLUG && previewDiff <= 80, {
      restoredSlug,
      expectedSlug: TARGET_HEADING_SLUG,
      savedPreviewScrollTop: Math.round(savedPreviewScrollTop),
      restoredPreviewScrollTop: Math.round(restoredPreviewScrollTop),
      previewDiff: Math.round(previewDiff)
    })
    record('PMSR-11-editor-section-restored-after-reopen', restoredSectionAligned && restoredFirstVisibleLine >= expectedMinLine, {
      savedFirstVisibleLine,
      restoredFirstVisibleLine,
      expectedMinLine
    })
    const cacheState = getApi()?.getMarkdownSessionCacheState?.() ?? null
    const cacheEntry = cacheState?.entries.find(entry => entry.filePath === targetPath) ?? null
    record('PMSR-12-markdown-session-cache-hit-after-reopen', cacheState?.lastRestore.mode === 'hit' && Boolean(cacheEntry), {
      lastRestore: cacheState?.lastRestore ?? null,
      cacheEntry,
      cacheSize: cacheState?.size ?? null,
      cacheLimit: cacheState?.limit ?? null
    })

    for (let trial = 2; trial <= SHORTCUT_REOPEN_TRIALS; trial += 1) {
      if (cancelled()) return results
      const closedForTrial = await closeProjectEditor(`pmsr-project-editor-closed-shortcut-repeat-${trial}`)
      if (!closedForTrial) {
        shortcutReopenObservations.push({
          trial,
          triggered: false,
          reopened: false,
          previewReady: false,
          selectFileEmptyStateSamples: -1,
          bodyBeforeShellSamples: -1,
          bodyVisibleSamples: 0,
          shellVisibleSamples: 0,
          totalSamples: 0,
          reopenRestore: null,
          nonIdlePhaseSamplesDuringReopen: -1,
          opacityFadedSamplesDuringReopen: -1,
          observedPhasesDuringReopen: [],
          htmlLengthAfterReopen: 0,
          overlayMidOpacitySamples: -1,
          overlayMinOpacityDuringReopen: -1,
          overlayMaxOpacityDuringReopen: -1
        })
        break
      }
      const observation = await reopenProjectEditorViaShortcut(trial)
      shortcutReopenObservations.push(observation)
      if (!observation.reopened || !observation.previewReady) break
    }
    const repeatedShortcutPathOk =
      shortcutReopenObservations.length === SHORTCUT_REOPEN_TRIALS &&
      shortcutReopenObservations.every((observation) =>
        observation.triggered &&
        observation.reopened &&
        observation.previewReady &&
        observation.selectFileEmptyStateSamples === 0 &&
        observation.bodyVisibleSamples > 0 &&
        observation.bodyBeforeShellSamples === 0 &&
        observation.reopenRestore?.cause === 'retained-view' &&
        observation.reopenRestore.filePath === targetPath
      )
    record('PMSR-13-escape-and-shortcut-reopen-repeat', repeatedShortcutPathOk, {
      trials: shortcutReopenObservations
    })

    // PMSR-13a guards against the silent "reopen reflash" the user reported.
    // The visible refresh comes from `previewRestorePhase` toggling through
    // 'waiting-html' / 'restoring-layout' on every reopen, which CSS rule
    // `.project-editor-preview-body.preview-phase-waiting-html
    //  .project-editor-preview-content { opacity: 0; ... }` drives. Pre-fix
    // the owner-switch effect clears `markdownRenderedHtmlRef`, the reopen
    // path falls into `applyMarkdownSessionCacheHit` → `beginPreviewRestore`,
    // phase momentarily becomes non-'idle', and the preview content fades
    // to opacity 0 before fading back in. Post-fix the cache mirror keeps
    // `shouldPreserveCachedRender` true, the cache-hit branch is skipped,
    // and the phase stays 'idle' across the reopen so the content never fades.
    const reopenSurvivedTrials = shortcutReopenObservations.filter((obs) => obs.reopened && obs.previewReady)
    const noReflashOk =
      reopenSurvivedTrials.length === SHORTCUT_REOPEN_TRIALS &&
      reopenSurvivedTrials.every((obs) =>
        obs.nonIdlePhaseSamplesDuringReopen === 0 &&
        obs.opacityFadedSamplesDuringReopen === 0 &&
        obs.htmlLengthAfterReopen > 0
      )
    record('PMSR-13a-shortcut-reopen-no-preview-phase-flash', noReflashOk, {
      expectedTrials: SHORTCUT_REOPEN_TRIALS,
      observedTrials: reopenSurvivedTrials.length,
      perTrial: shortcutReopenObservations.map((obs) => ({
        trial: obs.trial,
        nonIdlePhaseSamplesDuringReopen: obs.nonIdlePhaseSamplesDuringReopen,
        opacityFadedSamplesDuringReopen: obs.opacityFadedSamplesDuringReopen,
        observedPhasesDuringReopen: obs.observedPhasesDuringReopen,
        htmlLengthAfterReopen: obs.htmlLengthAfterReopen
      }))
    })

    // PMSR-13b guards against the panel overlay fade returning. Each toggle
    // (open or close) of `.project-editor-overlay.panel` must read its
    // computed opacity as exactly 0 or exactly 1 — never a fractional value
    // mid-transition. A 0.16s `transition: opacity` curve will, with
    // certainty under a ~16ms rAF-paced sampler, produce at least one frame
    // with `0 < opacity < 1`. Removing the transition in
    // `ProjectEditor.css` makes the toggle instant and this assertion
    // trivially pass.
    const noOverlayFadeOk =
      reopenSurvivedTrials.length === SHORTCUT_REOPEN_TRIALS &&
      reopenSurvivedTrials.every((obs) => obs.overlayMidOpacitySamples === 0)
    record('PMSR-13b-shortcut-toggle-no-overlay-fade', noOverlayFadeOk, {
      expectedTrials: SHORTCUT_REOPEN_TRIALS,
      observedTrials: reopenSurvivedTrials.length,
      perTrial: shortcutReopenObservations.map((obs) => ({
        trial: obs.trial,
        overlayMidOpacitySamples: obs.overlayMidOpacitySamples,
        overlayMinOpacityDuringReopen: obs.overlayMinOpacityDuringReopen,
        overlayMaxOpacityDuringReopen: obs.overlayMaxOpacityDuringReopen
      }))
    })

    // PMSR-30..35 cross-entry preview cache hit.
    //
    // Reproduces the user-reported "Markdown Preview cache fails on
    // non-shortcut entries" bug. The user explicitly framed the
    // complaint as a *cache* failure, not as a state-loss failure:
    // "the cache only works for the shortcut close-reopen path within
    // the same Task; entries through other paths invalidate it".
    //
    // The shortcut-reopen path is locked by PMSR-13a: preview phase
    // must stay 'idle' across reopen (cache hit short-circuits the
    // 'waiting-html' -> 'restoring-layout' transitions that would
    // otherwise drive `.project-editor-preview-content { opacity: 0 }`).
    //
    // These new cases extend the SAME contract to the subpage-return
    // entries:
    //   * Editor -> Git Diff -> Editor (PMSR-30..32)
    //   * Editor -> Git History -> Editor (PMSR-33..35)
    //
    // For each entry path we sample the preview phase + content opacity
    // across the entire transition window. The cache-hit fast path
    // emits zero non-idle phase samples AND zero faded-content samples;
    // any single observation of `phase != 'idle'` or `opacity < 1` means
    // the renderer fell back to the slow re-render path, which is what
    // the user perceives as "preview disappeared".

    const clickSubpageButton = (target: 'diff' | 'editor' | 'history'): boolean => {
      const button = document.querySelector<HTMLButtonElement>(`[data-subpage-button="${target}"]`)
      if (!button || button.disabled) return false
      button.click()
      return true
    }

    // Faithful reproduction of the user-reported entry path: click the
    // panel-shell's Diff / History button from inside the Editor.
    // This goes through ProjectEditor.handleSelectSubpage ->
    // handleOpenGitDiff (or handleOpenGitHistory), which sets
    // `subpageReturnFileRef` AND triggers the editor close path.
    //
    // The earlier viewGitDiff shortcut path bypasses ProjectEditor
    // entirely (TerminalGrid handles 'git-diff:open' directly without
    // closing the editor), so it does not reproduce the bug. Using the
    // subpage button click is the correct fixture for the cache-hit
    // cross-entry regression.
    const enterGitDiff = async (label: string): Promise<boolean> => {
      if (!clickSubpageButton('diff')) return false
      return await waitFor(
        label,
        () => Boolean(document.querySelector('.terminal-grid-subpage-host[data-active-subpage="diff"]')),
        10000,
        100
      )
    }

    const enterGitHistory = async (label: string): Promise<boolean> => {
      if (!clickSubpageButton('history')) return false
      return await waitFor(
        label,
        () => Boolean(document.querySelector('.terminal-grid-subpage-host[data-active-subpage="history"]')),
        10000,
        100
      )
    }

    const exitSubpageToEditor = async (label: string): Promise<boolean> => {
      if (!clickSubpageButton('editor')) return false
      return await waitFor(
        label,
        () => Boolean(getApi()?.isOpen?.())
          && document.querySelector('.terminal-grid-subpage-host[data-active-subpage="editor"]') !== null,
        10000,
        100
      )
    }

    /** Re-establish the canonical "Preview on, raw editor visible" state on
     * `targetPath` before each cross-entry probe. Idempotent: if the editor
     * is already in this state (e.g. after PMSR-13b's shortcut reopen) the
     * setters are no-ops. */
    const ensureCanonicalPreviewState = async (label: string): Promise<boolean> => {
      const api = getApi()
      if (!api) return false
      if (api.getActiveFilePath?.() !== targetPath) {
        await api.openFileByPathAsUser?.(targetPath, { trackRecent: true })
      }
      api.setMarkdownPreviewVisible?.(true)
      api.setMarkdownEditorVisible?.(true)
      return await waitForPreviewReady(label, targetPath)
    }

    /** Sample preview phase + content opacity for `durationMs`. Mirrors the
     * sampleShortcutReopenFrames sampler used by PMSR-13a/13b but trimmed
     * to the two signals we care about for cache-hit detection. */
    const SUBPAGE_RETURN_SAMPLE_MS = 600
    const sampleSubpageReturnFrames = async (durationMs: number) => {
      const phases: Array<string | null> = []
      const opacities: number[] = []
      const waitForSampleTick = () => new Promise<void>((resolve) => {
        let resolved = false
        const finish = () => {
          if (resolved) return
          resolved = true
          resolve()
        }
        requestAnimationFrame(finish)
        window.setTimeout(finish, 32)
      })
      const startedAt = performance.now()
      const maxSampleMs = durationMs + 4000
      let sawEditorSubpage = false
      while (
        performance.now() - startedAt < durationMs ||
        phases.length < MIN_SUBPAGE_RETURN_SAMPLE_COUNT ||
        (!sawEditorSubpage && performance.now() - startedAt < maxSampleMs)
      ) {
        sawEditorSubpage = sawEditorSubpage || (
          Boolean(getApi()?.isOpen?.()) &&
          document.querySelector('.terminal-grid-subpage-host[data-active-subpage="editor"]') !== null
        )
        const previewBody = document.querySelector('.project-editor-preview-body') as HTMLElement | null
        const previewContent = previewBody?.querySelector('.project-editor-preview-content') as HTMLElement | null
        const opacity = previewContent ? Number(window.getComputedStyle(previewContent).opacity) : 1
        opacities.push(opacity)
        phases.push(getApi()?.getPreviewRestorePhase?.() ?? null)
        await waitForSampleTick()
      }
      return { phases, opacities }
    }

    /** Run the full Diff (or History) round-trip while sampling preview
     * phase / opacity. Returns the collected samples plus the post-trip
     * final state so the assertions can check both transient regressions
     * (mid-trip flash) and final-state correctness. */
    interface SubpageRoundtripObservation {
      setupReady: boolean
      enteredSubpage: boolean
      exitedToEditor: boolean
      previewReady: boolean
      phases: Array<string | null>
      opacities: number[]
      nonIdlePhaseSamples: number
      fadedOpacitySamples: number
      totalSamples: number
      finalIsMarkdownPreviewVisible: boolean | null
      finalIsMarkdownEditorVisible: boolean | null
      finalHtmlLength: number
      finalRestorePhase: string | null
    }
    const runSubpageRoundtrip = async (
      label: string,
      enterSubpage: (label: string) => Promise<boolean>
    ): Promise<SubpageRoundtripObservation> => {
      const setupReady = await ensureCanonicalPreviewState(`${label}-setup`)
      if (!setupReady) {
        return {
          setupReady, enteredSubpage: false, exitedToEditor: false, previewReady: false,
          phases: [], opacities: [],
          nonIdlePhaseSamples: -1, fadedOpacitySamples: -1, totalSamples: 0,
          finalIsMarkdownPreviewVisible: null, finalIsMarkdownEditorVisible: null,
          finalHtmlLength: 0, finalRestorePhase: null
        }
      }
      const enteredSubpage = await enterSubpage(`${label}-enter-subpage`)
      if (!enteredSubpage) {
        return {
          setupReady, enteredSubpage, exitedToEditor: false, previewReady: false,
          phases: [], opacities: [],
          nonIdlePhaseSamples: -1, fadedOpacitySamples: -1, totalSamples: 0,
          finalIsMarkdownPreviewVisible: null, finalIsMarkdownEditorVisible: null,
          finalHtmlLength: 0, finalRestorePhase: null
        }
      }
      // Start sampling THEN dispatch the navigate event so we catch the
      // first paint frames where the cache-miss flash would surface.
      const samplesPromise = sampleSubpageReturnFrames(SUBPAGE_RETURN_SAMPLE_MS)
      const exitedToEditor = await exitSubpageToEditor(`${label}-exit-to-editor`)
      const { phases, opacities } = await samplesPromise
      const previewReady = exitedToEditor
        && await waitForPreviewReady(`${label}-preview-ready`, targetPath)
      const api = getApi()
      const nonIdlePhaseSamples = phases.filter((phase) => phase !== null && phase !== 'idle').length
      const fadedOpacitySamples = opacities.filter((opacity) => opacity < 0.99).length
      return {
        setupReady,
        enteredSubpage,
        exitedToEditor,
        previewReady,
        phases,
        opacities,
        nonIdlePhaseSamples,
        fadedOpacitySamples,
        totalSamples: phases.length,
        finalIsMarkdownPreviewVisible: api?.isMarkdownPreviewVisible?.() ?? null,
        finalIsMarkdownEditorVisible: api?.isMarkdownEditorVisible?.() ?? null,
        finalHtmlLength: api?.getMarkdownRenderedHtml?.()?.length ?? 0,
        finalRestorePhase: api?.getPreviewRestorePhase?.() ?? null
      }
    }

    // PMSR-30..32 Editor -> Git Diff -> Editor.

    const diffObservation = await runSubpageRoundtrip('pmsr-diff', enterGitDiff)
    record('PMSR-30-diff-roundtrip-cache-hit-no-phase-flash',
      diffObservation.previewReady
        && diffObservation.totalSamples > 0
        && diffObservation.nonIdlePhaseSamples === 0,
      {
        ...diffObservation,
        // Truncate raw samples to keep the diagnostic blob readable.
        phases: diffObservation.phases.slice(0, 30),
        opacities: diffObservation.opacities.slice(0, 30)
      }
    )
    record('PMSR-31-diff-roundtrip-cache-hit-no-opacity-fade',
      diffObservation.previewReady
        && diffObservation.totalSamples > 0
        && diffObservation.fadedOpacitySamples === 0,
      {
        nonIdlePhaseSamples: diffObservation.nonIdlePhaseSamples,
        fadedOpacitySamples: diffObservation.fadedOpacitySamples,
        totalSamples: diffObservation.totalSamples
      }
    )
    record('PMSR-32-diff-roundtrip-final-state-preview-rendered',
      diffObservation.previewReady
        && diffObservation.finalIsMarkdownPreviewVisible === true
        && diffObservation.finalHtmlLength > 0,
      {
        finalIsMarkdownPreviewVisible: diffObservation.finalIsMarkdownPreviewVisible,
        finalIsMarkdownEditorVisible: diffObservation.finalIsMarkdownEditorVisible,
        finalHtmlLength: diffObservation.finalHtmlLength,
        finalRestorePhase: diffObservation.finalRestorePhase
      }
    )

    // PMSR-33..35 Editor -> Git History -> Editor.

    const historyObservation = await runSubpageRoundtrip('pmsr-history', enterGitHistory)
    record('PMSR-33-history-roundtrip-cache-hit-no-phase-flash',
      historyObservation.previewReady
        && historyObservation.totalSamples > 0
        && historyObservation.nonIdlePhaseSamples === 0,
      {
        ...historyObservation,
        phases: historyObservation.phases.slice(0, 30),
        opacities: historyObservation.opacities.slice(0, 30)
      }
    )
    record('PMSR-34-history-roundtrip-cache-hit-no-opacity-fade',
      historyObservation.previewReady
        && historyObservation.totalSamples > 0
        && historyObservation.fadedOpacitySamples === 0,
      {
        nonIdlePhaseSamples: historyObservation.nonIdlePhaseSamples,
        fadedOpacitySamples: historyObservation.fadedOpacitySamples,
        totalSamples: historyObservation.totalSamples
      }
    )
    record('PMSR-35-history-roundtrip-final-state-preview-rendered',
      historyObservation.previewReady
        && historyObservation.finalIsMarkdownPreviewVisible === true
        && historyObservation.finalHtmlLength > 0,
      {
        finalIsMarkdownPreviewVisible: historyObservation.finalIsMarkdownPreviewVisible,
        finalIsMarkdownEditorVisible: historyObservation.finalIsMarkdownEditorVisible,
        finalHtmlLength: historyObservation.finalHtmlLength,
        finalRestorePhase: historyObservation.finalRestorePhase
      }
    )
  } finally {
    for (const cleanupPath of cleanupPaths) {
      const deleted = await window.electronAPI.project.deletePath(rootPath, cleanupPath)
      log('pmsr-cleanup', { cleanupPath, deleted })
    }
  }

  return results
}
