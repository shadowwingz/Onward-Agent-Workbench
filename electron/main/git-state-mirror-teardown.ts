/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure, dependency-free teardown decision logic for the GitStateMirror worker,
 * extracted so the @parcel/watcher worker-teardown SIGABRT fix can be unit-tested
 * without an Electron build. Two classes of bug live here:
 *
 *  1. The shutdown QUIESCE barrier — the worker must prove native quiescence
 *     (zero live @parcel/watcher subscriptions AND zero in-flight unsubscribes)
 *     before it frees its own JS env, else a PromiseRunner completion resolves a
 *     Deferred into a dead isolate -> napi_fatal_error -> abort(). The old fix was
 *     a blind 250 ms sleep; this is a real wait-until-empty barrier.
 *
 *  2. The RESPAWN suppression — dispose() (app quit) must not let a worker that
 *     died near quit respawn a fresh watcher-bearing worker into a quitting app
 *     (the compounding teardown path that maximizes outstanding subscribe work
 *     at isolate teardown).
 *
 * `git-state-mirror-worker-entry.ts` and `git-state-mirror-router.ts` import from
 * here; the unit test (`test/unittest/git-state-mirror-shutdown-quiesce.test.mts`)
 * targets these pure functions directly.
 */

// Settle past @parcel/watcher's macOS FSEvents 500 ms MAX_WAIT_TIME (Debounce.cc)
// so a coalesced event delivered AFTER unsubscribe resolves still lands while the
// isolate is alive and is swallowed by the subscribe callback's shuttingDown guard.
// Linux inotify / Windows RDCW settle faster, so 600 ms is a safe ceiling for all.
export const NATIVE_WATCHER_SETTLE_MS = 600

// Hard cap on the quiesce spin so a leaked subscription counter can never wedge
// shutdown forever — the router's terminate backstop is only provably safe AFTER
// shutdown-complete, so the worker must always reach it.
export const WATCHER_QUIESCE_DEADLINE_MS = 3_000

/**
 * The shutdown gate: the worker is safe to free its env iff there are no live
 * watcher subscriptions and no in-flight unsubscribe async-work. Negative inputs
 * (a bookkeeping bug) count as quiescent so a leaked counter cannot hard-wedge
 * teardown — the deadline + ack-gated terminate is the backstop for that case.
 */
export function isGitStateMirrorQuiescent(
  activeSubscriptions: number,
  pendingUnsubscribes: number
): boolean {
  return activeSubscriptions <= 0 && pendingUnsubscribes <= 0
}

/**
 * Real native-quiesce barrier (replaces the blind sleep). Awaits every in-flight
 * unsubscribe to settle, then spins — re-settling any freshly-queued unsubscribe
 * each tick (closing the "drain races the unsubscribe it just queued" gap) —
 * until quiescent or the deadline. All effects are injected so this is a pure,
 * deterministic unit under test.
 *
 * Returns whether the deadline was hit (still non-quiescent) and how long it spun.
 */
export async function awaitWatcherQuiescence(opts: {
  getActive: () => number
  getPending: () => number
  settlePending: () => Promise<void>
  delay: (ms: number) => Promise<void>
  now: () => number
  deadlineMs?: number
  tickMs?: number
}): Promise<{ deadlineHit: boolean; spunMs: number }> {
  const deadlineMs = opts.deadlineMs ?? WATCHER_QUIESCE_DEADLINE_MS
  const tickMs = opts.tickMs ?? 20
  const startedAt = opts.now()
  await opts.settlePending()
  while (
    !isGitStateMirrorQuiescent(opts.getActive(), opts.getPending()) &&
    opts.now() - startedAt < deadlineMs
  ) {
    await opts.delay(tickMs)
    if (opts.getPending() > 0) await opts.settlePending()
  }
  return {
    deadlineHit: !isGitStateMirrorQuiescent(opts.getActive(), opts.getPending()),
    spunMs: opts.now() - startedAt
  }
}

/**
 * Whether a worker that just exited should be respawned. Suppressed when the
 * router is disposing/disposed (quit in progress), a worker already exists, or
 * the retry budget is exhausted — so no fresh watcher-bearing worker is spawned
 * into a quitting app (the compounding teardown path), and a flapping worker
 * still gives up after `maxAttempts`.
 */
export function shouldRespawnGitStateMirrorWorker(opts: {
  disposed: boolean
  hasLiveWorker: boolean
  respawnAttempt: number
  maxAttempts: number
}): boolean {
  if (opts.disposed) return false
  if (opts.hasLiveWorker) return false
  if (opts.respawnAttempt >= opts.maxAttempts) return false
  return true
}
