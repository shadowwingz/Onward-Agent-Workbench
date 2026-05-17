/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for isPreviewWorkPending(): the pure-logic decision that
 * picks between the fast path (setTimeout(0) -> phase:idle) and waiting
 * for the next render/mermaid/layout event inside
 * `ProjectEditor.tsx::queuePreviewReveal::settleReveal`. Pair with the
 * autotest suite `run-markdown-preview-latency` which exercises the
 * same decision through the live React component against three
 * representative markdown source sizes.
 *
 * The truth table is simple: any single signal "still working" delays
 * reveal; only when every signal is idle do we take the fast path. This
 * unit test enumerates every reachable combination so a future refactor
 * that drops a signal (and thus the fast path silently starts firing
 * while work is still in flight) fails loudly here.
 *
 * Usage:
 *   node --experimental-strip-types --test test/unittest/preview-restore-settle.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isPreviewWorkPending,
  shouldRevealSettledPreview,
  type PreviewWorkSignals
} from '../../src/components/ProjectEditor/utils/previewRestoreSettle.ts'

const idleSignals: PreviewWorkSignals = {
  markdownRenderPending: false,
  workerInFlight: false,
  workerQueued: false,
  mermaidPending: 0,
  mermaidInFlight: false
}

// ─────────────── PRS-U-01: every signal off → fast path ───────────────
test('PRS-U-01 all idle → fast path (returns false)', () => {
  assert.equal(isPreviewWorkPending(idleSignals), false)
})

// ─────────────── PRS-U-02: each individual signal delays reveal ───────────────
test('PRS-U-02 markdownRenderPending delays reveal', () => {
  assert.equal(isPreviewWorkPending({ ...idleSignals, markdownRenderPending: true }), true)
})

test('PRS-U-03 workerInFlight delays reveal', () => {
  assert.equal(isPreviewWorkPending({ ...idleSignals, workerInFlight: true }), true)
})

test('PRS-U-04 workerQueued delays reveal', () => {
  assert.equal(isPreviewWorkPending({ ...idleSignals, workerQueued: true }), true)
})

test('PRS-U-05 mermaidPending=1 delays reveal', () => {
  assert.equal(isPreviewWorkPending({ ...idleSignals, mermaidPending: 1 }), true)
})

test('PRS-U-06 mermaidPending=10 delays reveal', () => {
  assert.equal(isPreviewWorkPending({ ...idleSignals, mermaidPending: 10 }), true)
})

test('PRS-U-07 mermaidInFlight delays reveal', () => {
  assert.equal(isPreviewWorkPending({ ...idleSignals, mermaidInFlight: true }), true)
})

// ─────────────── PRS-U-08: mermaidPending=0 must NOT trip the gate ───────────────
test('PRS-U-08 mermaidPending=0 alone is not work', () => {
  assert.equal(isPreviewWorkPending({ ...idleSignals, mermaidPending: 0 }), false)
})

// ─────────────── PRS-U-09: every combination of two signals is still work ───────────────
test('PRS-U-09 markdownRenderPending + workerInFlight delays reveal', () => {
  assert.equal(
    isPreviewWorkPending({ ...idleSignals, markdownRenderPending: true, workerInFlight: true }),
    true
  )
})

test('PRS-U-10 workerQueued + mermaidInFlight delays reveal', () => {
  assert.equal(
    isPreviewWorkPending({ ...idleSignals, workerQueued: true, mermaidInFlight: true }),
    true
  )
})

// ─────────────── PRS-U-11: full enumeration (32 boolean combos × pending-int boundary) ───────────────
test('PRS-U-11 enumerate all 32 boolean combinations', () => {
  const bools = [false, true]
  for (const markdownRenderPending of bools) {
    for (const workerInFlight of bools) {
      for (const workerQueued of bools) {
        for (const mermaidInFlight of bools) {
          for (const mermaidPending of [0, 1]) {
            const signals: PreviewWorkSignals = {
              markdownRenderPending,
              workerInFlight,
              workerQueued,
              mermaidInFlight,
              mermaidPending
            }
            const expectedWorking =
              markdownRenderPending ||
              workerInFlight ||
              workerQueued ||
              mermaidInFlight ||
              mermaidPending > 0
            assert.equal(
              isPreviewWorkPending(signals),
              expectedWorking,
              `combo=${JSON.stringify(signals)}`
            )
          }
        }
      }
    }
  }
})

// ─────────────── PRS-U-12: negative mermaidPending coerced to "no pending" ───────────────
// Defence-in-depth: an upstream bug that inverts a counter shouldn't make
// the function falsely report work. We treat any non-positive integer as
// "no pending diagrams". The current implementation uses `> 0`, which
// already gives this behaviour — locking it in.
test('PRS-U-12 mermaidPending=-1 is not work (defence-in-depth)', () => {
  assert.equal(isPreviewWorkPending({ ...idleSignals, mermaidPending: -1 }), false)
})

// ─────────────── PRS-U-13: function purity (no input mutation) ───────────────
test('PRS-U-13 input signals object is not mutated', () => {
  const input: PreviewWorkSignals = { ...idleSignals, markdownRenderPending: true, mermaidPending: 2 }
  const snapshot = { ...input }
  isPreviewWorkPending(input)
  assert.deepEqual(input, snapshot)
})

// ─────────────── PRS-U-14: existing rendered HTML can leave waiting-html ───────────────
test('PRS-U-14 rendered HTML + idle signals reveals from waiting-html', () => {
  assert.equal(
    shouldRevealSettledPreview({
      ...idleSignals,
      isMarkdownRenderAllowed: true,
      renderedHtmlLength: 1024,
      phase: 'waiting-html'
    }),
    true
  )
})

test('PRS-U-15 rendered HTML + idle signals reveals from restoring-layout', () => {
  assert.equal(
    shouldRevealSettledPreview({
      ...idleSignals,
      isMarkdownRenderAllowed: true,
      renderedHtmlLength: 1024,
      phase: 'restoring-layout'
    }),
    true
  )
})

test('PRS-U-16 idle/revealing phases do not requeue reveal', () => {
  assert.equal(
    shouldRevealSettledPreview({
      ...idleSignals,
      isMarkdownRenderAllowed: true,
      renderedHtmlLength: 1024,
      phase: 'idle'
    }),
    false
  )
  assert.equal(
    shouldRevealSettledPreview({
      ...idleSignals,
      isMarkdownRenderAllowed: true,
      renderedHtmlLength: 1024,
      phase: 'revealing'
    }),
    false
  )
})

test('PRS-U-17 rendered HTML does not reveal while any work is pending', () => {
  assert.equal(
    shouldRevealSettledPreview({
      ...idleSignals,
      markdownRenderPending: true,
      isMarkdownRenderAllowed: true,
      renderedHtmlLength: 1024,
      phase: 'waiting-html'
    }),
    false
  )
})

test('PRS-U-18 missing rendered HTML does not reveal', () => {
  assert.equal(
    shouldRevealSettledPreview({
      ...idleSignals,
      isMarkdownRenderAllowed: true,
      renderedHtmlLength: 0,
      phase: 'waiting-html'
    }),
    false
  )
})
