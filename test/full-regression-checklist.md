<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# Full Regression Checklist

> **Version:** v0.3
> **Date:** 2026-04-24
> **Previous version:** v0.2 (2026-04-23)

## Changelog vs. v0.2

- **Added to mandatory pass (1 script):**
  `run-trace-infra-self-check-autotest.sh` — T02 baseline trace
  self-check. Launches the app with `ONWARD_PERF_TRACE=1` for 6 s,
  asserts a Chrome trace JSON lands under `traces/perf/`, is JSON-
  parseable, and contains at least one `main:*` event. Total
  canonical runners: **44** (+1 skipped Windows).
- **`test/run-with-timeout.mjs` committed.** Appendix A's inline
  source was pseudocode in v0.2 — it now ships as a real file so
  regression is reproducible from a fresh clone.
- **All 43 existing runners migrated.** LOG_FILE paths moved from
  `/tmp/onward-<suite>-autotest.log` to
  `<repoRoot>/traces/test-logs/<suite>.log`, matching the canonical
  trace-artefact location. Runners `mkdir -p` their log dir before
  writing. The migration was done via
  `scripts/migrate-autotest-log-paths.mjs` (kept in-repo for audit).
- **New §11 "Trace infrastructure"** documents where traces land,
  how to open them, and the format (Chrome Trace Event Format
  consumed natively by Perfetto UI / `trace_processor_shell`).
- **Underlying app change** (commit landed alongside this bump):
  `electron/main/perf-trace-logger.ts` now emits Chrome trace JSON
  directly to `traces/perf/perf-trace-<ISO>-<pid>.json`. No JSONL,
  no converter, no new npm dep. Event names are registered in
  `src/utils/perf-trace-names.ts`; dereferencing the registry is
  enforced by `CLAUDE.md` Hard rule § 3.
- **§8 known-failure list unchanged** this pass — the 11 assertion
  failures from 2026-04-23 morning remain open.

## Changelog vs. v0.1

- **Added to mandatory pass (4 scripts):**
  `run-prompt-input-latency-autotest.sh`,
  `run-prompt-input-longtail-autotest.sh`,
  `run-terminal-architecture-baseline-autotest.sh`,
  `run-working-directory-copy-autotest.sh`.
  All four had runners but were absent from v0.1's SCRIPTS array; the Agent
  Team audit flagged them as "orphan runners".
- **Scheduled for removal (harnesses under review):**
  `test-regression.ts`, `test-stress.ts`, `test-per-agent-font.ts`,
  `test-preview-position-restore.ts`, `test-sidebar-autoscroll.ts`,
  `test-terminal-state-persistence.ts`, `test-feedback.ts`,
  `test-prompt-cleanup.ts` (kept only if a runner is added).
  Rationale per case is in §9 below.
- **Feature inventory introduced (§6):** every runner now maps to one or more
  user-visible features, the user entry point, and the expected observable
  output. Derived from six parallel feature-domain audits.
- **Known failure classification (§8):** 13 morning-run failures split into
  "app regression — keep red tests" vs. "test design flaw — rewrite or
  delete" to stop the conversation between "is it the test?" and "is it
  the app?".
- **Runner runtime cap added (§3):** each script must complete inside a
  5-minute wall-clock budget. Hard-timed-out scripts count as FAIL.
- **Inter-test gap bumped to 2 s** to let Electron helpers tear down
  between scripts (fixes the flaky back-to-back launch residue seen at
  end of v0.1).

## Table of contents

1. Scope & goals
2. Quality bar for test cases
3. Prerequisites and runtime policy
4. Build and static checks
5. Startup smoke test
6. Feature inventory & runner mapping
7. Full macOS regression command
8. Known failing tests (as of 2026-04-23)
9. Tests scheduled for removal
10. Coverage gaps (new tests needed)
11. Trace infrastructure (v0.3)
12. Focused rerun commands
13. Windows-only follow-up

---

## 1. Scope & goals

Run this checklist after changes that affect:

- Project Editor launch, file tree, markdown preview, outline panel, file
  memory, or session restore
- Git Diff, Git History, repo filtering, submodule handling, Git watch
- Editor / Diff / History subpage switching and working-directory copy
- Terminal focus, prompt sender, prompt list, prompt integrity, prompt
  input latency
- Binary readers: PDF, EPUB, image preview, SQLite viewer
- Telemetry, feedback, change log, schedule
- Packaging, release workflow, TypeScript / static-check coverage
- Shared Electron main / preload APIs touched by renderer code

## 2. Quality bar for test cases (v0.2 addition)

Every test kept in the checklist must answer **yes** to all three questions:

1. **Is the assertion about something the user can observe?** DOM text,
   DOM structure, clipboard, file-system, a rendered preview — yes. An
   internal `ref.current` value, a private React state name, or an IPC
   call count — no.
2. **Does the user care if this breaks?** If nobody would notice, nobody
   should gate the release on it.
3. **Is the result determined solely by the feature being tested?**
   Assertions that depend on system time, network, specific user paths,
   or on the render order of unrelated code do not belong here.

Tests that fail all three questions are **candidates for deletion** per
§9. Tests that catch a real regression but fail for reasons 1 or 3 need
to be rewritten to target stable user-observable contracts.

## 3. Prerequisites and runtime policy

- Run from the repository root.
- Use the development package unless a production build is explicitly
  required (see §4). On macOS the dev binary is
  `release/mac-arm64/Under Development <version>-<branch>.app`.
- Always kill the app by **exact** process name before launching or
  before each test script. No wildcards, no substring matches.
- **Per-script timeout:** 5 minutes hard wall-clock. The v0.2 harness in
  `test/run-full-regression.sh` wraps each runner with
  `node test/run-with-timeout.mjs 300 bash <runner> …`, sending SIGTERM
  at 300 s and SIGKILL 10 s later. A timeout is reported as FAIL.
- **Inter-script gap:** 2 seconds after `pkill -x` before starting the
  next runner, to let Electron helper processes exit.
- **Per-runner scratch location:** each runner writes its Electron
  `ONWARD_USER_DATA_DIR` under `mktemp -d`. No run touches the real
  user-data directory. (See the
  "Automated-test scratch locations and cleanup" rule in `CLAUDE.md`.)
- **Consent dialog suppression:** `ONWARD_AUTOTEST=1` now implies the
  renderer reports "consent = declined" when nothing is stored. No
  explicit `ONWARD_AUTOTEST_SKIP_CONSENT=1` is required, although
  runners may set it for clarity.

## 4. Build and static checks

```bash
rm -rf out release && ONWARD_DIST_DEV_OPEN=0 pnpm dist:dev
```

`pnpm dist:dev` runs, in order:

- `node scripts/check-chinese-comments.js`
- `node scripts/compile-changelog.js`
- `pnpm typecheck`
- `pnpm generate-notices`
- `electron-vite build`
- `electron-builder --dir`

Static check only:

```bash
pnpm typecheck
```

## 5. Startup smoke test

```bash
APP_NAME="Under Development 2.0.1-master"
APP_PATH="/Users/yingyun/Projects/Onward-Github/release/mac-arm64/Under Development 2.0.1-master.app"

pgrep -lx "$APP_NAME" || true
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 0.5
open "$APP_PATH"
sleep 4
pgrep -lx "$APP_NAME"
pkill -x "$APP_NAME" 2>/dev/null || true
```

Expected: `pgrep` prints one main-process line, the packaged app reached
the main UI, no crash dialog.

## 6. Feature inventory & runner mapping

Grouped by functional domain. One row per runner. "Key features covered"
is a short list of user-observable contracts the runner asserts on.

### 6.1 Project Editor core

| Runner | Key features covered |
|---|---|
| `run-project-editor-restore-autotest.sh` | File tree, open file, Monaco editor wiring, per-tab scope, session restore of open file + cursor |
| `run-project-editor-restore-unit-autotest.sh` | Pure unit coverage of `projectEditorRestoreUtils` key helpers |
| `run-project-editor-file-memory-autotest.sh` | Per-file scroll + cursor + preview-scroll-anchor memory, pagehide flush, outline-scroll memory restore on file switch / editor reopen |
| `run-project-editor-markdown-navigation-autotest.sh` | Markdown outline / heading navigation, outline scroll restore on toggle and reopen |
| `run-project-editor-markdown-session-restore-autotest.sh` | Markdown preview scroll anchor + heading restore across session restart |
| `run-project-editor-multi-terminal-scope-autotest.sh` | Independent Project Editor state per terminal scope |
| `run-project-editor-open-position-autotest.sh` | Initial cursor + scroll position when re-opening a file from restored state |
| `run-project-editor-sqlite-autotest.sh` | SQLite viewer: table list, row pagination, edit/save/delete/insert, SQL console |
| `run-markdown-latex-preview-autotest.sh` | KaTeX math rendering inline + block, preview pane activation |
| `run-mermaid-panzoom-autotest.sh` | Mermaid rendering across 6 fixtures, pan/zoom toolbar actions, fullscreen toggle |
| `run-preview-search-autotest.sh` | Markdown preview in-document search: match count, ordering, centering, forward/back navigation, wrap-around |
| `run-global-search-autotest.sh` | Ripgrep-backed cross-file search, result grouping by file+line, jump-to-match opens the file |

### 6.2 Git integration

| Runner | Key features covered |
|---|---|
| `run-git-cross-platform-autotest.sh` | IPC contract for `getDiff` / `getHistory`, path normalization, split-view ratio set + persist + restore |
| `run-git-diff-subdir-autotest.sh` | Diff works when cwd is inside a repo subdirectory |
| `run-git-diff-submodules-autotest.sh` | Regular (non-recursive) submodule discovery, outline-before-full-load |
| `run-git-diff-recursive-submodules-autotest.sh` | Recursive (≥ 2-level) submodule discovery and nested loading status |
| `run-git-nested-submodules-autotest.sh` | History + Diff file filtering across deeply nested submodules |
| `run-git-history-multi-terminal-scope-autotest.sh` | History view scoping to each terminal's repo |
| `run-image-diff-autotest.sh` | Image diff in Diff, History, and ProjectEditor: swipe / onion / SVG text mode |
| `run-pdf-epub-diff-autotest.sh` | Git compare view for PDF and EPUB files (side-by-side, chapter-level diff) |

### 6.3 Binary readers

| Runner | Key features covered |
|---|---|
| `run-pdf-epub-preview-autotest.sh` | PDF viewer: file-url correctness, ready postMessage, switch + reopen clears state; EPUB viewer: TOC, chapter render, outline panel, font-size bump + location preservation, search, outlined PDF + outline panel integration, per-file view-state memory |
| `run-pdf-epub-full-autotest.sh` | Above plus Git compare suites in one session |

### 6.4 Terminal & Prompt

| Runner | Key features covered |
|---|---|
| `run-terminal-autofollow-autotest.sh` | Terminal cwd change propagates to Project Editor cwd when autofollow is enabled |
| `run-terminal-focus-activation-autotest.sh` | Focus activation across grid cells (pointer + keyboard), visible selection indicator |
| `run-terminal-perf-autotest.sh` | PTY output throughput + IPC batching under single-terminal load |
| `run-terminal-stress-autotest.sh` | Multi-terminal grid under concurrent heavy output, hidden-terminal optimization |
| `run-terminal-architecture-baseline-autotest.sh` *(new)* | Captures renderer scheduler + Prompt-input-priority baseline per docs/Off-Renderer Threaded Design — Electron Refactor.md |
| `run-prompt-input-latency-autotest.sh` *(new)* | Prompt input keystroke latency (p50 / p95 / p99) under concurrent terminal load |
| `run-prompt-input-longtail-autotest.sh` *(new)* | Long-tail input latency detection across extended typing + multi-terminal output |
| `run-prompt-integrity-autotest.sh` | Multi-line send + OSC marker + hex-identical payload |
| `run-prompt-list-autotest.sh` | Prompt cards grid, edit mode, save-as-new button label contract |
| `run-prompt-sender-autotest.sh` | Terminal selection grid, send vs. send-and-execute dispatch |
| `run-schedule-autotest.sh` | Schedule create / pause / resume / delete lifecycle against stored state |

### 6.5 Subpage navigation & platform

| Runner | Key features covered |
|---|---|
| `run-subpage-navigation-autotest.sh` | Editor / Diff / History switch, shared shell reuse, deleted-file handling on return-to-editor |
| `run-subpage-viewstate-restore-autotest.sh` | Editor view-state (cursor + first-visible-line) survives round-trip through Diff |
| `run-working-directory-copy-autotest.sh` *(new)* | Subpage shell cwd label → clipboard, copy-feedback toast |
| `run-settings-update-autotest.sh` | Settings panel UI, font / theme preview, update controls mock |
| `run-telemetry-autotest.sh` | Telemetry event / heartbeat logging, consent gating, daily aggregation |
| `run-feedback-autotest.sh` | Feedback modal open / close, submit to GitHub draft URL |
| `run-feedback-persistence-autotest.sh` | Consent toggle + submitted records persist across restart |
| `run-change-log-autotest.sh` | Change Log modal open, markdown + mermaid content render, close paths |

### 6.6 File index & watching

| Runner | Key features covered |
|---|---|
| `run-file-index-cache-ui-autotest.sh` | Quick-open filename search, index reuse on create / delete / rename |
| `run-file-watch-autotest.sh` | External file change auto-refresh in editor + tree |

### 6.7 Trace infrastructure (v0.3)

| Runner | Key features covered |
|---|---|
| `run-trace-infra-self-check-autotest.sh` | T02 baseline. Launches app with `ONWARD_PERF_TRACE=1` for ~6 s, asserts `traces/perf/*.json` is produced, is valid Chrome trace JSON, and carries at least one `main:*` event. Optionally parse-verifies via `trace_processor_shell` when locally installed. |

**Per-operation trace coverage** — wired in the v0.3.x trace-expansion
pass. Every Onward-initiated operation, child process, and renderer
hot path is expected to emit at least one event from the families
below. Absence in a fresh trace is a regression:

| Family | Events | Call site |
|---|---|---|
| App lifecycle | `main:app.before-quit`, `main:app.will-quit`, `main:renderer-process-gone`, `main:renderer-unresponsive` | `electron/main/index.ts` app/webContents handlers |
| PTY subprocess | `main:pty.spawn`, `main:pty.exit`, `main:pty.kill` | `electron/main/pty-manager.ts` |
| Git CLI exec | `main:git.exec` (one slice per `execFile(git ...)`, tagged with `subcommand`) | `electron/main/git-utils.ts` shared `execFileAsync` wrapper, routed by `classifyExecBinary` so only real git calls qualify |
| Non-git proc exec | `main:proc.exec` (lsof cwd probes, future helpers) | Same wrapper, non-git branch — tagged with `binary` |
| Ripgrep subprocess | `worker.ripgrep:process.spawn`, `worker.ripgrep:process.exit` | `electron/main/ripgrep-search-worker-entry.ts` (forwarded via `parentPort`) |
| Updater spawns | `main:updater.spawn` (tagged `wmi` / `batch` / `detached-spawn` / `macos-sh`) | `electron/main/update-service.ts` |
| Markdown pipeline | `worker.markdown:render-complete`, `renderer:markdown.dompurify-sanitize`, `renderer:markdown.render` | `src/components/ProjectEditor/ProjectEditor.tsx` + `src/workers/markdownPreviewWorker.ts` |
| IPC bridge latency | `renderer:ipc.project.read-file`, `renderer:ipc.git.get-diff`, `renderer:ipc.terminal.write` | `electron/preload/index.ts` `traceIpc()` wrapper |
| Window events | `renderer:window.visibility-change`, `renderer:window.focus`, `renderer:window.blur`, `renderer:window.pagehide` | `src/utils/perf-trace.ts` `installWindowEventTrace()` |
| Monaco / xterm init | `renderer:monaco.viewstate-restore`, `renderer:xterm.webgl-context-init` | ProjectEditor Monaco handler + `src/components/Terminal/Terminal.tsx` |
| **PTY data flow (end-to-end)** | `main:terminal-data.ipc-send`, `renderer:terminal-data.ipc-recv`, `renderer:terminal-data.fast-path`, `renderer:terminal-data.scheduler-enqueue`, `renderer:terminal-data.scheduler-flush`, `renderer:terminal-data.xterm-write`, `main:pty.write` | All Task-scoped — land on per-Task tid rows (`task-<shortId>` on main, `-rnd` suffix on renderer). Absence of any hop in a trace that otherwise shows `main:pty.spawn` is a regression. |
| User-input hot paths | `renderer:prompt.editor.submit/cancel`, `renderer:prompt.sender.dispatch`, `renderer:terminal.focus-change`, `renderer:terminal.send-input`, `renderer:project.file-open`, `renderer:project.subpage-navigate`, `renderer:project.search.global` | Previously registered-but-unwired; now fire on their respective user gestures. `focus-change` / `send-input` / `split-add` are Task-scoped. |
| GUI entries | `renderer:tab.create`, `renderer:tab.switch`, `renderer:terminal.split-add`, `renderer:gitdiff.open`, `renderer:githistory.open`, `renderer:settings.open`, `renderer:changelog.open` | TabBar + App.tsx. |
| Background ops | `main:file-index.build/update`, `main:project-tree-watch.event/batch` | Project FS worker build and tree-watch coalesce. |

**Total canonical runners in v0.3: 44** (+1 skipped on macOS →
`run-auto-update-windows-e2e.sh`, covered in §12).

## 7. Full macOS regression command

```bash
APP_NAME="Under Development 2.0.1-master"
APP_BIN="/Users/yingyun/Projects/Onward-Github/release/mac-arm64/Under Development 2.0.1-master.app/Contents/MacOS/Under Development 2.0.1-master"
FULL_LOG="/tmp/onward-full-regression-$(date +%Y%m%d%H%M%S).log"

# Shared fixture for the git-diff-submodules autotest. Other runners build
# their own fixtures.
RSM_JSON="$(node test/create-recursive-git-submodule-fixture.mjs)"
DSM_REPO="$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.repoRoot)' "$RSM_JSON")"

FAILED=0
PASSED=0
SKIPPED=0
FAILED_LIST=()

SCRIPTS=(
  test/run-change-log-autotest.sh
  test/run-feedback-autotest.sh
  test/run-feedback-persistence-autotest.sh
  test/run-file-index-cache-ui-autotest.sh
  test/run-file-watch-autotest.sh
  test/run-git-cross-platform-autotest.sh
  test/run-git-diff-recursive-submodules-autotest.sh
  test/run-git-diff-subdir-autotest.sh
  test/run-git-diff-submodules-autotest.sh
  test/run-git-history-multi-terminal-scope-autotest.sh
  test/run-git-nested-submodules-autotest.sh
  test/run-global-search-autotest.sh
  test/run-image-diff-autotest.sh
  test/run-markdown-latex-preview-autotest.sh
  test/run-mermaid-panzoom-autotest.sh
  test/run-pdf-epub-diff-autotest.sh
  test/run-pdf-epub-full-autotest.sh
  test/run-pdf-epub-preview-autotest.sh
  test/run-preview-search-autotest.sh
  test/run-project-editor-file-memory-autotest.sh
  test/run-project-editor-markdown-navigation-autotest.sh
  test/run-project-editor-markdown-session-restore-autotest.sh
  test/run-project-editor-multi-terminal-scope-autotest.sh
  test/run-project-editor-open-position-autotest.sh
  test/run-project-editor-restore-autotest.sh
  test/run-project-editor-restore-unit-autotest.sh
  test/run-project-editor-sqlite-autotest.sh
  test/run-prompt-input-latency-autotest.sh
  test/run-prompt-input-longtail-autotest.sh
  test/run-prompt-integrity-autotest.sh
  test/run-prompt-list-autotest.sh
  test/run-prompt-sender-autotest.sh
  test/run-schedule-autotest.sh
  test/run-settings-update-autotest.sh
  test/run-subpage-navigation-autotest.sh
  test/run-subpage-viewstate-restore-autotest.sh
  test/run-telemetry-autotest.sh
  test/run-terminal-architecture-baseline-autotest.sh
  test/run-terminal-autofollow-autotest.sh
  test/run-terminal-focus-activation-autotest.sh
  test/run-terminal-perf-autotest.sh
  test/run-terminal-stress-autotest.sh
  test/run-trace-infra-self-check-autotest.sh
  test/run-working-directory-copy-autotest.sh
)

printf 'Full regression log: %s\n' "$FULL_LOG" | tee -a "$FULL_LOG"
printf 'Using app: %s\n' "$APP_BIN" | tee -a "$FULL_LOG"
printf 'Using git-diff-submodules fixture: %s\n' "$DSM_REPO" | tee -a "$FULL_LOG"
printf 'SKIP test/run-auto-update-windows-e2e.sh (Windows-only)\n' | tee -a "$FULL_LOG"
SKIPPED=$((SKIPPED + 1))

for script in "${SCRIPTS[@]}"; do
  printf '\n=== RUN %s ===\n' "$script" | tee -a "$FULL_LOG"
  pkill -x "$APP_NAME" 2>/dev/null || true
  sleep 2

  USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-regression-userdata.XXXXXX")"
  SCRIPT_START=$(date +%s)

  if [[ "$script" == "test/run-git-diff-submodules-autotest.sh" ]]; then
    ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
      node test/run-with-timeout.mjs 300 \
        bash "$script" "$APP_BIN" "/tmp/onward-git-diff-submodules-autotest.log" "$DSM_REPO" 2>&1 | tee -a "$FULL_LOG"
    RC=${PIPESTATUS[0]}
  else
    ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
      node test/run-with-timeout.mjs 300 \
        bash "$script" "$APP_BIN" 2>&1 | tee -a "$FULL_LOG"
    RC=${PIPESTATUS[0]}
  fi
  SCRIPT_ELAPSED=$(( $(date +%s) - SCRIPT_START ))

  if [[ "$RC" == "0" ]]; then
    printf 'PASS %s (%ds)\n' "$script" "$SCRIPT_ELAPSED" | tee -a "$FULL_LOG"
    PASSED=$((PASSED + 1))
  elif [[ "$RC" == "124" || "$RC" == "137" ]]; then
    printf 'FAIL %s (timeout after %ds)\n' "$script" "$SCRIPT_ELAPSED" | tee -a "$FULL_LOG"
    FAILED=$((FAILED + 1))
    FAILED_LIST+=("$script (TIMEOUT)")
    pkill -x "$APP_NAME" 2>/dev/null || true
  else
    printf 'FAIL %s (exit=%s, %ds)\n' "$script" "$RC" "$SCRIPT_ELAPSED" | tee -a "$FULL_LOG"
    FAILED=$((FAILED + 1))
    FAILED_LIST+=("$script (exit=$RC)")
  fi

  pkill -x "$APP_NAME" 2>/dev/null || true
  sleep 2
done

printf '\n=== FULL REGRESSION SUMMARY ===\n' | tee -a "$FULL_LOG"
printf 'Passed: %d\nFailed: %d\nSkipped: %d\n' "$PASSED" "$FAILED" "$SKIPPED" | tee -a "$FULL_LOG"
if (( FAILED > 0 )); then
  printf 'Failed scripts:\n' | tee -a "$FULL_LOG"
  printf '  %s\n' "${FAILED_LIST[@]}" | tee -a "$FULL_LOG"
  exit 1
fi
```

`test/run-with-timeout.mjs` is a small Node wrapper (no `gtimeout`
dependency on macOS); it spawns the runner with `stdio: inherit`, sends
SIGTERM at the budget, upgrades to SIGKILL 10 s later, and exits with
124 on timeout. The source is checked into the repo — see Appendix A
for a pointer.

Baseline clean-run target for v0.3:

```text
Passed: 44
Failed: 0
Skipped: 1
```

## 8. Known failing tests (as of 2026-04-23)

These reflect the state on master after commits `7fd26ee` and `8a45088`.
Each row is classified so the next repair pass knows whether to touch
the test or the app.

| Test id | Script | Classification | Action |
|---|---|---|---|
| `PFM-42-outline-scroll-restored-on-switch` | `run-project-editor-file-memory-autotest.sh` | **App regression.** Outline scroll ref is clobbered by the post-mount scroll=0 event racing against `applyInitialScroll`. Triggered/exposed by `4e32ea5` (off-renderer refactor). | Keep test red. Fix app: debounce `onScrollCapture` during pending restore OR re-run restore when `outlineScrollTopRef` is populated after mount. |
| `PFM-47-outline-scroll-restored-after-reopen` | same | Same root cause. | Same. |
| `PMN-16-markdown-outline-restores-after-toggle` | `run-project-editor-markdown-navigation-autotest.sh` | Same class. | Same. |
| `PMN-43-outline-restores-after-project-editor-reopen` | same | Same class. | Same. |
| `SN-14-diff-deleted-file-does-not-override-editor` | `run-subpage-navigation-autotest.sh` | **App regression.** `handleOpenGitDiff` calls `resetActiveFileState()` which nulls `activeFilePath`; no restore on subpage-return because scope didn't change. | Keep test red. Fix app: on subpage-return, re-open last `activeFilePath` from persisted scope state, guarded so it does not clobber Diff's own captured view. |
| `SVR-06-editor-restored-from-diff` | `run-subpage-viewstate-restore-autotest.sh` | Same class as SN-14. | Same. |
| `SN-13-history-deleted-file-does-not-override-editor` | `run-subpage-navigation-autotest.sh` | **App regression (separate).** History panel cannot select a deleted file (`selectedDeletedHistoryFile=false`). Unrelated to activeFilePath. | Keep test red. Fix app: History file list should include files that appeared in any commit in range, not just files present in working tree. |
| `XP-09b-diff-split-ratio-applies` | `run-git-cross-platform-autotest.sh` | **App regression — trivial.** `dragDiffSplitRatio` debug helper at `GitDiffViewer.tsx:1141-1226` forgets to call `persistDiffSplitRatio` after a successful drag. | Keep test red. Fix app: one-line addition. |
| `RSM-03-nested-outline-visible-before-full-load` | `run-git-diff-recursive-submodules-autotest.sh` | **Product decision needed.** The test asserts an "optimistic UX" (outline visible while submodules still load). Current app gates the whole render on `files.length > 0`. | Decide: is optimistic outline a product requirement? If yes, keep test and fix render gate. If no, delete the test. |
| `DSM-03-outline-visible-before-full-load` | `run-git-diff-submodules-autotest.sh` | Same as RSM-03. | Same. |
| `PL-11-save-as-new-button-label` | `run-prompt-list-autotest.sh` | **Test design flaw / ambiguous.** Selector hits `[data-prompt-editing="true"]`; result is `buttonLabels: []`. Either the attribute isn't set to the literal `"true"` at query time (timing race), or the button moved. | Investigate: add a pre-check `waitFor` for `[data-prompt-editing="true"]`. If still empty, the feature changed — update selector or rewrite against the observable contract. |

## 9. Tests scheduled for removal

The Agent Team audit found the following harnesses have no runner AND
their coverage is either dead, stale, or subsumed by newer granular
tests. Action proposed; final removal waits for explicit user approval.

| Harness | Reason | Action |
|---|---|---|
| `src/autotest/test-regression.ts` (19 KB, 21 assertions) | Phase-5 monolithic regression predating the per-feature runners. Every assertion it makes is now made by a dedicated runner. | **Delete.** |
| `src/autotest/test-stress.ts` (6 KB, 7 assertions) | Phase-6 "rapid toggle" CPU stress. Superseded by `run-terminal-stress-autotest.sh`. | **Delete.** |
| `src/autotest/test-per-agent-font.ts` | Deprecated feature (per-agent font for Git Diff); never had a runner; no product owner for the feature. | **Delete.** |
| `src/autotest/test-preview-position-restore.ts` | Orphan harness, no runner, assertions overlap with `test-project-editor-markdown-session-restore`. | **Delete.** |
| `src/autotest/test-sidebar-autoscroll.ts` | Orphan harness, no runner. Behavior worth testing but the current file reads private refs on sidebar internals — violates §2 rule 1. | **Delete**, then **rewrite from scratch** against `OutlinePanel` DOM queries only (no debug API). |
| `src/autotest/test-terminal-state-persistence.ts` | Orphan, subsumed by `test-project-editor-restore` + `test-terminal-architecture-baseline`. | **Delete.** |
| `src/autotest/test-feedback.ts` | Superseded by `test-feedback-ui.ts` (which is invoked by `run-feedback-autotest.sh`). | **Delete.** |
| `src/autotest/test-prompt-cleanup.ts` | Orphan but functionally non-obsolete (prompt cleanup cascade). No runner means it never ran in full regression — unreliable. | Either **add a runner** or **delete**. |
| `src/autotest/test-quick-file-unit.ts` | Pure unit tests for `buildQuickFileLabels` / `normalizeQuickFilePaths`. Does NOT need an E2E runner. | **Keep.** Consider moving to a Jest-style harness if one is introduced. |

## 10. Coverage gaps (new tests needed)

These are features found in the code that have no test or only
incidental coverage. Ordered by user impact.

### High impact

- **Editor / preview split ratio drag + persist** (ProjectEditor).
  Code at `STORAGE_KEY_MARKDOWN_PREVIEW_RATIO` persists the ratio, but
  no test drives the drag or verifies restore.
- **PDF diff and EPUB diff rendering in Git Diff** (status = added /
  deleted / modified). Components exist (`GitPdfCompare`,
  `GitEpubCompare`) but the PDF / EPUB diff paths are not covered by
  `run-pdf-epub-diff-autotest.sh` assertions.
- **Deleted-file diff visual confirmation**: Diff's "file was deleted"
  state is rendered but not asserted.
- **History can select deleted files** (see SN-13 above): related
  coverage should add "select a file that was deleted in commit X, see
  its previous content".
- **Change Log auto-open on version bump**: tests only cover the modal
  opened by explicit user click.
- **Theme switching (light / dark) persistence**: Settings exposes the
  selector, nothing verifies storage or render.
- **Keyboard shortcut activation across the 20+ documented keybindings**:
  only the settings UI is tested.
- **Tab context menu (close other, rename)**: not covered.

### Medium impact

- **File create / delete / rename from context menu** (file tree ops).
- **Path copy actions** (usePathCopy) from both file tree and diff.
- **EPUB theme sync on OS dark / light toggle** while reading.
- **EPUB error handling** (corrupt / empty .epub).
- **SQLite blob column edit prevention + size hint**.
- **SQLite concurrent external write handling**.
- **File watcher under rapid change bursts** (current test does 3
  sequential writes).
- **Settings persistence across app restart** (current test only runs
  within one launch).
- **Update-service channel switching** (daily ↔ dev).
- **Auto-update download-progress UI rendering**.

### Low impact / nice-to-have

- Tray icon, Dock icon smoke tests.
- Prompt pinning drag-drop UX beyond API calls.
- Schedule actually firing on cron time (not just stored state).
- xterm addon integration (search, ligatures, links).

## 11. Trace infrastructure (v0.3)

Every autotest run that carries `ONWARD_PERF_TRACE=1` emits a Chrome
Trace Event Format file to `<repoRoot>/traces/perf/`. T02
(`run-trace-infra-self-check-autotest.sh`) validates the baseline
plumbing as part of the full pass.

- **Format**: Chrome Trace Event Format — `{"traceEvents":[…]}`.
  Consumed natively by Perfetto UI and `trace_processor_shell`. No
  JSONL, no converter, no protobufjs dep. See
  `infra/trace.md` § 4 for the exact per-event shape.
- **Output path**: `<repoRoot>/traces/perf/perf-trace-<ISO>-<pid>.json`
  plus a `latest.txt` pointer. Production builds fall back to
  `userData/debug/`; autotest runners always resolve the repo path
  via `ONWARD_REPO_ROOT`.
- **Event name registry**: `src/utils/perf-trace-names.ts`. Per
  `CLAUDE.md` Hard rule § 3, new events must be registered there
  before they are instrumented, and `infra/trace.md` § 2 must be
  updated.
- **Open a trace**:
  ```bash
  bash infra/scripts/open_trace.sh              # newest traces/perf/*.json
  bash infra/scripts/open_trace.sh <file.json>
  ```
  The script boots a local `trace_processor_shell --httpd` and opens
  a version-pinned `ui.perfetto.dev/v<ver>-<sha>/#!/?rpc_port=9001`.
  The trace never leaves localhost.
- **Test-log location**: every runner writes its stdout / stderr to
  `<repoRoot>/traces/test-logs/<suite>.log`. If a runner misbehaves
  the log is the first place to look; all logs are gitignored but
  trivially diff-friendly because they stay inside the checkout.

## 12. Focused rerun commands

When diagnosing a single failure, rerun that runner only:

```bash
APP_NAME="Under Development 2.0.1-master"
APP_BIN="/Users/yingyun/Projects/Onward-Github/release/mac-arm64/Under Development 2.0.1-master.app/Contents/MacOS/Under Development 2.0.1-master"
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 2
ONWARD_USER_DATA_DIR="$(mktemp -d)" \
  node test/run-with-timeout.mjs 300 \
  bash test/run-subpage-navigation-autotest.sh "$APP_BIN"
pkill -x "$APP_NAME" 2>/dev/null || true
```

For the git-diff multi-submodule runner, pass the fixture path as the
third arg:

```bash
RSM_JSON="$(node test/create-recursive-git-submodule-fixture.mjs)"
DSM_REPO="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.repoRoot)' "$RSM_JSON")"
ONWARD_USER_DATA_DIR="$(mktemp -d)" \
  node test/run-with-timeout.mjs 300 \
  bash test/run-git-diff-submodules-autotest.sh "$APP_BIN" /tmp/onward-git-diff-submodules-autotest.log "$DSM_REPO"
```

## 13. Windows-only follow-up

Run this separately on Windows:

```bash
bash test/run-auto-update-windows-e2e.sh
```

Validates Windows pending-update recovery and update restart behavior.
Intentionally excluded from the macOS full pass.

---

## Appendix A: Runner runtime wrapper

Fresh macOS installs do not ship `gtimeout`. The wrapper ships in the
repo at **`test/run-with-timeout.mjs`** (committed as part of the v0.3
cutover). The §7 command invokes it directly; no bootstrap needed on a
fresh clone.

Usage:
```bash
node test/run-with-timeout.mjs <seconds> <cmd> [args...]
```
Behaviour: spawns with `stdio: inherit`, SIGTERM at the budget, SIGKILL
10 s later, exits 124 on timeout, 127 on spawn error, otherwise the
child's exit code.
