<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# Full Regression Checklist

This checklist documents the full macOS regression pass used after fixing the subpage restore and typecheck gate work. Keep this file updated when the regression scope changes.

## Scope

Run this checklist after changes that affect:

- Project Editor launch, markdown preview, file memory, or session restore
- Git Diff, Git History, repo filtering, or submodule handling
- Editor / Diff / History subpage switching
- terminal focus, prompt sending, terminal performance, or terminal stress behavior
- packaging, release workflow, or TypeScript/static-check coverage
- shared Electron main/preload APIs touched by renderer code

## Prerequisites

- Run from the repository root.
- Use the development package unless a production build is explicitly required.
- On macOS, the dev package name is `Under Development <version>-<branch>`, for example `Under Development 2.0.1-master`.
- Always kill the app by exact process name before launching or before each test script. Do not use wildcard or substring process matching.
- This checklist documents the macOS regression pass. `test/run-auto-update-windows-e2e.sh` is Windows-only and must be run separately on Windows with PowerShell and Windows build tooling.

## Build And Static Checks

Use a clean development build. Keep `rm -rf out release` and `pnpm dist:dev` in the same command so stale packaged files cannot be reused.

```bash
rm -rf out release && ONWARD_DIST_DEV_OPEN=0 pnpm dist:dev
```

The development build runs these checks before packaging:

- `node scripts/check-chinese-comments.js`
- `node scripts/compile-changelog.js`
- `pnpm typecheck`
- `pnpm generate-notices`
- `electron-vite build`
- `electron-builder --dir`

If only the static check needs to be rerun:

```bash
pnpm typecheck
```

## Startup Smoke Test

After the build succeeds, launch the packaged app once and confirm the main process starts. Use exact name matching.

```bash
APP_NAME="Under Development 2.0.1-master"
APP_PATH="/Users/yingyun/Projects/Onward-Agent-Workbench/release/mac/Under Development 2.0.1-master.app"

pgrep -lx "$APP_NAME" || true
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 0.5
open "$APP_PATH"
sleep 4
pgrep -lx "$APP_NAME"
```

Expected result:

- `pgrep` prints one main app process.
- The packaged app reaches the main UI.

After the smoke test, close the app by exact process name:

```bash
pkill -x "Under Development 2.0.1-master" 2>/dev/null || true
```

## Logs And Temporary Files

Use one aggregate log for the whole run:

```bash
FULL_LOG="/tmp/onward-full-regression-$(date +%Y%m%d%H%M%S).log"
```

Most test scripts also write their own fixed log files under `/tmp`, for example:

- `/tmp/onward-change-log-autotest.log`
- `/tmp/onward-feedback-autotest.log`
- `/tmp/onward-feedback-persistence-seed.log`
- `/tmp/onward-feedback-persistence-verify.log`
- `/tmp/onward-file-index-cache-ui-autotest.log`
- `/tmp/onward-file-watch-autotest.log`
- `/tmp/onward-git-cross-platform-autotest.log`
- `/tmp/onward-git-diff-recursive-submodules-autotest.log`
- `/tmp/onward-git-diff-subdir-autotest.log`
- `/tmp/onward-git-diff-submodules-autotest.log`
- `/tmp/onward-git-history-multi-terminal-scope-autotest.log`
- `/tmp/onward-git-nested-submodules-autotest.log`
- `/tmp/onward-global-search-autotest.log`
- `/tmp/onward-image-diff-autotest.log`
- `/tmp/onward-markdown-latex-preview-autotest.log`
- `/tmp/onward-mermaid-panzoom-autotest.log`
- `/tmp/onward-pdf-epub-autotest.log`
- `/tmp/onward-pdf-epub-diff-autotest.log`
- `/tmp/onward-pdf-epub-full-autotest.log`
- `/tmp/onward-preview-search-autotest.log`
- `/tmp/onward-project-editor-file-memory-autotest.log`
- `/tmp/onward-project-editor-markdown-navigation-autotest.log`
- `/tmp/onward-project-editor-markdown-session-restore-autotest.log`
- `/tmp/onward-project-editor-multi-terminal-scope-autotest.log`
- `/tmp/onward-project-editor-open-position-autotest.log`
- `/tmp/onward-project-editor-restore-autotest.log`
- `/tmp/onward-project-editor-restore-unit-autotest.log`
- `/tmp/onward-project-editor-sqlite-autotest.log`
- `/tmp/onward-prompt-integrity-autotest.log`
- `/tmp/onward-prompt-list-autotest.log`
- `/tmp/onward-prompt-sender-autotest.log`
- `/tmp/onward-schedule-autotest.log`
- `/tmp/onward-settings-update-autotest.log`
- `/tmp/onward-subpage-navigation-autotest.log`
- `/tmp/onward-subpage-viewstate-restore-autotest.log`
- `/tmp/onward-telemetry-autotest.log`
- `/tmp/onward-terminal-autofollow-autotest.log`
- `/tmp/onward-terminal-focus-activation-autotest-*.log`
- `/tmp/onward-terminal-perf-autotest.log`
- `/tmp/onward-terminal-stress-autotest.log`

The scripts create temporary working directories. These are expected:

- Per-script user-data directories under `${TMPDIR:-/tmp}/onward-regression-userdata.*`
- Feedback user-data directories under `${TMPDIR:-/tmp}/onward-feedback-*`
- PDF/EPUB user-data directories under `${TMPDIR:-/tmp}/onward-pdf-epub-*`
- Git recursive submodule fixtures under `${TMPDIR:-/tmp}/onward-git-recursive-submodules-*`
- Subpage navigation fixtures under `/Users/yingyun/Projects/onward-autotest-subpage-navigation-*` when run from the same local environment
- Committed reusable fixtures under `test/fixtures/**`

## Full macOS Regression Command

This command reproduces the full macOS pass. It runs every shell regression script except the Windows-only auto-update E2E script, and it supplies the required explicit fixture argument for `test/run-git-diff-submodules-autotest.sh`.

```bash
APP_NAME="Under Development 2.0.1-master"
APP_BIN="/Users/yingyun/Projects/Onward-Agent-Workbench/release/mac/Under Development 2.0.1-master.app/Contents/MacOS/Under Development 2.0.1-master"
FULL_LOG="/tmp/onward-full-regression-$(date +%Y%m%d%H%M%S).log"

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
  test/run-prompt-integrity-autotest.sh
  test/run-prompt-list-autotest.sh
  test/run-prompt-sender-autotest.sh
  test/run-schedule-autotest.sh
  test/run-settings-update-autotest.sh
  test/run-subpage-navigation-autotest.sh
  test/run-subpage-viewstate-restore-autotest.sh
  test/run-telemetry-autotest.sh
  test/run-terminal-autofollow-autotest.sh
  test/run-terminal-focus-activation-autotest.sh
  test/run-terminal-perf-autotest.sh
  test/run-terminal-stress-autotest.sh
)

printf 'Full regression log: %s\n' "$FULL_LOG" | tee -a "$FULL_LOG"
printf 'Using app: %s\n' "$APP_BIN" | tee -a "$FULL_LOG"
printf 'Using git-diff-submodules fixture: %s\n' "$DSM_REPO" | tee -a "$FULL_LOG"
printf 'SKIP test/run-auto-update-windows-e2e.sh (Windows-only)\n' | tee -a "$FULL_LOG"
SKIPPED=$((SKIPPED + 1))

for script in "${SCRIPTS[@]}"; do
  printf '\n=== RUN %s ===\n' "$script" | tee -a "$FULL_LOG"
  pkill -x "$APP_NAME" 2>/dev/null || true
  sleep 0.5

  USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-regression-userdata.XXXXXX")"

  if [[ "$script" == "test/run-git-diff-submodules-autotest.sh" ]]; then
    if ONWARD_USER_DATA_DIR="$USER_DATA_DIR" bash "$script" "$APP_BIN" "/tmp/onward-git-diff-submodules-autotest.log" "$DSM_REPO" 2>&1 | tee -a "$FULL_LOG"; then
      printf 'PASS %s\n' "$script" | tee -a "$FULL_LOG"
      PASSED=$((PASSED + 1))
    else
      printf 'FAIL %s\n' "$script" | tee -a "$FULL_LOG"
      FAILED=$((FAILED + 1))
      FAILED_LIST+=("$script")
    fi
  else
    if ONWARD_USER_DATA_DIR="$USER_DATA_DIR" bash "$script" "$APP_BIN" 2>&1 | tee -a "$FULL_LOG"; then
      printf 'PASS %s\n' "$script" | tee -a "$FULL_LOG"
      PASSED=$((PASSED + 1))
    else
      printf 'FAIL %s\n' "$script" | tee -a "$FULL_LOG"
      FAILED=$((FAILED + 1))
      FAILED_LIST+=("$script")
    fi
  fi

  pkill -x "$APP_NAME" 2>/dev/null || true
  sleep 0.5
done

printf '\n=== FULL REGRESSION SUMMARY ===\n' | tee -a "$FULL_LOG"
printf 'Passed: %d\nFailed: %d\nSkipped: %d\n' "$PASSED" "$FAILED" "$SKIPPED" | tee -a "$FULL_LOG"

if (( FAILED > 0 )); then
  printf 'Failed scripts:\n' | tee -a "$FULL_LOG"
  printf '  %s\n' "${FAILED_LIST[@]}" | tee -a "$FULL_LOG"
  exit 1
fi
```

Expected summary for the macOS pass:

```text
Passed: 39
Failed: 0
Skipped: 1
```

## Test Content By Area

The full pass covers these areas:

- Static/package gate: `pnpm typecheck` through `pnpm dist:dev`
- Startup smoke: packaged app launch to the main UI
- Change Log generation and UI
- Feedback UI and feedback persistence
- File index cache UI and file watch behavior
- Git cross-platform IPC behavior
- Git Diff subdirectory handling
- Git Diff submodule and recursive submodule handling
- Git History multi-terminal scope
- Nested Git submodule History/Diff filtering
- Global Search
- Image Diff in Diff, History, and Project Editor
- Markdown LaTeX preview
- Mermaid pan/zoom
- PDF/EPUB preview, Diff, and History
- Performance trace export and default content redaction
- Preview Search ordering and active match centering
- Project Editor file memory
- Project Editor markdown navigation
- Project Editor markdown session restore
- Project Editor multi-terminal isolation
- Project Editor open-position restore
- Project Editor restore unit and integration coverage
- Project Editor SQLite viewer
- Prompt Integrity
- Prompt List
- Prompt Sender
- Schedule lifecycle behavior
- Settings update UI
- Subpage navigation across Editor, Diff, and History
- Subpage editor view-state restore
- Telemetry
- Terminal autofollow
- Terminal focus activation
- Terminal performance
- Terminal stress

## Focused Rerun Commands

When diagnosing failures, rerun only the affected area first:

```bash
APP_NAME="Under Development 2.0.1-master"
APP_BIN="/Users/yingyun/Projects/Onward-Agent-Workbench/release/mac/Under Development 2.0.1-master.app/Contents/MacOS/Under Development 2.0.1-master"

pkill -x "$APP_NAME" 2>/dev/null || true
sleep 0.5
bash test/run-subpage-navigation-autotest.sh "$APP_BIN"
pkill -x "$APP_NAME" 2>/dev/null || true
```

Use the same pattern for:

- `test/run-subpage-viewstate-restore-autotest.sh`
- `test/run-git-diff-subdir-autotest.sh`
- `test/run-preview-search-autotest.sh`
- `test/run-performance-trace-autotest.sh`
- `test/run-project-editor-markdown-session-restore-autotest.sh`
- `test/run-prompt-integrity-autotest.sh`
- `test/run-prompt-sender-autotest.sh`

For Git Diff multi-submodule focused reruns:

```bash
APP_NAME="Under Development 2.0.1-master"
APP_BIN="/Users/yingyun/Projects/Onward-Agent-Workbench/release/mac/Under Development 2.0.1-master.app/Contents/MacOS/Under Development 2.0.1-master"
RSM_JSON="$(node test/create-recursive-git-submodule-fixture.mjs)"
DSM_REPO="$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.repoRoot)' "$RSM_JSON")"

pkill -x "$APP_NAME" 2>/dev/null || true
sleep 0.5
bash test/run-git-diff-submodules-autotest.sh "$APP_BIN" "/tmp/onward-git-diff-submodules-autotest.log" "$DSM_REPO"
pkill -x "$APP_NAME" 2>/dev/null || true
```

## Windows-Only Follow-Up

Run this separately on Windows:

```bash
bash test/run-auto-update-windows-e2e.sh
```

This script validates Windows pending-update recovery and update restart behavior. It is intentionally excluded from the macOS full pass.
