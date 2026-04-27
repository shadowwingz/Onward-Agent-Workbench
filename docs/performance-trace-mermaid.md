<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Performance Trace Mermaid Map

This document uses Mermaid diagrams to describe the current performance
trace design: which trace points are produced by user actions, main-thread
IPC, the API / Prompt Bridge, the PTY subprocess, Task state transitions,
and the renderer paint pipeline — and how the automated checks prove
these points are actually visible.

The trace file uses the Chrome Trace / Perfetto compatible JSON format.
Enable it with:

```bash
ONWARD_PERF_TRACE=1
```

Raw input content is NOT recorded by default — only length, line count,
and a hash. Opt in only when manually debugging payload content:

```bash
ONWARD_PERF_TRACE_CAPTURE_CONTENT=1
```

Two additional runtime knobs:

| Environment variable | Purpose |
| --- | --- |
| `ONWARD_PERF_TRACE_FLUSH_SEC` | Periodic flush-to-disk interval, default `30` seconds; `0` means flush only on quit or manual flush |
| `ONWARD_PERF_TRACE_MAX_MB` | In-memory trace buffer cap, default `256` MB; once exceeded, `droppedEvents` increments |

## Event types

```mermaid
flowchart LR
  start["ph=s<br/>flow start"] --> step["ph=t<br/>flow step"]
  step --> finish["ph=f<br/>flow end"]
  complete["ph=X<br/>complete event<br/>carries dur"]
  instant["ph=i<br/>instant event<br/>state / point event"]
  counter["ph=C<br/>counter event<br/>periodic snapshot"]

  file["trace JSON"] --- start
  file --- complete
  file --- instant
  file --- counter
```

When reading a trace, look at three categories first:

| Type | Use | Example |
| --- | --- | --- |
| `ph=X` | Inspect duration | `ui.prompt.action`, `ipc.invoke`, `pty.write`, `terminal.render.flush` |
| `ph=i` | Inspect state and point-in-time events | `ui.prompt.edit`, `ui.prompt.task_select`, `pty.output`, `terminal.task.state` |
| `ph=s/t/f` | Trace how one user action flows across processes | `ui.prompt.action -> ipc.terminal.write -> terminal.render.flush` |
| `ph=C` | Inspect 1-second-granularity performance counters | `perf.renderer.snapshot` |

## Diff review of newly-added trace coverage

Another Coding Agent introduced several new trace capabilities in the
working tree; reviewed against the current directory state:

| Change | Verdict | Action taken |
| --- | --- | --- |
| `git.runtime.task` | Useful — exposes the Git scheduler queue, concurrency, and duration. Explains whether Git polling / cwd probing is piling up. | Privacy issue fixed: no longer writes raw `repoKey` / `label`; uses length + hash instead. |
| `markdown.render.worker` | Useful — surfaces real Markdown worker render duration; good for diagnosing Project Editor / preview lag. | Kept; documentation extended on the Project Editor path. |
| `project_editor.render.apply` | Right direction, but the original implementation only measured the apply *scheduling* time, not the actual DOMPurify / apply time. | Moved into the idle apply callback so it records DOMPurify / setState invocation time. |
| `pty.dispose` / `pty.shutdown_all` | Useful — confirms that PTY teardown is hermetic on quit, agent restart, or app close. | Documentation extended on the PTY lifecycle. |
| `ONWARD_PERF_TRACE_FLUSH_SEC` / `ONWARD_PERF_TRACE_MAX_MB` | Useful — adds disk-flush guarantees for crash scenarios and an in-memory cap. | Documentation extended on env vars and the `trace.session.start` payload. |
| `scripts/trace-coverage-audit.mjs` | Useful — provides a registry / code / trace three-way self-consistency check. | Documentation extended on the verification path. |
| `scripts/trace-narrate.mjs` | Useful — converts a trace into a human-readable, time-ordered narrative. | Documentation extended on the reading path. |

## End-to-end map

```mermaid
flowchart LR
  subgraph Renderer["Renderer"]
    edit["User edits Prompt<br/>ui.prompt.edit"]
    select["Selects Task<br/>ui.prompt.task_select"]
    action["Clicks Send / Execute / Send and Execute<br/>ui.prompt.action"]
    project["Project Editor Markdown preview<br/>markdown.render.worker<br/>project_editor.render.apply"]
    renderReceive["Terminal output received<br/>terminal.render.receive"]
    renderFlush["Written into xterm<br/>terminal.render.flush"]
    snapshot["Periodic perf snapshot<br/>perf.renderer.snapshot"]
  end

  subgraph Main["Main Process"]
    api["HTTP API<br/>api.request"]
    git["Git scheduler<br/>git.runtime.task"]
    bridge["Prompt Bridge<br/>prompt.bridge"]
    ipc["IPC handler<br/>ipc.invoke"]
    buffer["TerminalDataBuffer<br/>terminal.buffer.flush"]
    send["webContents.send terminal:data<br/>terminal.ipc.send"]
  end

  subgraph Task["Task / PTY Process"]
    state["Task state<br/>terminal.task.state"]
    ptyWrite["Write PTY<br/>pty.write / pty.send_input_sequence"]
    ptyOutput["PTY output<br/>pty.output"]
    ptyLife["PTY lifecycle<br/>pty.spawn / pty.dispose / pty.shutdown_all"]
    spawn["Create PTY<br/>pty.spawn"]
  end

  subgraph Tools["Self-proof Tools"]
    contract["golden contract<br/>validate-performance-trace-contract.mjs"]
    audit["coverage audit<br/>trace-coverage-audit.mjs"]
    narrate["human narration<br/>trace-narrate.mjs"]
  end

  edit --> action
  select --> action
  api --> bridge
  bridge --> action
  action --> ipc
  git --> snapshot
  project --> snapshot
  ipc --> ptyWrite
  ptyLife --> state
  spawn --> state
  ptyWrite --> state
  ptyWrite --> ptyOutput
  ptyOutput --> buffer
  buffer --> send
  send --> renderReceive
  renderReceive --> renderFlush
  renderFlush --> snapshot
  contract --> audit
  audit --> narrate
```

## User sends a command from the Prompt panel

User actions covered: editing the Prompt, selecting a Task, clicking
`Send`, then `Execute`, or clicking `Send and Execute`.

```mermaid
sequenceDiagram
  autonumber
  participant User as User
  participant PN as PromptNotebook
  participant PS as PromptSender
  participant App as App renderer handlers
  participant Preload as preload terminal API
  participant IPC as main ipc-handlers
  participant PTY as PtyManager
  participant Proc as Task PTY process
  participant Buffer as TerminalDataBuffer
  participant TS as TerminalSessionManager
  participant Xterm as xterm

  User->>PN: Type or edit Prompt
  PN-->>PN: trace ui.prompt.edit<br/>field, mode, payloadLength, payloadHash

  User->>PS: Select target Task
  PS-->>PS: trace ui.prompt.task_select<br/>terminalId, selected, selectedCount

  User->>PS: Click Send / Execute / Send and Execute
  PS->>App: onSend / onExecute / onSendAndExecute
  App-->>App: flow start ui.prompt.action<br/>action, terminalIds, flowId, payloadLength, payloadHash
  App-->>App: complete ui.prompt.action<br/>dur, result

  App->>Preload: terminal.write or sendInputSequence
  Preload->>IPC: ipcRenderer.invoke
  IPC-->>IPC: trace terminal.task.state input_pending
  IPC-->>IPC: flow step ipc.terminal.write or ipc.terminal.send_input_sequence
  IPC-->>IPC: complete ipc.invoke<br/>channel, terminalId, result, dur

  IPC->>PTY: pty.write or pty.send_input_sequence
  PTY-->>PTY: complete pty.write / pty.send_input_sequence<br/>writeMode, includesEnter, result, dur
  PTY-->>PTY: trace terminal.task.state running<br/>when input includes Enter
  PTY->>Proc: Actual write into the PTY

  Proc-->>PTY: stdout / stderr
  PTY-->>PTY: trace pty.output<br/>terminalId, bytes, bracketedPasteMode
  PTY-->>PTY: trace terminal.task.state output_active
  PTY->>Buffer: push output
  Buffer-->>Buffer: complete terminal.buffer.flush<br/>chunkCount, bytes, dur
  Buffer->>TS: terminal:data IPC
  Buffer-->>Buffer: trace terminal.ipc.send<br/>terminalId, bytes

  TS-->>TS: trace terminal.render.receive<br/>visible, bytes, pendingBytes
  TS->>Xterm: terminal.write(data)
  TS-->>TS: complete terminal.render.flush<br/>visible, bytes, xtermDurationMs, dur
  TS-->>TS: flow end terminal.render.flush
```

The key self-proof on this path is that the same `flowId` simultaneously
appears in:

```mermaid
flowchart LR
  a["ui.prompt.action<br/>flow start"] --> b["ipc.terminal.write<br/>flow step"]
  b --> c["terminal.render.receive<br/>flow step"]
  c --> d["terminal.render.flush<br/>flow end"]
```

If the validation script cannot find a single `flowId` spanning UI, IPC,
and renderer, the trace has not proved the closed loop from "user action"
to "user-visible output."

## HTTP API sending to a Task

Program behaviour covered: external clients or test code call
`/api/terminal/:id/write`; the Onward main process forwards the request
through the Prompt Bridge so the renderer can reuse the same Prompt-send
logic.

```mermaid
sequenceDiagram
  autonumber
  participant Client as HTTP client
  participant API as api-server.ts
  participant Main as ipc-handlers sendPromptViaBridge
  participant Renderer as App Prompt Bridge listener
  participant IPC as terminal IPC
  participant PTY as PtyManager
  participant Proc as Task PTY process
  participant Terminal as Terminal renderer

  Client->>API: POST /api/terminal/:id/write<br/>{ text, execute }
  API-->>API: flow start api.terminal.write<br/>terminalId, action, payloadLength, payloadHash
  API->>Main: sendPromptViaBridge
  Main-->>Main: flow step prompt.bridge.send<br/>requestId, terminalId, action
  Main->>Renderer: prompt:bridge-send

  Renderer->>Renderer: handleSendToTerminals or handleSendAndExecuteOnTerminals
  Renderer-->>Renderer: ui.prompt.action<br/>action, terminalIds, flowId, dur
  Renderer->>IPC: terminal.write / sendInputSequence
  IPC->>PTY: pty.write / pty.send_input_sequence
  PTY->>Proc: PTY command
  Proc-->>Terminal: pty.output -> terminal.buffer.flush -> terminal.render.flush

  Renderer->>Main: prompt:bridge-response
  Main-->>Main: complete prompt.bridge<br/>successCount, failedCount, result, dur
  API-->>API: complete api.request<br/>route, status, deliveredCount, failedCount, dur
  API->>Client: JSON result
```

What to look for during validation:

| Behaviour | Trace points that must appear |
| --- | --- |
| API received the request | `api.terminal.write`, `api.request` |
| Main process forwarded to renderer | `prompt.bridge.send`, `prompt.bridge` |
| Renderer reused Prompt-send logic | `ui.prompt.action` |
| Eventually reached the PTY and rendered | `pty.write`, `pty.output`, `terminal.render.flush` |

## Task state machine

`terminal.task.state` is the core event answering "is this Task currently
working?" It does not depend on a particular command string — it derives
state from input, execution, output, and exit signals.

```mermaid
stateDiagram-v2
  [*] --> idle: terminal created
  idle --> input_pending: terminal.write / sendInputSequence
  input_pending --> running: input includes Enter
  running --> output_active: PTY emits output
  input_pending --> output_active: command echoes or shell responds
  output_active --> idle: output idle timeout
  running --> exited: PTY exits
  output_active --> exited: PTY exits
  idle --> exited: dispose / process exit
```

Per-state fields:

| state | When emitted | Key fields |
| --- | --- | --- |
| `input_pending` | renderer or API wrote input to a Task | `terminalId`, `flowId`, `inputKind`, `payloadLength`, `payloadHash` |
| `running` | input contained Enter, meaning the command was executed | `terminalId`, `flowId`, `reason` |
| `output_active` | PTY produced output | `terminalId`, `flowId`, `bytes` |
| `idle` | output stopped for a short window | `terminalId`, `flowId`, `reason` |
| `exited` | PTY process exited | `terminalId`, `flowId`, `exitCode`, `signal` |

## Coding Agent / subprocess startup

Program behaviour covered: configuring and launching a coding agent.
Onward rebuilds the target Task's PTY so it can execute the agent
command.

```mermaid
sequenceDiagram
  autonumber
  participant UI as Renderer UI
  participant IPC as main ipc-handlers
  participant Runtime as coding-agent-runtime
  participant PTY as PtyManager
  participant Proc as Agent PTY process

  UI->>IPC: coding-agent:prepare
  IPC-->>IPC: complete coding_agent.prepare<br/>commandKind, executablePathProvided, dur
  IPC->>Runtime: resolve executable

  UI->>IPC: coding-agent:launch
  IPC-->>IPC: flow start coding_agent.launch<br/>terminalId, commandKind
  IPC-->>IPC: trace terminal.task.state running<br/>reason=coding-agent-launch
  IPC->>Runtime: resolve executable and args
  IPC->>PTY: dispose old PTY and create new PTY
  PTY-->>PTY: complete pty.spawn<br/>commandKind, shellKind, argsCount, result, dur
  PTY->>Proc: spawn actual command
  IPC-->>IPC: complete coding_agent.launch<br/>argsCount, envVarCount, result, dur
  IPC-->>IPC: flow step coding_agent.pty.spawned
```

This proves two things:

1. `coding_agent.launch` confirms Onward actually initiated the agent launch.
2. `pty.spawn` confirms the Task was backed by a real OS process via PTY.

If launch fails, a `coding_agent.launch.error` flow end is emitted; if
the launch restarts an existing Task, you'll see the old PTY's
`pty.dispose` paired with the new PTY's `pty.spawn`.

## Output backflow and render duration

```mermaid
flowchart LR
  proc["PTY process stdout/stderr"] --> output["pty.output<br/>bytes"]
  output --> state["terminal.task.state<br/>output_active"]
  output --> buffer["terminal.buffer.flush<br/>chunkCount, bytes, dur"]
  buffer --> ipc["terminal.ipc.send<br/>bytes"]
  ipc --> receive["terminal.render.receive<br/>visible, bytes, pendingBytes"]
  receive --> flush["terminal.render.flush<br/>xtermDurationMs, dur"]
  flush --> idle["terminal.task.state<br/>idle"]
  flush --> snapshot["perf.renderer.snapshot<br/>fps, xtermWriteCount, ipcDataMsgCount"]
```

When the UI feels laggy, look at these events first:

| Symptom | Inspect |
| --- | --- |
| Main process emitting output too frequently | `pty.output`, `terminal.buffer.flush`, `terminal.ipc.send` |
| Renderer slow to write into xterm | `terminal.render.flush.dur`, `xtermDurationMs` |
| Hidden terminal still consuming resources | `terminal.render.receive.visible`, `terminal.render.hidden_buffer` |
| Overall load at 1-second granularity | `perf.renderer.snapshot` |

## Git and Project Editor

Two non-terminal performance paths added by the other Agent — primarily
to explain "the terminal isn't slow but the UI still feels slow."

```mermaid
flowchart TD
  subgraph Git["Git Runtime"]
    scheduled["Git task scheduled<br/>kind / priority / queueDepth"]
    run["git.runtime.task<br/>dur, result, inflight"]
    metrics["debug:get-git-runtime-metrics<br/>scheduler counters"]
    scheduled --> run --> metrics
  end

  subgraph Markdown["Project Editor Markdown Preview"]
    request["sendMarkdownRenderRequest<br/>profile=true when trace enabled"]
    worker["markdown.render.worker<br/>contentLength, outputLength, imageCount, dur"]
    apply["project_editor.render.apply<br/>outputLength, imageCount, dompurifyDurationMs, dur"]
    request --> worker --> apply
  end

  run --> snapshot["perf.renderer.snapshot"]
  apply --> snapshot
```

Limits of these two paths:

| Trace point | Proves | Does NOT prove |
| --- | --- | --- |
| `git.runtime.task` | A Git scheduler task's queue depth, concurrency, success / failure, and duration | Does not display the raw repo path or full Git arguments by default |
| `markdown.render.worker` | Worker-side Markdown render duration | Does not include DOM apply or browser paint time |
| `project_editor.render.apply` | Renderer-side DOMPurify and React setState invocation duration | Not equivalent to the browser's final paint completion time |

## PTY lifecycle

```mermaid
stateDiagram-v2
  [*] --> spawned: pty.spawn
  spawned --> active: terminal create success
  active --> resized: pty.resize
  resized --> active: resize success
  active --> disposed: pty.dispose
  active --> shutdown: pty.shutdown_all
  disposed --> [*]
  shutdown --> [*]
```

Lifecycle events used to verify cleanup is hermetic:

| Scenario | Must see |
| --- | --- |
| Create a Task | `pty.spawn.result=success` |
| Resize the terminal | `pty.resize.result=success` |
| Close a single Task or restart an agent | `pty.dispose.result=success` |
| App quit | `pty.shutdown_all.total`, `closed`, `timedOut` |

## Trace Point Registry

| Trace point | Type | Location | Description | Key fields |
| --- | --- | --- | --- | --- |
| `trace.session.start` | instant | main | Trace session started | `schema`, `platform`, `appVersion`, `contentCaptured`, `flushIntervalSec`, `maxBufferMB` |
| `trace.session.flush` | complete | main | Trace JSON written | `reason`, `eventCount`, `droppedEvents`, `dur` |
| `ui.prompt.edit` | instant | renderer | Prompt content or title changed | `field`, `mode`, `payloadLength`, `payloadLineCount`, `payloadHash` |
| `ui.prompt.task_select` | instant | renderer | Task selection toggled | `terminalId`, `selected`, `selectedCount`, `totalCount` |
| `ui.prompt.action` | complete + flow start | renderer | Send / Execute / Send and Execute | `action`, `terminalIds`, `flowId`, `result`, `dur` |
| `ui.prompt.action.done` | flow end | renderer | Prompt action completed | `successCount`, `sentOnlyCount`, `failedCount` |
| `ui.terminal.write` | flow step | renderer | Renderer decided to write to terminal | `terminalId`, `action`, `payloadLength`, `payloadHash` |
| `ui.terminal.paste` | flow step | renderer | Send via paste mode | `terminalId`, `shellKind`, `payloadLength`, `payloadHash` |
| `ui.terminal.send_input_sequence` | flow step | renderer | Send input in stages | `terminalId`, `kind`, `ok`, `phase` |
| `api.terminal.write` | flow start/result | main | API write-to-Task flow | `terminalId`, `action`, `payloadLength`, `payloadHash`, `status` |
| `api.terminal.write.result` | flow step | main | API write-to-Task result | `terminalId`, `action`, `status`, `deliveredCount`, `failedCount` |
| `api.request` | complete | main | HTTP API request | `route`, `terminalId`, `action`, `status`, `deliveredCount`, `failedCount`, `dur` |
| `prompt.bridge.send` | flow step | main | Main process asks renderer to perform a Prompt action | `requestId`, `terminalId`, `action` |
| `prompt.bridge.response` | flow step | main | Renderer returns Prompt Bridge result | `requestId`, `terminalId`, `action`, `successCount`, `failedCount` |
| `prompt.bridge.timeout` | flow end | main | Prompt Bridge timed out | `requestId`, `terminalId`, `action` |
| `prompt.bridge` | complete | main | Prompt Bridge round-trip | `requestId`, `terminalId`, `action`, `successCount`, `failedCount`, `result`, `dur` |
| `ipc.invoke` | complete | main | IPC handler duration | `channel`, `terminalId`, `result`, `dur` |
| `ipc.terminal.write` | flow step | main | IPC write to terminal | `terminalId`, `includesEnter`, `payloadLength`, `payloadHash` |
| `ipc.terminal.send_input_sequence` | flow step | main | IPC staged input | `terminalId`, `kind`, `payloadLength`, `payloadHash` |
| `pty.spawn` | complete | main / PTY | Real PTY process created | `terminalId`, `commandKind`, `shellKind`, `argsCount`, `cwdProvided`, `result`, `dur` |
| `pty.write` | complete | main / PTY | Write into PTY | `terminalId`, `writeMode`, `includesEnter`, `payloadLength`, `payloadHash`, `result`, `dur` |
| `pty.send_input_sequence` | complete | main / PTY | Large-text / paste sequence written into PTY | `terminalId`, `phase`, `enterDelayMs`, `result`, `dur` |
| `pty.resize` | complete | main / PTY | PTY resized | `terminalId`, `cols`, `rows`, `result`, `dur` |
| `pty.dispose` | complete | main / PTY | Single PTY closed | `terminalId`, `result`, `dur` |
| `pty.shutdown_all` | complete | main / PTY | All PTYs closed on app quit | `total`, `closed`, `timedOut`, `dur` |
| `pty.output` | instant | main / PTY | PTY output | `terminalId`, `bytes`, `bracketedPasteMode`, `flowId` |
| `terminal.task.state` | instant | main / task thread | Task activity state | `terminalId`, `state`, `flowId`, `reason`, `bytes` |
| `terminal.buffer.flush` | complete | main | Coalesce PTY output and forward to renderer | `terminalId`, `chunkCount`, `bytes`, `dur` |
| `terminal.ipc.send` | instant | main | Send `terminal:data` to renderer | `terminalId`, `bytes`, `flowId` |
| `terminal.render.receive` | instant + flow step | renderer | Renderer received terminal output | `terminalId`, `visible`, `bytes`, `pendingBytes`, `flowId` |
| `terminal.render.flush` | complete + flow end | renderer | Written into xterm | `terminalId`, `visible`, `bytes`, `xtermDurationMs`, `dur`, `flowId` |
| `terminal.render.hidden_buffer` | counter | renderer | Hidden terminal buffer | `terminalId`, `pendingChunks`, `pendingBytes` |
| `terminal.input` | instant | renderer | User typed directly into the terminal | `terminalId`, `payloadLength`, `payloadHash`, `includesEnter` |
| `perf.renderer.snapshot` | counter | renderer | 1-second perf snapshot | `fps`, `frameDrops`, `xtermWriteCount`, `ipcDataMsgCount`, `inputLatencyAvgMs` |
| `coding_agent.prepare` | complete | main | Check agent runtime | `commandKind`, `executablePathProvided`, `result`, `dur` |
| `coding_agent.launch` | complete + flow start | main | Launch coding agent | `terminalId`, `commandKind`, `argsCount`, `envVarCount`, `result`, `dur` |
| `coding_agent.launch.error` | flow end | main | Agent launch failed | `terminalId`, `reason` |
| `coding_agent.pty.spawned` | flow step | main | Agent PTY created | `terminalId` |
| `git.runtime.task` | complete | main | Git scheduler task | `kind`, `priority`, `repoScoped`, `repoKeyLength`, `repoKeyHash`, `labelLength`, `labelHash`, `queueDepth`, `inflight`, `result`, `dur` |
| `markdown.render.worker` | complete | renderer worker result | Markdown worker render | `contentLength`, `outputLength`, `imageCount`, `profileFlag`, `dur` |
| `project_editor.render.apply` | complete | renderer | Markdown preview DOMPurify / setState apply | `outputLength`, `imageCount`, `dompurifyDurationMs`, `dur` |

## Automated verification mapping

`test/autotest/validate-performance-trace-contract.mjs` reads the trace JSON and
checks the following contracts. It does NOT verify "logs exist" — it
verifies "the trace can reconstruct critical behaviour."

```mermaid
flowchart TD
  trace["trace JSON"] --> schema["TC-00/01<br/>traceEvents + session metadata"]
  trace --> ui["TC-03/04<br/>Prompt edit + Task select"]
  trace --> action["TC-05/06/07<br/>send / execute / sendAndExecute"]
  trace --> api["TC-08/09<br/>API + Prompt Bridge"]
  trace --> ipc["TC-10/11<br/>IPC + PTY write"]
  trace --> output["TC-12/13/14/15/16<br/>PTY output -> buffer -> IPC -> renderer -> xterm"]
  trace --> state["TC-17/18/19/20<br/>Task input_pending/running/output_active/idle"]
  trace --> perf["TC-21<br/>renderer performance snapshot"]
  trace --> flow["TC-22<br/>same flowId crosses UI -> IPC -> renderer"]
  trace --> privacy["TC-23/24<br/>raw marker and raw command are redacted"]
```

The other Agent's three-way audit and narration tools complete the
"is the verification exhaustive" and "can a human read it" proofs:

```mermaid
flowchart LR
  registry["Event Registry<br/>src/utils/perf-trace-names.ts"]
  code["Code emits<br/>performanceTrace.* call sites"]
  trace["Actual trace JSON"]
  audit["trace-coverage-audit.mjs<br/>registry x code x trace"]
  contract["validate-performance-trace-contract.mjs<br/>golden scenario"]
  narrative["trace-narrate.mjs<br/>chronological sentences"]

  registry --> audit
  code --> audit
  trace --> audit
  trace --> contract
  trace --> narrative
  audit --> verdict["dead registrations / unregistered emits / scenario gaps"]
  contract --> verdict
  narrative --> human["human-readable behavior proof"]
```

| Contract | What it proves |
| --- | --- |
| TC-03/04 | User input and target Task selection are observable |
| TC-05/06/07 | All three Prompt actions carry duration and result |
| TC-08/09 | The external API → renderer Prompt Bridge path is visible |
| TC-10/11 | Main-thread IPC and PTY writes are visible |
| TC-12 .. TC-16 | The subprocess-output-back-to-screen path is visible |
| TC-17 .. TC-20 | Whether a Task is working, when it outputs, when it idles, are visible |
| TC-22 | The cross-process flow of the same user action stays linked |
| TC-23/24 | The default configuration does not leak raw input content |
| Coverage audit | Registry, code emit sites, and actual trace agree — no unregistered events or dead registrations |
| Trace narration | The chronological story of what Onward was doing can be read out |

## Common-behaviour to trace-point cheat sheet

| Behaviour you want to verify | Trace points to look for |
| --- | --- |
| Size of user input | `ui.prompt.edit.payloadLength`, `payloadLineCount`, `payloadHash` |
| Which Task the user selected | `ui.prompt.task_select.terminalId`, `selectedCount` |
| Whether Send fired and how long it took | `ui.prompt.action[action=send].dur` |
| Whether Execute actually triggered the command | `ipc.terminal.write.includesEnter=true`, `terminal.task.state[state=running]` |
| Whether the command was actually written into the PTY | `pty.write.result=success` or `pty.send_input_sequence.result=success` |
| Whether the Task is working in the background | `terminal.task.state` transitions from `input_pending/running` to `output_active` |
| Whether Task output reached the main process | `pty.output.bytes` |
| Whether the main process forwarded output to the renderer | `terminal.buffer.flush`, `terminal.ipc.send` |
| Whether the UI actually rendered the output | `terminal.render.receive`, `terminal.render.flush` |
| Whether rendering is slow | `terminal.render.flush.dur`, `xtermDurationMs`, `perf.renderer.snapshot` |
| Whether API writes succeeded end-to-end | `api.request.status`, `prompt.bridge.result`, `ui.prompt.action` |
| Whether the Coding Agent launched via PTY | `coding_agent.launch`, `pty.spawn`, `terminal.task.state[state=running]` |
| Whether Git polling / cwd probing is piling up | `git.runtime.task.queueDepth`, `inflight`, `dur` |
| Whether Markdown preview is slow | `markdown.render.worker.dur`, `project_editor.render.apply.dur` |
| Whether PTY teardown is hermetic | `pty.dispose`, `pty.shutdown_all.closed`, `timedOut` |
| Whether trace registry agrees with code | `node scripts/trace-coverage-audit.mjs --latest` |
| Whether the trace is human-readable | `node scripts/trace-narrate.mjs --latest` |

## Minimal verification commands

Common verification commands for the macOS development build:

```bash
rm -rf out release && ONWARD_DIST_DEV_OPEN=0 pnpm dist:dev
bash test/autotest/run-performance-trace-autotest.sh "release/mac/Under Development 2.0.1-event_trace_gate_0424_codex.app/Contents/MacOS/Under Development 2.0.1-event_trace_gate_0424_codex"
```

The script prints the trace file path and invokes:

```bash
node test/autotest/validate-performance-trace-contract.mjs "<trace-file>"
node scripts/trace-coverage-audit.mjs "<trace-file>"
node scripts/trace-narrate.mjs "<trace-file>" | head -80
```

Pass criterion:

```text
Performance trace contract PASSED: 25 checks
```
