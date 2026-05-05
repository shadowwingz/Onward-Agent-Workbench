/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-diff-precompute-scheduler.test.mts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GitDiffPrecomputeScheduler,
  type DiffFile,
  type PrecomputeSchedulerOptions
} from '../../electron/main/git-diff-precompute-scheduler.ts'

interface FakeTimerHandle { id: number; cb: () => void; ms: number; cancelled: boolean }

class FakeTimer {
  private nextId = 1
  public scheduled: FakeTimerHandle[] = []
  setTimeout(cb: () => void, ms: number): FakeTimerHandle {
    const handle: FakeTimerHandle = { id: this.nextId++, cb, ms, cancelled: false }
    this.scheduled.push(handle)
    return handle
  }
  clearTimeout(handle: unknown): void {
    const h = handle as FakeTimerHandle
    if (h) h.cancelled = true
  }
  /** Fires every timer that has not been cancelled, in order. */
  flushAll(): void {
    while (true) {
      const next = this.scheduled.find((h) => !h.cancelled)
      if (!next) return
      next.cancelled = true
      next.cb()
    }
  }
}

function file(filename: string, additions: number, deletions = 0): DiffFile {
  return {
    filename,
    additions,
    deletions,
    changeType: 'unstaged',
    status: 'M'
  }
}

async function nextTick() {
  // Yield once to let microtasks settle (Promise.all chains in the scheduler).
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function makeScheduler(opts: Partial<PrecomputeSchedulerOptions> = {}) {
  const fakeTimer = new FakeTimer()
  const fetched: Array<{ project: string; filename: string }> = []
  const scheduler = new GitDiffPrecomputeScheduler({
    concurrency: 2,
    debounceMs: 100,
    maxCandidatesPerBurst: 10,
    timer: fakeTimer,
    fetchFile: async (project, f) => {
      fetched.push({ project, filename: f.filename })
    },
    loadWorkingSet: async () => [],
    ...opts
  })
  return { scheduler, fakeTimer, fetched }
}

test('debounce collapses multiple invalidations into one burst', async () => {
  const fetched: Array<{ project: string; filename: string }> = []
  const fakeTimer = new FakeTimer()
  const workingSet = [file('a.ts', 1), file('b.ts', 2)]
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 100,
    timer: fakeTimer,
    fetchFile: async (p, f) => { fetched.push({ project: p, filename: f.filename }) },
    loadWorkingSet: async () => workingSet
  })

  scheduler.onProjectInvalidated('/p')
  scheduler.onProjectInvalidated('/p')
  scheduler.onProjectInvalidated('/p')

  // Only one timer should be active at a time; the other two are cancelled.
  const active = fakeTimer.scheduled.filter((h) => !h.cancelled)
  assert.equal(active.length, 1)

  fakeTimer.flushAll()
  await nextTick()

  assert.deepEqual(fetched.map((f) => f.filename).sort(), ['a.ts', 'b.ts'])
})

test('candidates are sorted by additions+deletions descending', async () => {
  const fetched: string[] = []
  const fakeTimer = new FakeTimer()
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 0,
    concurrency: 1,
    timer: fakeTimer,
    fetchFile: async (_p, f) => { fetched.push(f.filename) },
    loadWorkingSet: async () => [
      file('small.ts', 1, 0),
      file('big.ts', 200, 50),
      file('medium.ts', 30, 10)
    ]
  })
  scheduler.onProjectInvalidated('/p')
  fakeTimer.flushAll()
  await nextTick()
  assert.deepEqual(fetched, ['big.ts', 'medium.ts', 'small.ts'])
})

test('isEligible filter is applied before sorting', async () => {
  const fetched: string[] = []
  const fakeTimer = new FakeTimer()
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 0,
    concurrency: 1,
    timer: fakeTimer,
    fetchFile: async (_p, f) => { fetched.push(f.filename) },
    loadWorkingSet: async () => [
      file('a.png', 100, 0),
      file('b.ts', 5, 0)
    ],
    isEligible: (f) => !f.filename.endsWith('.png')
  })
  scheduler.onProjectInvalidated('/p')
  fakeTimer.flushAll()
  await nextTick()
  assert.deepEqual(fetched, ['b.ts'])
})

test('maxCandidatesPerBurst caps the number of files fetched', async () => {
  const fetched: string[] = []
  const fakeTimer = new FakeTimer()
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 0,
    concurrency: 1,
    maxCandidatesPerBurst: 2,
    timer: fakeTimer,
    fetchFile: async (_p, f) => { fetched.push(f.filename) },
    loadWorkingSet: async () => [
      file('a.ts', 9), file('b.ts', 8), file('c.ts', 7),
      file('d.ts', 6), file('e.ts', 5)
    ]
  })
  scheduler.onProjectInvalidated('/p')
  fakeTimer.flushAll()
  await nextTick()
  assert.equal(fetched.length, 2)
  assert.deepEqual(fetched, ['a.ts', 'b.ts'])
})

test('cancelProject during a pending debounce drops the burst entirely', async () => {
  const fetched: string[] = []
  const fakeTimer = new FakeTimer()
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 100,
    timer: fakeTimer,
    fetchFile: async (_p, f) => { fetched.push(f.filename) },
    loadWorkingSet: async () => [file('a.ts', 1)]
  })
  scheduler.onProjectInvalidated('/p')
  scheduler.cancelProject('/p')
  fakeTimer.flushAll()
  await nextTick()
  assert.equal(fetched.length, 0)
})

test('two projects schedule independent bursts', async () => {
  const fetched: string[] = []
  const fakeTimer = new FakeTimer()
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 0,
    concurrency: 1,
    timer: fakeTimer,
    fetchFile: async (project, f) => { fetched.push(`${project}:${f.filename}`) },
    loadWorkingSet: async (project) => {
      if (project === '/p1') return [file('a.ts', 1)]
      if (project === '/p2') return [file('b.ts', 1)]
      return []
    }
  })
  scheduler.onProjectInvalidated('/p1')
  scheduler.onProjectInvalidated('/p2')
  fakeTimer.flushAll()
  await nextTick()
  assert.deepEqual(fetched.sort(), ['/p1:a.ts', '/p2:b.ts'])
})

test('fetchFile rejection does not abort the burst', async () => {
  const fetched: string[] = []
  const fakeTimer = new FakeTimer()
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 0,
    concurrency: 1,
    timer: fakeTimer,
    fetchFile: async (_p, f) => {
      if (f.filename === 'broken.ts') throw new Error('nope')
      fetched.push(f.filename)
    },
    loadWorkingSet: async () => [
      file('a.ts', 5),
      file('broken.ts', 4),
      file('c.ts', 3)
    ]
  })
  scheduler.onProjectInvalidated('/p')
  fakeTimer.flushAll()
  await nextTick()
  assert.deepEqual(fetched, ['a.ts', 'c.ts'])
  const stats = scheduler.inspectStats()
  assert.equal(stats.totalSkipped, 1)
  assert.equal(stats.totalCompleted, 2)
})

test('inspectStats reports totals across bursts', async () => {
  const fakeTimer = new FakeTimer()
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 0,
    concurrency: 1,
    timer: fakeTimer,
    fetchFile: async () => { /* noop */ },
    loadWorkingSet: async () => [file('a.ts', 1), file('b.ts', 2)]
  })
  scheduler.onProjectInvalidated('/p')
  fakeTimer.flushAll()
  await nextTick()
  const stats = scheduler.inspectStats()
  assert.equal(stats.totalBursts, 1)
  assert.equal(stats.totalCompleted, 2)
})
