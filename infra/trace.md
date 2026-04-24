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
| `MAIN_APP_BEFORE_QUIT` | `main:app.before-quit` | `i` | Electron `before-quit` handler (planned) |
| `MAIN_APP_WILL_QUIT` | `main:app.will-quit` | `i` | Electron `will-quit` handler (planned) |

#### Monitors (1 s tick)

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `MAIN_EVENT_LOOP_STALL` | `main:event-loop-stall` | `X` (`dur`=driftMs) | `startEventLoopMonitor()` — 250 ms sample, ≥ 100 ms threshold |
| `MAIN_EVENT_LOOP_METRICS_RESET` | `main:event-loop-metrics-reset` | `i` | `resetEventLoopMetrics()` |
| `MAIN_GIT_RUNTIME_SUMMARY` | `main:git-runtime-summary` | `i` (t) | `startGitRuntimeMonitor()` — 1 s |
| `MAIN_GIT_RUNTIME_SUMMARY_ERROR` | `main:git-runtime-summary-error` | `i` | same, on exception |
| `MAIN_GITWATCH_SUMMARY` | `main:gitwatch-summary` | `i` (t) | `git-watch-manager.ts` 1 s roll-up |
| `MAIN_TERMINAL_DATA_IPC_SUMMARY` | `main:terminal-data-ipc-summary` | `i` (t) | `ipc-handlers.ts` terminal IPC counter sampler |

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

#### IPC hot paths (planned)

| Constant | Name | Phase | Intended call site |
|---|---|---|---|
| `MAIN_IPC_PROJECT_READ_FILE` | `main:ipc.project.read-file` | `X` | `ipc-handlers.ts` readFile handler |
| `MAIN_IPC_PROJECT_SAVE_FILE` | `main:ipc.project.save-file` | `X` | saveFile handler |
| `MAIN_IPC_GIT_GET_DIFF` | `main:ipc.git.get-diff` | `X` | getDiff handler |
| `MAIN_IPC_GIT_GET_HISTORY` | `main:ipc.git.get-history` | `X` | getHistory handler |
| `MAIN_IPC_TERMINAL_SPAWN` | `main:ipc.terminal.spawn` | `X` | terminal create handler |

### 2.2 Worker threads (pid=1, tid=1 — emitted on main track)

For each worker (`app-state`, `git-ipc`, `git-status`, `project-fs`,
`sqlite`, `ripgrep`) we emit the same four-event family from its
client. `*-latency` is a completed span with `dur`; the others are
instant.

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

All are emitted in `electron/main/*-worker-client.ts`. Exact file:line
is kept in the git log rather than pasted here (faster to trust `git
grep PERF_TRACE_EVENT.WORKER_` than a stale markdown table).

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

#### Planned — Web events + user input

These constants are registered but not yet emitted. They cover user's
directive that instrumentation must span "main thread / renderer /
worker / Web events / user input". Adding the emitter call is a
simple `perfTrace(PERF_TRACE_EVENT.X, {...})` at the listed site.

| Constant | Name | Intended site |
|---|---|---|
| `RENDERER_WINDOW_VISIBILITY_CHANGE` | `renderer:window.visibility-change` | `document.addEventListener('visibilitychange', …)` in `App.tsx` |
| `RENDERER_WINDOW_FOCUS` | `renderer:window.focus` | `window.addEventListener('focus', …)` |
| `RENDERER_WINDOW_BLUR` | `renderer:window.blur` | `window.addEventListener('blur', …)` |
| `RENDERER_WINDOW_PAGEHIDE` | `renderer:window.pagehide` | `window.addEventListener('pagehide', …)` |
| `RENDERER_PROMPT_EDITOR_SUBMIT` | `renderer:prompt.editor.submit` | `PromptEditor.tsx` submit handler |
| `RENDERER_PROMPT_EDITOR_CANCEL` | `renderer:prompt.editor.cancel-edit` | PromptEditor cancel |
| `RENDERER_PROMPT_SENDER_DISPATCH` | `renderer:prompt.sender.dispatch` | `PromptSender.tsx` send/execute |
| `RENDERER_TERMINAL_FOCUS_CHANGE` | `renderer:terminal.focus-change` | `TerminalGrid.tsx` focus activation |
| `RENDERER_TERMINAL_SEND_INPUT` | `renderer:terminal.send-input` | `App.tsx:723` sendInputSequence |
| `RENDERER_PROJECT_FILE_OPEN` | `renderer:project.file-open` | `ProjectEditor.tsx` openFile |
| `RENDERER_PROJECT_SUBPAGE_NAVIGATE` | `renderer:project.subpage-navigate` | `subpage:navigate` dispatch |
| `RENDERER_PROJECT_SEARCH_GLOBAL` | `renderer:project.search.global` | `GlobalSearch/SearchPanel.tsx` submit |
| `RENDERER_IPC_PROJECT_READ_FILE` | `renderer:ipc.project.read-file` | `electronAPI.project.readFile()` wrapper |
| `RENDERER_IPC_GIT_GET_DIFF` | `renderer:ipc.git.get-diff` | `electronAPI.git.getDiff()` wrapper |
| `RENDERER_IPC_TERMINAL_WRITE` | `renderer:ipc.terminal.write` | `electronAPI.terminal.write()` wrapper |
| `RENDERER_MARKDOWN_RENDER` | `renderer:markdown.render` | ProjectEditor markdown render cycle |
| `RENDERER_MARKDOWN_SANITIZE` | `renderer:markdown.dompurify-sanitize` | DOMPurify call |
| `RENDERER_MARKDOWN_MERMAID` | `renderer:markdown.mermaid-render` | mermaid rendering |
| `RENDERER_MONACO_VIEWSTATE_RESTORE` | `renderer:monaco.viewstate-restore` | Monaco restoreViewState |
| `RENDERER_XTERM_WEBGL_INIT` | `renderer:xterm.webgl-context-init` | terminal-session-manager.ts WebGL attach |

---

## 3. Planned coverage gaps

Short list of instrumentation work that is **not yet done** but has a
reserved constant in the registry. Each is a single `perfTrace(…)` call
away from active. Prioritise in this order for ROI:

1. **IPC bridge latency** (`RENDERER_IPC_*`) — the single most useful
   addition. Wrap the three hot `window.electronAPI.*` calls in a
   `performance.now()`-timed closure and record a complete span.
2. **Markdown render cycle** (`RENDERER_MARKDOWN_*`) — the longest
   renderer stalls in Onward's current profile; having per-phase
   spans (`render` → `sanitize` → `mermaid`) makes the real slow step
   visible.
3. **Window visibility + focus / blur** — needed to explain
   "autosave burst on pagehide" and to correlate stalls with hidden /
   foregrounded state.
4. **User-input hot paths** — `prompt.editor.submit`, `prompt.sender.
   dispatch`, `terminal.focus-change`, `project.subpage-navigate`.
   These anchor user-observable events on the timeline and let the
   next `trace_processor_shell` query be: "for every submit, what
   was the timeline until the next event-loop-stall?"

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
(`test/run-trace-infra-self-check-autotest.sh`) performs both
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
`test/run-trace-infra-self-check-autotest.sh`.

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

`test/run-trace-infra-self-check-autotest.sh` runs as part of the
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
   corresponding TXX row in `test/full-regression-checklist.md` so
   the signal is protected by regression.

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
| `test/run-trace-infra-self-check-autotest.sh` | T02 baseline self-check |
| `test/full-regression-checklist.md` | Regression index, § 11 "Trace infrastructure" |
| `docs/debug-env-variables.md` | `ONWARD_PERF_TRACE`, `ONWARD_REPO_ROOT` flags |
| `docs/Off-Renderer Threaded Design - Electron Refactor.md` | Architectural constraint for any perf change |
| `docs/repo-wide-performance-architecture-migration-plan.md` | Ongoing perf-architecture migration plan |
| `scripts/migrate-perf-trace-literals.mjs` | One-shot helper promoting literals to registry constants (kept for audit) |
