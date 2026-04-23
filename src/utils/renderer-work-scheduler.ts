/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type RendererWorkLane =
  | 'prompt-input'
  | 'focused-task'
  | 'visible-task-output'
  | 'visible-ui'
  | 'background-ui'

type RendererTask = {
  lane: RendererWorkLane
  run: () => void
}

const LANE_ORDER: RendererWorkLane[] = [
  'prompt-input',
  'focused-task',
  'visible-task-output',
  'visible-ui',
  'background-ui'
]

const LANE_BUDGET_MS: Record<RendererWorkLane, number> = {
  'prompt-input': 8,
  'focused-task': 6,
  'visible-task-output': 5,
  'visible-ui': 5,
  'background-ui': 3
}

export class RendererWorkScheduler {
  private readonly queues = new Map<RendererWorkLane, RendererTask[]>()
  private timer: number | null = null
  private raf: number | null = null
  private readonly metrics = {
    enqueued: 0,
    executed: 0,
    yieldedToInput: 0,
    maxQueueDepth: 0,
    lastFlushMs: 0
  }

  constructor() {
    for (const lane of LANE_ORDER) {
      this.queues.set(lane, [])
    }
  }

  enqueue(lane: RendererWorkLane, run: () => void): void {
    const queue = this.queues.get(lane) ?? []
    queue.push({ lane, run })
    this.queues.set(lane, queue)
    this.metrics.enqueued += 1
    this.metrics.maxQueueDepth = Math.max(this.metrics.maxQueueDepth, this.getQueueDepth())
    this.schedule()
  }

  getMetrics(): Record<string, number> {
    return {
      ...this.metrics,
      queueDepth: this.getQueueDepth()
    }
  }

  private schedule(): void {
    if (this.timer !== null || this.raf !== null) return
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.raf = window.requestAnimationFrame(() => {
        this.raf = null
        this.flush()
      })
    }, 20)
  }

  private flush(): void {
    const startedAt = performance.now()
    for (const lane of LANE_ORDER) {
      const laneStartedAt = performance.now()
      const budget = LANE_BUDGET_MS[lane]
      const queue = this.queues.get(lane)
      if (!queue) continue

      while (queue.length > 0) {
        if (lane !== 'prompt-input' && this.hasPendingInput()) {
          this.metrics.yieldedToInput += 1
          this.schedule()
          this.metrics.lastFlushMs = performance.now() - startedAt
          return
        }
        const task = queue.shift()
        if (!task) break
        task.run()
        this.metrics.executed += 1
        if (performance.now() - laneStartedAt >= budget) {
          this.schedule()
          this.metrics.lastFlushMs = performance.now() - startedAt
          return
        }
      }
    }
    if (this.getQueueDepth() > 0) {
      this.schedule()
    }
    this.metrics.lastFlushMs = performance.now() - startedAt
  }

  private hasPendingInput(): boolean {
    const scheduling = (navigator as Navigator & {
      scheduling?: { isInputPending?: (options?: { includeContinuous?: boolean }) => boolean }
    }).scheduling
    try {
      return Boolean(scheduling?.isInputPending?.({ includeContinuous: true }))
    } catch {
      return false
    }
  }

  private getQueueDepth(): number {
    let total = 0
    for (const queue of this.queues.values()) {
      total += queue.length
    }
    return total
  }
}

export const rendererWorkScheduler = new RendererWorkScheduler()

if (typeof window !== 'undefined') {
  ;(window as Window & { __onwardRendererWorkScheduler?: RendererWorkScheduler }).__onwardRendererWorkScheduler = rendererWorkScheduler
}
