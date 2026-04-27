<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# Onward Trace System Index

The authoritative index of Onward's performance / behaviour tracing
infrastructure. **Before any performance optimisation or experience
tweak, register an event here, capture a trace, and look at data.**
This is how `CLAUDE.md` Hard rule § 3 ("data-first") is enforced.

**Upstream reference**: https://perfetto.dev/docs/ — Perfetto's
trace_processor, Chrome Trace Event Format spec, SQL table model,
and TrackEvent schema.

Document layout:
1. System architecture
2. Implemented trace events
3. Planned trace events (gaps to fill)
4. On-disk format (Chrome Trace Event Format, JSON subset Onward uses)
5. Toolchain usage
6. Extension rules — how to add an event

---

## 1. System architecture

```
┌────────────── Electron main (pid=1, tid=1) ─────────────────┐
│  electron/main/perf-trace-logger.ts                          │
│    · startEventLoopMonitor()   — 250 ms sample; drift ≥ 100  │
│      ms → main:event-loop-stall                              │
│    · startGitRuntimeMonitor()  — 1 s tick → main:git-runtime-│
│      summary + main:gitwatch-summary                         │
│    · record(name, data, source?) — generic emitter           │
│        ↓                                                     │
│    <repoRoot>/traces/perf/perf-trace-<ISO>-<pid>.json        │
│    (Chrome Trace Event Format — loaded natively by Perfetto  │
│     UI and trace_processor_shell; SQL on the same `slice`,   │
│     `thread`, `process` tables as .pftrace)                  │
│                                                              │
│  Workers (Node Worker threads):                              │
│    · app-state / git-ipc / git-status / project-fs / sqlite  │
│      / ripgrep                                               │
│    · Each worker-client in electron/main/*-worker-client.ts  │
│      emits a ph='X' latency slice per request on the main    │
│      thread (track pid=1, tid=1) — the worker itself is a    │
│      synchronous message pump so the request is its own span │
│                                                              │
┌────────────── Electron renderer (pid=2, tid=<wc.id>) ────────┐
│  src/utils/perf-trace.ts                                     │
│    · installPromptInputTrace() — input → rAF → rAF → paint,  │
│      emits renderer:prompt-input-paint                       │
│    · installRendererStallTrace() — 250 ms + per-frame rAF    │
│    · PerformanceObserver('longtask') → renderer:longtask     │
│  src/utils/perf-monitor.ts                                   │
│    · 1 s aggregation → renderer:perf-snapshot                │
│        ↓ IPC DEBUG_PERF_TRACE (sender.id → tid)              │
│    main-side perfTraceLogger.record(event, data, {           │
│      process: 'renderer', tid })                             │
│                                                              │
└──────────────┬───────────────────────────────────────────────┘
               │
               ▼
┌─ infra/scripts/open_trace.sh ────────────────────────────────┐
│  · Bootstrap + start trace_processor_shell --httpd :9001,    │
│    load newest traces/perf/*.json                            │
│  · Pin UI URL to tp_shell build:                             │
│    https://ui.perfetto.dev/v<ver>-<sha>/#!/?rpc_port=9001    │
│  · Open browser automatically — trace never leaves localhost │
└──────────────┬───────────────────────────────────────────────┘
               │
               ├─► Perfetto UI (slice / instant / counter tracks)
               └─► SQL queries (Python `perfetto.trace_processor`
                   against the same file, no conversion)
```

Key design decisions:

| Decision | Choice | Rationale |
|---|---|---|
| Wire format | Chrome Trace Event Format (`{"traceEvents":[…]}`) | Perfetto UI and `trace_processor_shell` consume it natively; zero extra dependency; Node's built-in `JSON.stringify` is enough |
| Output path | `<repoRoot>/traces/perf/` (dev + autotest), `userData/debug/` (packaged production) | Dev-time traces are diff-friendly and CI-collectable; end users without a checkout still get local diagnostics |
| Event-name registry | `src/utils/perf-trace-names.ts` single const enum | Perfetto SQL queries key on event names — a centralised registry makes renames visible and prevents drift |
| Phase mapping | `resolvePhase()` routes by name: stall / longtask / input-paint default to `X` with auto-derived `dur` | Callers pass `(name, data)` without worrying about Chrome trace protocol details |
| File closure | Terminal `{}` element + `]}` on graceful quit; `SIGTERM` / `SIGINT` / `will-quit` / `before-quit` all flush | Perfetto UI tolerates truncated arrays on crash; tp_shell is strict, so we also close in the T02 self-check before handing tp_shell the file |
| UI build pinning | Grep `tp_shell --version` → `ui.perfetto.dev/v<ver>-<sha>/` path | Avoids the "different build" warning banner that fires when the cloud UI leads or lags tp_shell |
| Per-Task tid lanes | `assignTaskTid(terminalId, side)` — main tids start at 10000, renderer at 20000; thread_name = `task-<shortId>` (main) / `task-<shortId>-rnd` (renderer); auto-emitted on first event | Lets every hop in the PTY data-flow pipeline (onData → buffer → IPC send → renderer recv → scheduler enqueue → scheduler flush → xterm.write) line up on one Perfetto row per Task, on both processes. Real `tid=1` / `tid=WebContents.id` rows retained unchanged for everything not task-scoped. |

### PTY data flow — end-to-end, per Task row

Every hop below is emitted onto the same `task-<shortId>` tid (renderer
side has `-rnd` suffix; time axis aligned). Reading left-to-right in
Perfetto UI tells the full story: when the PTY fired, when main
flushed IPC, when the renderer received it, when the scheduler got to
it, and when xterm actually wrote. Reverse direction (user input) is
symmetric.

```
Task track (per terminalId)                                         Event name
────────────────────────────────────────────────────────────────    ─────────────────────────────────────
  (output)  ptyProcess.onData                                        — aggregated in main:terminal-data-ipc-summary
      │
      ▼
  ipc-handlers.ts:635  TerminalDataBuffer.push
      │ (buffer:  fast≤128B direct / boost flush / batched 100 ms)
      ▼
  ipc-handlers.ts:600  webContents.send(TERMINAL_DATA)               main:terminal-data.ipc-send  (X, path=fast|boost|batched, bufferAgeMs, bytes)
════════════════════════════════════════════════════════════════════════ IPC boundary
  preload/index.ts:1082   ipcRenderer.on(TERMINAL_DATA)
      │
      ▼
  terminal-session-manager.ts:207  onData listener                   renderer:terminal-data.ipc-recv  (i, bytes)
      │
      ├─ fast path (≤128B / boost active, no pending):              renderer:terminal-data.fast-path  (i, bytes, interactiveBoost)
      │      ─► writeTerminalData                                    renderer:terminal-data.xterm-write (X, bytes, durationMs)
      │
      └─ slow path (bufferred):
             pendingData.push + markDirty                             renderer:terminal-data.scheduler-enqueue  (i, bytes, pendingBytes)
             OutputScheduler.flush (frame-budget loop)                renderer:terminal-data.scheduler-flush  (X, bytes, durationMs)
                 ─► target.writeData → session.terminal.write         renderer:terminal-data.xterm-write  (X, bytes, durationMs)

  (input)   xterm onData → electronAPI.terminal.write                renderer:terminal.send-input  (i, kind, bytes)
      │                                                               renderer:ipc.terminal.write  (X, durationMs)
      ▼
  ipc-handlers.ts  ipcMain.handle(TERMINAL_WRITE)                     main:ipc.terminal.write  (X)
      │
      ▼
  pty-manager.ts  ptyManager.write                                     main:pty.write  (X, path=small|large, bytes, durationMs)
      │
      ▼
  record.pty.write(data)
```

`renderer:terminal-data.scheduler-flush` is **also** emitted on the
default renderer tid (no terminalId) — the scheduler heartbeat carries
`processed` count, `durationMs`, `frameBudgetMs` so its cost is
visible even when no single Task dominates.

---

## 2. Implemented trace events

Registered in `src/utils/perf-trace-names.ts` and emitted by the code
listed under each section. Event names MUST NOT change once in use —
append new names, never rename existing ones.

### 2.1 Main process (pid=1, tid=1)

#### Lifecycle

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `MAIN_TRACE_START` | `main:trace-start` | `i` (g) | `perf-trace-logger.ts` first start() |
| `MAIN_TRACE_STOP` | `main:trace-stop` | `i` (t) | `perf-trace-logger.ts::stop()` |
| `MAIN_APP_BEFORE_QUIT` | `main:app.before-quit` | `i` | `electron/main/index.ts` `app.on('before-quit')` |
| `MAIN_APP_WILL_QUIT` | `main:app.will-quit` | `i` | `electron/main/index.ts` `app.on('will-quit')` |

#### Monitors (1 s tick)

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `MAIN_EVENT_LOOP_STALL` | `main:event-loop-stall` | `X` (`dur`=driftMs) | `startEventLoopMonitor()` — 250 ms sample, ≥ 100 ms threshold |
| `MAIN_EVENT_LOOP_METRICS_RESET` | `main:event-loop-metrics-reset` | `i` | `resetEventLoopMetrics()` |
| `MAIN_GIT_RUNTIME_SUMMARY` | `main:git-runtime-summary` | `i` (t) | `startGitRuntimeMonitor()` — 1 s |
| `MAIN_GIT_RUNTIME_SUMMARY_ERROR` | `main:git-runtime-summary-error` | `i` | same, on exception |
| `MAIN_GITWATCH_SUMMARY` | `main:gitwatch-summary` | `i` (t) | `git-watch-manager.ts` 1 s roll-up |
| `MAIN_TERMINAL_DATA_IPC_SUMMARY` | `main:terminal-data-ipc-summary` | `i` (t) | `ipc-handlers.ts` terminal IPC counter sampler |

#### Git Diff cache & freshness (Bug 1 / Bug 2)

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `MAIN_GIT_DIFF_CACHE_HIT` | `main:git.diff.cache-hit` | `i` | `electron/main/git-utils.ts::getGitDiff` — request-level cache served without spawning git. Tagged `cwd`, `scope`, `ageMs`. |
| `MAIN_GIT_DIFF_CACHE_INVALIDATE` | `main:git.diff.cache-invalidate` | `i` | Same file — cleared on watcher debounce, force=true entry, or LRU eviction. Tagged `cwd`, `reason: 'watcher' \| 'force' \| 'lru' \| 'manual'`, `entriesCleared`. |
| `MAIN_GIT_DIFF_FS_WATCH_EVENT` | `main:git.diff.fs-watch-event` | `i` | `electron/main/git-diff-cache-invalidator.ts` — one event per 180 ms debounce window per watched cwd. Tagged `cwd`, `pendingMs`. |
| `MAIN_GIT_DIFF_SUBMODULE_FILTER` | `main:git.diff.submodule-filter` | `i` | `electron/main/git-utils.ts::filterMeaninglessSubmoduleEntries` — one event per submodule entry decision (kept iff `<c>=C` OR `changeType==='staged'`). Tagged `repoRoot`, `repoLabel`, `path`, `flags`, `changeType`, `kept`. |

#### Git Repository Snapshot Service (lesson #13 phase 1)

The snapshot service is the canonical answer to "what are the parent +
submodule structural facts for this cwd?" Phase 1 migrates `loadGitDiff`
through it; History / Editor scope / Quick Open continue to call
`detectSubmodulesRecursive`, which is now a thin compatibility wrapper
that derives the legacy `GitSubmoduleInfo[]` shape from the snapshot.

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `MAIN_GIT_SNAPSHOT_CAPTURE` | `main:git.snapshot.capture` | `i` | `electron/main/git-repository-snapshot-service.ts` — first call for a cwd or `force: true`. Tagged `cwd`, `isRepo`, `submoduleCount`, `validSubmoduleCount`, `fingerprint`. |
| `MAIN_GIT_SNAPSHOT_CACHE_HIT` | `main:git.snapshot.cache-hit` | `i` | Same file — cached snapshot returned without re-running git. Tagged `cwd`, `fingerprint`, `ageMs`, `submoduleCount`. |
| `MAIN_GIT_SNAPSHOT_INVALIDATE` | `main:git.snapshot.invalidate` | `i` | Same file — entry dropped because `invalidateGitDiffCache(cwd)` was called (watcher fan-out, force, manual). Tagged `cwd`. |

The snapshot service emits these events from BOTH main and the
git-ipc-worker — the worker's events forward through the existing
`PerfTraceWorkerEvent` envelope and land in the main trace on the
`git-ipc-worker` tid lane (per lesson #10).

#### Renderer lifecycle

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `MAIN_RENDERER_PROCESS_GONE` | `main:renderer-process-gone` | `i` | `electron/main/index.ts` `render-process-gone` |
| `MAIN_RENDERER_UNRESPONSIVE` | `main:renderer-unresponsive` | `i` | Same, `unresponsive` event |

#### AppState persistence

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `MAIN_APP_STATE_SAVE` | `main:app-state-save` | `X` (has `durationMs`) | `app-state-storage.ts` save completion |
| `MAIN_APP_STATE_SAVE_ERROR` | `main:app-state-save-error` | `i` | same, error path |

#### IPC hot paths

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `MAIN_IPC_PROJECT_READ_FILE` | `main:ipc.project.read-file` | `X` | `ipc-handlers.ts` readFile handler |
| `MAIN_IPC_PROJECT_SAVE_FILE` | `main:ipc.project.save-file` | `X` | saveFile handler |
| `MAIN_IPC_GIT_GET_DIFF` | `main:ipc.git.get-diff` | `X` | getDiff handler |
| `MAIN_IPC_GIT_GET_HISTORY` | `main:ipc.git.get-history` | `X` | getHistory handler |
| `MAIN_IPC_TERMINAL_SPAWN` | `main:ipc.terminal.spawn` | `X` | terminal create handler |

#### Child processes — PTY / Git CLI / Ripgrep / Updater

Every subprocess Onward fires off is emitted so a trace shows the
operation in the same timeline as the renderer/user input that
triggered it (see `CLAUDE.md` § "Hard rule — Per-feature perf
instrumentation"). Git emits one slice per `execFile`; PTY / Ripgrep /
Updater emit on spawn + exit/kill.

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `MAIN_PTY_SPAWN` | `main:pty.spawn` | `X` | `electron/main/pty-manager.ts` `PtyManager.create()` |
| `MAIN_PTY_EXIT` | `main:pty.exit` | `i` | Same, `pty.onExit` handler |
| `MAIN_PTY_KILL` | `main:pty.kill` | `i` | `PtyManager.killRecord()` |
| `MAIN_GIT_EXEC` | `main:git.exec` | `X` (has `durationMs`) | `electron/main/git-utils.ts` shared `execFileAsync` wrapper — **only** emitted when the executed binary's basename is `git` (routing via `classifyExecBinary`). Tagged with `subcommand`, `repoKey`, `ok`. |
| `MAIN_PROC_EXEC` | `main:proc.exec` | `X` (has `durationMs`) | Same wrapper, **non-git** exec path (lsof cwd probes, etc.) — tagged with `binary`. Separated from `main:git.exec` so git-pressure percentiles are not diluted by unrelated spawns. |
| `WORKER_RIPGREP_PROCESS_SPAWN` | `worker.ripgrep:process.spawn` | `X` | `electron/main/ripgrep-search-worker-entry.ts` — forwarded via `parentPort.postMessage({event:'trace', …})` and replayed by `ripgrep-search.ts::handleWorkerEvent` |
| `WORKER_RIPGREP_PROCESS_EXIT` | `worker.ripgrep:process.exit` | `X` (has `durationMs`) | Same, on ripgrep process `close`/`error` |
| `MAIN_UPDATER_SPAWN` | `main:updater.spawn` | `i` / `X` | `electron/main/update-service.ts` — one emission per strategy (`wmi` / `batch` / `detached-spawn` on win32, `macos-sh` on darwin) |
| `MAIN_PTY_WRITE` | `main:pty.write` | `X` (has `durationMs`) | `electron/main/pty-manager.ts::write` — one span per PTY write (`path=small` direct or `large` chunked). Task-scoped tid. |

#### Task-scoped data flow (PTY pipeline)

Routed onto per-Task virtual tid (`task-<shortId>` on main, `-rnd` suffix on renderer). See diagram in § 1.

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `MAIN_TERMINAL_DATA_IPC_SEND` | `main:terminal-data.ipc-send` | `X` (has `bufferAgeMs`; dur unused) | `electron/main/ipc-handlers.ts` — every merged send; tagged `path=fast|boost|batched` |
| `RENDERER_TERMINAL_DATA_IPC_RECV` | `renderer:terminal-data.ipc-recv` | `i` | `src/terminal/terminal-session-manager.ts::registerGlobalDataListener` |
| `RENDERER_TERMINAL_DATA_FAST_PATH` | `renderer:terminal-data.fast-path` | `i` | Same file, fast-path branch (small chunk or interactive boost) |
| `RENDERER_TERMINAL_DATA_SCHEDULER_ENQUEUE` | `renderer:terminal-data.scheduler-enqueue` | `i` | Slow-path branch — bytes entered the per-task queue |
| `RENDERER_TERMINAL_DATA_SCHEDULER_FLUSH` | `renderer:terminal-data.scheduler-flush` | `X` (has `durationMs`) | `src/terminal/terminal-output-scheduler.ts::flush` — aggregate slice (no terminalId) + per-Task slice (with bytes consumed) |
| `RENDERER_TERMINAL_DATA_XTERM_WRITE` | `renderer:terminal-data.xterm-write` | `X` (has `durationMs`) | `src/terminal/terminal-session-manager.ts::writeTerminalData` — actual `session.terminal.write()` cost |

### 2.2 Worker threads (pid=1, dedicated tid lane per worker)

Each Node Worker thread now writes through the **same** main-side
`perfTraceLogger` instance via a `parentPort.postMessage` envelope —
there is exactly **one** trace JSON per process, and each worker shows
up as its own `thread_name` track in Perfetto UI. The previous
"per-worker tmpdir trace file + race for `latest.txt`" design was
removed in 2026-04-25.

Wire format (worker → main):

```ts
{ event: 'trace', name: string, data?: object, source?: { tid?, terminalId? } }
```

The shape mirrors the long-standing ripgrep precedent
(`ripgrep-search-worker-entry.ts::postTrace`), generalised so every
worker now uses it transparently — `perfTraceLogger.record(...)` inside
a worker context auto-detects `!isMainThread` and forwards via
`parentPort.postMessage(...)` instead of opening its own write stream.

Receivers in each `*-worker-client.ts`:

```ts
this.worker.on('message', (message) => {
  if (isPerfTraceWorkerEvent(message)) {
    replayPerfTraceWorkerEvent(message, {
      tid: WORKER_TID.GIT_IPC,           // stable per-worker tid
      threadName: 'git-ipc-worker'       // human label for Perfetto UI
    })
    return
  }
  this.handleMessage(message as WorkerResponse)
})
```

Worker tid lanes (defined in `electron/main/perf-trace-logger.ts`,
exported as `WORKER_TID.*`). Main tid stays at `1`; per-task tids start
at `MAIN_TASK_TID_BASE = 10000`; renderer per-task at `20000`. Worker
tids occupy the gap 5000-5999 so all three coexist without overlap.

| Constant | tid | thread_name in trace |
|---|---|---|
| `WORKER_TID.GIT_IPC` | 5001 | `git-ipc-worker` |
| `WORKER_TID.GIT_STATUS` | 5002 | `git-status-worker` |
| `WORKER_TID.PROJECT_FS` | 5003 | `project-fs-worker` |
| `WORKER_TID.SQLITE` | 5004 | `sqlite-worker` |
| `WORKER_TID.APP_STATE` | 5005 | `app-state-worker` |
| `WORKER_TID.RIPGREP_SEARCH` | 5006 | (ripgrep already used its own pre-existing lane) |

Worker-client latency / timeout / error / exit events still come from
the main-thread side after a worker IPC round-trip, and stay on
`tid=1`:

| Constant | Name |
|---|---|
| `WORKER_APP_STATE_{LATENCY,TIMEOUT,ERROR,EXIT}` | `main:app-state-worker-{latency,timeout,error,exit}` |
| `WORKER_GIT_IPC_{LATENCY,TIMEOUT,ERROR,EXIT}` | `main:git-ipc-worker-…` |
| `WORKER_GIT_STATUS_{LATENCY,TIMEOUT,ERROR,EXIT}` | `main:git-status-worker-…` |
| `WORKER_PROJECT_FS_{LATENCY,TIMEOUT,ERROR,EXIT}` | `main:project-fs-worker-…` |
| `WORKER_SQLITE_{LATENCY,TIMEOUT,ERROR,EXIT}` | `main:sqlite-worker-…` |
| `WORKER_RIPGREP_{LATENCY,TIMEOUT,ERROR,EXIT}` | `main:ripgrep-worker-…` |
| `WORKER_RIPGREP_BINARY_MISSING` | `main:ripgrep-binary-missing` |
| `WORKER_RIPGREP_START_ERROR` | `main:ripgrep-worker-start-error` |

All worker-client events are emitted in `electron/main/*-worker-client.ts`.
Exact file:line stays in the git log rather than pasted here (faster
to trust `git grep PERF_TRACE_EVENT.WORKER_` than a stale markdown table).

Important: do NOT static-import `electron` from `perf-trace-logger.ts`
or any of its transitive importers (`git-utils.ts`, `git-runtime-
manager.ts`, etc.). Worker threads inside Electron cannot resolve
`require('electron')`, and a top-of-file import crashes the worker
before any uncaughtException handler can register. Lazy-load via
`require('electron')` gated on `worker_threads.isMainThread`.

### 2.3 Renderer (pid=2, tid=<WebContents.id>)

#### Built-in observers

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `RENDERER_TRACE_START` | `renderer:trace-start` | `i` | First `installRendererPerfTrace()` |
| `RENDERER_EVENT_LOOP_STALL` | `renderer:event-loop-stall` | `X` (`dur`=driftMs) | 250 ms sampler |
| `RENDERER_FRAME_STALL` | `renderer:frame-stall` | `X` (`dur`=frameDeltaMs) | Per-rAF |
| `RENDERER_LONGTASK` | `renderer:longtask` | `X` (`dur`=durationMs) | `PerformanceObserver('longtask')` |
| `RENDERER_PROMPT_INPUT_PAINT` | `renderer:prompt-input-paint` | `X` (`dur`=eventToPaintMs) | Prompt textarea `input` → rAF → rAF |
| `RENDERER_PERF_SNAPSHOT` | `renderer:perf-snapshot` | `i` (t) | `perf-monitor.ts` 1 s tick |
| `RENDERER_APPSTATE_SUMMARY` | `renderer:appstate-summary` | `i` (t) | `AppStateContext` 1 s tick |

#### Web events — wired

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `RENDERER_WINDOW_VISIBILITY_CHANGE` | `renderer:window.visibility-change` | `i` | `src/utils/perf-trace.ts::installWindowEventTrace()` — `document.addEventListener('visibilitychange', …)` |
| `RENDERER_WINDOW_FOCUS` | `renderer:window.focus` | `i` | Same, `window.addEventListener('focus', …)` |
| `RENDERER_WINDOW_BLUR` | `renderer:window.blur` | `i` | Same, `blur` |
| `RENDERER_WINDOW_PAGEHIDE` | `renderer:window.pagehide` | `i` | Same, `pagehide` |

#### IPC bridge latency (renderer→main→renderer round trip)

Wrapped at the preload boundary (`electron/preload/index.ts::traceIpc`),
so every call through `window.electronAPI.<domain>.<method>()` gets a
`ph='X'` span with `durationMs` in its payload.

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `RENDERER_IPC_PROJECT_READ_FILE` | `renderer:ipc.project.read-file` | `X` | `project.readFile()` wrapper |
| `RENDERER_IPC_GIT_GET_DIFF` | `renderer:ipc.git.get-diff` | `X` | `git.getDiff()` wrapper |
| `RENDERER_IPC_TERMINAL_WRITE` | `renderer:ipc.terminal.write` | `X` | `terminal.write()` wrapper |

#### Async rendering hot paths

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `RENDERER_MARKDOWN_RENDER` | `renderer:markdown.render` | `X` | `ProjectEditor.tsx::scheduleMarkdownApply` — end-to-end span from `postMessage` send to sanitized HTML commit |
| `RENDERER_MARKDOWN_SANITIZE` | `renderer:markdown.dompurify-sanitize` | `X` | Same, DOMPurify call |
| `RENDERER_MARKDOWN_MERMAID` | `renderer:markdown.mermaid-render` | `i`/`X` | `src/utils/mermaidRenderer.ts` |
| `WORKER_MARKDOWN_RENDER_COMPLETE` | `worker.markdown:render-complete` | `X` | Worker-measured duration reported to renderer via `worker.onmessage` — parse + katex + highlight |
| `RENDERER_MONACO_VIEWSTATE_RESTORE` | `renderer:monaco.viewstate-restore` | `X` | `ProjectEditor.tsx::editor.restoreViewState` |
| `RENDERER_XTERM_WEBGL_INIT` | `renderer:xterm.webgl-context-init` | `X` | `src/components/Terminal/Terminal.tsx` WebGL addon attach |

#### User-input hot paths (wired)

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `RENDERER_PROMPT_EDITOR_SUBMIT` | `renderer:prompt.editor.submit` | `i` | `PromptEditor.tsx::handleSubmit` |
| `RENDERER_PROMPT_EDITOR_CANCEL` | `renderer:prompt.editor.cancel-edit` | `i` | `PromptEditor.tsx::handleCancel` |
| `RENDERER_PROMPT_SENDER_DISPATCH` | `renderer:prompt.sender.dispatch` | `i` | `PromptSender.tsx::handleSend*` + `handleExecute` — tagged `action=send|execute|sendAndExecute|sendAllAndExecute` |
| `RENDERER_TERMINAL_FOCUS_CHANGE` | `renderer:terminal.focus-change` | `i` | `src/App.tsx::handleTerminalFocus` — Task-scoped tid |
| `RENDERER_TERMINAL_SEND_INPUT` | `renderer:terminal.send-input` | `i` | `src/App.tsx` sendInputSequence — Task-scoped tid |
| `RENDERER_PROJECT_FILE_OPEN` | `renderer:project.file-open` | `i` | `ProjectEditor.tsx::openFile` |
| `RENDERER_PROJECT_SUBPAGE_NAVIGATE` | `renderer:project.subpage-navigate` | `i` | Two sites in `ProjectEditor.tsx` dispatching `subpage:navigate` for diff / history |
| `RENDERER_PROJECT_SEARCH_GLOBAL` | `renderer:project.search.global` | `i` | `useGlobalSearch.ts::executeSearch` — fires once per debounced query commit |

#### GUI entries (new)

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `RENDERER_TAB_CREATE` | `renderer:tab.create` | `i` | `TabBar.tsx` new-tab button |
| `RENDERER_TAB_SWITCH` | `renderer:tab.switch` | `i` | `TabBar.tsx` tab `onSelect` |
| `RENDERER_TERMINAL_SPLIT_ADD` | `renderer:terminal.split-add` | `i` | `src/App.tsx` split-layout auto-fill — Task-scoped tid |
| `RENDERER_GITDIFF_OPEN` | `renderer:gitdiff.open` | `i` | `src/App.tsx` dropdown + shortcut dispatches |
| `RENDERER_GITHISTORY_OPEN` | `renderer:githistory.open` | `i` | `src/App.tsx` dropdown `terminalGitHistory` branch |
| `RENDERER_SETTINGS_OPEN` | `renderer:settings.open` | `i` | `src/App.tsx` panel switcher |
| `RENDERER_CHANGELOG_OPEN` | `renderer:changelog.open` | `i` | `src/App.tsx::handleToggleChangeLog` |
| `RENDERER_SUBPAGE_FRESHNESS_CHECK` | `renderer:subpage.freshness-check` | `i` | `src/components/TerminalGrid/TerminalGrid.tsx::handleViewGitDiff` / `handleViewGitHistory` — fires once per subpage activation. Tagged `subpage: 'diff' \| 'history' \| 'editor'`, `cwd`, `reason: 'open' \| 'switch'`. Pairs with `MAIN_GIT_DIFF_CACHE_INVALIDATE { reason: 'force' }` on the main side. |

#### Background ops

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `MAIN_FILE_INDEX_BUILD` | `main:file-index.build` | `X` (has `durationMs`) | `electron/main/ipc-handlers.ts` `PROJECT_BUILD_FILE_INDEX` handler |
| `MAIN_FILE_INDEX_UPDATE` | `main:file-index.update` | `i` | Same, `PROJECT_INVALIDATE_FILE_INDEX` handler |
| `MAIN_PROJECT_TREE_WATCH_EVENT` | `main:project-tree-watch.event` | `i` | `project-tree-watch-manager.ts::scheduleFlush` — one per debounce-window start (not per raw FSEvent) |
| `MAIN_PROJECT_TREE_WATCH_BATCH` | `main:project-tree-watch.batch` | `i` | Same, `flush()` — coalesced batch shipped to renderer |

---

## 3. Planned coverage gaps

Remaining opportunities, in priority order. Not blockers — § 2 now
covers PTY data flow end-to-end, all user-input hot paths, GUI entries
and the known background ops.

1. **Main-side IPC payload enrichment** — `MAIN_IPC_*` slices exist and
   fire, but carry minimal payload. Adding file size / repo key /
   result row count would let SQL queries join renderer-side
   `RENDERER_IPC_*` spans against main-side execution time for
   bandwidth analysis.
2. **Raw FSEvent sampling** — `MAIN_PROJECT_TREE_WATCH_EVENT` emits at
   debounce-window start (good signal-to-noise). If a deeper analysis
   of FSEvent storms is ever needed, add a separate `.raw-event` span
   inside `handleRawEvent` with a 1/N sampler to keep volume bounded.
3. **Monaco dispose / mount** — restoreViewState is covered; the heavy
   Monaco model attach/detach around subpage navigation is not. Adding
   a span around `editor.dispose()` + `createEditor()` would close the
   gap on "why did this tab switch stutter?".

When moving an event from this list to § 2, add the file:line to the
corresponding `PERF_TRACE_EVENT` block comment in `perf-trace-names.ts`
so the authoritative source stays unambiguous.

---

## 4. On-disk format — Chrome Trace Event Format

Each record is a standard Chrome Trace Event Format entry inside the
`traceEvents` array:

```ts
{
  ph: 'X' | 'i' | 'M'          // slice / instant / metadata
  name: string                  // from PERF_TRACE_EVENT
  ts: number                    // microseconds since epoch
  pid: 1 | 2                    // 1 = main, 2 = any renderer
  tid: number                   // main: 1; renderer: WebContents.id
  dur?: number                  // ph='X' only, microseconds
  s?: 'g' | 'p' | 't'           // ph='i' scope
  args?: Record<string, unknown>
}
```

Upstream Chrome Trace Event Format spec:
https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview

Perfetto's ingestion into SQL tables is documented at
https://perfetto.dev/docs/analysis/trace-processor — the mapping is:
- `ph='X'` → `slice` table (queryable by `name`, `ts`, `dur`,
  `track_id`)
- `ph='i'` → `slice` with `dur=0` (still in the same table)
- `ph='M'` (process_name / thread_name / process_sort_index) →
  metadata for `process` / `thread` tables

### Tolerance of unclosed files

`electron/main/perf-trace-logger.ts` opens the file with
`{"traceEvents":[\n`, writes each event as a trailing-comma object,
and closes with `\n  {}\n]}` on any of `app.on('will-quit')` /
`app.on('before-quit')` / `SIGTERM` / `SIGINT`. If all four miss
(sudden crash), Perfetto UI still loads the truncated array; reading
the file in Node requires `text.replace(/,\s*$/,"")+"]}"` before
`JSON.parse`. The T02 self-check runner
(`test/autotest/run-trace-infra-self-check-autotest.sh`) performs both
validations.

---

## 5. Toolchain usage

### 5.1 First-time setup

```bash
pip install perfetto                     # Only if you want SQL in Python.
# trace_processor_shell is downloaded on demand by `open_trace.sh`
# into ~/.local/share/perfetto/prebuilts/. No manual step needed.
```

### 5.2 Capture a trace

**Dev mode** (most common):

```bash
ONWARD_PERF_TRACE=1 pnpm dev
# reproduce the operation you want to observe, then Cmd+Q
```

**From an autotest** — set `ONWARD_PERF_TRACE=1` alongside
`ONWARD_AUTOTEST=1` on the runner. Example template:
`test/autotest/run-trace-infra-self-check-autotest.sh`.

Artefact: `<repoRoot>/traces/perf/perf-trace-<ISO>-<pid>.json`.
`latest.txt` in the same directory points at the last session.

### 5.3 Open in Perfetto UI

```bash
bash infra/scripts/open_trace.sh                      # newest .json
bash infra/scripts/open_trace.sh <file.json>          # pick a specific one
```

The script starts `trace_processor_shell --httpd --http-port=9001`
locally and opens the browser to a pinned
`https://ui.perfetto.dev/v<tp_ver>-<sha>/#!/?rpc_port=9001` — the
trace never leaves localhost. To stop the HTTPD, `kill <pid>` using
the PID printed at the end of the script.

### 5.4 SQL queries

Trace processor normalises both `.json` and `.pftrace` into the same
SQL schema. The queries below are verified against a live
`traces/perf/*.json` produced by `ONWARD_PERF_TRACE=1`.

Python:
```python
from perfetto.trace_processor import TraceProcessor
tp = TraceProcessor(trace='traces/perf/<newest>.json')

# Every event-loop stall, worst-first.
for row in tp.query("""
    SELECT ts, dur, name
    FROM slice
    WHERE name = 'main:event-loop-stall'
    ORDER BY dur DESC
    LIMIT 20
"""):
    print(f"{row.ts/1e9:.3f}s dur={row.dur/1e3:.1f}us")

# Count by event name (top 10).
for row in tp.query("""
    SELECT name, COUNT(*) cnt
    FROM slice
    GROUP BY name
    ORDER BY cnt DESC
    LIMIT 10
"""):
    print(row.name, row.cnt)

# Worker-side latency percentiles.
for row in tp.query("""
    SELECT
      name,
      CAST(PERCENTILE(dur, 50) AS INT) AS p50_us,
      CAST(PERCENTILE(dur, 95) AS INT) AS p95_us,
      MAX(dur) AS max_us
    FROM slice
    WHERE name LIKE 'main:%-worker-latency'
    GROUP BY name
"""):
    print(row)
```

`trace_processor_shell -q <file.sql> <trace.json>` — CSV output, good
for CI. Example one-liner:
```bash
printf 'SELECT name, COUNT(*) FROM slice GROUP BY name;\n' > /tmp/q.sql
~/.local/share/perfetto/prebuilts/trace_processor_shell -q /tmp/q.sql \
  traces/perf/<newest>.json
```

### 5.5 T02 self-check (regression)

`test/autotest/run-trace-infra-self-check-autotest.sh` runs as part of the
v0.3 full regression. It launches Onward with `ONWARD_PERF_TRACE=1`
for ~6 s, asserts the file exists and parses, asserts at least one
`main:*` slice, and (when `trace_processor_shell` is locally
installed) parse-verifies via tp_shell.

---

## 6. Extension rules

Adding a new trace event — five steps, no step skipped:

1. Register the name in `src/utils/perf-trace-names.ts` as a new
   `PERF_TRACE_EVENT.FOO_BAR` constant. No string literals in
   business code (enforced by grep in code review).
2. Instrument at the call site:
   - main-side: `perfTraceLogger.record(PERF_TRACE_EVENT.FOO_BAR,
     { …args })`
   - renderer-side: `perfTrace(PERF_TRACE_EVENT.FOO_BAR, { …args })`
3. If the event carries a duration, put it in the payload as
   `driftMs` / `durationMs` / `eventToPaintMs`. `resolvePhase()` in
   `perf-trace-logger.ts` will convert to `ph='X', dur=<µs>`
   automatically. Otherwise it stays a `ph='i'` instant.
4. Update § 2 of this file — move rows from § 3 "Planned" to the
   appropriate § 2 subsection, or append a new row if it's brand new.
5. If the event represents a user-visible performance signal, add a
   corresponding runner under `test/autotest/run-<suite>-autotest.sh`
   and append it to the `SCRIPTS` list in
   `test/autotest/run-full-regression.py` so the signal is protected
   by regression.

Forbidden:

- Renaming an existing event — breaks historical SQL / UI queries.
  Add a new name instead.
- `perfTraceLogger.record("foo", …)` with a literal string in code —
  bypasses the registry and breaks `CLAUDE.md` Hard rule § 3.
- Writing traces outside `<repoRoot>/traces/` on dev / autotest
  builds (`CLAUDE.md` Hard rule § 1).
- Reporting perf results without an `open_trace.sh` follow-up
  command (`CLAUDE.md` Hard rule § 2).

---

## Design research (per skill §5.0 Rule A)

Subagent research of https://perfetto.dev/docs/ conducted 2026-04-24
before this revision. Summary and citations:

- **Format choice for Node / Electron — Chrome Trace Event Format is
  the official recommended path.** Perfetto's Track Event SDK is
  C++17-only (https://perfetto.dev/docs/instrumentation/track-events).
  For non-C++ hosts, the documented route is
  https://perfetto.dev/docs/getting-started/other-formats which
  explicitly covers Chrome trace JSON ingestion. No first-party
  JavaScript SDK exists. Onward therefore **stays on Chrome Trace
  JSON**, zero deps, no migration to protobufjs.
- **SQL table mapping** — confirmed that `ph='X'` events populate
  `slice.name` / `slice.ts` / `slice.dur`, `ph='C'` populates
  `counter`, `ph='M'` populates `process` / `thread`. Queries such as
  `SELECT name, dur FROM slice WHERE name LIKE 'main:%'` work without
  any conversion step. Source:
  https://perfetto.dev/docs/analysis/sql-tables.
- **Local UI workflow unchanged** — `trace_processor --httpd
  --http-port=<N>` + `https://ui.perfetto.dev/#!/?rpc_port=<N>` is
  still the pattern. We pin to `/v<tp_ver>-<sha>/` to avoid the
  "different build" banner. Source:
  https://perfetto.dev/docs/visualization/large-traces.
- **Example percentile SQL from docs** — `SELECT name,
  PERCENTILE_CONT(dur, 0.95) FROM slice GROUP BY name` is canonical
  (https://perfetto.dev/docs/analysis/sql-tables). §5.4 above adapts
  it for Onward's worker-latency family.

Decision: Onward v0.3 continues to emit Chrome Trace Event Format.
Re-open this section and re-run the research when Perfetto publishes
a JavaScript SDK or a protobuf alternative that is declared
"recommended" for non-C++ hosts.

---

## Related files

| Path | Purpose |
|---|---|
| `src/utils/perf-trace-names.ts` | Event-name registry (single source of truth) |
| `electron/main/perf-trace-logger.ts` | Main-side emitter + Chrome trace JSON writer |
| `src/utils/perf-trace.ts` | Renderer emitter (IPC to main) |
| `src/utils/perf-monitor.ts` | Renderer 1 s snapshot aggregator |
| `infra/scripts/open_trace.sh` | One-liner trace opener (local tp_shell + pinned UI) |
| `test/autotest/run-trace-infra-self-check-autotest.sh` | Trace baseline self-check |
| `test/autotest/run-full-regression.py` | Regression orchestrator + canonical runner list |
| `docs/debug-env-variables.md` | `ONWARD_PERF_TRACE`, `ONWARD_REPO_ROOT` flags |
| `docs/Off-Renderer Threaded Design - Electron Refactor.md` | Architectural constraint for any perf change |
| `scripts/migrate-perf-trace-literals.mjs` | One-shot helper promoting literals to registry constants (kept for audit) |
