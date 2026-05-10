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
  // Yield enough times for the bounded-concurrency loop AND the runBurst
  // async finally to drain. setTimeout(0) flushes the macro-task queue so
  // even multi-stage await chains complete in time for assertions.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
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

test('perProject meta records pendingSince when invalidated', () => {
  const fakeTimer = new FakeTimer()
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 100,
    timer: fakeTimer,
    fetchFile: async () => { /* noop */ },
    loadWorkingSet: async () => []
  })
  scheduler.onProjectInvalidated('/p')
  // Burst hasn't run yet — pendingSince should be set, inFlightSince null,
  // lastBurst null.
  const stats = scheduler.inspectStats()
  const meta = stats.perProject['/p']
  assert.ok(meta, 'perProject entry must exist for /p')
  assert.ok(meta.pendingSince !== null, 'pendingSince must be set')
  assert.equal(meta.inFlightSince, null)
  assert.equal(meta.lastBurst, null)
})

test('perProject meta records lastBurst summary after a burst completes', async () => {
  const fakeTimer = new FakeTimer()
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 0,
    concurrency: 2,
    maxCandidatesPerBurst: 10,
    timer: fakeTimer,
    isEligible: (f) => !f.filename.endsWith('.png'),
    fetchFile: async () => { /* noop */ },
    loadWorkingSet: async () => [
      file('a.ts', 9),
      file('b.ts', 8),
      file('c.png', 7) // ineligible
    ]
  })
  scheduler.onProjectInvalidated('/p')
  fakeTimer.flushAll()
  await nextTick()

  const stats = scheduler.inspectStats()
  const meta = stats.perProject['/p']
  assert.ok(meta?.lastBurst, 'lastBurst must be recorded after the burst')
  assert.equal(meta.lastBurst.workingSetSize, 3)
  assert.equal(meta.lastBurst.eligibleCount, 2, '.png filtered out by isEligible')
  assert.equal(meta.lastBurst.candidateCount, 2)
  assert.equal(meta.lastBurst.completed, 2)
  assert.equal(meta.lastBurst.skipped, 0)
  // Pending / in-flight cleared once the burst finishes.
  assert.equal(meta.pendingSince, null)
  assert.equal(meta.inFlightSince, null)
})

test('perProject lastBurst.skipped counts fetchFile failures, not isEligible drops', async () => {
  const fakeTimer = new FakeTimer()
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 0,
    concurrency: 1,
    timer: fakeTimer,
    fetchFile: async (_p, f) => {
      if (f.filename === 'broken.ts') throw new Error('worker error')
    },
    loadWorkingSet: async () => [file('a.ts', 5), file('broken.ts', 4)]
  })
  scheduler.onProjectInvalidated('/p')
  fakeTimer.flushAll()
  await nextTick()
  const meta = scheduler.inspectStats().perProject['/p']
  assert.ok(meta?.lastBurst)
  assert.equal(meta.lastBurst.completed, 1)
  assert.equal(meta.lastBurst.skipped, 1, 'fetchFile rejection counts as a skipped fetch')
})

test('perProject meta caps the per-burst slice at maxCandidatesPerBurst', async () => {
  const fakeTimer = new FakeTimer()
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 0,
    concurrency: 1,
    maxCandidatesPerBurst: 2,
    timer: fakeTimer,
    fetchFile: async () => { /* noop */ },
    loadWorkingSet: async () => [
      file('a.ts', 9),
      file('b.ts', 8),
      file('c.ts', 7),
      file('d.ts', 6)
    ]
  })
  scheduler.onProjectInvalidated('/p')
  fakeTimer.flushAll()
  await nextTick()
  const meta = scheduler.inspectStats().perProject['/p']
  assert.ok(meta?.lastBurst)
  assert.equal(meta.lastBurst.workingSetSize, 4)
  assert.equal(meta.lastBurst.eligibleCount, 4, 'all eligible (no isEligible drops)')
  assert.equal(meta.lastBurst.candidateCount, 2, 'sliced to maxCandidatesPerBurst')
  assert.equal(meta.lastBurst.completed, 2)
})

test('perProject pendingSince clears when burst starts; inFlightSince set during burst', async () => {
  // Use a delayed loadWorkingSet so we can observe the in-flight phase.
  const fakeTimer = new FakeTimer()
  let resolveWorkingSet: (() => void) | null = null
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 0,
    concurrency: 1,
    timer: fakeTimer,
    fetchFile: async () => { /* noop */ },
    loadWorkingSet: async () => {
      await new Promise<void>((resolve) => { resolveWorkingSet = resolve })
      return [file('a.ts', 1)]
    }
  })
  scheduler.onProjectInvalidated('/p')
  fakeTimer.flushAll()
  // runBurst is now awaiting loadWorkingSet — measurement is in-flight.
  await nextTick()
  let meta = scheduler.inspectStats().perProject['/p']
  assert.ok(meta?.inFlightSince !== null, 'inFlightSince must be set while burst runs')
  assert.equal(meta.pendingSince, null, 'pendingSince cleared when burst starts')
  // Let the burst finish. runBurst has multiple async boundaries after
  // loadWorkingSet resolves (filter / sort / per-candidate fetch loop /
  // finally block), so give the microtask queue plenty of room to flush.
  resolveWorkingSet?.()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  meta = scheduler.inspectStats().perProject['/p']
  assert.equal(meta.inFlightSince, null, 'inFlightSince cleared once burst completes')
  assert.ok(meta.lastBurst, 'lastBurst recorded')
})

test('cancelProject clears pending / in-flight timestamps but preserves lastBurst', async () => {
  const fakeTimer = new FakeTimer()
  const scheduler = new GitDiffPrecomputeScheduler({
    debounceMs: 0,
    concurrency: 1,
    timer: fakeTimer,
    fetchFile: async () => { /* noop */ },
    loadWorkingSet: async () => [file('a.ts', 1)]
  })
  scheduler.onProjectInvalidated('/p')
  fakeTimer.flushAll()
  await nextTick()
  const before = scheduler.inspectStats().perProject['/p']
  assert.ok(before?.lastBurst)
  // Schedule another invalidation, then cancel before it runs.
  scheduler.onProjectInvalidated('/p')
  scheduler.cancelProject('/p')
  const after = scheduler.inspectStats().perProject['/p']
  // lastBurst from the earlier burst stays; pendingSince / inFlightSince cleared.
  assert.deepEqual(after.lastBurst, before.lastBurst, 'lastBurst preserved across cancel')
  assert.equal(after.pendingSince, null)
  assert.equal(after.inFlightSince, null)
})
