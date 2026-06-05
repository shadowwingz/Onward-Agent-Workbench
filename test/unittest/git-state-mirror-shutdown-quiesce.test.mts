/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-state-mirror-shutdown-quiesce.test.mts
 *
 * Locks the pure teardown decision logic behind the @parcel/watcher
 * worker-teardown SIGABRT fix (electron/main/git-state-mirror-teardown.ts):
 *   - the quiescence gate (zero live subscriptions AND zero pending unsubscribes),
 *   - the async quiesce barrier's ordering (drain BEFORE return; spin until empty,
 *     never return after only the first settle; give up at the deadline),
 *   - the respawn-suppression predicate (no fresh watcher-bearing worker spawns
 *     into a quitting app).
 *
 * All effects are injected, so these run in plain Node in milliseconds with NO
 * real timers — the failure signal is deterministic, not flaky.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isGitStateMirrorQuiescent,
  awaitWatcherQuiescence,
  shouldRespawnGitStateMirrorWorker
} from '../../electron/main/git-state-mirror-teardown.ts'

// ---------------------------------------------------------------------------
// isGitStateMirrorQuiescent
// ---------------------------------------------------------------------------

test('isGitStateMirrorQuiescent is true only at zero subscriptions AND zero pending', () => {
  assert.equal(isGitStateMirrorQuiescent(0, 0), true)
  assert.equal(isGitStateMirrorQuiescent(1, 0), false)
  assert.equal(isGitStateMirrorQuiescent(0, 1), false)
  assert.equal(isGitStateMirrorQuiescent(3, 2), false)
})

test('isGitStateMirrorQuiescent treats negative (leaked) counters as quiescent so a bug cannot hard-wedge teardown', () => {
  assert.equal(isGitStateMirrorQuiescent(-1, 0), true)
  assert.equal(isGitStateMirrorQuiescent(0, -2), true)
})

// ---------------------------------------------------------------------------
// awaitWatcherQuiescence — the ordering barrier
// ---------------------------------------------------------------------------

function fakeClock() {
  let t = 0
  return { now: () => t, delay: async (ms: number) => { t += ms } }
}

test('awaitWatcherQuiescence returns immediately (no spin) when already quiescent', async () => {
  const clock = fakeClock()
  let delays = 0
  const result = await awaitWatcherQuiescence({
    getActive: () => 0,
    getPending: () => 0,
    settlePending: async () => {},
    delay: async (ms) => { delays += 1; await clock.delay(ms) },
    now: clock.now
  })
  assert.equal(result.deadlineHit, false)
  assert.equal(delays, 0)
})

test('awaitWatcherQuiescence drains a single in-flight unsubscribe via the pre-loop settle', async () => {
  const clock = fakeClock()
  // One live subscription + one in-flight unsubscribe. The first settlePending
  // resolves it: pending clears AND the paired live count decrements (the real
  // dispose-closure finally).
  let active = 1
  let pending = 1
  const result = await awaitWatcherQuiescence({
    getActive: () => active,
    getPending: () => pending,
    settlePending: async () => { if (pending > 0) { pending = 0; active = 0 } },
    delay: clock.delay,
    now: clock.now
  })
  assert.equal(result.deadlineHit, false)
  assert.equal(active, 0)
  assert.equal(pending, 0)
})

test('awaitWatcherQuiescence SPINS until pending reaches zero — never returns after only the first settle (GAP 4)', async () => {
  const clock = fakeClock()
  // Two in-flight unsubscribes; each settle clears exactly one (with its paired
  // live-count decrement). The barrier must NOT return when pending is still 1
  // after the first settle — it must spin and re-settle until BOTH drain.
  let active = 2
  let pending = 2
  let settles = 0
  const result = await awaitWatcherQuiescence({
    getActive: () => active,
    getPending: () => pending,
    settlePending: async () => { settles += 1; if (pending > 0) { pending -= 1; active -= 1 } },
    delay: clock.delay,
    now: clock.now,
    tickMs: 20
  })
  assert.equal(result.deadlineHit, false)
  assert.equal(pending, 0)
  assert.equal(active, 0)
  // First settle (pre-loop) cleared 1; at least one more settle inside the spin
  // cleared the second — proving it did not return after the first.
  assert.ok(settles >= 2, `expected >=2 settles, got ${settles}`)
})

test('awaitWatcherQuiescence gives up at the deadline when a leaked counter never drains (bounded, not forever)', async () => {
  const clock = fakeClock()
  const result = await awaitWatcherQuiescence({
    getActive: () => 1, // stuck forever (simulated bookkeeping leak)
    getPending: () => 0,
    settlePending: async () => {},
    delay: clock.delay,
    now: clock.now,
    tickMs: 20,
    deadlineMs: 100
  })
  assert.equal(result.deadlineHit, true)
  assert.ok(result.spunMs >= 100, `expected spunMs >= deadline, got ${result.spunMs}`)
})

// ---------------------------------------------------------------------------
// shouldRespawnGitStateMirrorWorker
// ---------------------------------------------------------------------------

test('shouldRespawnGitStateMirrorWorker respawns only when not disposed, no live worker, and budget remains', () => {
  const base = { disposed: false, hasLiveWorker: false, respawnAttempt: 0, maxAttempts: 5 }
  assert.equal(shouldRespawnGitStateMirrorWorker(base), true)
  assert.equal(shouldRespawnGitStateMirrorWorker({ ...base, respawnAttempt: 4 }), true)
})

test('shouldRespawnGitStateMirrorWorker suppresses respawn while disposing/disposed (the quitting-app guard, GAP 5/6)', () => {
  const base = { disposed: true, hasLiveWorker: false, respawnAttempt: 0, maxAttempts: 5 }
  assert.equal(shouldRespawnGitStateMirrorWorker(base), false)
  // disposed wins even with full budget remaining.
  assert.equal(shouldRespawnGitStateMirrorWorker({ ...base, respawnAttempt: 0 }), false)
})

test('shouldRespawnGitStateMirrorWorker suppresses respawn when a worker already exists', () => {
  assert.equal(
    shouldRespawnGitStateMirrorWorker({ disposed: false, hasLiveWorker: true, respawnAttempt: 0, maxAttempts: 5 }),
    false
  )
})

test('shouldRespawnGitStateMirrorWorker gives up once the retry budget is exhausted', () => {
  const base = { disposed: false, hasLiveWorker: false, maxAttempts: 5 }
  assert.equal(shouldRespawnGitStateMirrorWorker({ ...base, respawnAttempt: 5 }), false)
  assert.equal(shouldRespawnGitStateMirrorWorker({ ...base, respawnAttempt: 6 }), false)
})
