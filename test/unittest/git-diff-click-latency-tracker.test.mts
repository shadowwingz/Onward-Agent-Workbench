/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-diff-click-latency-tracker.test.mts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { GitDiffClickLatencyTracker } from '../../src/components/GitDiffViewer/clickLatencyTracker.ts'

function withFakeRaf<T>(fn: () => T): T {
  const original = (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame
  const raf = (cb: FrameRequestCallback) => {
    // Synchronous: invoke immediately so the test sees the paint signal.
    cb(0)
    return 0
  }
  ;(globalThis as { requestAnimationFrame?: typeof raf }).requestAnimationFrame = raf as never
  try {
    return fn()
  } finally {
    if (original) {
      ;(globalThis as { requestAnimationFrame?: typeof original }).requestAnimationFrame = original
    } else {
      delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    }
  }
}

function makeTracker() {
  let clock = 1000
  const tracker = new GitDiffClickLatencyTracker(() => clock)
  return {
    tracker,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

test('happy path records every phase and emits a final paintReadyAt', () => {
  withFakeRaf(() => {
    const { tracker, advance } = makeTracker()
    const events: unknown[] = []
    tracker.addListener((m) => events.push(m))

    tracker.start('k', 'a.ts')
    advance(2)
    tracker.markIpcStart('k')
    advance(15)
    tracker.markIpcEnd('k', 'hit')
    advance(1)
    tracker.markStateSet('k')
    advance(3)
    tracker.markEditorReady('k')
    advance(10)
    tracker.markDiffComputed('k') // synchronous fake rAF flushes here

    const last = tracker.getLast()
    assert.ok(last)
    assert.equal(last.fileKey, 'k')
    assert.equal(last.cacheState, 'hit')
    assert.equal(last.clickAt, 1000)
    assert.equal(last.ipcStartAt, 1002)
    assert.equal(last.ipcEndAt, 1017)
    assert.equal(last.stateSetAt, 1018)
    assert.equal(last.editorReadyAt, 1021)
    assert.equal(last.diffComputedAt, 1031)
    assert.equal(last.paintReadyAt, 1031) // fake rAF is synchronous
    assert.equal(last.totalMs, 31)
    assert.equal(last.cancelled, false)
    assert.equal(events.length, 1)
  })
})

test('switching files mid-flight cancels the previous measurement', () => {
  withFakeRaf(() => {
    const { tracker, advance } = makeTracker()
    tracker.start('a', 'a.ts')
    advance(5)
    tracker.markIpcStart('a')
    advance(5)
    // User impatiently clicks a different file before A is done.
    tracker.start('b', 'b.ts')

    const aPrev = tracker.getLastForFile('a')
    assert.ok(aPrev)
    assert.equal(aPrev.cancelled, true)
    assert.equal(aPrev.paintReadyAt, null)

    advance(1)
    tracker.markIpcStart('b')
    advance(2)
    tracker.markIpcEnd('b', 'miss')
    advance(2)
    tracker.markStateSet('b')
    advance(1)
    tracker.markEditorReady('b')
    advance(3)
    tracker.markDiffComputed('b')

    const bDone = tracker.getLastForFile('b')
    assert.ok(bDone)
    assert.equal(bDone.cancelled, false)
    assert.equal(bDone.fileKey, 'b')
    assert.ok(bDone.paintReadyAt !== null)
  })
})

test('phase markers for stale files are silently ignored', () => {
  withFakeRaf(() => {
    const { tracker, advance } = makeTracker()
    tracker.start('a', 'a.ts')
    advance(2)
    // Bogus key — should not advance the active measurement.
    tracker.markIpcStart('zzz')
    tracker.markIpcEnd('zzz')
    tracker.markEditorReady('zzz')
    tracker.markDiffComputed('zzz')

    const active = tracker.getActive()
    assert.ok(active)
    assert.equal(active.ipcStartAt, null)
    assert.equal(active.ipcEndAt, null)
    assert.equal(active.editorReadyAt, null)
    assert.equal(active.diffComputedAt, null)
    assert.equal(active.paintReadyAt, null)
  })
})

test('history is bounded so long sessions do not leak memory', () => {
  withFakeRaf(() => {
    const { tracker, advance } = makeTracker()
    for (let i = 0; i < 250; i += 1) {
      tracker.start(`k${i}`, `f${i}.ts`)
      advance(1)
      tracker.markIpcStart(`k${i}`)
      tracker.markIpcEnd(`k${i}`, 'hit')
      tracker.markStateSet(`k${i}`)
      tracker.markEditorReady(`k${i}`)
      tracker.markDiffComputed(`k${i}`)
    }
    const history = tracker.getHistory()
    assert.ok(history.length <= 100)
    // Latest entry must be the most recent click.
    assert.equal(history[history.length - 1].fileKey, 'k249')
  })
})
