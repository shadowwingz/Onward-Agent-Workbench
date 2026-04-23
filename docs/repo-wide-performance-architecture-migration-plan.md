<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Repo-wide Performance Architecture Migration Plan

## Goal

Move Onward from local performance fixes to a repo-wide scheduling and worker
architecture that keeps Prompt input responsive while terminals, search, file
indexing, Git, persistence, and other background workloads are active.

The acceptance point is user-visible latency, not internal throughput. The
primary metric is scheduled Prompt input to the next paint where the typed
character is visible. Mean latency is not enough; every migration phase must
track p99, p999, max latency, standard deviation, and event-loop stall counters.

## Non-negotiable Rules

- The renderer is the user input loop. It must not run terminal parsing, Git
  work, project search, full file indexing, large JSON parsing/stringifying,
  DOM sanitization, or large list sorting when that work can be moved to a
  Worker Thread, utility process, or main-process worker client.
- Main process handlers must not perform CPU-heavy or large synchronous file
  work on IPC hot paths. The main process should schedule, route, coalesce, and
  observe work instead of executing it directly.
- Prompt input has global priority over terminal output, project search, file
  indexing, AppState persistence, Git polling, and maintenance jobs.
- Every high-volume source must support batching, deduplication, cancellation,
  and owner cleanup on tab close, task close, project switch, or app shutdown.
- A performance migration is not complete without before/after JSON results and
  threshold gates for Prompt input latency under pressure.

## Current Risk Inventory

The first Git, SQLite, and terminal-output refactors reduced the known
six-terminal pressure path, but several repo-wide paths still violate the target
model.

| Area | Current risk | Why it matters |
| --- | --- | --- |
| AppState | `src/contexts/AppStateContext.tsx` keeps broad state in one React context and persists large state snapshots. | Unrelated task updates can re-render Prompt, Prompt History, context menus, and project UI. |
| AppState storage | `electron/main/app-state-storage.ts` still contains synchronous file operations and full JSON clone/stringify paths. | Large state snapshots can create main-process event-loop spikes. |
| Project file index | `src/components/ProjectEditor/ProjectEditor.tsx` builds a file index from the renderer through repeated IPC calls. | Large repos can block renderer input and flood main IPC handlers. |
| Filename fuzzy search | `src/components/ProjectEditor/ProjectEditor.tsx` and `src/components/ProjectEditor/GlobalSearch/SearchPanel.tsx` score and sort broad file lists in the renderer. | Every keystroke can become O(n log n) renderer work. |
| Content search | `electron/main/ripgrep-search.ts` parses rg JSON output in the main process; `src/components/ProjectEditor/GlobalSearch/useGlobalSearch.ts` groups batches in the renderer. | High-match searches can stress both main and renderer. |
| Project tree watch | `electron/main/project-tree-watch-manager.ts` performs synchronous stat work in raw file-watch handling. | File storms can stall the main process. |
| Markdown/changelog rendering | Renderer paths still perform DOM sanitization and fallback markdown rendering. | Large content can create renderer long tasks. |
| Project file reads | `electron/main/project-editor-utils.ts` handles large reads, image data URLs, EPUB buffers, and directory sorting in main-process IPC paths. | Large files and folder scans compete with input-related IPC. |

## Target Architecture

```text
User input
  -> Renderer prompt input lane
     -> local paint first
     -> low-cost state patch
     -> background persistence queue

PTY / project / Git / search / file events
  -> Main process routing
     -> MainWorkScheduler
        -> WorkerClient
           -> domain worker
              -> coalesced result batch
                 -> RendererWorkScheduler
                    -> selector store update
                       -> narrow React render
```

The intended architecture has four shared layers.

## Layer 1: MainWorkScheduler

Create a repo-wide scheduler by generalizing the existing Git runtime scheduling
pattern. All expensive main-side work must enter this scheduler instead of
running directly inside IPC handlers or event callbacks.

Required lanes:

| Lane | Use cases | Rules |
| --- | --- | --- |
| `realtime-input` | terminal writes, focus changes, Prompt-adjacent IPC | Lowest queue latency; no heavy work allowed. |
| `focused-interactive` | focused task output, active project operation | Time-bounded boost; cannot starve Prompt input. |
| `visible-ui` | visible task output, visible search result chunks | Batched and frame-budget aware. |
| `background-index` | file indexing, tree watch reconciliation, background search | Deduped by project root and cancellable by owner. |
| `maintenance` | persistence flush, update checks, cache compaction | Runs only when higher lanes are idle or under explicit deadlines. |

Scheduler contract:

- `enqueue({ lane, ownerId, dedupeKey, priority, timeoutMs, signal, run })`
- Per-lane queue depth metrics.
- Queue wait p95/p99/p999 metrics.
- Worker execution p95/p99 metrics.
- Dedupe hit and cancellation counters.
- Owner cleanup on close/switch.
- Cross-platform behavior must not depend on shell-specific commands.

## Layer 2: Standard WorkerClient

Standardize the worker client currently represented by the Git and SQLite worker
clients so every domain gets the same reliability and measurement behavior.

Required worker-client features:

- Request id and typed response envelope.
- Timeout and cancellation.
- Pending request map cleanup.
- Crash detection and restart policy.
- Trace events for enqueue, worker start, worker finish, timeout, cancel, and
  crash.
- Transferable payload support where possible.
- Clear shutdown on app quit.

Initial worker domains:

| Worker | Responsibility | Migration status |
| --- | --- | --- |
| Git IPC worker | Git diff/history/status requests. | Already started; keep behind scheduler. |
| SQLite worker | SQLite read/query/export pressure. | Already started; wrap with shared scheduler/metrics. |
| AppState worker | Patch merge, snapshot compaction, durable writes. | New. |
| Project FS worker | Recursive list, stat, read metadata, file preview preparation. | New. |
| File Index worker | File index build, incremental update, filename fuzzy top-k. | New. |
| Search worker | rg stdout parsing, result grouping, replay cache, cancellation. | New. |
| Markdown worker | Markdown parse/sanitize preparation where feasible. | Partial existing markdown worker; move sanitizer pressure out of renderer or budget it strictly. |

## Layer 3: RendererWorkScheduler

Generalize the terminal output scheduler into a renderer-wide scheduler. The
renderer must batch UI updates and yield to input before processing background
updates.

Required lanes:

| Lane | Use cases | Rules |
| --- | --- | --- |
| `prompt-input` | Prompt text entry, caret movement, composition events | Highest priority. Runs before any terminal/search/app-state update. |
| `focused-task` | focused terminal input/output | Short boost after direct interaction. |
| `visible-task-output` | visible non-focused terminal output | 20 ms or frame-budgeted batching. |
| `visible-ui` | visible search result chunks, file tree deltas | Chunked; max apply budget per frame. |
| `background-ui` | hidden task summaries, non-visible project updates | Buffered, summarized, or dropped until visible. |

The scheduler must expose metrics for frame budget usage, dropped/deferred work,
input preemption count, and per-lane apply duration.

## Layer 4: Selector Stores Instead of Broad Context

Replace broad React Context invalidation with domain stores and selector-based
subscriptions. UI components should subscribe only to the state slice they use.

Target stores:

| Store | Contents | Persistence |
| --- | --- | --- |
| `PromptStore` | current Prompt input, Prompt History/List UI state | Patch-based persistence for durable fields only. |
| `TaskTerminalStore` | tabs, terminals, focus, visibility, terminal metadata | Patch-based persistence for durable layout; ephemeral focus in memory. |
| `ProjectEditorStore` | active project, editor tabs, search state | Durable patches for restore data; search result data remains ephemeral. |
| `UIPreferencesStore` | layout, theme, editor preferences | Low-frequency durable patches. |
| `EphemeralInteractionStore` | context menu, hover, drag, transient selection | Never persisted; isolated from Task output refresh. |

The context menu bug class is fixed only when Task refreshes cannot invalidate
Prompt History / Prompt List context menu ownership.

## AppState Persistence Design

Replace full-state writes with patch persistence.

```text
Renderer domain store
  -> small patch event
     -> main AppStatePatchQueue
        -> AppState worker
           -> append/merge patch
           -> periodic compact snapshot
           -> async durable write
```

Rules:

- Prompt input paint must not wait for persistence.
- Multiple patches for the same owner/key must be coalesced.
- App close must request a bounded flush and report failures without freezing
  the renderer.
- Full snapshot stringify belongs in the AppState worker, not in renderer or
  main IPC handlers.
- Add metrics for patch count, coalesced count, flush duration, snapshot size,
  and write failures.

## Project FS and Search Design

Move project-wide scanning and search out of the renderer.

File index flow:

```text
Renderer requests project index
  -> main schedules background-index job
     -> File Index worker walks tree and builds index
        -> chunked index-ready / index-delta events
           -> renderer store receives bounded deltas
```

Filename search flow:

```text
Renderer query
  -> cancellable worker request
     -> worker fuzzy score with top-k selection
        -> top results only
           -> renderer applies small result set
```

Content search flow:

```text
Renderer query
  -> main schedules Search worker
     -> worker owns rg process and stdout JSON parsing
        -> worker groups and coalesces matches
           -> main forwards bounded batches
              -> renderer applies visible chunks
```

Rules:

- Renderer must not map/sort the full file index per keystroke.
- Search queries must cancel superseded queries.
- Result replay cache belongs in the worker or main scheduler, not in renderer
  component state.
- Hidden or background project views should receive summaries, not full result
  streams.

## Baseline and Regression Matrix

Each phase must produce before/after JSON files and compare them with
`test/compare-performance-baseline.mjs` where applicable.

| Suite | Scenario | Acceptance gate |
| --- | --- | --- |
| Prompt input latency | six visible Tasks output while typing in Prompt | p95 <= 120 ms, max <= 250 ms, mismatches = 0. |
| Prompt long-tail | six visible Tasks plus Git/status pressure | p99 <= 160 ms, p999 <= 300 ms, max <= 600 ms, stddev <= 60 ms, over500 = 0. |
| Prompt + AppState churn | terminal output plus repeated state patches and open context menu | context menu remains mounted; p999 <= 300 ms; no broad React commit spike. |
| Prompt + file index | large fixture, file index build, continuous Prompt typing | p999 <= 300 ms, max <= 600 ms, main over1000 = 0. |
| Prompt + filename search | large file index, continuous fuzzy query updates | search apply p99 <= 8 ms, Prompt p999 <= 300 ms. |
| Prompt + content search | high-match rg workload plus continuous Prompt typing | renderer result apply p99 <= 8 ms, Prompt p999 <= 300 ms. |
| Prompt + tree watch storm | bulk create/delete/rename fixture files | main over1000 = 0, watch events coalesced, Prompt p999 <= 300 ms. |
| Combined pressure | terminal, Git, SQLite, AppState churn, file index, and search together | no input mismatch, over500 = 0, no main over1000 stalls. |

Required metrics:

- Prompt input p95, p99, p999, max, stddev, over250, over500.
- Renderer event-loop delay and long-task count.
- Main event-loop max drift, over1000, over3000, over6000.
- React commit count by store/domain.
- IPC messages per second by channel.
- Scheduler queue depth, wait latency, execution latency, dedupe hits, cancels.
- Worker crash/restart/timeout count.
- AppState patch count, flush duration, snapshot size.

## Migration Phases

### Phase 0: Instrumentation First

Add observability without changing behavior.

Deliverables:

- Main scheduler trace schema, even before all jobs are migrated.
- Renderer long-task and React commit counters by domain.
- AppState save/clone/stringify/write timing.
- IPC per-channel rate counters.
- New automated suites for AppState churn, file index pressure, search pressure,
  and tree watch storm.

Exit criteria:

- Baseline JSON exists for every suite in the matrix.
- The test fixtures live under `test/fixtures/<suite-name>/`.
- The result files are written under `test/results/<suite-name>/`.

### Phase 1: AppState Split and Patch Persistence

Deliverables:

- Domain stores with selector subscriptions.
- `EphemeralInteractionStore` for context menus and transient UI state.
- AppState patch queue and AppState worker.
- Full-state snapshot only in worker compaction.

Exit criteria:

- Task refresh no longer re-renders Prompt History/List unless their selected
  data changes.
- Prompt History context menu stays open during six-task output pressure.
- AppState churn suite passes its p999/max gates.

### Phase 2: Project FS and File Index Workers

Deliverables:

- Project FS worker for recursive list, stat, read metadata, and preview
  preparation.
- File Index worker with incremental updates.
- Filename fuzzy search moves to worker top-k selection.
- Renderer receives only bounded result sets and deltas.

Exit criteria:

- Renderer does not map/sort the full file index per keystroke.
- File index pressure and filename search suites pass.
- Main process has no synchronous stat/read loop in tree-watch pressure paths.

### Phase 3: Search Worker

Deliverables:

- Search worker owns rg lifecycle, stdout parsing, grouping, and replay cache.
- Query cancellation and dedupe by project root/query/options.
- Renderer applies bounded result chunks through the renderer scheduler.

Exit criteria:

- High-match content search does not produce main-process over1000 stalls.
- Search result apply p99 stays within the frame budget.
- Prompt input p999 remains within gate while search streams results.

### Phase 4: Renderer Scheduler Generalization

Deliverables:

- Shared `RendererWorkScheduler` used by terminal output, search results, file
  tree deltas, AppState-driven UI updates, and background maintenance UI.
- Per-lane frame budget and input preemption.
- Hidden-view buffering or summarization for non-visible consumers.

Exit criteria:

- Combined pressure suite passes.
- Prompt input lane records preemption over lower-priority work.
- No visible starvation for focused terminal output.

### Phase 5: Remaining Heavy Paths

Deliverables:

- Markdown/sanitization pressure moved out of the input path or made strictly
  frame-budgeted.
- Update/changelog/project preview operations scheduled as maintenance or
  background work.
- Repo-wide audit forbids new synchronous heavy work in renderer/main hot paths.

Exit criteria:

- No remaining known CPU-bound or large sync IO path can be triggered while
  blocking Prompt input.
- New performance-sensitive features have a baseline suite before merge.

## Cross-platform Requirements

Every worker and test fixture must be designed for macOS, Linux, and Windows.

- Do not rely on shell-specific syntax for fixture generation unless the runner
  has explicit platform branches.
- Avoid path separator assumptions; normalize paths at API boundaries.
- File watcher behavior differs by platform, so tree-watch tests must assert
  coalesced semantic deltas rather than raw event counts.
- Process cleanup must use exact process names only.

## Definition of Done

A migration phase is done only when all of the following are true:

- The heavy work for that domain no longer runs on the renderer input loop.
- Main-process IPC handlers for that domain only route, schedule, or coalesce.
- The domain supports cancellation, dedupe, and owner cleanup.
- Before/after JSON results exist.
- Prompt input p999/max and main event-loop stall gates pass.
- The implementation uses shared scheduler/worker contracts instead of a
  domain-specific one-off patch.
- Documentation and performance regression procedures are updated when the
  acceptance surface changes.
