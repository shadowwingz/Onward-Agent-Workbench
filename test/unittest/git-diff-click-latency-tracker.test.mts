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
    // Listeners fire twice: once at markIpcEnd (so the panel pill can
    // render before tokenize-settle) and once at the full seal (so totalMs
    // and the history entry are exposed).
    assert.equal(events.length, 2)
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

test('markIpcEnd fires listeners so the panel pill can render before tokenize-settle', () => {
  // The diagnostics-panel pill must not wait until markTokenizeSettled.
  // Listeners must fire as soon as cacheState / cacheSource are recorded.
  const { tracker } = makeTracker()
  const events: { fileKey: string; cacheState: string; ipcEndAt: number | null; tokenizeSettleAt: number | null }[] = []
  tracker.addListener((m) => events.push({
    fileKey: m.fileKey,
    cacheState: m.cacheState,
    ipcEndAt: m.ipcEndAt,
    tokenizeSettleAt: m.tokenizeSettleAt
  }))
  tracker.start('k', 'a.ts')
  tracker.markIpcStart('k')
  tracker.markIpcEnd('k', 'hit', { source: 'main-content-cache' })
  // Panel must already have the data — no need to wait for tokenize-settle.
  assert.equal(events.length, 1)
  assert.equal(events[0].fileKey, 'k')
  assert.equal(events[0].cacheState, 'hit')
  assert.ok(events[0].ipcEndAt !== null, 'ipcEndAt must be set in the notification')
  assert.equal(events[0].tokenizeSettleAt, null, 'measurement is not yet sealed at this point')
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

test('start watchdog seals a stuck measurement so aggregator stats stay honest', async () => {
  // Reproduces the empty-untracked-file failure mode: tracker.start fires,
  // markIpcEnd lands with valid cacheState/cacheSource, but Monaco never
  // fires onDidUpdateDiff (new model content matches the placeholder), so
  // markTokenizeSettled is never called. Without the watchdog, the click
  // would never enter history, biasing the aggregator's hit-rate.
  // (The panel pill itself doesn't depend on this — it updates at
  // markIpcEnd via the live listener.)
  const { tracker } = makeTracker()
  const events: { fileKey: string; cancelled: boolean; settleReason: string | null; ipcEndAt: number | null }[] = []
  tracker.addListener((m) => events.push({
    fileKey: m.fileKey,
    cancelled: m.cancelled,
    settleReason: m.settleReason,
    ipcEndAt: m.ipcEndAt
  }))
  tracker.start('empty-untracked', 'newfile.txt')
  tracker.markIpcStart('empty-untracked')
  tracker.markIpcEnd('empty-untracked', 'miss', {
    source: 'worker-rebuild',
    missReason: 'first-load'
  })
  // First listener fire: at markIpcEnd, panel-pill data ready.
  assert.equal(events.length, 1)
  assert.equal(events[0].cancelled, false)
  assert.ok(events[0].ipcEndAt !== null)

  // No further marks happen — Monaco silent.
  await new Promise(resolve => setTimeout(resolve, 5100))

  // Second listener fire: watchdog seals into history.
  assert.equal(events.length, 2, 'watchdog adds one more event after timeout')
  assert.equal(events[1].cancelled, true)
  assert.equal(events[1].settleReason, 'start-timeout')

  const last = tracker.getLast()
  assert.ok(last)
  assert.equal(last.fileKey, 'empty-untracked')
  // Crucially: the cache outcome that markIpcEnd recorded is preserved,
  // so the panel pills can render real data even though the click was
  // sealed by watchdog.
  assert.equal(last.cacheState, 'miss')
  assert.equal(last.cacheSource, 'worker-rebuild')
  assert.equal(last.cacheMissReason, 'first-load')
})

test('start watchdog is cleared when markTokenizeSettled fires normally', async () => {
  // Confirms the watchdog doesn't fire when a measurement seals normally.
  const { tracker } = makeTracker()
  withFakeRaf(() => {
    tracker.start('normal', 'a.ts')
    tracker.markIpcStart('normal')
    tracker.markIpcEnd('normal', 'hit')
    tracker.markStateSet('normal')
    tracker.markModelBound('normal')
    tracker.markEditorReady('normal')
    tracker.markDiffComputed('normal')
    tracker.markTokenizeSettled('normal', 'test')
  })
  // Watchdog window passes — no extra measurement should appear.
  const beforeCount = tracker.getHistory().length
  await new Promise(resolve => setTimeout(resolve, 5100))
  assert.equal(tracker.getHistory().length, beforeCount, 'watchdog must NOT fire after a normal seal')
})

test('start watchdog is replaced when a new click starts', async () => {
  // If user clicks A then quickly clicks B, A's watchdog should be replaced
  // by B's. Otherwise A's stale watchdog could later seal B by mistake.
  const { tracker } = makeTracker()
  tracker.start('a', 'a.ts')
  // Replace before A's watchdog fires.
  tracker.start('b', 'b.ts')
  // Both A's start and the cancellation pushed A to history with cancelled=true.
  // B is now active. Wait for ONE watchdog's worth of time and verify only
  // B's watchdog fires (not stacked with A's).
  await new Promise(resolve => setTimeout(resolve, 5100))
  const history = tracker.getHistory()
  // A from the explicit cancel-on-switch (no settleReason since it was the
  // synchronous cancel path), B from the watchdog.
  const aEntries = history.filter(m => m.fileKey === 'a')
  const bEntries = history.filter(m => m.fileKey === 'b')
  assert.equal(aEntries.length, 1, 'A should appear exactly once (from the cancel-on-switch)')
  assert.equal(bEntries.length, 1, 'B should appear exactly once (from the watchdog)')
  assert.equal(bEntries[0].settleReason, 'start-timeout')
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
