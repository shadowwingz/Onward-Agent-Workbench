<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# Onward Performance Optimization & Perf-Infra Master Plan

> **Status:** PROPOSAL — 2026-06-01. This is a *plan-first* document. **No production code changes are made until this plan is reviewed and approved**, then we execute phase by phase with the user gating each phase.
>
> **Locked decisions (from the kickoff Q&A):**
> 1. **Measure-first budgets.** The ~15 ms "imperceptible" ideal applies only to *input* and *warm-cached* interactions. Cold opens (Git Diff/History, file open, cold start) physically cannot hit 15 ms — they involve a git subprocess, disk read, or Monaco mount. Phase 0 instruments every surface, runs it N times, produces a **real latency distribution**, hands the numbers to the user, and only then does the user set the per-surface budget that gets encoded as a gate.
> 2. **Hybrid runtime posture** for the memory + CPU infra: cheap always-on sampling everywhere; heavy capture (heap snapshot / CPU profile) only on threshold / on-demand / debug builds, with single-shot + cooldown + OOM-spiral guards.
> 3. **CPU profiler = V8 inspector `.cpuprofile` portable baseline (all processes, cross-platform, no OS perms) + OS-native deep tier** (macOS `sample`/`spindump`, Windows WPR/ETW, Linux `perf`) as isolated per-OS adapters, on-demand.
> 4. **Gate-before-optimize.** A surface is not optimized until it has BOTH a functional autotest and a latency gate.

---

## 0. How to read this document

This plan was produced by a read-only territory map (13 parallel code-reading agents over the 7 user-facing surfaces and 6 infra dimensions) plus a peer-research pass (4 agents studying VS Code / Chromium / Electron / Node, cited in §12). Nothing here was guessed: every "current state" claim came from reading the actual source, and every architecture recommendation is grounded in a cited peer precedent per the repo's *Peer-product research before non-trivial design* rule.

The plan is sequenced into Phases (§9). Each phase has an explicit definition-of-done. We do not start Phase N+1 until Phase N is green and the user approves.

---

## 1. Current-state baseline

### 1.1 Trace **capture** is mature; trace **regression detection** is absent

The capture pipeline is genuinely production-grade: a single main-side `performanceTrace` singleton (`electron/main/performance-trace.ts`) is the only disk writer; main, all Node worker threads, and the renderer all funnel into one NDJSON stream (`electron/main/trace-store.ts`), one `thread_name` lane per source, openable directly in Perfetto via `infra/scripts/open_trace.sh`. ~449 event names are registered in `src/utils/perf-trace-names.ts` and indexed in `infra/trace.md` §2.

What does **not** exist: any automated consumer that reads the NDJSON back, computes per-event-name percentiles, and compares against a committed baseline. The `ONWARD_PERF_COMPARE_BASELINE` comparator exists but is **dead in CI** — `run-full-regression.py` never sets the env, and there is **no committed baseline corpus** to diff against. The trace self-checks (`run-trace-infra-self-check`, `run-perf-trace-rotation`) prove the *plumbing* (chunks parse, rotate, survive SIGKILL) but never assert that a given user action emitted the right event, with the right phase, on the right tid lane. Overhead (`~5 µs/event`, "always-on is cheap") is asserted by documentation, never measured.

### 1.2 Existing optimization fabric (do NOT rebuild these)

The densest investment is the Git Diff cache stack — ~6 files:

| Layer | Mechanism | File |
|---|---|---|
| Request | TTL + maxEntries map, single-flight in-flight de-dup, per-key generation counters | `git-diff-request-cache.ts` |
| Content | Per-project LRU (100 MB/project, max 8 projects, 10 MB single-file cap) | `git-diff-content-cache.ts`, `…-wiring.ts` |
| Precompute | Background burst scheduler (largest-file-first, concurrency 3, 50-cap) + cold-start prefetch kick | `git-diff-precompute-scheduler.ts` |
| Snapshot | Submodule/scope structural snapshot, 5 s TTL | `git-repository-snapshot-service.ts` |
| Invalidation | Single-authority bus driven by GitStateMirror deltas + miss-reason classification | `git-diff-cache-invalidator.ts`, `git-diff-content-cache-state.ts` |
| Off-thread | Git CLI runs in a Node worker thread | `git-ipc-worker-client.ts` |

Other shipped optimizations: renderer-side immutable range/patch/content caches in Git History; markdown session-HTML LRU + render-ref mirror + adaptive debounce + `requestIdleCallback`-scheduled commit; Monaco eager warm-up at boot; file-index off-thread build + dual-layer (worker + renderer) cache; ripgrep search off-thread with cancellation/dedup; terminal two-stage IPC output batching + renderer multi-queue scheduler + interactive boost + hidden-output suppression; window `backgroundColor` + `show-on-ready-to-show`.

**Systemic gaps in the existing fabric** (these are the cross-cutting opportunities, §7): every cache is pure in-memory and dies on restart (no disk warm-start); no boot-time anticipatory warm-up; no unified cache governor / memory-pressure backpressure (each cache enforces its own fixed budget in isolation); the markdown worker is `terminate()`d and recreated per file switch (no pool); no V8 compile-cache for worker cold-boot.

### 1.3 Greenfield = literally zero today

Verified by exhaustive grep:

- **Memory monitoring:** zero. `perf-monitor.ts` samples FPS / frame drops / xterm writes / input latency but has **no memory field**. No `process.memoryUsage`/`v8.getHeapStatistics` sampling anywhere. No heap-dump trigger.
- **CPU profiler:** zero. No `node:inspector` Profiler, no `--cpu-prof`, no OS-native `sample`/`WPR`/`perf`. The only CPU signal is the event-loop-stall monitor (timer drift), which tells you the main thread blocked for *N* ms but never *which frames* were executing.
- **Trace regression gate:** zero (see §1.1).

These three are the infra this plan builds (§4, §5, §6).

---

## 2. User-facing surfaces — gap matrix

`L/M/S` = expected gain (large/medium/small); confidence in parens. "First-level entry" = clicked directly from the main UI (strictest latency target).

| Surface | Top optimization (gain/conf) | Dominant hot-path risk | Critical gate gap |
|---|---|---|---|
| **Git Diff** | Wire the list-open trace + add a tight latency gate (M/high) | `GitDiffViewer.tsx` is one ~6,600-line component (broad re-render); renderer prefetch loop is whole-list, uncapped, serial | **No tight latency gate** (only a 7000 ms anti-hang); list-open `MAIN_IPC_GIT_GET_DIFF` + `RENDERER_IPC_GIT_GET_DIFF` are *registered but never emitted* |
| **Git History** | **Move `parsePatchFiles` + `@pierre/diffs` render off the renderer thread + add a main/worker result cache (L/med)** | Diff body is parsed + tokenized + laid out **synchronously on the renderer**; `renderDiff` is a plain non-memoized function called in JSX; **no result cache** for `getGitHistoryDiff`/`getGitHistoryFileContent` | `MAIN_IPC_GIT_GET_HISTORY` is a dead registry entry; **no latency gate**; the GH-* functional suite may be the only coverage |
| **Markdown / HTML preview** | Pool the markdown worker + move parse/highlight/katex into it; sanitize only the visible slice on-renderer (L/med) | **DOMPurify.sanitize runs synchronously on the renderer** on every cache-miss commit; the worker is `terminate()`+recreated on **every file switch** (re-pays katex+highlight boot) | Many pure-logic gates (debounce table, session-cache LRU, KaTeX tokenizers) have **no unit test**; HTML preview first-paint untimed |
| **File open / Monaco** | **Replace the 16 ms full-`getValue()` poll with a cheap readiness signal; chunk the 30 MB single-string IPC payload (L/high)** | `waitForEditorModelReady` polls every 16 ms calling full `model.getValue()` and comparing the **entire file string**; whole-file content up to 30 MB crosses IPC as one JS string | **No open-latency gate at all**; large-file path untested for timing |
| **Terminal** | **Chunk-cap xterm writes *within* a single scheduler flush so the frame budget is enforced inside a target, not only between targets (L/med)** | `xterm.write()` is synchronous on the renderer; cold-start does back-to-back synchronous DOM/GPU ops with no yield | No cold-open first-paint gate; the legacy `Terminal.tsx` path has no scheduler and **zero functional coverage** |
| **Subpage / Tab / layout** | **Trust the Git Diff/History cache on re-open of an *unchanged* repo instead of force-refetching (L/med — see §8 tension)** | Tab-switch re-render cost is **unmeasured and uncapped**; Git Diff/History re-fetch on every `isOpen` flip | **No `run-tab-*` functional runner at all**; no switch-latency gate |
| **Prompt / Quick Open / search / cold start** | Debounce + cancel Quick Open filename search (M/high) | **Quick Open fires a full fuzzy scan on EVERY keystroke** with no debounce; `buildFileIndex` uses `queue.shift()` = O(n²) over the walk | Quick Open / cold-start latency ungated; **app cold start has neither a functional nor a latency gate and zero instrumentation** |

Per-surface detail (entry points, file:line, full opportunity list) lives in the territory-map digest captured during planning; this table is the actionable summary. The recurring pattern: **the click/warm paths are well-instrumented and cached; the *open* paths, the *cold* paths, and the *renderer-thread parse* paths are the holes.**

---

## 3. Phase 0 — Acceptance-gate design ("measure first")

This is the gate the whole initiative hangs on: **you cannot prove an optimization without a gate, and you cannot set a fair budget without measuring first.** Per the locked decision, Phase 0 does not pick budgets — it produces the data that lets the user pick them.

### 3.1 Two-layer gate per surface

Per the repo's *Unit test + autotest as a paired deliverable* rule, every surface we touch gets:

1. **Functional autotest** — would catch a behaviour regression if we refactor the hot path. Most surfaces already have one (the gap matrix flags the exceptions: tab create/switch has none; the legacy terminal path has none).
2. **Latency gate** — a timed assertion with an explicit, product-signed-off budget, using the repo's N-trial aggregation rules.

### 3.2 The measurement loop

For each surface, in order:

1. **Instrument the open/cold path end-to-end.** Wire the registered-but-dead spans first (`MAIN_IPC_GIT_GET_DIFF`, `RENDERER_IPC_GIT_GET_DIFF`, `MAIN_IPC_GIT_GET_HISTORY`, `RENDERER_MARKDOWN_MERMAID`) and add the missing ones (cold-start: `main:app.ready` / `main:window.created` / `renderer:first-paint`; Quick Open per-query span; tab-switch duration span; precompute burst completion). All emitted into the existing `traces/` pipeline.
2. **Author the latency autotest** that drives the real path N times against a real fixture (N=5 boolean / N=3 one-of-three for latency, per the repo timing rules), and **records the distribution** (p50/p95/p99/min/max) into the run log — initially with a generous placeholder budget so it cannot fail.
3. **Run it, harvest the real numbers**, present p50/p95/p99 per surface per OS to the user.
4. **User sets the budget.** Encode it as a named constant (e.g. `const GIT_HISTORY_OPEN_BUDGET_MS = …`) with a `// signed-off: <date>` comment, mirroring the existing `SURFACE_RESTORE_BUDGET_MS` precedent.
5. **Lock it** as a hard gate in the runner and (Phase 1) into the trace-regression baseline.

### 3.3 Budget tiers (proposed framing for step 4)

| Tier | Surfaces | Target shape |
|---|---|---|
| **Input / warm** | Prompt typing, virtual caret, warm Git-Diff file click, already-open subpage switch | ~15 ms ideal; these *can* be imperceptible |
| **Warm open** | Re-open of an unchanged Git Diff/History, retained-view file reopen, markdown session-cache fast path | tens of ms |
| **Cold open** | First Git Diff/History load, cold file open + Monaco mount, cold terminal first paint | measured-then-set; dominated by subprocess/disk/Monaco |
| **Cold start** | App launch → interactive | measured-then-set per OS |

### 3.4 Aggregation & flake control

We adopt the peer-validated discipline (hyperfine / vscode-perf-bot, §12): run N trials, **drop the first (cold) trial**, then aggregate the warm samples. Boolean-correctness → all-N; latency-budget → min-of-N meets budget (transient GC/scheduler spikes acknowledged, systematic regression fails); throughput → median/p95. This is already the house rule in `CLAUDE.md`; Phase 0 makes it uniform across surfaces.

---

## 4. Greenfield infra A — Trace-output regression gate

**Goal:** every regression run reads the NDJSON it already captured and fails if a tracked event's latency regressed past a tolerance band against a committed baseline.

**Peer grounding (§12):** Chromium Catapult uses change-point/anomaly detection over a *time series* (not flat thresholds); Android Benchmark explicitly rejects author-maintained flat baselines; VS Code `vscode-perf-bot` uses best-of-N with a single absolute constant; TracerBench provides Mann-Whitney U / Wilcoxon / confidence-interval primitives for "real regression vs noise"; hyperfine warms then discards cold runs.

**Design — a pure-Node post-run gate** (`test/autotest/perf-gate.mjs`), no Perfetto dependency on the hot path:

1. **Parse & group:** stream the NDJSON chunks, keep only `{ph:'X', dur, name, pid/tid}`, bucket `dur` arrays by `surface:event-name` (surface ∈ main/renderer/worker, derived from the `main:`/`renderer:`/`worker:` naming convention) so a renderer regression is never averaged away by a main one. Convert µs→ms once.
2. **Aggregate with flake control:** N=5, drop trial 1, pool warm samples, compute p50/p95/p99 + stddev per key.
3. **Dual gate per event:** (a) **absolute budget** — does p95 beat the product-signed-off budget? (mirrors `Constants.FAST`); (b) **baseline delta** — is the candidate distribution significantly slower than the committed baseline? Use a `% tolerance band` first (simple, deterministic), with `@tracerbench/stats` confidence-interval as an optional upgrade (requires storing raw sample arrays).
4. **Committed baseline format:** `test/autotest/fixtures/<suite>/perf-baseline.<os>.json` — one file **per suite per OS** (`darwin`/`win32`/`linux`), because budgets were tuned on macOS and Windows/Linux perf differs. Baseline refresh is a **reviewed commit** (governance: a documented regenerate command, never an unreviewed auto-update).
5. **Activate the dormant comparator** (`ONWARD_PERF_COMPARE_BASELINE`) as the interim win while the gate is built, by exporting it from `run-full-regression.py` for the suites that already have latency runners (prompt-input-latency, longtail).
6. **Windows analysis parity:** add `infra/scripts/Open-Trace.ps1` (the only material cross-platform hole — `open_trace.sh` is bash + `open`/`xdg-open`, no `start`).

**Paired tests:** unit-test the pure trace logic that currently has thin coverage — `resolvePhase`, `sanitizeArgs`/`isSensitiveKey` (PII redaction correctness), `enforceBudget` eviction math, `checkRateLimit` token bucket, `normalizeTraceValue`. Plus an overhead benchmark replacing the assumed `~5 µs/event` with a measured `ONWARD_PERF_TRACE=0` vs default-on delta.

---

## 5. Greenfield infra B — Memory watchdog + heap-dump (hybrid)

**Peer grounding (§12):** Node ships three triggers (`--heapsnapshot-signal=SIGUSR2`, `--heapsnapshot-near-heap-limit=N`, programmatic `v8.writeHeapSnapshot()`); a snapshot needs **~2× the live heap**, is synchronous (seconds–minutes), and can itself trigger the OOM it's diagnosing. **VS Code does NOT auto-dump in production** — it ships a Process-Explorer (per-process CPU+memory) + on-demand/CI snapshots. Renderer snapshots go through CDP `HeapProfiler.takeHeapSnapshot` / `webContents.takeHeapSnapshot(path)`; cheaper continuous signal is `HeapProfiler.startSampling`. **Critical insight:** renderer RSS growth is frequently Chromium *resource cache* (images/fonts/css), invisible in a V8 heap snapshot — only `webFrame.getResourceUsage()` sees it, and `webFrame.clearCache()` is a cheaper first remediation than a dump.

### Tier 1 — cheap always-on sampler

A single `MemoryWatcher` owned by main on a 5–10 s timer fans out three cheap reads:

- `app.getAppMetrics()` for every Electron process (main/renderer/GPU/utility): pid, type, `memory.private`/`residentSet`, cpu.
- main-thread `v8.getHeapStatistics()` → `used_heap_size/heap_size_limit` ratio + `number_of_detached_contexts` (a strong leak signal).
- an IPC ping to **each worker thread** (git/sqlite/ripgrep/app-state/markdown) that self-reports `process.memoryUsage()` + `v8.getHeapStatistics()` — **workers are invisible to `getAppMetrics`, so they MUST self-report**.
- each renderer also reports `webFrame.getResourceUsage()` so cache-driven RSS is attributed, not mistaken for a JS leak.

All samples emit as `ph='i'` perf-trace events (`main:mem-watch.sample`, `worker:mem-watch.worker-sample`, `renderer:mem-watch.resource-usage`) at ~1 Hz-class granularity — the breadcrumb a user-reported trace needs, with near-zero cost. Default **OFF** in user builds (`ONWARD_MEM_WATCH=1` to enable), per the VS Code precedent.

### Tier 2 — heavy heap dump, gated three ways

1. **Threshold:** per-process growth-gated — sliding window (last ~12 samples ≈ 2 min), fire only when `used/limit > 0.85` AND a consecutive-rise / positive-slope condition holds. The detection algorithm is a **pure, unit-testable function** (`{timeseries} → {pressure: none|warn|critical}`).
2. **On-demand:** an `ONWARD_*` env one-shot + a debug IPC/menu command ("dump heap of process X").
3. **Safety net:** launch main + workers with `--heapsnapshot-near-heap-limit=2` (via `execArgv` for workers) so a runaway leak still produces a snapshot even if the custom detector mis-tunes.

**OOM-spiral guards (non-negotiable):** global single-flight mutex + per-pid cooldown + session cap (single-shot by default); require N MB headroom before dumping; skip if a dump is already in flight. Renderer dumps go via `webContents.takeHeapSnapshot`; main/worker via `v8.writeHeapSnapshot` (each isolate dumps itself — main cannot dump a worker's heap).

**Artifact lifecycle:** `traces/heap/` (dev) / `userData/debug/` (prod), naming `Heap-<ts>-<pid>-<thread>.heapsnapshot`, size-capped with oldest-eviction (snapshots are 50–500 MB), **flagged as PII-bearing** (live strings = file paths, buffered file contents, env values) — never auto-uploaded; only included in a diagnostic bundle on explicit user action.

**Diagnostic-trace breadcrumbs** (per `CLAUDE.md` rules): `main:memory.pressure-detected`, `main:memory.dump-written`, `main:memory.dump-skipped` (with reason: cooldown / in-flight / insufficient-headroom).

**Cross-platform:** V8 + `process.memoryUsage` are identical on all three OSes (the key strength — no branching). Divergences to branch: `ProcessMemoryInfo.residentSet` is **absent on macOS** (use `private`); `--heapsnapshot-signal` is **inert on Windows** (no Unix signals → on-demand must be IPC/menu-driven there).

---

## 6. Greenfield infra C — CPU profiler (V8 baseline + OS-native deep)

**Peer grounding (§12):** VS Code ships `v8-inspect-profiler` (CDP Profiler over the inspector port). Node `inspector.Session` → `Profiler.enable/setSamplingInterval/start/stop` → `.cpuprofile`; `--cpu-prof` for startup; `session.connectToMainThread()` from a worker. Renderer via `webContents.debugger` Profiler domain (mutually exclusive with open DevTools). `app.getAppMetrics()` CPU% identifies the hog pid first (0 on first call — sample twice). A **hung main thread cannot profile itself** → Chromium's `base::HangWatcher` is an out-of-process/watcher pattern. OS-native deep tier is permission-gated and largely dev-only.

### Tier 1 — portable V8-inspector baseline (cross-platform, no OS perms)

One `ProfilerService` in main, IPC `profiler:start`/`profiler:stop`, targeting driven by `app.getAppMetrics()` (sampled twice ~1 s apart):

- **Main:** `new inspector.Session(); connect()` → Profiler domain → write `traces/cpu/main-<ts>.cpuprofile`. Expose a 100 µs "fine" vs 1000 µs "cheap" sampling toggle.
- **Each worker thread:** a tiny embedded profiler agent creating its **own** `inspector.Session().connect()` inside that worker (NOT `connectToMainThread`, which is for inspecting main *from* a worker); main posts a start/stop control message over the existing worker channel; the worker streams the profile JSON back. This is the only correct way to get a per-worker `.cpuprofile`.
- **Renderer(s):** `webContents.debugger.attach('1.3')` → Profiler → detach, guarded against the DevTools mutual-exclusion.

### Tier 2 — OS-native deep tier (on-demand, isolated per-OS adapters)

| OS | Command | Captures | Permission |
|---|---|---|---|
| macOS | `sample <pid> <secs> 1 -file out.txt` (then `xctrace record --template 'Time Profiler'` for deep) | native + (with symbols) JS frames, text backtrace | dev build needs `com.apple.security.get-task-allow` (stripped from notarized builds → dev-only) |
| Windows | `wpr -start CPU -filemode` / `wpr -stop out.etl` → WPA | native + JS (with V8 ETW provider) | **elevated/Administrator required** (`0xc5585011` otherwise) |
| Linux | `perf record --call-graph=fp -p <pid> -g` → `perf inject --jit` → `perf script` → flamegraph | native + JS (with V8 `--perf-prof --interpreted-frames-native-stack`) | `kernel.perf_event_paranoid ≤ 1` |

### Triggers & viewing

- **Threshold-driven auto-capture:** extend the existing event-loop-stall monitor — when drift crosses a high tier (start with the existing `over1000Ms` bucket), kick a short main-thread profile. For a *hard* main-thread hang (which can't profile itself), follow the HangWatcher pattern: a watcher (worker thread, or a renderer watching main) initiates capture off the blocked thread.
- **On-demand:** `ONWARD_CPU_PROFILE_MS` env (auto-capture first N seconds) + a debug IPC.
- **Viewing:** a `.cpuprofile` opener analogous to `open_trace.sh` → speedscope / DevTools (`.cpuprofile` needs no extra symbol work for app JS). ETW → WPA; perf → flamegraph.
- **Route into `electron/main/diagnostic-bundle.ts`** so a user-reported CPU spike ships the actual stacks, not just stall counters — the highest-leverage diagnostic win.

**Posture:** Tier 1 baseline can be hybrid (threshold-armed in prod, low cost); Tier 2 OS-native is **dev/debug-only** (permission-gated). Paired unit test (threshold/cooldown decision logic) + autotest runner (`run-cpu-profile-autotest.sh`).

---

## 7. Renderer-offload, warm-start & cache governor

**Peer grounding (§12):** Monaco runs language services + **diff computation** in Web Workers (`WorkerBasedDocumentDiffProvider`); VS Code keeps tokenization on the main thread but incremental/yielding/visible-first. **DOMPurify needs a real DOM** — moving it into a worker via linkedom/jsdom **silently under-sanitizes (mXSS)** and is a documented security hazard (cure53/DOMPurify#577, GitLab MR!74963). React's scheduler uses `MessageChannel` + 5 ms slices + `isInputPending`; the standardized `scheduler.postTask` exposes user-blocking/user-visible/background. Node `module.enableCompileCache` / `NODE_COMPILE_CACHE` (v22.1+) shrinks worker cold-boot.

### 7.1 What to move off the renderer thread (ordered by payoff/risk)

1. **`@pierre` Git-History diff parse → pooled worker thread.** Pure text-in / structured-diff-out, exact Monaco precedent, highest payoff, lowest risk, no DOM. This is the single biggest renderer-responsiveness win in the gap matrix.
2. **Markdown parse + highlight.js + KaTeX → worker** (string → HTML string). Then run **real DOMPurify on the renderer**, but only over the **visible viewport slice**, chunked via `scheduler.postTask` so it never blocks a keystroke. This splits the cost: the O(n) parse/highlight/math leaves the renderer; the security-critical sanitize stays on a trustworthy DOM. **Do NOT move DOMPurify into a worker.**
3. **Pool the markdown worker** (stop `terminate()`+recreate per file switch; reuse via owner-id routing) and apply `NODE_COMPILE_CACHE` to all worker entries.

### 7.2 Warm-start & governor (cross-cutting)

- **Disk-persisted warm-start** of the renderer **file index** + a **last-working-set manifest** (paths only, not bodies) to `userData`, rehydrated + revalidated (mtime/size/hash) on launch — VS Code's working-copy/backup precedent. Bodies are never persisted (freshness + PII).
- **Anticipatory boot-time warm-up** on the `MainWorkScheduler` background lane: proactively warm the last-open project's file index + diff working-set + git snapshot before first input.
- **Central cache governor** with a uniform `trim(pressureLevel)` interface across the diff content cache, request cache, snapshot cache, and file-index cache, fed by the Tier-1 memory sampler (§5) — so caches shrink under real memory pressure instead of each holding a fixed isolated budget.
- **Promote "prompt input wins" to a global invariant:** today the priority model is enforced for terminal output only. Have at least Git-status fanout apply and global-search apply consult `inputPriorityLane.shouldYieldToPromptInput()`. Either wire a real caller for `MainWorkScheduler`'s dead `realtime-input` lane or remove it.

---

## 8. The cache-freshness tension (must resolve before §7/Subpage work)

The highest-leverage subpage optimization — **trust the Git Diff/History cache on re-open of an unchanged repo instead of force-refetching** — directly contradicts `docs/lessons.md` lesson #3 *("subpage entry should always trigger a freshness fetch, not rely on the cache")*, which was learned from a real bug where a time-based cache showed stale state after an FS mutation.

**Why it may now be safe to revisit:** that lesson predates GitStateMirror. The Mirror is now the **single authority** on whether a repo's working tree changed (it owns the parcel-watcher + porcelain-v2 status + change fingerprint, and fans out deltas). So the safe formulation is **not** "trust the cache" but: **"on re-open, trust the cache *iff* the GitStateMirror generation for this repo root has not advanced since the cache entry was written; otherwise force-refresh."** That preserves lesson #3's guarantee (you always see post-mutation state) while skipping the redundant refetch in the common unchanged case.

This is a correctness-sensitive change. The plan: bring a detailed design + a dedicated autotest that drives the exact lesson-#3 failure path (mutate file while subpage is closed, reopen, assert fresh) **before** touching the re-fetch path. Not changed unilaterally.

---

## 9. Phased roadmap & definition-of-done

| Phase | Scope | Definition of done |
|---|---|---|
| **0 — Acceptance gate + measure** | Instrument every open/cold path (wire dead spans + add cold-start/quick-open/tab-switch spans); author functional gates where missing (tab create/switch, legacy terminal decision); author latency autotests with placeholder budgets; **run, harvest distributions, present to user, user sets budgets, encode**. | Every surface in §2 has a functional autotest + a latency autotest; real p50/p95/p99 measured per OS; budgets signed off and encoded as named constants. |
| **1 — Trace regression gate** | `perf-gate.mjs` (parse→aggregate→dual-gate), committed per-suite per-OS baselines + governance, activate dormant comparator, `Open-Trace.ps1`, unit tests for pure trace logic, overhead benchmark. | Regression run fails on a synthetic injected regression; baseline regenerate command documented; Windows analysis parity; trace-logic unit tests green. |
| **2 — Memory + CPU infra** | MemoryWatcher (Tier 1 sampler + Tier 2 gated dump + OOM guards); ProfilerService (V8 baseline all processes + OS-native deep adapters + stall-triggered + diagnostic-bundle wiring). Paired unit + autotests. | Synthetic allocation flips detector to critical + writes one guarded dump; CPU profile captured on-demand + on-stall and opens in a viewer; both wired into diagnostic bundle; per-OS adapters validated. |
| **3 — High-leverage optimizations (per surface)** | In gain order, each "gate → change → gate verifies → trace before/after": Git History off-thread + result cache; markdown worker pool + parse-off-thread + sliced sanitize; Monaco readiness signal + IPC chunking; Quick Open debounce + O(n) index build; terminal flush chunk-cap; subpage cache-trust (§8). | Each surface's latency gate shows a *meaningful* improvement (not marginal — per the user's "if it's only a tiny gain, don't bother"); no functional regression; trace before/after captured. |
| **4 — Cross-cutting** | Disk warm-start + anticipatory boot warm-up; central cache governor + memory-pressure backpressure; global prompt-input-wins priority; worker compile-cache. | Cold-start + warm-open budgets improved; governor trims under injected pressure; priority invariant asserted by autotest. |

We stay in the loop between phases: each phase is reviewed before the next starts. Per-feature perf + diagnostic-trace instrumentation and the 5-step test SOP apply to every change inside every phase (not deferred).

---

## 10. Cross-platform matrix (per `CLAUDE.md` three-platform rule)

| Concern | macOS | Windows | Linux |
|---|---|---|---|
| Memory in-process V8 / `process.memoryUsage` | ✅ identical | ✅ identical | ✅ identical |
| `ProcessMemoryInfo.residentSet` | ❌ absent → use `private` | ✅ | ✅ |
| `--heapsnapshot-signal` | ✅ SIGUSR2 | ❌ inert → IPC/menu trigger only | ✅ |
| CPU V8 inspector baseline | ✅ no perms | ✅ no perms | ✅ no perms |
| CPU OS-native deep | `sample`/`xctrace`; dev needs `get-task-allow` | WPR/ETW; **admin required** | `perf`; `perf_event_paranoid ≤ 1` |
| Trace analysis opener | `open_trace.sh` (`open`) | ❌ **gap → add `Open-Trace.ps1`** (`start`) | `open_trace.sh` (`xdg-open`) |
| Perf baseline file | `perf-baseline.darwin.json` | `perf-baseline.win32.json` (read NDJSON as utf8, split `/\r?\n/`) | `perf-baseline.linux.json` |
| FS case sensitivity (warm-start keys) | insensitive | insensitive | **sensitive → exact key compare** |

---

## 11. Open decisions still needed (before specific phases)

These are deferred to the relevant phase, not blocking the plan's approval:

1. **Per-surface budgets** — set by the user after Phase 0 measurement (the whole point of measure-first).
2. **Memory-watchdog default in prod** — confirmed hybrid; need the exact `used/limit` threshold + window length once we have real RSS curves.
3. **§8 cache-freshness** — approve the "trust iff Mirror generation unchanged" formulation before Phase 3 subpage work.
4. **OS-native CPU tier scope** — confirmed dev-only given permission gates; confirm we ship the adapters for all three OSes in Phase 2 or stage macOS-first.

---

## 12. Peer-research citations

**Memory:** Node heap-snapshot diagnostics <https://nodejs.org/learn/diagnostics/memory/using-heap-snapshot>; node-heapdump growth-gated pattern <https://github.com/bnoordhuis/node-heapdump>; VS Code Process Explorer / no-auto-dump posture <https://github.com/microsoft/vscode/issues/10149>; CDP HeapProfiler <https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/>; Electron memory case study (webFrame resource cache) <https://seenaburns.com/debugging-electron-memory-usage/>.

**CPU:** v8-inspect-profiler <https://github.com/jrieken/v8-inspect-profiler>; Node inspector <https://nodejs.org/api/inspector.html>; Chromium HangWatcher <https://chromium.googlesource.com/chromium/src/base/+/refs/heads/main/threading/README.md>; V8 linux-perf JS symbolication <https://v8.dev/docs/linux-perf>.

**Regression gate:** Catapult change-point detection <https://github.com/catapult-project/catapult/blob/master/dashboard/dashboard/find_change_points.py>; Android Benchmark anomaly detection <https://medium.com/androiddevelopers/fighting-regressions-with-benchmarks-in-ci-6ea9a14b5c71>; vscode-perf-bot best-of-N <https://github.com/microsoft/vscode-perf-bot>; TracerBench stats <https://github.com/TracerBench/tracerbench/tree/master/packages/stats>; hyperfine <https://github.com/sharkdp/hyperfine>.

**Renderer offload / warm-start:** Monaco editor workers <https://github.com/microsoft/monaco-editor/issues/4264>; VS Code tokenization-on-main-thread <https://code.visualstudio.com/blogs/2017/02/08/syntax-highlighting-optimizations>; VS Code working copies/backup <https://github.com/microsoft/vscode/wiki/Working-Copies>; GitLab DOMPurify→js-xss in worker <https://gitlab.com/gitlab-org/gitlab/-/merge_requests/74963>; DOMPurify-in-worker hazard <https://github.com/cure53/DOMPurify/issues/577>; Prioritized Task Scheduling <https://developer.mozilla.org/en-US/docs/Web/API/Prioritized_Task_Scheduling_API>; Node compile cache <https://nodejs.org/api/module.html#moduleenablecompilecachecachedir>.

> Citations are from a no-fetch-failure research pass; a few exact numeric constants (Catapult anomaly thresholds, VS Code's run-split) could not be byte-verified and are flagged in the research notes. Verify any constant before hard-coding it.
