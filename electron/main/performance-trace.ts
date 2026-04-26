/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { app } from 'electron'
import { getAppInfo } from './app-info'

type TracePhase = 'X' | 'i' | 'C' | 'M' | 's' | 't' | 'f'
type TraceScope = 'g' | 'p' | 't'
type TraceArgValue = string | number | boolean | null | string[] | number[] | boolean[]
type TraceArgs = Record<string, TraceArgValue | undefined>
type TraceTaskState = 'idle' | 'input_pending' | 'running' | 'output_active' | 'exited'

export interface RendererTraceEvent {
  name: string
  cat?: string
  ph?: TracePhase
  ts?: number
  dur?: number
  tid?: number
  id?: string
  scope?: TraceScope
  args?: TraceArgs
}

export interface TraceContext {
  traceFlowId?: string
}

interface ChromeTraceEvent {
  name: string
  ph: TracePhase
  pid: number
  tid: number
  ts?: number
  dur?: number
  cat?: string
  id?: string
  s?: TraceScope
  args?: Record<string, TraceArgValue>
}

interface TaskActivity {
  state: TraceTaskState
  flowId: string | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

const MAIN_THREAD_ID = 1
const RENDERER_THREAD_ID = 1
const TASK_IDLE_DELAY_MS = 1000
const MAX_TRACE_EVENTS = 200000
const MAX_CAPTURED_STRING_LENGTH = 240
const MAX_CAPTURED_ARRAY_LENGTH = 50

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

// Periodic flush interval: writes the in-memory event buffer to disk every
// N seconds so a crash loses at most this much of the capture. Default 30s;
// set ONWARD_PERF_TRACE_FLUSH_SEC=0 to disable (final flush on quit still runs).
const PERIODIC_FLUSH_SEC = (() => {
  const raw = process.env.ONWARD_PERF_TRACE_FLUSH_SEC
  if (raw === '0') return 0
  return parsePositiveInt(raw, 30)
})()

// Byte-bounded ring complement to MAX_TRACE_EVENTS. Under sustained PTY
// flood with content capture, individual events can be ~hundreds of bytes
// each — 200 000 events × 500 B is ~100 MB; a malicious or accidental
// large content burst could push past that. The byte cap caps memory
// regardless of count.
const MAX_TRACE_BYTES = parsePositiveInt(process.env.ONWARD_PERF_TRACE_MAX_MB, 256) * 1024 * 1024

const SENSITIVE_KEY_RE = /(content|text|input|output|prompt|path|cwd|url|env|error|file|value|preview|raw)/i
const ALLOWED_STRING_KEYS = new Set([
  'action',
  'bufferMode',
  'cat',
  'channel',
  'commandKind',
  'flowId',
  'inputKind',
  'kind',
  'mode',
  'phase',
  'reason',
  'result',
  'route',
  'schema',
  'shellKind',
  'state',
  'terminalId'
])

class PerformanceTrace {
  readonly enabled = process.env.ONWARD_PERF_TRACE === '1'
  readonly captureContent = this.enabled && process.env.ONWARD_PERF_TRACE_CAPTURE_CONTENT === '1'

  private initialized = false
  private filePath: string | null = null
  private events: ChromeTraceEvent[] = []
  private droppedEvents = 0
  private currentBytes = 0
  private flowCounter = 0
  private taskThreadCounter = 0
  private readonly salt = randomBytes(16).toString('hex')
  private readonly mainPid = process.pid
  private readonly rendererPid = process.pid + 100000
  private readonly taskPid = process.pid + 200000
  private taskThreadIds = new Map<string, number>()
  private taskActivities = new Map<string, TaskActivity>()
  private periodicFlushTimer: ReturnType<typeof setInterval> | null = null

  initialize(): void {
    if (!this.enabled || this.initialized) return
    this.initialized = true

    const dir = join(app.getPath('userData'), 'performance-traces')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    this.filePath = join(dir, `onward-perf-trace-${timestamp}-${process.pid}.json`)
    console.log(`[PerfTrace] Active (ONWARD_PERF_TRACE=1): ${this.filePath}`)
    if (this.captureContent) {
      console.log('[PerfTrace] Sensitive content capture active (ONWARD_PERF_TRACE_CAPTURE_CONTENT=1)')
    }

    this.recordMetadata(this.mainPid, MAIN_THREAD_ID, 'process_name', 'Onward Main')
    this.recordMetadata(this.mainPid, MAIN_THREAD_ID, 'thread_name', 'main')
    this.recordMetadata(this.rendererPid, RENDERER_THREAD_ID, 'process_name', 'Onward Renderer')
    this.recordMetadata(this.rendererPid, RENDERER_THREAD_ID, 'thread_name', 'renderer-main')
    this.recordMetadata(this.taskPid, 0, 'process_name', 'Onward Tasks')

    const appInfo = getAppInfo()
    this.recordInstant('trace.session.start', {
      schema: 'onward.perf_trace.v1',
      platform: process.platform,
      appVersion: appInfo.version,
      buildChannel: appInfo.buildChannel,
      contentCaptured: this.captureContent,
      flushIntervalSec: PERIODIC_FLUSH_SEC,
      maxBufferMB: Math.floor(MAX_TRACE_BYTES / (1024 * 1024))
    })

    // Schedule periodic flush so a crash loses at most PERIODIC_FLUSH_SEC of
    // capture. Disabled when env var is 0; the final flush in requestQuit()
    // is still authoritative and runs regardless.
    if (PERIODIC_FLUSH_SEC > 0) {
      this.periodicFlushTimer = setInterval(() => {
        try { this.flush('periodic') } catch (error) {
          console.warn('[PerfTrace] periodic flush failed:', String(error))
        }
      }, PERIODIC_FLUSH_SEC * 1000)
      this.periodicFlushTimer.unref?.()
      console.log(`[PerfTrace] Periodic flush every ${PERIODIC_FLUSH_SEC}s, max buffer ${Math.floor(MAX_TRACE_BYTES / (1024 * 1024))}MB`)
    } else {
      console.log(`[PerfTrace] Periodic flush disabled (ONWARD_PERF_TRACE_FLUSH_SEC=0); final flush on quit only`)
    }
  }

  getStatus(): Record<string, string | number | boolean | null> {
    return {
      enabled: this.enabled,
      captureContent: this.captureContent,
      initialized: this.initialized,
      filePath: this.filePath,
      eventCount: this.events.length,
      droppedEvents: this.droppedEvents
    }
  }

  nowUs(): number {
    return Math.round((performance.timeOrigin + performance.now()) * 1000)
  }

  createFlowId(prefix = 'flow'): string {
    this.flowCounter += 1
    return `${prefix}-${Date.now().toString(36)}-${this.flowCounter.toString(36)}`
  }

  summarizeText(prefix: string, value: string): TraceArgs {
    const normalizedPrefix = prefix || 'payload'
    const summary: TraceArgs = {
      [`${normalizedPrefix}Length`]: value.length,
      [`${normalizedPrefix}LineCount`]: value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length,
      [`${normalizedPrefix}Hash`]: this.hashText(value)
    }

    if (this.captureContent) {
      summary[`${normalizedPrefix}Preview`] = this.truncateString(value)
      summary.contentCaptured = true
    }

    return summary
  }

  recordRendererEvent(event: RendererTraceEvent): void {
    if (!this.enabled || !event || typeof event.name !== 'string') return
    this.addEvent({
      name: event.name,
      cat: event.cat ?? 'renderer',
      ph: event.ph ?? 'i',
      ts: typeof event.ts === 'number' ? Math.round(event.ts) : this.nowUs(),
      dur: typeof event.dur === 'number' ? Math.max(0, Math.round(event.dur)) : undefined,
      pid: this.rendererPid,
      tid: typeof event.tid === 'number' ? event.tid : RENDERER_THREAD_ID,
      id: typeof event.id === 'string' ? event.id : undefined,
      s: event.scope,
      args: this.sanitizeArgs(event.args)
    })
  }

  recordInstant(name: string, args?: TraceArgs, cat = 'main'): void {
    if (!this.enabled) return
    this.addEvent({
      name,
      cat,
      ph: 'i',
      ts: this.nowUs(),
      pid: this.mainPid,
      tid: MAIN_THREAD_ID,
      args: this.sanitizeArgs(args)
    })
  }

  recordCounter(name: string, args?: TraceArgs, cat = 'counter'): void {
    if (!this.enabled) return
    this.addEvent({
      name,
      cat,
      ph: 'C',
      ts: this.nowUs(),
      pid: this.mainPid,
      tid: MAIN_THREAD_ID,
      args: this.sanitizeArgs(args)
    })
  }

  recordComplete(name: string, startUs: number, args?: TraceArgs, cat = 'main'): void {
    if (!this.enabled) return
    const now = this.nowUs()
    this.addEvent({
      name,
      cat,
      ph: 'X',
      ts: startUs,
      dur: Math.max(0, now - startUs),
      pid: this.mainPid,
      tid: MAIN_THREAD_ID,
      args: this.sanitizeArgs(args)
    })
  }

  timeSync<T>(name: string, args: TraceArgs | undefined, fn: () => T, cat = 'main'): T {
    if (!this.enabled) return fn()
    const startUs = this.nowUs()
    try {
      const result = fn()
      this.recordComplete(name, startUs, { ...args, result: 'success' }, cat)
      return result
    } catch (error) {
      this.recordComplete(name, startUs, { ...args, result: 'error', errorType: this.errorType(error) }, cat)
      throw error
    }
  }

  async timeAsync<T>(name: string, args: TraceArgs | undefined, fn: () => Promise<T>, cat = 'main'): Promise<T> {
    if (!this.enabled) return await fn()
    const startUs = this.nowUs()
    try {
      const result = await fn()
      this.recordComplete(name, startUs, { ...args, result: 'success' }, cat)
      return result
    } catch (error) {
      this.recordComplete(name, startUs, { ...args, result: 'error', errorType: this.errorType(error) }, cat)
      throw error
    }
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

  markTaskInput(terminalId: string, flowId?: string | null, args?: TraceArgs): void {
    this.setTaskState(terminalId, 'input_pending', flowId ?? null, args)
  }

  markTaskRunning(terminalId: string, flowId?: string | null, args?: TraceArgs): void {
    this.setTaskState(terminalId, 'running', flowId ?? null, args)
  }

  markTaskOutput(terminalId: string, bytes: number): void {
    const current = this.taskActivities.get(terminalId)
    this.setTaskState(terminalId, 'output_active', current?.flowId ?? null, { bytes })
    this.scheduleTaskIdle(terminalId)
  }

  markTaskExited(terminalId: string, exitCode?: number, signal?: number): void {
    const current = this.taskActivities.get(terminalId)
    this.setTaskState(terminalId, 'exited', current?.flowId ?? null, { exitCode, signal })
  }

  markTaskIdle(terminalId: string, reason: string): void {
    const current = this.taskActivities.get(terminalId)
    this.setTaskState(terminalId, 'idle', current?.flowId ?? null, { reason })
  }

  getTaskFlowId(terminalId: string): string | null {
    return this.taskActivities.get(terminalId)?.flowId ?? null
  }

  flush(reason = 'manual'): Record<string, string | number | boolean | null> {
    if (!this.enabled || !this.filePath) {
      return this.getStatus()
    }

    const startUs = this.nowUs()
    this.recordComplete('trace.session.flush', startUs, {
      reason,
      eventCount: this.events.length,
      droppedEvents: this.droppedEvents
    }, 'trace')

    const payload = {
      traceEvents: this.events,
      metadata: {
        schema: 'onward.perf_trace.v1',
        generatedAt: new Date().toISOString(),
        droppedEvents: this.droppedEvents,
        contentCaptured: this.captureContent
      }
    }

    writeFileSync(this.filePath, JSON.stringify(payload), 'utf-8')
    return this.getStatus()
  }

  private recordFlow(name: string, ph: 's' | 't' | 'f', flowId: string, args?: TraceArgs, cat = 'flow'): void {
    if (!this.enabled || !flowId) return
    this.addEvent({
      name,
      cat,
      ph,
      ts: this.nowUs(),
      pid: this.mainPid,
      tid: MAIN_THREAD_ID,
      id: flowId,
      s: 'g',
      args: this.sanitizeArgs(args)
    })
  }

  private setTaskState(terminalId: string, state: TraceTaskState, flowId: string | null, args?: TraceArgs): void {
    if (!this.enabled || !terminalId) return
    const current = this.taskActivities.get(terminalId)
    if (current?.idleTimer) {
      clearTimeout(current.idleTimer)
      current.idleTimer = null
    }

    const nextFlowId = flowId ?? current?.flowId ?? null
    const threadId = this.getTaskThreadId(terminalId)
    this.taskActivities.set(terminalId, { state, flowId: nextFlowId, idleTimer: null })
    this.addEvent({
      name: 'terminal.task.state',
      cat: 'task',
      ph: 'i',
      ts: this.nowUs(),
      pid: this.taskPid,
      tid: threadId,
      args: this.sanitizeArgs({
        terminalId,
        state,
        flowId: nextFlowId ?? undefined,
        ...args
      })
    })
  }

  private scheduleTaskIdle(terminalId: string): void {
    const current = this.taskActivities.get(terminalId)
    if (!current) return
    current.idleTimer = setTimeout(() => {
      this.markTaskIdle(terminalId, 'output-idle-timeout')
    }, TASK_IDLE_DELAY_MS)
  }

  private getTaskThreadId(terminalId: string): number {
    const existing = this.taskThreadIds.get(terminalId)
    if (existing !== undefined) return existing

    this.taskThreadCounter += 1
    const threadId = this.taskThreadCounter
    this.taskThreadIds.set(terminalId, threadId)
    this.recordMetadata(this.taskPid, threadId, 'thread_name', `task:${terminalId}`)
    return threadId
  }

  private recordMetadata(pid: number, tid: number, name: string, value: string): void {
    this.addEvent({
      name,
      ph: 'M',
      pid,
      tid,
      args: { name: value }
    })
  }

  private addEvent(event: ChromeTraceEvent): void {
    if (!this.enabled) return
    if (this.events.length >= MAX_TRACE_EVENTS) {
      this.droppedEvents += 1
      return
    }
    const eventBytes = estimateEventBytes(event)
    if (this.currentBytes + eventBytes > MAX_TRACE_BYTES) {
      this.droppedEvents += 1
      return
    }
    this.events.push(event)
    this.currentBytes += eventBytes
  }

  private sanitizeArgs(args?: TraceArgs): Record<string, TraceArgValue> | undefined {
    if (!args) return undefined
    const result: Record<string, TraceArgValue> = {}

    for (const [key, rawValue] of Object.entries(args)) {
      if (rawValue === undefined) continue
      const sanitized = this.sanitizeValue(key, rawValue)
      if (sanitized !== undefined) {
        result[key] = sanitized
      }
    }

    return Object.keys(result).length > 0 ? result : undefined
  }

  private sanitizeValue(key: string, value: TraceArgValue): TraceArgValue | undefined {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      return value
    }

    if (typeof value === 'string') {
      if (this.isSensitiveKey(key) && !this.captureContent) return undefined
      return this.truncateString(value)
    }

    if (Array.isArray(value)) {
      const values = value.slice(0, MAX_CAPTURED_ARRAY_LENGTH)
      if (values.every(item => typeof item === 'string')) {
        if (this.isSensitiveKey(key) && !this.captureContent) return undefined
        return values.map(item => this.truncateString(item)) as string[]
      }
      if (values.every(item => typeof item === 'number')) return values as number[]
      if (values.every(item => typeof item === 'boolean')) return values as boolean[]
    }

    return undefined
  }

  private isSensitiveKey(key: string): boolean {
    if (ALLOWED_STRING_KEYS.has(key)) return false
    return SENSITIVE_KEY_RE.test(key)
  }

  private truncateString(value: string): string {
    if (value.length <= MAX_CAPTURED_STRING_LENGTH) return value
    return `${value.slice(0, MAX_CAPTURED_STRING_LENGTH)}...`
  }

  private hashText(value: string): string {
    return createHash('sha256')
      .update(this.salt)
      .update(value)
      .digest('hex')
      .slice(0, 16)
  }

  private errorType(error: unknown): string {
    if (error instanceof Error) return error.name || 'Error'
    return typeof error
  }
}

/**
 * Estimate JSON-encoded byte size of a trace event without running
 * JSON.stringify on the hot path. Accurate enough for ring-buffer accounting;
 * over-estimates are safer than under-estimates.
 */
function estimateEventBytes(event: ChromeTraceEvent): number {
  let size = 64 + event.name.length
  if (event.cat) size += event.cat.length
  if (event.dur !== undefined) size += 12
  if (event.ts !== undefined) size += 12
  if (event.id) size += event.id.length + 4
  if (event.s) size += 4
  if (event.args) {
    for (const [k, v] of Object.entries(event.args)) {
      size += k.length + 4
      if (typeof v === 'string') size += v.length + 2
      else if (typeof v === 'number') size += 16
      else if (typeof v === 'boolean') size += 5
      else if (Array.isArray(v)) size += 16 + v.length * 8
      else size += 16
    }
  }
  return size
}

export const performanceTrace = new PerformanceTrace()
