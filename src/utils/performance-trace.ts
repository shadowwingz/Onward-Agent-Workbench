/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PerformanceTraceContext, PerformanceTraceRendererEvent } from '../types/electron.d.ts'

type TraceArgs = NonNullable<PerformanceTraceRendererEvent['args']>

const MAX_PREVIEW_LENGTH = 240
const TERMINAL_FLOW_IDLE_MS = 1200

class RendererPerformanceTrace {
  readonly enabled = Boolean(window.electronAPI?.debug?.perfTraceEnabled)
  readonly captureContent = Boolean(window.electronAPI?.debug?.perfTraceCaptureContent)

  private flowCounter = 0
  private readonly salt = Math.random().toString(36).slice(2)
  private terminalFlows = new Map<string, { flowId: string; timer: number | null }>()

  nowUs(): number {
    return Math.round((performance.timeOrigin + performance.now()) * 1000)
  }

  createFlowId(prefix = 'renderer-flow'): string {
    this.flowCounter += 1
    return `${prefix}-${Date.now().toString(36)}-${this.flowCounter.toString(36)}`
  }

  context(flowId?: string | null): PerformanceTraceContext | undefined {
    return flowId ? { traceFlowId: flowId } : undefined
  }

  summarizeText(prefix: string, value: string): TraceArgs {
    const normalizedPrefix = prefix || 'payload'
    const summary: TraceArgs = {
      [`${normalizedPrefix}Length`]: value.length,
      [`${normalizedPrefix}LineCount`]: value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length,
      [`${normalizedPrefix}Hash`]: this.hashText(value)
    }

    if (this.captureContent) {
      summary[`${normalizedPrefix}Preview`] = this.truncate(value)
      summary.contentCaptured = true
    }

    return summary
  }

  setActiveTerminalFlow(terminalId: string, flowId: string): void {
    if (!terminalId || !flowId) return
    const existing = this.terminalFlows.get(terminalId)
    if (existing?.timer !== null && existing?.timer !== undefined) {
      window.clearTimeout(existing.timer)
    }
    const timer = window.setTimeout(() => {
      this.terminalFlows.delete(terminalId)
    }, TERMINAL_FLOW_IDLE_MS)
    this.terminalFlows.set(terminalId, { flowId, timer })
  }

  getActiveTerminalFlow(terminalId: string): string | null {
    return this.terminalFlows.get(terminalId)?.flowId ?? null
  }

  refreshTerminalFlow(terminalId: string): void {
    const active = this.terminalFlows.get(terminalId)
    if (!active) return
    this.setActiveTerminalFlow(terminalId, active.flowId)
  }

  recordInstant(name: string, args?: TraceArgs, cat = 'renderer'): void {
    this.record({ name, cat, ph: 'i', ts: this.nowUs(), args })
  }

  recordCounter(name: string, args?: TraceArgs, cat = 'counter'): void {
    this.record({ name, cat, ph: 'C', ts: this.nowUs(), args })
  }

  recordComplete(name: string, startUs: number, args?: TraceArgs, cat = 'renderer'): void {
    this.record({
      name,
      cat,
      ph: 'X',
      ts: startUs,
      dur: Math.max(0, this.nowUs() - startUs),
      args
    })
  }

  recordFlowStart(name: string, flowId: string, args?: TraceArgs, cat = 'flow'): void {
    this.recordFlow(name, 's', flowId, args, cat)
  }

  recordFlowStep(name: string, flowId: string, args?: TraceArgs, cat = 'flow'): void {
    this.recordFlow(name, 't', flowId, args, cat)
  }

  recordFlowEnd(name: string, flowId: string, args?: TraceArgs, cat = 'flow'): void {
    this.recordFlow(name, 'f', flowId, args, cat)
  }

  async timeAsync<T>(name: string, args: TraceArgs | undefined, fn: () => Promise<T>, cat = 'renderer'): Promise<T> {
    if (!this.enabled) return await fn()
    const startUs = this.nowUs()
    try {
      const result = await fn()
      this.recordComplete(name, startUs, { ...args, result: 'success' }, cat)
      return result
    } catch (error) {
      this.recordComplete(name, startUs, {
        ...args,
        result: 'error',
        errorType: error instanceof Error ? error.name : typeof error
      }, cat)
      throw error
    }
  }

  private recordFlow(
    name: string,
    ph: NonNullable<PerformanceTraceRendererEvent['ph']>,
    flowId: string,
    args?: TraceArgs,
    cat = 'flow'
  ): void {
    if (!flowId) return
    this.record({ name, cat, ph, ts: this.nowUs(), id: flowId, scope: 'g', args })
  }

  private record(event: PerformanceTraceRendererEvent): void {
    if (!this.enabled) return
    window.electronAPI.debug.recordPerfTrace(event)
  }

  private truncate(value: string): string {
    if (value.length <= MAX_PREVIEW_LENGTH) return value
    return `${value.slice(0, MAX_PREVIEW_LENGTH)}...`
  }

  private hashText(value: string): string {
    let hash = 2166136261
    const input = `${this.salt}:${value}`
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
  }
}

export const performanceTrace = new RendererPerformanceTrace()
