/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Terminal as XTerm } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { perfMonitor } from '../utils/perf-monitor'
import { perfTrace } from '../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../utils/perf-trace-names'

export type RuntimePlatform = 'darwin' | 'win32' | 'linux'

export type TerminalRendererMode = 'webgl' | 'fallback'

export type TerminalRendererSurfaceEvent =
  | 'window-focus'
  | 'document-visible'
  | 'page-show'
  | 'manual-debug'
  | 'webgl-context-loss'
  | 'webgl-context-restored'

export type TerminalRendererLifecycleReason =
  | 'attach'
  | 'visible'
  | 'hidden'
  | 'dispose'
  | TerminalRendererSurfaceEvent

export interface TerminalRendererPolicy {
  platform: RuntimePlatform
  surfaceResumeDebounceMs: number
  postResumeFrameCount: number
  webglFailureFallbackThreshold: number
  webglFallbackCooldownMs: number
}

export interface TerminalRendererLifecycleSnapshot {
  mode: TerminalRendererMode
  webglActive: boolean
  webglAvailable: boolean
  webglFailureCount: number
  webglDisabledUntil: number | null
  contextLost: boolean
  hasContextListeners: boolean
  lastLifecycleReason: TerminalRendererLifecycleReason | null
  lastLifecycleAt: number | null
  lastSurfaceEvent: TerminalRendererSurfaceEvent | null
  lastSurfaceEventAt: number | null
}

export interface TerminalRendererLifecycleResult {
  mode: TerminalRendererMode
  webglActive: boolean
  attemptedWebgl: boolean
  changedRenderer: boolean
}

export interface TerminalRendererLifecycleOptions {
  terminalId: string
  terminal: XTerm
  platform: RuntimePlatform
}

// Cooldown thresholds are tuned for "single transient context loss should not
// disable WebGL for 15 seconds". macOS Spaces / Windows virtual desktop swipes
// can produce one short loss; falling back immediately on the first failure
// (the previous Win/Linux policy) was over-aggressive and was part of why the
// blank-Task symptom persisted on those platforms.
export function createTerminalRendererPolicy(platform: RuntimePlatform): TerminalRendererPolicy {
  if (platform === 'darwin') {
    return {
      platform,
      surfaceResumeDebounceMs: 80,
      postResumeFrameCount: 1,
      webglFailureFallbackThreshold: 3,
      webglFallbackCooldownMs: 5000
    }
  }

  return {
    platform,
    surfaceResumeDebounceMs: 120,
    postResumeFrameCount: 1,
    webglFailureFallbackThreshold: 3,
    webglFallbackCooldownMs: 5000
  }
}

export class TerminalRendererLifecycle {
  private readonly terminalId: string
  private readonly terminal: XTerm
  private readonly policy: TerminalRendererPolicy
  private webglAddon: WebglAddon | null = null
  private webglFailureCount = 0
  private webglDisabledUntil: number | null = null
  private lastLifecycleReason: TerminalRendererLifecycleReason | null = null
  private lastLifecycleAt: number | null = null
  private lastSurfaceEvent: TerminalRendererSurfaceEvent | null = null
  private lastSurfaceEventAt: number | null = null

  // Canvas-level state. These survive `disposeWebgl` so the
  // `webglcontextrestored` listener can re-arm the renderer once the GPU
  // surface is alive again — the previous design tore down the addon's
  // `onContextLoss` callback synchronously, so nothing was left listening
  // for the restoration the browser eventually emits.
  private observedCanvas: HTMLCanvasElement | null = null
  private contextLost = false
  private boundHandleContextLost: ((event: Event) => void) | null = null
  private boundHandleContextRestored: ((event: Event) => void) | null = null

  constructor(options: TerminalRendererLifecycleOptions) {
    this.terminalId = options.terminalId
    this.terminal = options.terminal
    this.policy = createTerminalRendererPolicy(options.platform)
  }

  getPolicy(): TerminalRendererPolicy {
    return this.policy
  }

  getSnapshot(): TerminalRendererLifecycleSnapshot {
    return {
      mode: this.getMode(),
      webglActive: this.isWebglActive(),
      webglAvailable: !this.isWebglCooldownActive(performance.now()),
      webglFailureCount: this.webglFailureCount,
      webglDisabledUntil: this.webglDisabledUntil,
      contextLost: this.contextLost,
      hasContextListeners: this.observedCanvas !== null,
      lastLifecycleReason: this.lastLifecycleReason,
      lastLifecycleAt: this.lastLifecycleAt,
      lastSurfaceEvent: this.lastSurfaceEvent,
      lastSurfaceEventAt: this.lastSurfaceEventAt
    }
  }

  getMode(): TerminalRendererMode {
    return this.webglAddon ? 'webgl' : 'fallback'
  }

  isWebglActive(): boolean {
    return this.webglAddon !== null
  }

  /**
   * Returns the canvas this lifecycle is currently observing for context
   * lost/restored events, or null if no listeners are attached. Exposed so
   * the autotest repro layer can reach the same canvas reference we hold
   * (xterm may detach the node from the DOM tree we'd otherwise query).
   */
  getObservedCanvas(): HTMLCanvasElement | null {
    return this.observedCanvas ?? this.findWebglCanvas()
  }

  activate(reason: TerminalRendererLifecycleReason): TerminalRendererLifecycleResult {
    this.markLifecycle(reason)
    return this.ensureWebgl(reason)
  }

  deactivate(reason: TerminalRendererLifecycleReason): TerminalRendererLifecycleResult {
    this.markLifecycle(reason)
    const changedRenderer = this.disposeWebgl(reason)
    return this.buildResult(false, changedRenderer)
  }

  restoreSurface(reason: TerminalRendererSurfaceEvent): TerminalRendererLifecycleResult {
    this.markLifecycle(reason)
    this.lastSurfaceEvent = reason
    this.lastSurfaceEventAt = Date.now()

    if (!this.webglAddon) {
      // Path A: addon was previously disposed (or never attached). After
      // creating a new one, xterm's render service won't repaint until
      // the next PTY write or resize fires — which the autotest harness
      // can't guarantee. Force a viewport refresh so the recovered surface
      // shows the live buffer instead of the empty/zeroed canvas xterm
      // hands back from initial allocation.
      const result = this.ensureWebgl(reason)
      this.refreshTerminalIfActive()
      return result
    }

    try {
      this.webglAddon.clearTextureAtlas()
      // Path B: addon stayed alive across the host surface event but the
      // GPU compositor may have invalidated our tile. clearTextureAtlas
      // only marks rows dirty for rebuild — actual repaint waits for the
      // next PTY write or resize. We can't rely on either firing in time,
      // so force a viewport refresh so xterm re-emits draw calls and the
      // recovered GPU tile gets a current frame committed.
      this.refreshTerminalIfActive()
      return this.buildResult(true, false)
    } catch (error) {
      return this.recreateWebgl(reason, error)
    }
  }

  dispose(): void {
    this.markLifecycle('dispose')
    this.detachContextListeners()
    this.disposeWebgl('dispose')
  }

  private ensureWebgl(reason: TerminalRendererLifecycleReason): TerminalRendererLifecycleResult {
    if (this.webglAddon) {
      return this.buildResult(false, false)
    }

    // If we know the GL context is currently lost, do not hand a brand-new
    // WebglAddon a dead context — that is the original bug. The
    // `webglcontextrestored` listener will re-enter ensureWebgl once the
    // browser successfully re-creates the GPU surface. The same check covers
    // the case where this lifecycle never observed a `lost` event but the
    // canvas drifted into a lost state externally (e.g., GPU process crash).
    if (this.canvasContextIsLost()) {
      perfTrace(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_RESTORE_DEFERRED, {
        terminalId: this.terminalId,
        reason,
        contextLost: true
      })
      return this.buildResult(false, false)
    }

    this.clearExpiredWebglCooldown()
    if (this.isWebglSuppressed()) {
      perfTrace(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_RESTORE_DEFERRED, {
        terminalId: this.terminalId,
        reason,
        suppressedByCooldown: true,
        webglFailureCount: this.webglFailureCount,
        webglDisabledUntil: this.webglDisabledUntil
      })
      return this.buildResult(false, false)
    }

    try {
      const preserveDrawingBuffer = this.shouldPreserveDrawingBuffer()
      const webglAddon = new WebglAddon(preserveDrawingBuffer)
      this.terminal.loadAddon(webglAddon)
      this.webglAddon = webglAddon
      perfMonitor.incrementWebglContextCount()
      this.webglFailureCount = 0
      this.webglDisabledUntil = null
      this.contextLost = false
      this.attachContextListeners()
      perfTrace(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_ENSURE_WEBGL, {
        terminalId: this.terminalId,
        reason,
        ok: true,
        listenersAttached: this.observedCanvas !== null
      })
      return this.buildResult(true, true)
    } catch (error) {
      perfTrace(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_ENSURE_WEBGL, {
        terminalId: this.terminalId,
        reason,
        ok: false,
        error: String(error)
      })
      this.registerWebglFailure(reason, error)
      return this.buildResult(true, false)
    }
  }

  private recreateWebgl(
    reason: TerminalRendererLifecycleReason,
    error: unknown
  ): TerminalRendererLifecycleResult {
    this.disposeWebgl('webgl-context-loss')
    this.registerWebglFailure(reason, error)
    const ensureResult = this.ensureWebgl(reason)
    return {
      ...ensureResult,
      attemptedWebgl: true,
      changedRenderer: true
    }
  }

  private disposeWebgl(reason: TerminalRendererLifecycleReason): boolean {
    const webglAddon = this.webglAddon
    if (!webglAddon) return false

    this.webglAddon = null
    let disposeError: unknown = null
    try {
      webglAddon.dispose()
    } catch (error) {
      disposeError = error
      // xterm.js may already have moved to its internal fallback after context
      // loss; double-disposing is benign.
    }
    perfMonitor.decrementWebglContextCount()
    perfTrace(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_DISPOSE_WEBGL, {
      terminalId: this.terminalId,
      reason,
      disposeError: disposeError ? String(disposeError) : null
    })
    return true
  }

  private registerWebglFailure(reason: TerminalRendererLifecycleReason, error?: unknown): void {
    this.webglFailureCount += 1
    const reachedThreshold = this.webglFailureCount >= this.policy.webglFailureFallbackThreshold

    perfTrace(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_FAILURE, {
      terminalId: this.terminalId,
      reason,
      webglFailureCount: this.webglFailureCount,
      threshold: this.policy.webglFailureFallbackThreshold,
      cooldownActivated: reachedThreshold,
      cooldownMs: this.policy.webglFallbackCooldownMs,
      error: error ? String(error) : null
    })

    if (!reachedThreshold) {
      return
    }

    this.webglDisabledUntil = performance.now() + this.policy.webglFallbackCooldownMs
  }

  // ─────────── Canvas-level WebGL context lifecycle ───────────

  private attachContextListeners(): void {
    const canvas = this.findWebglCanvas()
    if (!canvas) return
    if (this.observedCanvas === canvas && this.boundHandleContextLost) return

    this.detachContextListeners()
    this.observedCanvas = canvas

    this.boundHandleContextLost = (event: Event) => {
      // Calling preventDefault on `webglcontextlost` tells Chromium we want
      // it to attempt to restore the context. Without this the browser
      // never fires `webglcontextrestored` and our recovery never gets a
      // chance to re-run — which is precisely the failure path that the
      // previous synchronous-dispose design never escaped.
      event.preventDefault()
      this.contextLost = true
      perfTrace(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_CONTEXT_LOST, {
        terminalId: this.terminalId,
        webglFailureCountBefore: this.webglFailureCount
      })
      // Intentionally DO NOT call disposeWebgl here. Disposing the addon
      // synchronously prompts xterm to swap to its DOM renderer, which
      // tears the WebGL canvas out of the DOM — and with it our listener
      // for `webglcontextrestored`. The original Spaces-swipe blank Task
      // bug is exactly this: the canvas gets destroyed before Chromium can
      // tell us the GPU surface is back. Keep the addon alive (its render
      // calls are silent no-ops while the GL context is lost — that just
      // freezes the last frame) so the canvas + this listener survive
      // until the restored event arrives.
      this.registerWebglFailure('webgl-context-loss')
    }

    this.boundHandleContextRestored = () => {
      this.contextLost = false
      perfTrace(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_CONTEXT_RESTORED, {
        terminalId: this.terminalId,
        webglFailureCount: this.webglFailureCount
      })
      // The addon's internal renderer still references the old (now-stale)
      // GL state, so swap it out for a fresh one now that the canvas's GL
      // context is alive again, then force a viewport refresh so the live
      // buffer is repainted into the recovered tile.
      this.disposeWebgl('webgl-context-restored')
      const ensureResult = this.ensureWebgl('webgl-context-restored')
      if (ensureResult.webglActive) {
        this.refreshTerminalIfActive()
        perfTrace(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_REFRESH_AFTER_RESTORE, {
          terminalId: this.terminalId
        })
      }
    }

    canvas.addEventListener('webglcontextlost', this.boundHandleContextLost, false)
    canvas.addEventListener('webglcontextrestored', this.boundHandleContextRestored, false)
  }

  private detachContextListeners(): void {
    const canvas = this.observedCanvas
    if (!canvas) return
    if (this.boundHandleContextLost) {
      canvas.removeEventListener('webglcontextlost', this.boundHandleContextLost)
    }
    if (this.boundHandleContextRestored) {
      canvas.removeEventListener('webglcontextrestored', this.boundHandleContextRestored)
    }
    this.observedCanvas = null
    this.boundHandleContextLost = null
    this.boundHandleContextRestored = null
  }

  private findWebglCanvas(): HTMLCanvasElement | null {
    const root = this.terminal.element
    if (!root) return null
    const canvases = root.querySelectorAll<HTMLCanvasElement>('.xterm-screen canvas')
    for (const canvas of Array.from(canvases)) {
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
      if (gl) return canvas
    }
    return null
  }

  private canvasContextIsLost(): boolean {
    // Trust the lifecycle's own `contextLost` flag, which is set in our
    // `webglcontextlost` listener and cleared in our `webglcontextrestored`
    // listener. Querying `observedCanvas.getContext(...).isContextLost()` is
    // tempting but unreliable across xterm WebglAddon's `dispose()` path —
    // the addon may release GPU resources via WEBGL_lose_context internally,
    // leaving the (now-detached) canvas's GL context permanently lost even
    // though we never observed a real context-loss event. That false
    // positive would make ensureWebgl defer forever after a manual
    // deactivate (which the existing TFA-09 surface-loss regression
    // exercises).
    return this.contextLost
  }

  private refreshTerminalIfActive(): void {
    const rows = this.terminal.rows
    if (!Number.isFinite(rows) || rows <= 0) return
    try {
      this.terminal.refresh(0, rows - 1)
    } catch {
      // Refreshing right after a surface event can race with xterm's own
      // re-attach; the next data write or fit will redraw, so swallowing is
      // safe here.
    }
  }

  private shouldPreserveDrawingBuffer(): boolean {
    const debug = window.electronAPI?.debug
    if (!debug?.autotest) return false
    // preserveDrawingBuffer is only enabled for autotest suites that probe
    // the WebGL framebuffer via `gl.readPixels`. Perf, latency, and stress
    // suites measure frame timing and should use production-default
    // context options to avoid measurement skew.
    const suite = (debug.autotestSuite ?? '').toLowerCase()
    const pixelProbingSuites = new Set(['terminal-blank-task-repro', 'terminal-focus-activation'])
    return suite.split(',').some((part) => pixelProbingSuites.has(part.trim()))
  }

  private isWebglSuppressed(): boolean {
    return this.isWebglCooldownActive(performance.now())
  }

  private isWebglCooldownActive(now: number): boolean {
    return this.webglDisabledUntil !== null && now < this.webglDisabledUntil
  }

  private clearExpiredWebglCooldown(): void {
    if (this.webglDisabledUntil === null || performance.now() < this.webglDisabledUntil) {
      return
    }

    this.webglDisabledUntil = null
    this.webglFailureCount = 0
  }

  private markLifecycle(reason: TerminalRendererLifecycleReason): void {
    this.lastLifecycleReason = reason
    this.lastLifecycleAt = Date.now()
  }

  private buildResult(
    attemptedWebgl: boolean,
    changedRenderer: boolean
  ): TerminalRendererLifecycleResult {
    return {
      mode: this.getMode(),
      webglActive: this.isWebglActive(),
      attemptedWebgl,
      changedRenderer
    }
  }
}
