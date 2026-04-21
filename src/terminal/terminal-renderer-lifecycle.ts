/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Terminal as XTerm } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { perfMonitor } from '../utils/perf-monitor'

export type RuntimePlatform = 'darwin' | 'win32' | 'linux'

export type TerminalRendererMode = 'webgl' | 'fallback'

export type TerminalRendererSurfaceEvent =
  | 'window-focus'
  | 'document-visible'
  | 'page-show'
  | 'manual-debug'
  | 'webgl-context-loss'

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
  onContextLoss: (terminalId: string) => void
}

export function createTerminalRendererPolicy(platform: RuntimePlatform): TerminalRendererPolicy {
  if (platform === 'darwin') {
    return {
      platform,
      surfaceResumeDebounceMs: 80,
      postResumeFrameCount: 1,
      webglFailureFallbackThreshold: 2,
      webglFallbackCooldownMs: 5000
    }
  }

  if (platform === 'win32') {
    return {
      platform,
      surfaceResumeDebounceMs: 120,
      postResumeFrameCount: 1,
      webglFailureFallbackThreshold: 1,
      webglFallbackCooldownMs: 15000
    }
  }

  return {
    platform,
    surfaceResumeDebounceMs: 120,
    postResumeFrameCount: 1,
    webglFailureFallbackThreshold: 1,
    webglFallbackCooldownMs: 15000
  }
}

export class TerminalRendererLifecycle {
  private readonly terminalId: string
  private readonly terminal: XTerm
  private readonly policy: TerminalRendererPolicy
  private readonly onContextLoss: (terminalId: string) => void
  private webglAddon: WebglAddon | null = null
  private webglFailureCount = 0
  private webglDisabledUntil: number | null = null
  private lastLifecycleReason: TerminalRendererLifecycleReason | null = null
  private lastLifecycleAt: number | null = null
  private lastSurfaceEvent: TerminalRendererSurfaceEvent | null = null
  private lastSurfaceEventAt: number | null = null

  constructor(options: TerminalRendererLifecycleOptions) {
    this.terminalId = options.terminalId
    this.terminal = options.terminal
    this.policy = createTerminalRendererPolicy(options.platform)
    this.onContextLoss = options.onContextLoss
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

  activate(reason: TerminalRendererLifecycleReason): TerminalRendererLifecycleResult {
    this.markLifecycle(reason)
    return this.ensureWebgl(reason)
  }

  deactivate(reason: TerminalRendererLifecycleReason): TerminalRendererLifecycleResult {
    this.markLifecycle(reason)
    const changedRenderer = this.disposeWebgl()
    return this.buildResult(false, changedRenderer)
  }

  restoreSurface(reason: TerminalRendererSurfaceEvent): TerminalRendererLifecycleResult {
    this.markLifecycle(reason)
    this.lastSurfaceEvent = reason
    this.lastSurfaceEventAt = Date.now()

    if (!this.webglAddon) {
      return this.ensureWebgl(reason)
    }

    try {
      this.webglAddon.clearTextureAtlas()
      return this.buildResult(true, false)
    } catch (error) {
      return this.recreateWebgl(reason, error)
    }
  }

  dispose(): void {
    this.markLifecycle('dispose')
    this.disposeWebgl()
  }

  private ensureWebgl(reason: TerminalRendererLifecycleReason): TerminalRendererLifecycleResult {
    if (this.webglAddon) {
      return this.buildResult(false, false)
    }

    this.clearExpiredWebglCooldown()
    if (this.isWebglSuppressed()) {
      return this.buildResult(false, false)
    }

    try {
      const preserveDrawingBuffer = window.electronAPI?.debug?.autotest ? true : undefined
      const webglAddon = new WebglAddon(preserveDrawingBuffer)
      webglAddon.onContextLoss(() => {
        if (this.webglAddon !== webglAddon) return
        console.warn(`[TerminalRenderer ${this.terminalId}] WebGL context lost`)
        this.disposeWebgl()
        this.registerWebglFailure('webgl-context-loss')
        this.onContextLoss(this.terminalId)
      })
      this.terminal.loadAddon(webglAddon)
      this.webglAddon = webglAddon
      perfMonitor.incrementWebglContextCount()
      this.webglFailureCount = 0
      this.webglDisabledUntil = null
      return this.buildResult(true, true)
    } catch (error) {
      this.registerWebglFailure(reason, error)
      return this.buildResult(true, false)
    }
  }

  private recreateWebgl(
    reason: TerminalRendererLifecycleReason,
    error: unknown
  ): TerminalRendererLifecycleResult {
    console.warn(`[TerminalRenderer ${this.terminalId}] WebGL renderer refresh failed during ${reason}`, error)
    this.disposeWebgl()
    this.registerWebglFailure(reason, error)
    const ensureResult = this.ensureWebgl(reason)
    return {
      ...ensureResult,
      attemptedWebgl: true,
      changedRenderer: true
    }
  }

  private disposeWebgl(): boolean {
    const webglAddon = this.webglAddon
    if (!webglAddon) return false

    this.webglAddon = null
    try {
      webglAddon.dispose()
    } catch {
      // xterm.js may already have moved to its internal fallback after context loss.
    }
    perfMonitor.decrementWebglContextCount()
    return true
  }

  private registerWebglFailure(reason: TerminalRendererLifecycleReason, error?: unknown): void {
    this.webglFailureCount += 1

    if (this.webglFailureCount < this.policy.webglFailureFallbackThreshold) {
      return
    }

    this.webglDisabledUntil = performance.now() + this.policy.webglFallbackCooldownMs
    if (error) {
      console.warn(
        `[TerminalRenderer ${this.terminalId}] Falling back from WebGL after ${reason}`,
        error
      )
    } else {
      console.warn(`[TerminalRenderer ${this.terminalId}] Falling back from WebGL after ${reason}`)
    }
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
