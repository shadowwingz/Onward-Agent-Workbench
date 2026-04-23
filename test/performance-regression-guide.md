<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Performance Regression Testing Guide

This guide describes how to run manual and semi-automated performance regression tests for the Onward terminal application. The primary focus is **input responsiveness under multi-terminal load** — the scenario where multiple terminals are producing high-volume output (e.g., Claude Code running in 3-6 panes) while the user types in the Prompt input area.

## Prerequisites

- A development build of Onward with `ONWARD_DEBUG=1` (enables PerfMonitor output in DevTools console).
- Build command: `rm -rf out release && pnpm dist:dev`
- Launch: set environment variable `ONWARD_DEBUG=1` before starting the app.

## 1. Terminal Stress Test (6-Pane Output Flood)

### Purpose

Verify that the Prompt input area remains responsive when all 6 terminal panes are producing continuous high-volume output simultaneously. This is the most demanding real-world scenario (e.g., 3 Claude Code instances plus 3 build/test terminals all running at once).

### Steps

1. **Launch the app** with `ONWARD_DEBUG=1`.

2. **Open 6-pane layout**: Click the 6-grid icon in the left sidebar.

3. **Start continuous output in all 6 terminals**. In each terminal, run:

   ```powershell
   # Windows PowerShell
   while ($true) { echo "stress-$(Get-Date -f ss.fff)-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
   ```

   ```bash
   # macOS / Linux
   yes "stress-$(date +%s.%N)-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   ```

   Alternatively, use the provided stress script (simulates Claude Code output patterns):

   ```powershell
   # Windows — requires PowerShell 7+
   pwsh -NoLogo -File test/stress-claude-output.ps1 -Duration 600 -Mode mixed
   ```

   ```bash
   # macOS / Linux
   bash test/stress-claude-output.sh 600 mixed
   ```

   To send the command to all 6 terminals at once via the API:

   ```bash
   API="http://127.0.0.1:<port>"  # port from /api/health
   TIDS=$(curl -s "$API/api/tasks" | python3 -c "import sys,json; [print(t['id']) for t in json.load(sys.stdin)['tasks']]" | tr -d '\r')
   while IFS= read -r tid; do
     curl -s -X POST "$API/api/terminal/$tid/write" \
       -H "Content-Type: application/json" \
       -d '{"text":"while ($true) { echo \"stress-$(Get-Date -f ss.fff)-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\" }","execute":true}'
     sleep 2
   done <<< "$TIDS"
   ```

4. **Type in the active terminal and in the Prompt input area** while output is running. Pay attention to:
   - Keystroke-to-character delay (should feel instant, target < 80ms, never obviously delayed)
   - Cursor movement responsiveness
   - Whether the Prompt area freezes or stutters

5. **Let the test run for at least 10-20 minutes** to catch long-running degradation (memory pressure, GC pauses, resource leaks).

6. **Stop all terminals**: Press `Ctrl+C` in each terminal, or send via API:

   ```bash
   while IFS= read -r tid; do
     curl -s -X POST "$API/api/terminal/$tid/write" \
       -H "Content-Type: application/json" -d '{"text":"\u0003","execute":false}'
   done <<< "$TIDS"
   ```

### Key Metrics (from DevTools Console)

Open DevTools (`Ctrl+Shift+I`) and look for `[PerfMon]` lines in the Console tab. Key fields:

| Metric | Healthy | Degraded | Meaning |
|--------|---------|----------|---------|
| `fps` | 28-33 | < 15 or 0 | Renderer frame rate; 0 means main thread is completely blocked |
| `drops` | 0-3 | > 10 | Frames exceeding 33ms threshold per second |
| `longest` | < 50ms | > 200ms | Longest single frame in the last second |
| `writes` | < 100/s | > 500/s | xterm.write() calls per second (should be throttled) |
| `writeMax` | < 5ms | > 20ms | Most expensive single xterm.write() call |
| `ipc` | < 80/s | > 200/s | IPC messages from main process per second |
| `hidden` | 0 (if all visible) | > 0 when tabs hidden | Data chunks buffered instead of rendered |

### Expected Results (Current Baseline)

With focused-terminal interactive boost enabled:

| Condition | fps | writes/s | ipc/s | Typing feel |
|-----------|-----|----------|-------|-------------|
| 6 terminals idle | 32 | 0 | 0 | Instant |
| 6 terminals max output | 28-32 | 40-80 | bursty on focused terminal | Responsive |
| 6 output + typing in focused terminal | 28-32 | focused terminal may spike temporarily | focused terminal may spike temporarily | Still feels near-instant |

## 2. Hidden Terminal Optimization Verification

### Purpose

Verify that terminals in background tabs do not consume rendering resources.

### Steps

1. Open 6-pane layout in **Tab A**.
2. Start continuous output in all 6 terminals.
3. Create a new **Tab B** and switch to it.
4. Check PerfMon output: `hidden` counter should increase (data is being buffered, not rendered).
5. `writes` should drop significantly (only Tab B's terminals are rendered).
6. Switch back to Tab A: buffered data should flush and output should appear.

### Expected Results

| Metric | Tab A visible | Tab B visible (Tab A hidden) |
|--------|--------------|------------------------------|
| `writes/s` | 40-60 | < 10 (only Tab B terminals) |
| `hidden` | 0 | > 0 (Tab A data buffered) |
| `fps` | 31-32 | 32-33 (less rendering work) |

## 3. Automated Stress Test Suite

The `src/autotest/test-terminal-stress.ts` file contains automated tests (TP-06 through TP-10) that can be run via:

```powershell
# Windows
pwsh test/run-terminal-stress-autotest.ps1

# macOS / Linux
bash test/run-terminal-stress-autotest.sh
```

These tests programmatically create terminals, inject output, toggle visibility via `setVisibility()`, and measure performance. They complement the manual test above but do not replace it because manual testing captures the real Prompt input feel that automated probes cannot fully measure.

## 3.1 Terminal Architecture Baseline Suite

Use this suite before changing the terminal architecture. It records a JSON
baseline for the current build so later optimization branches can report
percentage improvements against the same workload.

```powershell
# Windows
pwsh test/run-terminal-architecture-baseline-autotest.ps1
```

```bash
# macOS / Linux
bash test/run-terminal-architecture-baseline-autotest.sh
```

The runner prepares a dedicated fixture under
`test/fixtures/terminal-architecture-baseline/workdir`, launches the packaged
development app with `ONWARD_AUTOTEST_SUITE=terminal-architecture-baseline`, and
writes a result file under `test/results/terminal-architecture-baseline/`.

The suite records these scenarios:

| Scenario | Purpose |
|----------|---------|
| `idle-input` | Baseline xterm keystroke-to-echo latency with no terminal output pressure |
| `visible-output-5` | Five visible terminals stream output while the sixth receives input |
| `visible-output-5-git-diff` | Visible output plus repeated renderer-to-main Git diff requests |
| `hidden-output-5-git-diff` | Hidden output plus Git diff pressure to isolate renderer write cost |
| `visible-output-5-search` | Visible output plus project search pressure over the fixture tree |

Primary comparison metrics:

| Metric | Meaning |
|--------|---------|
| `inputLatency.p95Ms` | Main acceptance metric for typing responsiveness |
| `inputLatency.maxMs` | Worst observed keystroke-to-echo delay |
| `perf.avgFps` / `perf.minFps` | Renderer frame stability while terminal data is flowing |
| `perf.avgIpcMsgPerSec` | IPC pressure from terminal data and background work |
| `perf.avgXtermWritesPerSec` / `perf.maxXtermWriteMs` | Renderer terminal write pressure |
| `gitDiffPressure.p95Ms` | Main-process Git workload duration under terminal output |
| `searchPressure.p95Ms` | Project search workload duration under terminal output |

When comparing an optimization branch against the baseline, use the same runner
and compute:

```text
improvement_pct = (baseline_value - candidate_value) / baseline_value * 100
```

For latency and IPC metrics, positive values are improvements. For FPS, invert
the formula or report the direct FPS increase:

```text
fps_change_pct = (candidate_fps - baseline_fps) / baseline_fps * 100
```

Use the checked-in comparison tool to keep the optimization measurable:

```powershell
node test/compare-performance-baseline.mjs `
  --suite terminal-architecture-baseline `
  --profile optimization `
  --before test/results/terminal-architecture-baseline/<pre-optimization>.json `
  --after test/results/terminal-architecture-baseline/<candidate>.json
```

```bash
node test/compare-performance-baseline.mjs \
  --suite terminal-architecture-baseline \
  --profile optimization \
  --before test/results/terminal-architecture-baseline/<pre-optimization>.json \
  --after test/results/terminal-architecture-baseline/<candidate>.json
```

The `optimization` profile verifies that the candidate still clears the expected
improvement floor over the pre-optimization baseline. The `regression` profile
is for comparing against an already optimized reference build and allows only a
small absolute tolerance.

## 3.2 Prompt Input Latency Baseline Suite

Use this suite when validating the scenario where multiple Tasks are refreshing
while the user types in the Prompt input area. This is the primary acceptance
point for prompt responsiveness regressions.

```powershell
# Windows
pwsh test/run-prompt-input-latency-autotest.ps1
```

```bash
# macOS / Linux
bash test/run-prompt-input-latency-autotest.sh
```

The runner prepares a dedicated fixture under
`test/fixtures/prompt-input-latency/workdir`, launches the packaged development
app with `ONWARD_AUTOTEST_SUITE=prompt-input-latency`, and writes JSON results
under `test/results/prompt-input-latency/`.

The suite records these scenarios:

| Scenario | Purpose |
|----------|---------|
| `idle-prompt-input` | Prompt textarea input latency with no terminal output pressure |
| `visible-output-2-prompt-input` | Prompt textarea input latency while two visible terminal Tasks stream output |
| `visible-output-5-prompt-input` | Prompt textarea input latency while five visible terminal Tasks stream output |
| `visible-output-5-git-diff-prompt-input` | Prompt textarea input latency while five visible terminal Tasks stream output and Git Diff pressure runs |
| `visible-output-5-search-prompt-input` | Prompt textarea input latency while five visible terminal Tasks stream output and project search pressure runs |

Primary prompt input metrics:

| Metric | Meaning |
|--------|---------|
| `promptInput.inputLatency.p95Ms` | Main acceptance metric: scheduled input to next paint |
| `promptInput.inputLatency.p99Ms` | Long-tail latency for rare but visible stalls |
| `promptInput.inputLatency.p999Ms` | Extreme long-tail latency for periodic freeze detection |
| `promptInput.inputLatency.stddevMs` | Latency variance; high values indicate intermittent stalls even when p95 is stable |
| `promptInput.inputLatency.maxMs` | Worst observed scheduled input to next paint |
| `promptInput.eventLoopDelay.p95Ms` | Renderer main-thread delay before the input callback can run |
| `promptInput.paintDelay.p95Ms` | Callback-to-next-paint delay after the textarea input is applied |
| `promptInput.mismatches` | Number of samples where the textarea value did not match the expected typed value |

Recommended acceptance target after optimization:

| Condition | Target |
|-----------|--------|
| `visible-output-2-prompt-input` | `promptInput.inputLatency.p95Ms <= 80ms`, `mismatches = 0` |
| `visible-output-5-prompt-input` | `promptInput.inputLatency.p95Ms <= 120ms`, `mismatches = 0` |
| `visible-output-5-git-diff-prompt-input` | `promptInput.inputLatency.p95Ms <= 120ms`, `mismatches = 0` |
| `visible-output-5-search-prompt-input` | `promptInput.inputLatency.p95Ms <= 120ms`, `mismatches = 0` |
| Any prompt input scenario | `promptInput.inputLatency.maxMs <= 250ms` unless the host is under unrelated system load |

The runner can also run the comparison gate automatically:

```powershell
pwsh test/run-prompt-input-latency-autotest.ps1 `
  -CompareBaselineFile test/results/prompt-input-latency/<pre-optimization>.json `
  -CompareProfile optimization
```

```bash
bash test/run-prompt-input-latency-autotest.sh "" "" "" \
  test/results/prompt-input-latency/<pre-optimization>.json \
  optimization
```

### 3.4 Prompt Input Long-Tail Test

Use this suite when the bug is intermittent: for example, six Tasks appear to
freeze every 7 to 8 seconds while the user continuously types into Prompt. The
short prompt suite is good for average behavior and p95; this suite is designed
to catch outliers and periodic stalls.

```powershell
# Windows
pwsh test/run-prompt-input-longtail-autotest.ps1
```

```bash
# macOS / Linux
bash test/run-prompt-input-longtail-autotest.sh
```

The suite launches six visible terminal Tasks. Each Task repeatedly runs
`git status --porcelain=2 --branch -uall` in a heavy fixture repository and
prints a status line, while the Prompt test schedules input every 80ms for
72 seconds. The measured latency is scheduled input time to the next paint after
the typed character is visible. This intentionally includes renderer event-loop
stalls before the input callback can run.

The fixture is intentionally heavier than the short prompt suite: it creates a
Git worktree with many tracked, modified, and untracked files so periodic
terminal GitWatch/status refreshes have enough cost to expose 7 to 8 second
stall patterns.

Long-tail-only metrics:

| Metric | Meaning |
|--------|---------|
| `promptInput.inputLatency.stddevMs` | Spread of latency samples; the primary variance signal |
| `promptInput.inputLatency.p99Ms` | 99th percentile scheduled input-to-paint latency |
| `promptInput.inputLatency.p999Ms` | 99.9th percentile scheduled input-to-paint latency |
| `promptInput.over250Ms` | Number of samples above 250ms |
| `promptInput.over500Ms` | Number of samples above 500ms |
| `promptInput.buckets[]` | One-second buckets with max / p95 / p99 / stall counts |
| `promptInput.topOutliers[]` | Worst individual samples with timestamp offsets |
| `promptInput.stallWindows[]` | Consecutive samples above the stall threshold |
| `gitRuntime.delta.kinds.gitScheduled` | Git tasks scheduled by app runtime during the scenario |
| `gitRuntime.delta.scheduler.dedupHits` | Runtime-level Git task deduplication hits |
| `gitRuntime.delta.latencies.titleRefreshCount` | Terminal title/status refresh completions during the scenario |
| `mainEventLoop.maxDriftMs` | Browser/Main process event-loop stall observed after scenario reset |
| `mainEventLoop.over1000Ms` / `over3000Ms` / `over6000Ms` | Count of Main event-loop stalls beyond severe freeze thresholds |
| `perfTrace.logPath` | JSONL trace file used to inspect stall timing and causal events |

Recommended long-tail target:

| Condition | Target |
|-----------|--------|
| `visible-output-6-git-status-prompt-longtail` | `p99Ms <= 160ms`, `p999Ms <= 300ms`, `maxMs <= 600ms` |
| Variance | `stddevMs <= 60ms` |
| Extreme stalls | `over250Ms <= 3`, `over500Ms = 0`, `mismatches = 0` |
| Main process stall | `mainEventLoop.maxDriftMs <= 1000ms`, `over1000Ms = 0`, `over3000Ms = 0`, `over6000Ms = 0` |

## 4. Performance Architecture Overview

The terminal data pipeline and where scheduling occurs:

```
PTY (node-pty)
  -> TerminalDataBuffer (main process)
     -> output visibility gate
        -> IPC: webContents.send('terminal:data', id, merged)
           -> Renderer: registerGlobalDataListener()
              -> pendingData[] buffer (per session)
                 -> TerminalOutputScheduler
                    -> requestAnimationFrame + frame budget
                       -> terminal.write(chunk)
```

Key optimization points:
- **Main process**: terminal data is retained or dropped by explicit output visibility so hidden or non-consumed task output does not continuously cross IPC.
- **Renderer**: `TerminalOutputScheduler` uses frame budgets, chunk limits, and round-robin fairness across terminals.
- **Prompt input lane**: capture-phase input detection and `navigator.scheduling.isInputPending()` make terminal output yield while the Prompt editor is active.
- **Focused terminal input**: recent terminal input enables a short interactive boost for the focused session.
- **Hidden terminals**: hidden output avoids renderer `terminal.write()` and avoids sustained IPC pressure.
- **WebGL pooling**: Hidden terminals release GPU contexts via `setVisibility(false)`
- **GitWatch**: terminal output does not promote every task to interactive priority. Repository fingerprint and branch/status refreshes are shared per repo with in-flight coalescing so six visible Tasks in the same repo do not run six identical Git refreshes in the same burst. Terminal title/status refreshes must avoid untracked-file scans; full untracked enumeration belongs to explicit Git Diff / Git History flows.

Comparison gate expectations for the optimized architecture:

| Suite | Gate |
|-------|------|
| Prompt input | `visible-output-2-prompt-input` p95 <= 80ms, `visible-output-5-prompt-input` p95 <= 120ms, max <= 250ms, mismatches = 0 |
| Prompt long-tail | six visible output Tasks keep p99 <= 160ms, p999 <= 300ms, max <= 600ms, stddev <= 60ms, over500 = 0 |
| Terminal architecture | terminal echo median p50 <= 50ms for critical scenarios |
| Hidden output isolation | hidden git IPC <= 10/s and renderer hidden buffered MB <= 1 |
| Frame stability | critical scenarios keep average FPS >= 28 |

## 5. Regression Checklist

When making changes to the terminal rendering pipeline, verify:

- [ ] 6-pane layout opens without hanging at "Initializing"
- [ ] `fps` stays above 28 under 6-terminal full output
- [ ] `writes/s` stays below 100 (throttle is working)
- [ ] Focused terminal typing remains responsive while terminals are outputting
- [ ] Prompt input area is responsive while terminals are outputting
- [ ] Switching tabs flushes buffered data correctly
- [ ] Hidden terminals show `hidden > 0` in PerfMon
- [ ] No WebGL context errors in console after tab switching
- [ ] No memory growth over 20-minute sustained output
