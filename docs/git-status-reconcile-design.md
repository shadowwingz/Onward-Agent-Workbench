<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# Git Status Reconcile — Design

Always-on `dirty → reconcile` safety net for the Task git-status badge, running
**in parallel with** the `@parcel/watcher` fast path and **never gated on the
watcher reporting an error**.

## 1. Problem

The Task title badge (clean / modified=yellow / added=purple) is computed by the
GitStateMirror worker, which recomputes `git status` only when its
`@parcel/watcher` subscription fires. `@parcel/watcher` can fail **silently** on
packaged macOS builds — deliver no events and report **no error**
(cf. parcel-bundler/watcher#187: the FSEvents backend can stop delivering and
"hang indefinitely without user notification"). The existing fallback
(`degraded polling`) is **error-gated**: it only starts when the watcher throws,
so a silent failure never triggers it.

Production evidence (diagnostic bundle `2026-06-01`, build
`v2.1.0-daily.20260530.1`): across ~50 min of trace, the mirror produced exactly
**one** recompute, triggered by `focus-resync` — **zero `watcher-fire`** for any
repo, including 6 files we created live across both tabs. A real untracked file
(`docs/performance-optimization-master-plan.md`) sat green for ~5 hours. The
watcher was silently dead; the badge only ever updated when the user focused the
terminal.

Conclusion (matches Git's own fsmonitor philosophy — "FSMonitor functions as a
cache that Git validates rather than a source of truth"): freshness must not be
100% staked on the watcher delivering events and erroring on failure.

## 2. Goals / non-goals

- **Goal**: the badge self-corrects within a bounded interval even when the
  watcher is silently dead, without depending on the watcher reporting an error.
- **Goal**: keep the watcher as the sub-second fast path when it works.
- **Goal**: make silent watcher failure observable in the perf trace.
- **Non-goal (v1)**: diagnosing/repairing the underlying `@parcel/watcher`
  silent failure (auto re-subscribe is a follow-up — see §9). Correctness is
  guaranteed by reconcile regardless.

## 3. Hard constraints

### H1 — Reconcile/poll executes in the GitStateMirror **worker thread**, never the main thread (PERF-CRITICAL)

The periodic heartbeat timer **and** the `git status` it drives MUST run inside
the GitStateMirror worker (`electron/main/git-state-mirror-worker-entry.ts`),
**not** on the main process thread. Rationale:

- `git status` is a spawn + parse; running it (and a 1 s timer fanning it across
  N repos) on the main thread would contend with IPC, AppState, menu/tray, and
  every other main-thread responsibility — exactly the off-main / off-renderer
  threading posture mandated by
  `docs/Off-Renderer Threaded Design - Electron Refactor.md`.
- The worker **already** owns the watcher, `computeMirrorState` (the git status),
  the per-entry in-flight/queued dedup, the change-fingerprint short-circuit, and
  the existing (error-gated) `runDegradedPoll` timer. The always-on heartbeat is
  the natural sibling of that existing poll — it belongs next to it, in the
  worker.
- The main process (`git-state-mirror-router`) is **forward-only**: it relays
  renderer focus/visibility/dirty signals to the worker and fans worker
  `mirror-update` deltas back out. It performs **no git work and runs no
  reconcile timer**.

### H2 — Per-repo key-value dedup queue: one `git status` per repoRoot per cycle

The reconcile queue is **keyed by repoRoot** (a `Map`), not by task/terminal:

- Multiple tasks at the same repoRoot collapse to **one** reconcile.
- A repo that just reconciled is **not** eligible again until its interval
  elapses — `onReconcileDone(repoKey, now)` stamps `lastReconcileAt`, so a
  "just-finished → immediately polls again" back-to-back run is structurally
  impossible.
- An in-flight repo is skipped (`inFlight` guard) — no overlapping `git status`
  for the same repo.
- Cadence bounds: **min cycle = 1 s** (a focused repo), **max cycle = 3 s** (a
  visible-but-unfocused repo). Hidden repos have no heartbeat.

### H3 — Event-driven watcher fast path preserved, unchanged, in parallel

The `@parcel/watcher` subscription, `classifyEventPath` filter, 80 ms debounce,
and watcher-fault → degraded-polling recovery all stay exactly as they are. The
heartbeat is purely **additive** — a second, independent dirty source. When the
watcher works, it still flips the badge sub-second; the heartbeat is the floor,
not the ceiling.

## 4. Design — the `dirty → reconcile` pipeline

Every "this repo may be stale" signal funnels into one pipeline. Sources, all in
parallel:

| Source | Mechanism | Cadence / timing |
|---|---|---|
| watcher file event (fast path) | existing `scheduleRecompute` | 80 ms debounce |
| tab switch → newly-visible git task | `markDirty(repoKey, 'tab-visible')` | immediate |
| task activation / click | `markDirty(repoKey, 'activate')` | immediate |
| **heartbeat — focused task** | `tick()` due | **every 1 s** |
| **heartbeat — visible-unfocused task** | `tick()` due | **every 3 s** |
| hidden task | (none — woken only by tab-switch / activate) | — |

Repo cadence is the **fastest** among its tasks: any focused task → 1 s; else any
visible task → 3 s; else hidden → heartbeat off. The host (worker) checks
`isRepo` cheaply before tracking a task; non-git tasks never reconcile.

The decision table is a pure, dependency-free module:
`electron/main/git-reconcile-scheduler.ts` (`GitReconcileScheduler`), pinned by
`test/unittest/git-reconcile-scheduler.test.mts` (13 assertions). It never reads
the clock (`now` is injected) so it is deterministic and bundle-safe for the
worker. The worker hosts one instance, calls `tick(now)` on a worker-local timer
(interval ≤ 1 s), and for each due repo runs `runRecompute(entry, reason)` —
which already provides per-entry in-flight/queued dedup and the
change-fingerprint short-circuit (a no-op heartbeat emits nothing).

## 5. Architecture & signal flow

```
RENDERER (TerminalGrid)                 MAIN (git-state-mirror-router)        WORKER (git-state-mirror-worker-entry)
─────────────────────────               ──────────────────────────────       ──────────────────────────────────────
focus / visibility change   ──IPC──▶    forward-only relay        ──postMsg──▶  GitReconcileScheduler.setTaskState()
tab switch (visible git tasks) ─IPC──▶   (no git work, no timer)   ──postMsg──▶  .markDirty(repo,'tab-visible')
task activate / click       ──IPC──▶                              ──postMsg──▶  .markDirty(repo,'activate')
                                                                                 ┌───────────────────────────────┐
                            ◀──IPC──    fan out mirror-update      ◀──postMsg──  │ worker-local timer:            │
   badge re-renders                     (GIT_TERMINAL_INFO)                      │   tick(now) → due repos        │
                                                                                 │   runRecompute(entry, reason)  │
@parcel/watcher (in worker) ───────────────────────────────────────────────────│   [fast path, parallel]        │
                                                                                 └───────────────────────────────┘
```

- The "visible repo set" is derived in the worker for free: it already holds one
  `@parcel/watcher` group per subscribed repo (subscribe = visible, with a 30 s
  unsubscribe grace), so live groups == visible repos. The worker only needs to
  know which one is FOCUSED.
- One new worker message kind (main → worker): `reconcile-focus` `{ cwd }` — the
  focused terminal's cwd. The renderer already sends `GIT_NOTIFY_TERMINAL_FOCUS`
  on focus / click (`TerminalGrid.tsx`); the previously no-op main handler now
  forwards it through `TerminalGitInfoBridge.notifyFocus` →
  `gitStateMirrorRouter.setReconcileFocus(cwd)` → worker. No renderer change.
- The worker maps the focused cwd to its repoRoot via the existing
  `entryToGroupKey` map; the scheduler keys by `group.repoRootKey`.

## 6. Cost

- Heartbeat covers **visible tasks only** (focused 1 s, visible-unfocused 3 s);
  hidden background-tab repos run no timer (refreshed on tab-switch). Bounds
  sustained `git status` to the handful of on-screen repos.
- The change-fingerprint short-circuit makes a no-change heartbeat a single
  ~20–50 ms `git status` with **no** downstream fanout/render — no refresh storm.
- All of it is on the worker thread (H1), off the main/render hot paths.
- Huge-repo guard (peer-informed by VS Code's `isRepositoryHuge`): if a repo's
  `git status` repeatedly exceeds a budget, the worker backs its heartbeat off.

## 7. Diagnostics (closes the observability gap this bug exposed)

Register in `src/utils/perf-trace-names.ts`, emit from the worker, document in
`infra/trace.md` §2:

- `worker:git-state-mirror.reconcile-tick` — a heartbeat tick ran (counts of due
  repos by reason).
- `worker:git-state-mirror.reconcile-found-drift` — a heartbeat reconcile
  produced a delta while **no** `watcher-fire` had occurred for that repo in the
  preceding window ⇒ the watcher silently missed a change. This turns the exact
  failure mode behind this bug into a first-class, greppable trace signal.
- `recompute-status-done` already carries `reason`; `'heartbeat-focused'` /
  `'heartbeat-visible'` / `'tab-visible'` / `'activate'` make the trigger
  explicit.

## 8. Test plan

- **Unit (done)** — `test/unittest/git-reconcile-scheduler.test.mts` pins the
  pure decision table: 1 s / 3 s cadence, hidden=no-heartbeat, repo-keyed dedup,
  fastest-cadence aggregation, dirty-fires-immediately, in-flight skip,
  done-resets-cadence, prune-on-remove. 13/13 green.
- **Autotest** — add a `ONWARD_AUTOTEST_GSM_WATCHER_FAIL_*` injection that makes
  the watcher **silently swallow** events (no error), then assert the badge
  still flips to `added` within ≤1 s (focused) / ≤3 s (visible) via the
  heartbeat. Plus: tab-switch refreshes a newly-visible repo; click/activate
  refreshes; hidden repo does not poll. Amend the existing GitStateMirror runner
  (no new `SCRIPTS` row). Timing-sensitive ⇒ aggregate over N trials per the
  repeat-inside-the-test rule.

## 9. Open items / follow-ups

- **Watcher self-heal**: on repeated `reconcile-found-drift` for a repo,
  auto-re-subscribe (restart) its `@parcel/watcher` to restore the fast path
  (deferred; reconcile already guarantees correctness).
- **OSC 133 command-completion** as an extra `markDirty` source for sub-second
  freshness right after a shell command (deferred; focused 1 s already covers it).
- **`getEventsSince`**: `@parcel/watcher`'s `writeSnapshot` + `getEventsSince`
  could cheaply recover dropped events on each reconcile instead of a full
  `git status` (optimization; current short-circuit already keeps no-op ticks
  cheap).
- **Root cause of the silent FSEvents failure** remains unconfirmed (public
  record attributes it to library/limit/volume, not asar/hardened-runtime); a
  dev-build + CDP repro is the way to pin it. The reconcile layer is robust to it
  either way.
