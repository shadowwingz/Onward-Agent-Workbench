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
    while (performance.now() - startedAt < durationMs) {
      const host = document.querySelector('.terminal-grid-subpage-host.is-open')
      const shellVisible = Boolean(host?.querySelector('[data-subpage-panel-shell="true"]'))
      const bodyVisible = Boolean(host?.querySelector('.project-editor-overlay.panel.is-open .project-editor-body'))
      samples.push({
        selectFileEmptyStateVisible: Boolean(getApi()?.isSelectFileEmptyStateVisible?.()),
        shellVisible,
        bodyVisible
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
      reopenRestore: getApi()?.getLastProjectEditorReopenRestore?.() ?? null
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
          reopenRestore: null
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
  } finally {
    for (const cleanupPath of cleanupPaths) {
      const deleted = await window.electronAPI.project.deletePath(rootPath, cleanupPath)
      log('pmsr-cleanup', { cleanupPath, deleted })
    }
  }

  return results
}
