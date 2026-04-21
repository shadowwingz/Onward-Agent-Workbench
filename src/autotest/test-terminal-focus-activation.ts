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

  log('terminal-focus-activation:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
