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
    advance(1)
    tracker.markModelBound('k')
    advance(3)
    tracker.markEditorReady('k')
    advance(10)
    tracker.markDiffComputed('k') // synchronous fake rAF flushes here
    advance(100)
    tracker.markDomCommitted('k')
    advance(1)
    tracker.markTokenizeSettled('k', 'test')

    const last = tracker.getLast()
    assert.ok(last)
    assert.equal(last.fileKey, 'k')
    assert.equal(last.cacheState, 'hit')
    assert.equal(last.cacheSource, null)
    assert.equal(last.cacheMissReason, null)
    assert.equal(last.clickAt, 1000)
    assert.equal(last.ipcStartAt, 1002)
    assert.equal(last.ipcEndAt, 1017)
    assert.equal(last.stateSetAt, 1018)
    assert.equal(last.modelBoundAt, 1019)
    assert.equal(last.editorReadyAt, 1022)
    assert.equal(last.diffComputedAt, 1032)
    assert.equal(last.paintReadyAt, 1032) // fake rAF is synchronous
    assert.equal(last.domCommittedAt, 1132)
    assert.equal(last.tokenizeSettleAt, 1133)
    assert.equal(last.firstPaintMs, 32)
    assert.equal(last.totalMs, 133)
    assert.equal(last.settleReason, 'test')
    assert.equal(last.cancelled, false)
    assert.equal(events.length, 1)
  })
})

test('markIpcEnd records cache source and miss reason', () => {
  const { tracker } = makeTracker()
  tracker.start('k', 'a.ts')
  tracker.markIpcStart('k')
  tracker.markIpcEnd('k', 'miss', {
    source: 'worker-rebuild',
    missReason: 'invalidated-refresh'
  })
  const active = tracker.getActive()
  assert.ok(active)
  assert.equal(active.cacheState, 'miss')
  assert.equal(active.cacheSource, 'worker-rebuild')
  assert.equal(active.cacheMissReason, 'invalidated-refresh')
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
    tracker.markModelBound('b')
    advance(1)
    tracker.markEditorReady('b')
    advance(3)
    tracker.markDiffComputed('b')
    advance(1)
    tracker.markTokenizeSettled('b', 'test')

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
    tracker.markModelBound('zzz')
    tracker.markEditorReady('zzz')
    tracker.markDiffComputed('zzz')
    tracker.markDomCommitted('zzz')
    tracker.markTokenizeSettled('zzz', 'test')

    const active = tracker.getActive()
    assert.ok(active)
    assert.equal(active.ipcStartAt, null)
    assert.equal(active.ipcEndAt, null)
    assert.equal(active.modelBoundAt, null)
    assert.equal(active.editorReadyAt, null)
    assert.equal(active.diffComputedAt, null)
    assert.equal(active.domCommittedAt, null)
    assert.equal(active.paintReadyAt, null)
    assert.equal(active.tokenizeSettleAt, null)
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
      tracker.markModelBound(`k${i}`)
      tracker.markEditorReady(`k${i}`)
      tracker.markDiffComputed(`k${i}`)
      tracker.markTokenizeSettled(`k${i}`, 'test')
    }
    const history = tracker.getHistory()
    assert.ok(history.length <= 100)
    // Latest entry must be the most recent click.
    assert.equal(history[history.length - 1].fileKey, 'k249')
  })
})
