/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { inputPriorityLane } from './input-priority-lane'

export interface TerminalOutputTarget {
  id: string
  hasPendingData: () => boolean
  isOutputActive: () => boolean
  isInteractive: () => boolean
  consumeChunk: (maxBytes: number) => string | null
  writeData: (data: string) => void
}

type TerminalOutputQueueName = 'focused-task' | 'visible-task' | 'background'

interface TerminalOutputSchedulerOptions {
  batchIntervalMs?: number
  minFlushIntervalMs?: number
  visibleFrameBudgetMs?: number
  inputPressureFrameBudgetMs?: number
  focusedFrameBudgetMs?: number
  normalFrameBudgetMs?: number
  interactiveFrameBudgetMs?: number
  visibleChunkBytes?: number
  focusedChunkBytes?: number
  normalChunkBytes?: number
  interactiveChunkBytes?: number
  backgroundChunkBytes?: number
  promptInputMaxYieldMs?: number
  inputPressureMaxYieldMs?: number
}

const DEFAULT_OPTIONS: Required<TerminalOutputSchedulerOptions> = {
  batchIntervalMs: 20,
  minFlushIntervalMs: 20,
  visibleFrameBudgetMs: 5,
  inputPressureFrameBudgetMs: 1.5,
  focusedFrameBudgetMs: 8,
  normalFrameBudgetMs: 5,
  interactiveFrameBudgetMs: 8,
  visibleChunkBytes: 64 * 1024,
  focusedChunkBytes: 128 * 1024,
  normalChunkBytes: 64 * 1024,
  interactiveChunkBytes: 128 * 1024,
  backgroundChunkBytes: 16 * 1024,
  promptInputMaxYieldMs: 220,
  inputPressureMaxYieldMs: 220
}

const QUEUE_ORDER: TerminalOutputQueueName[] = ['focused-task', 'visible-task', 'background']

export class TerminalOutputScheduler {
  private readonly options: Required<TerminalOutputSchedulerOptions>
  private readonly targets = new Map<string, TerminalOutputTarget>()
  private readonly queues: Record<TerminalOutputQueueName, string[]> = {
    'focused-task': [],
    'visible-task': [],
    background: []
  }
  private readonly queuedLaneById = new Map<string, TerminalOutputQueueName>()
  private scheduled = false
  private timeoutId: number | null = null
  private animationFrameId: number | null = null
  private promptInputPressureStartedAt: number | null = null

  constructor(options: TerminalOutputSchedulerOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      batchIntervalMs: options.batchIntervalMs ?? options.minFlushIntervalMs ?? DEFAULT_OPTIONS.batchIntervalMs,
      visibleFrameBudgetMs: options.visibleFrameBudgetMs ?? options.normalFrameBudgetMs ?? DEFAULT_OPTIONS.visibleFrameBudgetMs,
      focusedFrameBudgetMs: options.focusedFrameBudgetMs ?? options.interactiveFrameBudgetMs ?? DEFAULT_OPTIONS.focusedFrameBudgetMs,
      visibleChunkBytes: options.visibleChunkBytes ?? options.normalChunkBytes ?? DEFAULT_OPTIONS.visibleChunkBytes,
      focusedChunkBytes: options.focusedChunkBytes ?? options.interactiveChunkBytes ?? DEFAULT_OPTIONS.focusedChunkBytes,
      promptInputMaxYieldMs: options.promptInputMaxYieldMs ?? options.inputPressureMaxYieldMs ?? DEFAULT_OPTIONS.promptInputMaxYieldMs
    }
  }

  registerTarget(target: TerminalOutputTarget): void {
    this.targets.set(target.id, target)
  }

  unregisterTarget(id: string): void {
    this.targets.delete(id)
    this.removeDirty(id)
  }

  removeDirty(id: string): void {
    const lane = this.queuedLaneById.get(id)
    if (!lane) return
    this.queuedLaneById.delete(id)
    this.removeFromQueue(lane, id)
  }

  markDirty(id: string, interactive = false): void {
    const target = this.targets.get(id)
    if (!target || !target.hasPendingData()) {
      this.removeDirty(id)
      return
    }

    if (!target.isOutputActive()) {
      this.removeDirty(id)
      return
    }

    const lane = this.classifyTarget(target, interactive)
    this.enqueue(id, lane, lane === 'focused-task')
    this.schedule(lane === 'focused-task')
  }

  flushSoon(): void {
    this.schedule(true)
  }

  private classifyTarget(target: TerminalOutputTarget, interactive: boolean): TerminalOutputQueueName {
    if (interactive || target.isInteractive()) return 'focused-task'
    if (target.isOutputActive()) return 'visible-task'
    return 'background'
  }

  private enqueue(id: string, lane: TerminalOutputQueueName, front: boolean): void {
    const existingLane = this.queuedLaneById.get(id)
    if (existingLane === lane) return
    if (existingLane) {
      this.removeFromQueue(existingLane, id)
    }

    this.queuedLaneById.set(id, lane)
    if (front) {
      this.queues[lane].unshift(id)
    } else {
      this.queues[lane].push(id)
    }
  }

  private removeFromQueue(lane: TerminalOutputQueueName, id: string): void {
    const queue = this.queues[lane]
    const index = queue.indexOf(id)
    if (index >= 0) {
      queue.splice(index, 1)
    }
  }

  private schedule(immediate: boolean): void {
    if (this.scheduled) return
    this.scheduled = true

    const delay = immediate ? 0 : this.options.batchIntervalMs
    const scheduleFrame = () => {
      this.animationFrameId = requestAnimationFrame(() => {
        this.animationFrameId = null
        this.flush()
      })

      this.timeoutId = window.setTimeout(() => {
        this.timeoutId = null
        this.flush()
      }, Math.max(32, this.options.batchIntervalMs * 2))
    }

    if (delay <= 0) {
      scheduleFrame()
      return
    }

    this.timeoutId = window.setTimeout(() => {
      this.timeoutId = null
      scheduleFrame()
    }, delay)
  }

  private clearScheduledHandles(): void {
    if (this.timeoutId !== null) {
      window.clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
  }

  private hasQueuedWork(): boolean {
    return QUEUE_ORDER.some((lane) => this.queues[lane].length > 0)
  }

  private shouldDeferForPromptInput(): boolean {
    if (!inputPriorityLane.shouldYieldToPromptInput()) {
      this.promptInputPressureStartedAt = null
      return false
    }

    const now = performance.now()
    if (this.promptInputPressureStartedAt === null) {
      this.promptInputPressureStartedAt = now
    }

    return now - this.promptInputPressureStartedAt < this.options.promptInputMaxYieldMs
  }

  private getFrameBudgetMs(): number {
    if (inputPriorityLane.shouldYieldToPromptInput()) {
      return this.options.inputPressureFrameBudgetMs
    }
    if (this.queues['focused-task'].length > 0) {
      return this.options.focusedFrameBudgetMs
    }
    if (inputPriorityLane.hasRecentFocusedTaskInput()) {
      return this.options.inputPressureFrameBudgetMs
    }
    return this.options.visibleFrameBudgetMs
  }

  private getChunkBytes(lane: TerminalOutputQueueName): number {
    if (lane === 'focused-task') return this.options.focusedChunkBytes
    if (lane === 'background') return this.options.backgroundChunkBytes
    return this.options.visibleChunkBytes
  }

  private nextTarget(lane: TerminalOutputQueueName): TerminalOutputTarget | null {
    const queue = this.queues[lane]
    const checked = queue.length

    for (let index = 0; index < checked; index++) {
      const id = queue.shift()
      if (!id) return null

      const target = this.targets.get(id)
      if (!target || !target.hasPendingData() || !target.isOutputActive()) {
        this.queuedLaneById.delete(id)
        continue
      }

      this.queuedLaneById.delete(id)
      return target
    }

    return null
  }

  private requeueIfNeeded(target: TerminalOutputTarget, lane: TerminalOutputQueueName): void {
    if (!target.hasPendingData() || !target.isOutputActive()) return
    const nextLane = this.classifyTarget(target, target.isInteractive())
    this.enqueue(target.id, nextLane, false)
  }

  private flush(): void {
    if (!this.scheduled) return
    this.scheduled = false
    this.clearScheduledHandles()

    if (!this.hasQueuedWork()) return

    if (this.shouldDeferForPromptInput()) {
      this.schedule(false)
      return
    }

    const startedAt = performance.now()
    const frameBudgetMs = this.getFrameBudgetMs()
    let processed = 0

    for (const lane of QUEUE_ORDER) {
      while (performance.now() - startedAt < frameBudgetMs) {
        const target = this.nextTarget(lane)
        if (!target) break

        const chunk = target.consumeChunk(this.getChunkBytes(lane))
        if (chunk) {
          target.writeData(chunk)
          processed++
        }

        this.requeueIfNeeded(target, lane)
      }

      if (performance.now() - startedAt >= frameBudgetMs) {
        break
      }
    }

    if (this.hasQueuedWork()) {
      this.schedule(processed > 0 && this.queues['focused-task'].length > 0)
    }
  }
}
