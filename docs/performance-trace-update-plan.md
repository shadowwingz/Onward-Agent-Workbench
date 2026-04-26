<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Performance Trace Update Plan

## Goal

Add a local, developer-controlled performance trace for Onward that can be opened in Perfetto or Chrome's trace viewer. The trace must connect user actions, renderer updates, main-process work, IPC, PTY-backed Task execution, and terminal rendering in one timeline.

The request used the name "Profit"; this plan treats that as a Perfetto-compatible visual trace target.

For a visual Mermaid map of the implemented trace points and their runtime behavior, see [performance-trace-mermaid.md](./performance-trace-mermaid.md).

## Non-Goals

- Do not send raw trace events through product telemetry.
- Do not collect terminal commands, terminal output, file paths, prompt text, URLs, or rendered document content unless a separate sensitive-content debug switch is explicitly enabled.
- Do not infer shell command boundaries by parsing platform-specific shell prompts as the primary mechanism. That is too fragile across macOS, Linux, Windows, PowerShell, cmd.exe, zsh, bash, and PTY control sequences.
- Do not add a production dependency for trace writing.

## Existing Architecture Summary

The current terminal data path is:

```text
Renderer xterm input
  -> preload terminal.write / terminal.sendInputSequence
  -> main IPC terminal:write / terminal:send-input-sequence
  -> PtyManager.write / sendInputSequence
  -> node-pty process
  -> ptyProcess.onData
  -> TerminalDataBuffer in main
  -> webContents.send('terminal:data')
  -> renderer TerminalSessionManager.onData
  -> pendingData / requestAnimationFrame throttle
  -> xterm.write
```

Important existing files:

- `electron/main/pty-manager.ts`: owns `node-pty` create, write, resize, dispose, and shutdown.
- `electron/main/ipc-handlers.ts`: owns terminal IPC handlers, `TerminalDataBuffer`, Prompt Bridge, coding-agent launch, debug handlers, telemetry handlers, and git runtime debug access.
- `electron/main/api-server.ts`: exposes `/api/tasks`, `/api/terminal/:id/buffer`, and `/api/terminal/:id/write`; the write endpoint enters Prompt Bridge.
- `electron/preload/index.ts`: exposes terminal, debug, coding-agent, telemetry, and other IPC APIs to the renderer.
- `src/App.tsx`: centralizes Prompt send, execute, send-and-execute, Prompt Bridge handling, and terminal CWD changes.
- `src/terminal/terminal-session-manager.ts`: owns renderer-side xterm sessions, direct terminal input, visible/hidden buffering, render flushing, WebGL lifecycle, and input latency.
- `src/components/PromptNotebook/PromptSender.tsx`: owns selected Task IDs and user-facing Prompt action dispatch.
- `src/utils/perf-monitor.ts`: already records FPS, frame drops, xterm writes, IPC data bytes, hidden terminal writes, WebGL count, React render count, and input latency at 1-second granularity.

The current diagnostics are useful but fragmented: `[PerfMon]`, `[PerfDiag]`, ad hoc debug logs, debug APIs, and telemetry local JSONL are separate. They do not provide a single action-to-render timeline.

## Trace Output Design

Use Chrome Trace Event JSON, which Perfetto can import directly:

```json
{
  "traceEvents": [
    { "ph": "M", "name": "process_name", "pid": 100, "args": { "name": "Onward Main" } },
    { "ph": "X", "cat": "ipc", "name": "ipc.terminal.write", "ts": 1234567890000, "dur": 420, "pid": 100, "tid": 1, "args": { "terminalId": "..." } }
  ],
  "metadata": {
    "schema": "onward.perf_trace.v1"
  }
}
```

Timing:

- Use epoch-aligned monotonic timestamps: `(performance.timeOrigin + performance.now()) * 1000`.
- Store `ts` and `dur` in microseconds, matching Chrome trace conventions.
- Main and renderer events should share a common time basis.

Process/thread lanes:

- Main process lane: IPC handlers, API server requests, Prompt Bridge, PTY manager, terminal data buffering, git runtime tasks.
- Renderer lane: Prompt input/actions, task selection, terminal render flushing, React/perf snapshots, Project Editor and Markdown render phases.
- Per-Task lanes: logical Task activity keyed by terminal ID. A Task lane represents the PTY-backed workload for that terminal, even though the shell process is not instrumented internally.
- Optional worker lanes: Markdown worker and future worker-backed rendering if events are forwarded to the renderer/main trace collector.

Event kinds:

- Complete events (`ph: "X"`) for measured operations with durations.
- Instant events (`ph: "i"`) for state changes and point-in-time user actions.
- Counter events (`ph: "C"`) for FPS, pending bytes, queue depth, IPC bytes, hidden writes, and active Task counts.
- Flow events (`ph: "s"`, `"t"`, `"f"`) to connect user action -> Prompt Bridge/API -> IPC -> PTY write -> PTY output -> renderer flush.

## Debug Switches

Add debug-only switches and document them in `docs/debug-env-variables.md`:

| Variable | Purpose |
|----------|---------|
| `ONWARD_PERF_TRACE=1` | Enable local performance trace recording. |
| `ONWARD_PERF_TRACE_CAPTURE_CONTENT=1` | Include sensitive raw content in local trace args. Requires `ONWARD_PERF_TRACE=1`. |

Rules:

- Both variables are read once at startup.
- Both log a clear message when active.
- Trace output is local only, under the app user-data directory, for example `performance-traces/onward-perf-trace-<timestamp>-<pid>.json`.
- Trace events must not be routed through `TelemetryService.track`.

## Privacy Policy

Default `ONWARD_PERF_TRACE=1` records metadata only:

- Allowed: durations, byte lengths, line counts, booleans, enum states, queue depths, selected Task counts, terminal IDs, per-run flow IDs, per-run salted content hashes, result status.
- Not allowed by default: prompt text, terminal input, terminal output, file paths, filenames, URLs, raw errors containing paths, environment variable values, stable user identifiers.

When `ONWARD_PERF_TRACE_CAPTURE_CONTENT=1` is also enabled:

- Include raw Prompt text, terminal input chunks, selected terminal output samples, and rendered-content samples only in the local trace file.
- Keep samples bounded: use short previews and explicit byte/line caps.
- Mark every content-bearing event with `contentCaptured: true`.
- Never upload content-bearing trace data.

Use a per-trace random salt for content hashes so content can be correlated within one trace without becoming a stable cross-run identifier.

## Event Registry

Append-only event names. Do not rename existing names after implementation.

| Event | Kind | Location | Args |
|-------|------|----------|------|
| `trace.session.start` | instant | main startup | schema, platform, app version, trace file path |
| `trace.session.flush` | complete | main trace writer | event count, byte count |
| `ui.prompt.edit` | instant | `PromptNotebook` editor changes | field, content length, line count, salted hash |
| `ui.prompt.task_select` | instant | `PromptSender` selection | terminal ID, selected count |
| `ui.prompt.action` | complete + flow start | `PromptSender` / `App` | action, terminal IDs, content length, multiline, result |
| `api.request` | complete | `api-server.ts` | method, route name, status, duration |
| `prompt.bridge` | complete + flow step | `sendPromptViaBridge` and renderer bridge handler | request ID, action, terminal ID, result |
| `ipc.invoke` | complete | selected IPC handlers | channel, terminal ID, result, duration |
| `pty.spawn` | complete | `PtyManager.create` | terminal ID, cols, rows, command kind, cwd present |
| `pty.write` | complete + flow step | `PtyManager.write` / `sendInputSequence` | terminal ID, bytes, direct/queued/chunked, includes enter |
| `pty.output` | instant/counter + flow step | `ptyProcess.onData` | terminal ID, bytes, bracketed paste mode, output burst ID |
| `terminal.buffer.flush` | complete | `TerminalDataBuffer.flush` | terminal ID, chunks, bytes, fast path/batched |
| `terminal.ipc.send` | instant | `webContents.send('terminal:data')` | terminal ID, bytes |
| `terminal.render.receive` | instant | renderer `onData` | terminal ID, bytes, visible |
| `terminal.render.flush` | complete + flow end | renderer `writeTerminalData` and visible flush | terminal ID, bytes, pending bytes, visible, xterm duration |
| `terminal.task.state` | instant | main Task activity tracker | terminal ID, idle/input_pending/running/output_active/exited |
| `coding_agent.launch` | complete | `coding-agent:launch` handler and TerminalGrid caller | terminal ID, command kind, args count, result |
| `perf.renderer.snapshot` | counter | `perf-monitor.ts` | FPS, drops, writes, IPC, hidden, input latency |
| `git.runtime.task` | complete | `git-runtime-manager.ts` | kind, priority, queue depth, inflight count, duration, success, repo/label length and hash only |
| `markdown.render.worker` | complete | Project Editor worker result handler | input length, output length, duration, profile flag |
| `project_editor.render.apply` | complete | `ProjectEditor.tsx` idle apply callback | output length, image count, DOMPurify/setState scheduling duration |
| `ui.prompt.action.done` | flow end | `App.tsx` `handleSendToTerminals` / `handleExecute…` | action, success/failed/sentOnly counts |
| `ui.terminal.write` | flow step | `App.tsx` `writeToTerminals` | terminal ID, action, includesEnter, payload length/hash |
| `ui.terminal.send_input_sequence` | flow step | `App.tsx` `sendContentToTerminals` | terminal ID, action, kind (raw/paste), payload length/hash |
| `ui.terminal.paste` | flow step | `App.tsx` bracketed-paste path | terminal ID, action, payload length/hash |
| `terminal.input` | instant | renderer `terminal-session-manager` direct input | terminal ID, payload length/hash, Enter flag |
| `terminal.render.hidden_buffer` | counter | renderer hidden-tab buffering | terminal ID, bytes, queued bytes |
| `prompt.bridge.send` | flow step | `sendPromptViaBridge` request emit | request ID, terminal ID, action, payload length/hash |
| `prompt.bridge.response` | flow step | `prompt:bridge-response` IPC | request ID, terminal ID, action, result |
| `prompt.bridge.timeout` | flow end | `sendPromptViaBridge` timeout path | request ID, terminal ID, action |
| `ipc.terminal.write` | complete + flow step | `ipcMain.handle('terminal:write')` | terminal ID, payload length, fast path, result |
| `ipc.terminal.send_input_sequence` | complete + flow step | `ipcMain.handle('terminal:send-input-sequence')` | terminal ID, kind, payload length, result |
| `api.terminal.write` | flow start | `POST /api/terminal/:id/write` route start | route, terminal ID, action |
| `api.terminal.write.result` | flow step | `POST /api/terminal/:id/write` after Prompt Bridge | route, terminal ID, status, deliveredCount |
| `pty.send_input_sequence` | complete + flow step | `PtyManager.sendInputSequence` | terminal ID, kind, bytes, includes enter, result |
| `pty.resize` | complete | `PtyManager.resize` | terminal ID, cols, rows, result |
| `pty.dispose` | complete | `PtyManager.dispose` | terminal ID, result |
| `pty.shutdown_all` | complete | `PtyManager.shutdownAll` | total, closed, timedOut |
| `coding_agent.prepare` | complete | `ipcMain.handle('coding-agent:prepare')` | command kind, result |
| `coding_agent.pty.spawned` | instant | post-launch new PTY spawn for agent | terminal ID, command kind |
| `coding_agent.launch.error` | instant | `coding-agent:launch` error path | terminal ID, command kind, error type |

## Diff Review Notes

The follow-up Coding Agent added useful coverage beyond the initial Prompt/PTY path:

- `git.runtime.task` fills an important blind spot for Git polling, cwd probing, queue depth, and scheduler contention. The implementation must not emit raw `repoKey` or raw `label` because those can contain paths or user file names; only length/hash metadata should be recorded by default.
- `markdown.render.worker` and `project_editor.render.apply` add Project Editor / Markdown preview visibility. The worker event measures worker-side render duration; the apply event measures the renderer-side DOMPurify and React state scheduling work, not final browser paint.
- `pty.dispose` and `pty.shutdown_all` make PTY lifecycle cleanup visible, which is important for agent restart and app shutdown validation.
- `scripts/trace-coverage-audit.mjs` adds registry/code/trace three-way proof. It complements the golden-path contract test by finding dead registrations, unregistered emits, and scenario gaps.
- `scripts/trace-narrate.mjs` adds human-readable chronological proof. It is useful when the question is not just "did an event exist?" but "can a reviewer tell what Onward was doing?"

## Task Activity Model

The app does not currently have a first-class "Task is executing a command" state. It has PTY session status, write events, output events, renderer pending data, and Prompt submit state.

Add a lightweight Task activity tracker in the main process:

```text
idle
  -> input_pending     when Onward writes user input or Prompt content
  -> running           when the write contains an Enter/execute intent, coding-agent launch occurs, or Prompt Bridge send-and-execute starts
  -> output_active     when PTY output arrives
  -> idle              after an idle timeout with no output, or on explicit stop/exit/dispose
  -> exited            on PTY exit
```

Important limitation: this does not prove that the shell command has completed. It provides an observable PTY activity state. Exact command completion would require shell integration or agent protocol support and should be treated as a later phase.

Command visibility:

- For Onward-initiated work, record the action and command intent because App/Prompt Bridge/coding-agent launch already know it.
- For manual terminal typing, default trace records input byte counts and Enter events. Raw command text is only available with `ONWARD_PERF_TRACE_CAPTURE_CONTENT=1`.
- For shell edits, backspaces, cursor movement, and bracketed paste, record raw input chunks or a best-effort line accumulator as debug evidence, not as a guaranteed parsed shell command.

## Implementation Phases

### Phase 1: Trace Core

- Add `electron/main/performance-trace.ts` as the main trace writer and registry gate.
- Add a small renderer trace client, likely `src/utils/performance-trace.ts`, that forwards renderer events to main over a debug-only IPC channel.
- Add preload/type declarations for trace APIs.
- Add debug handlers:
  - `performance-trace:record`
  - `performance-trace:get-status`
  - `performance-trace:flush`
- Add metadata events and startup/shutdown flush.
- Add `docs/debug-env-variables.md` rows.

### Phase 2: Main Process and PTY Points

- Instrument `api-server.ts` request durations for `/api/tasks`, `/api/terminal/:id/buffer`, and `/api/terminal/:id/write`.
- Instrument `sendPromptViaBridge`, `prompt:bridge-response`, timeouts, and failures.
- Instrument `terminal:create`, `terminal:write`, `terminal:send-input-sequence`, `terminal:resize`, `terminal:dispose`.
- Instrument `PtyManager.create`, `write`, `sendInputSequence`, queued large writes, chunked Windows writes, resize, dispose, exit, and shutdown.
- Instrument `TerminalDataBuffer.push` decisions and `flush`.
- Add the Task activity tracker.

### Phase 3: Renderer User Action and Render Points

- Instrument Prompt editor content changes as metadata-only by default.
- Instrument Task selection and PromptSender action begin/end.
- Propagate a `flowId` through Prompt actions and optional terminal IPC trace context.
- Instrument direct xterm input, paste, and terminal focus.
- Instrument renderer `terminal:data` receive, visible/hidden buffering, visible flush scheduling, and `xterm.write` duration.
- Feed existing `PerfMonitor` snapshots into the trace as counters when tracing is active.

### Phase 4: Coding Agent and Cross-Task Flow

- Instrument `coding-agent:prepare` and `coding-agent:launch`.
- Record the old PTY dispose and new agent PTY spawn as one flow.
- Add Task activity state transitions for coding-agent launch and exit.
- Add command-kind fields without leaking environment variable values.

### Phase 5: Extended UI Render Points

- Instrument Markdown worker render duration and Project Editor apply/render stages.
- Add Git runtime task spans from `git-runtime-manager.ts`.
- Add AppState update counters as trace counters, without dumping full state.

## Test Plan

New tests should follow existing project rules: fixtures under `test/fixtures/<suite>/`, isolated working directory, no real user data, and platform-aware behavior.

Add:

- `src/autotest/test-performance-trace.ts`
- `test/run-performance-trace-autotest.sh`
- `test/run-performance-trace-autotest.ps1`
- `test/validate-performance-trace-contract.mjs`

No fixture is required for the first contract suite because it drives the packaged app's real Prompt UI, API server, Prompt Bridge, PTY, and renderer using the existing autotest working directory.

Suggested cases:

| Case | Purpose | Minimum assertion |
|------|---------|-------------------|
| `PT-01-gate-off` | Trace disabled path | no trace APIs emit events, no trace file is created |
| `PT-02-schema` | Perfetto/Chrome trace compatibility | contract validator parses JSON, has `traceEvents`, metadata, valid visible fields |
| `PT-03-prompt-flow` | User action to render | `ui.prompt.action -> ipc/pty.write -> pty.output -> terminal.render.flush` share a flow ID |
| `PT-04-content-gate-off` | Privacy default | prompt text, terminal command, and output strings are absent; lengths/hashes exist |
| `PT-05-content-gate-on` | Explicit local content capture | bounded preview fields appear and are marked `contentCaptured: true` |
| `PT-06-multi-task-routing` | Multiple Task correctness | events for two Tasks stay separated by terminal ID and Task lane |
| `PT-07-coding-agent-launch` | PTY-backed agent launch | launch flow includes old PTY dispose, new PTY spawn, output, render |
| `PT-08-high-volume-overhead` | Trace under load | terminal-perf style output still satisfies existing latency and FPS thresholds |
| `PT-09-windows-chunked-write` | Windows PTY behavior | chunked write events preserve order and completion state |

Quantitative gates:

- Disabled trace path must not change existing behavior or require extra renderer calls.
- With `ONWARD_PERF_TRACE=1`, terminal-perf input latency p95 remains below the existing loaded threshold of 120 ms.
- `terminal.render.flush` p95 duration should stay below 20 ms under the standard terminal-perf suite.
- Trace file growth must be bounded under sustained output by aggregating high-frequency output into counters or burst events.
- The trace writer flush should not block app quit for more than 2 seconds.

Existing suites to run after implementation:

- `pnpm typecheck`
- `test/run-performance-trace-autotest.sh` on macOS/Linux
- `test/run-performance-trace-autotest.ps1` on Windows
- `test/run-terminal-perf-autotest.sh` / `.ps1`
- `test/run-terminal-stress-autotest.sh` / `.ps1` when high-volume trace points are touched
- Full `rm -rf out release && pnpm dist:dev` and startup smoke test after code changes

## Cross-Platform Notes

- Use Node/Electron APIs for timestamps, file paths, and JSON writing; avoid shell-dependent trace generation.
- Do not parse shell prompts as the core signal for command boundaries.
- Preserve Windows ConPTY chunking behavior in `PtyManager.writeLargeData` / `writeChunked`.
- Use exact process names when launching or killing the packaged app for validation.
- Use fixture scripts that run under Node where possible; avoid relying on bash-only or PowerShell-only syntax for shared assertions.

## Risks and Mitigations

- **Trace overhead under PTY output flood**: aggregate output into bursts/counters and cap raw samples.
- **Sensitive local data**: default to metadata, require explicit content-capture switch, mark content-bearing events.
- **Event name drift**: maintain this registry as append-only once implemented.
- **Flow propagation complexity**: begin with Prompt Bridge and terminal write paths, then extend to direct manual terminal input.
- **False command-completion claims**: label Task state as PTY activity, not exact shell command lifecycle.

## Recommended First Code Slice

The first implementation slice should be narrow:

1. Add the trace writer and debug IPC gate.
2. Record metadata events and `PerfMonitor` snapshots.
3. Instrument Prompt send-and-execute, `terminal:write`, `PtyManager.write`, `TerminalDataBuffer.flush`, and renderer `terminal.render.flush`.
4. Add the schema/content-gate autotest.

This gives an end-to-end trace for the most important flow before broadening coverage to coding-agent launch, Git runtime, Markdown rendering, and full Task activity state.
