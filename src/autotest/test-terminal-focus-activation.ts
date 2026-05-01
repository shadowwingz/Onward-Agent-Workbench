/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const POINTER_SUPPRESS_SETTLE_MS = 180
const POINTER_STALE_WAIT_MS = 520
const SURFACE_IDLE_TIMEOUT_MS = 2200
const SURFACE_IDLE_SAMPLE_MS = 160
const SURFACE_IDLE_STABLE_SAMPLE_COUNT = 4
const SURFACE_LOSS_TIMEOUT_MS = 1000
const SURFACE_RESTORE_TIMEOUT_MS = 1500

type WebglContext = WebGLRenderingContext | WebGL2RenderingContext

interface WebglSurfaceProbe {
  canvas: HTMLCanvasElement
  gl: WebglContext
}

interface WebglPixelStats {
  width: number
  height: number
  sampledPixels: number
  nonZeroPixels: number
  alphaPixels: number
  maxChannel: number
  checksum: number
  nonZeroRatio: number
  intensityMean: number
  intensityVariance: number
}

const escapeCssIdent = (value: string) => {
  const css = window.CSS as (typeof window.CSS & { escape?: (value: string) => string }) | undefined
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, '\\$&')
}

const nextFrame = () => new Promise<void>((resolve) => {
  window.requestAnimationFrame(() => resolve())
})

const waitForFrames = async (count: number) => {
  for (let index = 0; index < count; index += 1) {
    await nextFrame()
  }
}

const findWebglSurface = (terminalId: string): WebglSurfaceProbe | null => {
  const cell = document.querySelector<HTMLElement>(`.terminal-grid-cell[data-terminal-id="${escapeCssIdent(terminalId)}"]`)
  if (!cell) return null

  const canvases = Array.from(cell.querySelectorAll<HTMLCanvasElement>('.xterm-screen canvas'))
  for (const canvas of canvases) {
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 1 || rect.height <= 1 || canvas.width <= 1 || canvas.height <= 1) {
      continue
    }

    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (gl && !gl.isContextLost()) {
      return { canvas, gl }
    }
  }

  return null
}

const readWebglPixels = (gl: WebglContext): WebglPixelStats => {
  const width = gl.drawingBufferWidth
  const height = gl.drawingBufferHeight
  const pixels = new Uint8Array(width * height * 4)

  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.finish()
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

  let nonZeroPixels = 0
  let alphaPixels = 0
  let maxChannel = 0
  let checksum = 0
  let intensitySum = 0
  let intensitySquaredSum = 0

  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index]
    const g = pixels[index + 1]
    const b = pixels[index + 2]
    const a = pixels[index + 3]
    const pixelMax = Math.max(r, g, b, a)
    const intensity = r + g + b
    intensitySum += intensity
    intensitySquaredSum += intensity * intensity
    if (pixelMax > 8) {
      nonZeroPixels += 1
      checksum = ((checksum * 31) + r + (g * 3) + (b * 7) + (a * 11)) >>> 0
    }
    if (a > 8) {
      alphaPixels += 1
    }
    if (pixelMax > maxChannel) {
      maxChannel = pixelMax
    }
  }

  const sampledPixels = width * height
  const intensityMean = sampledPixels > 0 ? intensitySum / sampledPixels : 0
  const intensityVariance = sampledPixels > 0
    ? Math.max(0, (intensitySquaredSum / sampledPixels) - (intensityMean * intensityMean))
    : 0

  return {
    width,
    height,
    sampledPixels,
    nonZeroPixels,
    alphaPixels,
    maxChannel,
    checksum,
    nonZeroRatio: sampledPixels > 0 ? nonZeroPixels / sampledPixels : 0,
    intensityMean,
    intensityVariance
  }
}

const hasRenderablePixels = (stats: WebglPixelStats) => {
  return stats.maxChannel > 8 && stats.intensityVariance > 0.05
}

// Used by the TFA-10..17 phantom-blank cases. After `phantomBlank()` paints
// the WebGL canvas a flat white, every pixel reads (255,255,255,255) — high
// maxChannel and intensityMean but zero variance.
const looksAllWhite = (stats: WebglPixelStats) =>
  stats.maxChannel >= 250 && stats.intensityMean >= 720 && stats.intensityVariance < 0.05

const arePixelStatsStable = (current: WebglPixelStats, next: WebglPixelStats) => {
  return current.checksum === next.checksum &&
    Math.abs(current.intensityMean - next.intensityMean) < 0.01 &&
    Math.abs(current.intensityVariance - next.intensityVariance) < 0.01
}

export async function testTerminalFocusActivation(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardTerminalFocusDebug
  const getTerminalApi = () => window.__onwardTerminalDebug
  const closeProjectEditorIfNeeded = async () => {
    const projectEditorApi = window.__onwardProjectEditorDebug
    if (!projectEditorApi?.isOpen()) {
      return true
    }

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    }))

    const closed = await waitFor(
      'tfa-close-project-editor',
      () => !window.__onwardProjectEditorDebug?.isOpen?.(),
      4000,
      50
    )
    log('terminal-focus-activation:close-project-editor', { closed })
    return closed
  }
  const focusAppWindow = async (label: string) => {
    const requested = await window.electronAPI.debug.focusWindow()
    const focused = await waitFor(
      `tfa-window-focus-${label}`,
      () => document.hasFocus(),
      2000,
      50
    )
    log('terminal-focus-activation:focus-window', { label, requested, focused })
    return requested && focused
  }

  log('terminal-focus-activation:start', { terminalId })

  const api = getApi()
  _assert('TFA-01-debug-api-available', Boolean(api), {
    available: Boolean(api)
  })
  if (!api || cancelled()) {
    return results
  }

  await closeProjectEditorIfNeeded()
  await sleep(400)

  const prepared = api.prepareTerminalRestore(terminalId)
  _assert('TFA-02-prepare-terminal-restore', prepared, {
    terminalId,
    state: api.getState()
  })
  if (!prepared || cancelled()) {
    return results
  }

  await focusAppWindow('shortcut-restore')
  api.simulateRestore('shortcut-activated')
  const shortcutRestoreFocused = await waitFor(
    'tfa-shortcut-restore-focus',
    () => getApi()?.getFocusedTerminalId() === terminalId,
    3000,
    50
  )
  _assert('TFA-03-shortcut-restore-focuses-terminal', shortcutRestoreFocused, api.getState())

  api.blurActiveElement()
  const blurClearedFocus = await waitFor(
    'tfa-blur-clears-focus',
    () => getApi()?.getFocusedTerminalId() === null,
    1500,
    50
  )
  _assert('TFA-04-blur-clears-terminal-focus', blurClearedFocus, api.getState())

  api.prepareTerminalRestore(terminalId)
  api.simulatePointerTarget('terminal', terminalId)
  api.simulateRestore('window-focus')
  await sleep(POINTER_SUPPRESS_SETTLE_MS)
  _assert('TFA-05-window-focus-after-terminal-pointer-does-not-refocus', api.getFocusedTerminalId() === null, api.getState())

  await focusAppWindow('shortcut-activated')
  api.simulateRestore('shortcut-activated')
  const shortcutActivatedFocused = await waitFor(
    'tfa-shortcut-activated-focus',
    () => getApi()?.getFocusedTerminalId() === terminalId,
    3000,
    50
  )
  _assert('TFA-06-shortcut-activation-still-restores-terminal', shortcutActivatedFocused, api.getState())

  api.blurActiveElement()
  await waitFor('tfa-clear-focus-again', () => getApi()?.getFocusedTerminalId() === null, 1500, 50)
  api.prepareTerminalRestore(terminalId)
  api.simulatePointerTarget('other')
  api.simulateRestore('window-focus')
  await sleep(POINTER_SUPPRESS_SETTLE_MS)
  _assert('TFA-07-window-focus-after-mouse-other-does-not-refocus', api.getFocusedTerminalId() === null, api.getState())

  api.prepareTerminalRestore(terminalId)
  await sleep(POINTER_STALE_WAIT_MS)
  await focusAppWindow('stale-pointer')
  api.simulateRestore('window-focus')
  const stalePointerRestoreFocused = await waitFor(
    'tfa-stale-pointer-window-focus',
    () => getApi()?.getFocusedTerminalId() === terminalId,
    3000,
    50
  )
  _assert('TFA-08-window-focus-restores-terminal-when-pointer-is-stale', stalePointerRestoreFocused, api.getState())

  const terminalApi = getTerminalApi()
  const terminalDebugAvailable = Boolean(terminalApi)
  const dataSettledBeforeSurfaceProbe = Boolean(terminalApi) && await waitFor(
    'tfa-surface-repro-data-settled',
    () => {
      const state = terminalApi?.getSessionState(terminalId)
      return Boolean(state?.status === 'ready' && state.pendingDataBytes === 0 && state.pendingDataChunks === 0)
    },
    2000,
    50
  )
  const fitBeforeSurfaceProbe = terminalApi?.forceFit(terminalId) ?? false
  await waitForFrames(2)

  let initialSurface = findWebglSurface(terminalId)
  let beforeClearStats = initialSurface ? readWebglPixels(initialSurface.gl) : null
  let stableBeforeClearStats: WebglPixelStats | null = null
  let stableSurfaceElapsedMs: number | null = null
  let stableSurfaceSampleCount = 0
  const stableSurfaceStartedAt = performance.now()
  while (initialSurface && beforeClearStats && performance.now() - stableSurfaceStartedAt < SURFACE_IDLE_TIMEOUT_MS) {
    await sleep(SURFACE_IDLE_SAMPLE_MS)
    const nextSurface = findWebglSurface(terminalId)
    if (!nextSurface) break

    const nextStats = readWebglPixels(nextSurface.gl)
    if (hasRenderablePixels(nextStats) && arePixelStatsStable(beforeClearStats, nextStats)) {
      initialSurface = nextSurface
      stableBeforeClearStats = nextStats
      stableSurfaceSampleCount += 1
      stableSurfaceElapsedMs = Math.round(performance.now() - stableSurfaceStartedAt)
      if (stableSurfaceSampleCount >= SURFACE_IDLE_STABLE_SAMPLE_COUNT) {
        break
      }
    } else {
      stableSurfaceSampleCount = 0
    }

    initialSurface = nextSurface
    beforeClearStats = nextStats
  }

  const sessionBeforeSurfaceProbe = terminalApi?.getSessionState(terminalId) ?? null
  const sessionBeforeSurfaceRecord = (sessionBeforeSurfaceProbe ?? {}) as Record<string, unknown>
  if (!initialSurface) {
    _assert(
      'TFA-09-document-visible-recovers-visible-terminal-renderer',
      terminalDebugAvailable &&
        (
          sessionBeforeSurfaceRecord.rendererMode === 'fallback' ||
          sessionBeforeSurfaceRecord.webglActive === false
        ),
      {
        skipped: true,
        reason: 'webgl-surface-unavailable',
        terminalDebugAvailable,
        dataSettledBeforeSurfaceProbe,
        fitBeforeSurfaceProbe,
        sessionBeforeSurfaceProbe
      }
    )
  } else {
    const beforeLossStats = stableBeforeClearStats ?? beforeClearStats ?? readWebglPixels(initialSurface.gl)
    const initialCanvasSize = {
      cssWidth: Math.round(initialSurface.canvas.getBoundingClientRect().width),
      cssHeight: Math.round(initialSurface.canvas.getBoundingClientRect().height),
      deviceWidth: initialSurface.canvas.width,
      deviceHeight: initialSurface.canvas.height
    }
    const simulatedSurfaceLoss = terminalApi?.simulateRendererSurfaceLoss(terminalId) ?? false
    const surfaceLost = await waitFor(
      'tfa-webgl-renderer-surface-lost',
      () => {
        const state = terminalApi?.getSessionState(terminalId)
        return Boolean(state?.status === 'ready' && state.open && state.visible && state.webglActive === false && !findWebglSurface(terminalId))
      },
      SURFACE_LOSS_TIMEOUT_MS,
      50
    )
    const sessionAfterSurfaceLoss = terminalApi?.getSessionState(terminalId) ?? null

    let restoredStats: WebglPixelStats | null = null
    let restoreElapsedMs: number | null = null
    const restoreStartedAt = performance.now()
    document.dispatchEvent(new Event('visibilitychange'))
    const restored = await waitFor(
      'tfa-webgl-surface-restored-after-document-visible',
      () => {
        const surface = findWebglSurface(terminalId)
        if (!surface) return false
        const stats = readWebglPixels(surface.gl)
        if (
          hasRenderablePixels(stats) &&
          stats.checksum !== beforeLossStats.checksum
        ) {
          restoredStats = stats
          restoreElapsedMs = Math.round(performance.now() - restoreStartedAt)
          return true
        }
        return false
      },
      SURFACE_RESTORE_TIMEOUT_MS,
      80
    )
    const sessionAfterSurfaceRestore = terminalApi?.getSessionState(terminalId) ?? null

    _assert(
      'TFA-09-document-visible-recovers-visible-terminal-renderer',
      terminalDebugAvailable &&
        dataSettledBeforeSurfaceProbe &&
        fitBeforeSurfaceProbe &&
        Boolean(stableBeforeClearStats) &&
        hasRenderablePixels(beforeLossStats) &&
        simulatedSurfaceLoss &&
        surfaceLost &&
        restored &&
        Boolean(sessionAfterSurfaceRestore?.status === 'ready' &&
          sessionAfterSurfaceRestore.open &&
          sessionAfterSurfaceRestore.visible &&
          sessionAfterSurfaceRestore.webglActive),
      {
        terminalDebugAvailable,
        dataSettledBeforeSurfaceProbe,
        fitBeforeSurfaceProbe,
        simulatedSurfaceLoss,
        surfaceLost,
        stableSurfaceElapsedMs,
        stableSurfaceSampleCount,
        restoreElapsedMs,
        canvasSize: initialCanvasSize,
        beforeClearStats: beforeLossStats,
        restoredStats,
        sessionBeforeSurfaceProbe,
        sessionAfterSurfaceLoss,
        sessionAfterSurfaceRestore
      }
    )
  }

  // ───────────────────────────────────────────────────────────────────
  // TFA-10..17 — "blank Task after desktop swipe" lifecycle regression
  //
  // TFA-09 above exercises the legacy `simulateRendererSurfaceLoss` path
  // which goes through `lifecycle.deactivate('manual-debug')` → synchronous
  // `disposeWebgl()`. That path skips the real `webglcontextlost` event
  // chain and therefore never reproduced the user-visible bug ("white
  // Task + broken-image after macOS Spaces / Win virtual desktop swipe").
  //
  // The cases below drive WEBGL_lose_context.loseContext() directly so
  // every assertion exercises the real Chromium event path. Coverage:
  //   TFA-10 phantom-blank repro infrastructure self-test
  //   TFA-11 path B (visibilitychange) re-renders blanked canvas
  //   TFA-12 path B (window-focus) re-renders blanked canvas
  //   TFA-13 webglcontextlost handler calls preventDefault — without this
  //          Chromium never schedules webglcontextrestored after a real loss
  //   TFA-14 lost handler does NOT synchronously disposeWebgl — that
  //          would tear out the canvas + listener and strand the session
  //   TFA-15 full lost+restored round-trip recovers renderable pixels
  //   TFA-16 host surface event during the lost window doesn't strand
  //          recovery (ensureWebgl defers via gl.isContextLost check)
  //   TFA-17 3 repeated lost+restored cycles stay stable (no listener /
  //          cooldown / addon state accumulation)
  // ───────────────────────────────────────────────────────────────────
  const repro = window.__blankTaskRepro
  if (!repro) {
    _assert('TFA-10-blank-task-repro-api-available', false, {
      skipped: true,
      reason: 'window.__blankTaskRepro not exposed; ensure terminal-session-manager gated it on autotest mode'
    })
  } else {
    const PHANTOM_SETTLE_MS = 80
    const RESTORE_TIMEOUT_MS = SURFACE_RESTORE_TIMEOUT_MS
    const RESTORE_POLL_MS = 60
    const reproSurface = findWebglSurface(terminalId)
    _assert('TFA-10-blank-task-repro-api-available', Boolean(reproSurface), {
      reproApiAvailable: true,
      hasWebglSurface: Boolean(reproSurface)
    })

    if (reproSurface) {
      // ---- TFA-11: phantom-blank + visibilitychange recovers ----
      {
        const phantomResult = repro.phantomBlank(terminalId)
        await sleep(PHANTOM_SETTLE_MS)
        const surfaceAfterPaint = findWebglSurface(terminalId)
        const statsAfterPaint = surfaceAfterPaint ? readWebglPixels(surfaceAfterPaint.gl) : null
        const phantomBlankApplied =
          phantomResult.triggered && statsAfterPaint !== null && looksAllWhite(statsAfterPaint)

        document.dispatchEvent(new Event('visibilitychange'))
        const recovered = await waitFor(
          'tfa-11-restored-after-visibilitychange',
          () => {
            const surface = findWebglSurface(terminalId)
            if (!surface) return false
            return hasRenderablePixels(readWebglPixels(surface.gl))
          },
          RESTORE_TIMEOUT_MS,
          RESTORE_POLL_MS
        )
        _assert(
          'TFA-11-phantom-blank-recovered-by-visibilitychange',
          phantomBlankApplied && recovered,
          {
            phantomResult,
            statsAfterPaint,
            recovered,
            bugHypothesisFix:
              'restoreSurface path B (clearTextureAtlas) must follow with terminal.refresh() — clearTextureAtlas alone marks rows dirty but never paints'
          }
        )
      }

      // ---- TFA-12: phantom-blank + window-focus recovers ----
      {
        const phantomResult = repro.phantomBlank(terminalId)
        await sleep(PHANTOM_SETTLE_MS)
        window.dispatchEvent(new Event('focus'))
        const recovered = await waitFor(
          'tfa-12-restored-after-window-focus',
          () => {
            const surface = findWebglSurface(terminalId)
            if (!surface) return false
            return hasRenderablePixels(readWebglPixels(surface.gl))
          },
          RESTORE_TIMEOUT_MS,
          RESTORE_POLL_MS
        )
        _assert('TFA-12-phantom-blank-recovered-by-window-focus', phantomResult.triggered && recovered, {
          phantomResult,
          recovered
        })
      }

      // ---- TFA-13: webglcontextlost handler calls preventDefault ----
      // Spy via a listener registered AFTER the lifecycle's. preventDefault
      // is sticky across the listener chain, so a later listener observes
      // `event.defaultPrevented === true` iff the lifecycle handler called
      // it. Without preventDefault, Chromium never schedules a restore.
      {
        await sleep(200)
        const spySurface = findWebglSurface(terminalId)
        let listenerFired = false
        let defaultPreventedSeen = false
        const spyListener = (event: Event) => {
          listenerFired = true
          defaultPreventedSeen = event.defaultPrevented
        }
        if (spySurface) {
          spySurface.canvas.addEventListener('webglcontextlost', spyListener, false)
        }
        const lossResult = repro.triggerWebglLoss(terminalId)
        await sleep(80)
        // Capture lifecycle state mid-flight for TFA-14.
        const stateMidLost = repro.getSessionDebugState(terminalId) as {
          webglActive?: boolean
          rendererContextLost?: boolean
        } | null
        if (spySurface) {
          spySurface.canvas.removeEventListener('webglcontextlost', spyListener)
        }
        // Drive the round trip closed so the next case starts with a live
        // WebGL surface.
        repro.forceWebglRestore(terminalId)
        await waitFor(
          'tfa-13-recovery-after-prevent-default-spy',
          () => {
            const surface = findWebglSurface(terminalId)
            if (!surface) return false
            return hasRenderablePixels(readWebglPixels(surface.gl))
          },
          RESTORE_TIMEOUT_MS,
          RESTORE_POLL_MS
        )
        _assert(
          'TFA-13-webglcontextlost-handler-calls-preventDefault',
          Boolean(spySurface) && lossResult.triggered && listenerFired && defaultPreventedSeen,
          {
            spySurface: Boolean(spySurface),
            lossTriggered: lossResult.triggered,
            listenerFired,
            defaultPreventedSeen,
            bugHypothesisFix:
              'attachContextListeners must call event.preventDefault() — without it Chromium never fires webglcontextrestored after a real GPU loss'
          }
        )

        // ---- TFA-14: addon stays alive after webglcontextlost ----
        // The pre-fix v1 design synchronously disposeWebgl()'d in the lost
        // handler, which tore the WebGL canvas out of the DOM and killed
        // our restored listener. This canary catches that regression.
        _assert(
          'TFA-14-addon-alive-after-webglcontextlost',
          stateMidLost !== null &&
            stateMidLost.webglActive === true &&
            stateMidLost.rendererContextLost === true,
          {
            stateMidLost,
            bugHypothesisFix:
              'lost handler must NOT synchronously disposeWebgl — that lets xterm tear out the canvas and kill the restored listener. addon stays alive (its render becomes a no-op) until webglcontextrestored fires'
          }
        )
      }

      // ---- TFA-15: full real-loss + restored round trip recovers ----
      {
        await sleep(150)
        const surfaceBeforeLoss = findWebglSurface(terminalId)
        const statsBeforeLoss = surfaceBeforeLoss ? readWebglPixels(surfaceBeforeLoss.gl) : null
        const lossResult = repro.triggerWebglLoss(terminalId)
        await sleep(80)
        const restoreResult = repro.forceWebglRestore(terminalId)
        const recovered = await waitFor(
          'tfa-15-restored-after-real-loss-roundtrip',
          () => {
            const surface = findWebglSurface(terminalId)
            if (!surface) return false
            return hasRenderablePixels(readWebglPixels(surface.gl))
          },
          RESTORE_TIMEOUT_MS,
          RESTORE_POLL_MS
        )
        const surfaceAfter = findWebglSurface(terminalId)
        const statsAfter = surfaceAfter ? readWebglPixels(surfaceAfter.gl) : null
        _assert(
          'TFA-15-real-webgl-loss-restored-roundtrip',
          lossResult.triggered && restoreResult.triggered && recovered,
          {
            lossResult,
            restoreResult,
            recovered,
            statsBeforeLoss,
            statsAfter,
            bugHypothesisFix:
              'canvas-level lost listener calls preventDefault, defers ensureWebgl while gl.isContextLost is true, then on webglcontextrestored re-arms via dispose+ensureWebgl+terminal.refresh'
          }
        )
      }

      // ---- TFA-16: host event interleaved with lost window doesn't strand ----
      // Real users sometimes swipe back and forth across desktops faster
      // than the GPU finishes restoring. A visibilitychange that lands
      // mid-loss must not let ensureWebgl create a new addon on a still-
      // dead canvas — that's exactly the original bug.
      {
        await sleep(200)
        const lossResult = repro.triggerWebglLoss(terminalId)
        await sleep(50)
        document.dispatchEvent(new Event('visibilitychange'))
        await sleep(180)
        const restoreResult = repro.forceWebglRestore(terminalId)
        const recovered = await waitFor(
          'tfa-16-recovery-after-interleaved-host-event',
          () => {
            const surface = findWebglSurface(terminalId)
            if (!surface) return false
            return hasRenderablePixels(readWebglPixels(surface.gl))
          },
          RESTORE_TIMEOUT_MS,
          RESTORE_POLL_MS
        )
        _assert(
          'TFA-16-host-event-during-lost-window-recovers-cleanly',
          lossResult.triggered && restoreResult.triggered && recovered,
          {
            lossResult,
            restoreResult,
            recovered,
            bugHypothesisFix:
              'ensureWebgl must check gl.isContextLost() before creating a new addon — otherwise an interleaved host surface event spawns a dead-context addon that strands the session'
          }
        )
      }

      // ---- TFA-17: repeated lost+restored cycles stay stable ----
      {
        await sleep(200)
        const cycleResults: Array<{ index: number; recovered: boolean }> = []
        let allCyclesRecovered = true
        for (let i = 0; i < 3; i += 1) {
          const lossResult = repro.triggerWebglLoss(terminalId)
          if (!lossResult.triggered) {
            allCyclesRecovered = false
            cycleResults.push({ index: i, recovered: false })
            break
          }
          await sleep(50)
          const restoreResult = repro.forceWebglRestore(terminalId)
          if (!restoreResult.triggered) {
            allCyclesRecovered = false
            cycleResults.push({ index: i, recovered: false })
            break
          }
          const recovered = await waitFor(
            `tfa-17-cycle-${i}`,
            () => {
              const surface = findWebglSurface(terminalId)
              if (!surface) return false
              return hasRenderablePixels(readWebglPixels(surface.gl))
            },
            RESTORE_TIMEOUT_MS,
            RESTORE_POLL_MS
          )
          cycleResults.push({ index: i, recovered })
          if (!recovered) {
            allCyclesRecovered = false
            break
          }
          await sleep(150)
        }
        const finalState = repro.getSessionDebugState(terminalId) as {
          webglActive?: boolean
          rendererWebglDisabledUntil?: number | null
        } | null
        _assert(
          'TFA-17-repeated-lost-restored-cycles-stable',
          allCyclesRecovered &&
            finalState !== null &&
            finalState.webglActive === true &&
            (finalState.rendererWebglDisabledUntil ?? null) === null,
          {
            cycleResults,
            finalState,
            bugHypothesisFix:
              'each successful ensureWebgl must reset webglFailureCount to 0 — otherwise rapid swipes accumulate failures and trigger cooldown spuriously'
          }
        )
      }
    }
  }

  log('terminal-focus-activation:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
