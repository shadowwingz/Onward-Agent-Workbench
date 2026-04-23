/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export const PERF_TRACE_ENABLED = process.env.ONWARD_PERF_TRACE === '1'

type TracePayload = Record<string, unknown> | undefined

interface PerfTraceInfo {
  enabled: boolean
  logPath: string | null
  latestPointerPath: string
  eventLoop: EventLoopStallMetrics
}

export interface EventLoopStallMetrics {
  resetAt: number
  totalSamples: number
  stallCount: number
  maxDriftMs: number
  over100Ms: number
  over250Ms: number
  over500Ms: number
  over1000Ms: number
  over3000Ms: number
  over6000Ms: number
  lastStallAt: number | null
  recentStalls: Array<{ ts: number; driftMs: number }>
}

const LATEST_POINTER_PATH = join(tmpdir(), 'onward-perf-trace-latest.txt')
const MAX_OBJECT_DEPTH = 5
const MAX_ARRAY_ITEMS = 80
const MAX_OBJECT_KEYS = 80
const MAX_STRING_LENGTH = 4000
const MAX_RECENT_EVENT_LOOP_STALLS = 40

function createEventLoopStallMetrics(resetAt = Date.now()): EventLoopStallMetrics {
  return {
    resetAt,
    totalSamples: 0,
    stallCount: 0,
    maxDriftMs: 0,
    over100Ms: 0,
    over250Ms: 0,
    over500Ms: 0,
    over1000Ms: 0,
    over3000Ms: 0,
    over6000Ms: 0,
    lastStallAt: null,
    recentStalls: []
  }
}

function cloneEventLoopStallMetrics(metrics: EventLoopStallMetrics): EventLoopStallMetrics {
  return {
    ...metrics,
    recentStalls: metrics.recentStalls.map((entry) => ({ ...entry }))
  }
}

function normalizeTraceValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated:${value.length}]`
      : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack?.slice(0, MAX_STRING_LENGTH) ?? null
    }
  }
  if (depth >= MAX_OBJECT_DEPTH) return '[MaxDepth]'
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => normalizeTraceValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
      result[key] = normalizeTraceValue(nestedValue, depth + 1)
    }
    return result
  }
  return String(value)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(normalizeTraceValue(value))
  } catch (error) {
    return JSON.stringify({
      serializationError: String(error)
    })
  }
}

class PerfTraceLogger {
  private stream: WriteStream | null = null
  private logPath: string | null = null
  private initialized = false
  private eventLoopTimer: ReturnType<typeof setInterval> | null = null
  private gitRuntimeTimer: ReturnType<typeof setInterval> | null = null
  private eventLoopMetrics: EventLoopStallMetrics = createEventLoopStallMetrics()

  isEnabled(): boolean {
    return PERF_TRACE_ENABLED
  }

  start(): void {
    if (!PERF_TRACE_ENABLED || this.initialized) return
    this.initialized = true

    const logDir = join(app.getPath('userData'), 'debug')
    mkdirSync(logDir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    this.logPath = join(logDir, `perf-trace-${timestamp}-${process.pid}.jsonl`)
    this.stream = createWriteStream(this.logPath, { flags: 'a', encoding: 'utf8' })
    writeFileSync(LATEST_POINTER_PATH, this.logPath, 'utf8')
    console.log(`[PerfTrace] enabled (ONWARD_PERF_TRACE=1) path=${this.logPath}`)
    this.record('main:trace-start', {
      logPath: this.logPath,
      pid: process.pid,
      platform: process.platform,
      appVersion: app.getVersion()
    })
  }

  getInfo(): PerfTraceInfo {
    if (PERF_TRACE_ENABLED) {
      this.start()
    }
    return {
      enabled: PERF_TRACE_ENABLED,
      logPath: this.logPath,
      latestPointerPath: LATEST_POINTER_PATH,
      eventLoop: this.getEventLoopMetrics()
    }
  }

  resetEventLoopMetrics(): EventLoopStallMetrics {
    this.eventLoopMetrics = createEventLoopStallMetrics()
    this.record('main:event-loop-metrics-reset', {
      resetAt: this.eventLoopMetrics.resetAt
    })
    return this.getEventLoopMetrics()
  }

  getEventLoopMetrics(): EventLoopStallMetrics {
    return cloneEventLoopStallMetrics(this.eventLoopMetrics)
  }

  record(event: string, data?: TracePayload): void {
    if (!PERF_TRACE_ENABLED) return
    this.start()
    if (!this.stream || !this.logPath) return

    const line = safeStringify({
      ts: Date.now(),
      pid: process.pid,
      processType: 'main',
      event,
      data: data ?? {}
    })
    this.stream.write(`${line}\n`)
  }

  startEventLoopMonitor(): void {
    if (!PERF_TRACE_ENABLED || this.eventLoopTimer) return
    this.start()

    const intervalMs = 250
    const stallThresholdMs = 100
    let expectedAt = Date.now() + intervalMs

    this.eventLoopTimer = setInterval(() => {
      const now = Date.now()
      const driftMs = now - expectedAt
      expectedAt = now + intervalMs
      this.eventLoopMetrics.totalSamples += 1
      if (driftMs >= stallThresholdMs) {
        this.recordEventLoopStall(now, driftMs)
        this.record('main:event-loop-stall', {
          driftMs,
          intervalMs,
          stallThresholdMs
        })
      }
    }, intervalMs)
    this.eventLoopTimer.unref?.()
  }

  private recordEventLoopStall(ts: number, driftMs: number): void {
    const metrics = this.eventLoopMetrics
    metrics.stallCount += 1
    metrics.maxDriftMs = Math.max(metrics.maxDriftMs, driftMs)
    metrics.lastStallAt = ts
    if (driftMs >= 100) metrics.over100Ms += 1
    if (driftMs >= 250) metrics.over250Ms += 1
    if (driftMs >= 500) metrics.over500Ms += 1
    if (driftMs >= 1000) metrics.over1000Ms += 1
    if (driftMs >= 3000) metrics.over3000Ms += 1
    if (driftMs >= 6000) metrics.over6000Ms += 1
    metrics.recentStalls.push({
      ts,
      driftMs: Math.round(driftMs)
    })
    if (metrics.recentStalls.length > MAX_RECENT_EVENT_LOOP_STALLS) {
      metrics.recentStalls.splice(0, metrics.recentStalls.length - MAX_RECENT_EVENT_LOOP_STALLS)
    }
  }

  startGitRuntimeMonitor(getMetrics: () => unknown): void {
    if (!PERF_TRACE_ENABLED || this.gitRuntimeTimer) return
    this.start()

    this.gitRuntimeTimer = setInterval(() => {
      try {
        this.record('main:git-runtime-summary', getMetrics() as TracePayload)
      } catch (error) {
        this.record('main:git-runtime-summary-error', { error: String(error) })
      }
    }, 1000)
    this.gitRuntimeTimer.unref?.()
  }

  stop(): void {
    if (this.eventLoopTimer) {
      clearInterval(this.eventLoopTimer)
      this.eventLoopTimer = null
    }
    if (this.gitRuntimeTimer) {
      clearInterval(this.gitRuntimeTimer)
      this.gitRuntimeTimer = null
    }
    if (this.stream) {
      this.record('main:trace-stop')
      this.stream.end()
      this.stream = null
    }
  }
}

export const perfTraceLogger = new PerfTraceLogger()
