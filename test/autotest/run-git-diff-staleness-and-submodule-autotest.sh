#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$REPO_ROOT"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/git-diff-staleness-and-submodule-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
WATCHDOG_SEC="${GDS_WATCHDOG_SEC:-180}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Per the CLAUDE.md "Test fixture isolation" hard rule, every runner
# must point ONWARD_USER_DATA_DIR at a fresh mktemp dir so persisted state
# (active subpage, terminal cwds, ProjectEditor scope state, etc.) from a
# previous run can't leak in and turn unrelated PRs into "test broke things"
# investigations.
# ---------------------------------------------------------------------------
USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-gds-userdata.XXXXXX")"

# ---------------------------------------------------------------------------
# Build the fixture under test/autotest/fixtures/git-diff-staleness-and-submodule/runtime/
# (wipe-and-recreate semantics — see the fixture builder header). The runtime
# dir is gitignored and regenerated on every run, so we don't add it to the
# cleanup trap; only the per-run user-data scratch dir gets removed below.
# ---------------------------------------------------------------------------
FIXTURE_JSON="$(node "$REPO_ROOT/test/autotest/create-git-diff-staleness-fixture.mjs")"
TEMP_ROOT="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).tempRoot)' "$FIXTURE_JSON")"
CLEAN_ROOT="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).cleanRoot)' "$FIXTURE_JSON")"
MANIFEST_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).manifestPath)' "$FIXTURE_JSON")"

cleanup() {
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

echo "Starting Git Diff staleness + submodule filter autotest..."
echo "  Binary:        $APP_BIN"
echo "  Clean repo:    $CLEAN_ROOT"
echo "  Manifest:      $MANIFEST_PATH"
echo "  User data dir: $USER_DATA_DIR"
echo "  Watchdog:      ${WATCHDOG_SEC}s"
echo "  Log:           $LOG_FILE"
echo ""

APP_EXIT=0
ONWARD_DEBUG=1 \
ONWARD_PERF_TRACE=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=git-diff-staleness-and-submodule \
ONWARD_AUTOTEST_CWD="$CLEAN_ROOT" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$WATCHDOG_SEC" "$APP_BIN" > "$LOG_FILE" 2>&1 || APP_EXIT=$?

echo ""
echo "=== Test log (last 80 lines) ==="
tail -n 80 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Git Diff staleness autotest failed" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if [[ "$APP_EXIT" -ne 0 ]]; then
  echo "Git Diff staleness autotest exited with code $APP_EXIT" >&2
  exit "$APP_EXIT"
fi

if ! grep -q "GDS-12-trace-marker-watcher-and-freshness-expected" "$LOG_FILE"; then
  echo "Missing GDS-12 marker; the test may not have executed correctly" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "GDS-16-trace-marker-snapshot-service-expected" "$LOG_FILE"; then
  echo "Missing GDS-16 marker; the snapshot service migration test did not run" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "GDS-26-trace-marker-diff-file-load-expected" "$LOG_FILE"; then
  echo "Missing GDS-26 marker; the diff file-load trace test did not run" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "GDS-30-trace-marker-diff-ux-actions-expected" "$LOG_FILE"; then
  echo "Missing GDS-30 marker; the diff UX action trace test did not run" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "GDS-34-trace-marker-diff-body-prefetch-expected" "$LOG_FILE"; then
  echo "Missing GDS-34 marker; the diff body prefetch trace test did not run" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "GDS-42-trace-marker-diff-tree-editor-jumps-expected" "$LOG_FILE"; then
  echo "Missing GDS-42 marker; the diff tree/editor jump trace test did not run" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# GDS-11/12: post-mortem trace inspection. Verify the new trace events
# actually fired during the test session.
# ---------------------------------------------------------------------------
TRACE_LATEST_PATH="$REPO_ROOT/traces/perf/latest.txt"
if [[ ! -f "$TRACE_LATEST_PATH" ]]; then
  echo "GDS-11/12 FAIL: traces/perf/latest.txt missing" >&2
  exit 1
fi

TRACE_FILE="$(cat "$TRACE_LATEST_PATH")"
if [[ ! -f "$TRACE_FILE" ]]; then
  echo "GDS-11/12 FAIL: trace file pointed by latest.txt missing: $TRACE_FILE" >&2
  exit 1
fi

# Each Onward process writes its own trace file:
#   - main thread → <repoRoot>/traces/perf/  (pointed to by latest.txt)
#   - git-ipc worker thread → ${TMPDIR}/onward-traces-perf-worker/
# Some events fire only on one side (the worker emits submodule-filter when it
# parses git status; the main thread emits fs-watch-event when fs.watch
# debounces). We accept either trace as long as the event lands somewhere.
#
# We delegate matching to test/autotest/check-trace-event.mjs so the parser handles
# Chrome Trace JSON's `{"traceEvents":[...]}` wrapper and partial / truncated
# files correctly — `grep -F` would false-positive on payloads whose `args`
# field happens to embed the literal `"name":"X"` byte sequence.
WORKER_TRACE_DIR="${TMPDIR:-/tmp}/onward-traces-perf-worker"

expect_event() {
  local label="$1"
  local needle="$2"
  local match
  if match="$(node "$REPO_ROOT/test/autotest/check-trace-event.mjs" \
    --main "$TRACE_FILE" \
    --worker-dir "$WORKER_TRACE_DIR" \
    --name "$needle")"; then
    echo "PASS $label  ($needle in $match trace)"
    return 0
  fi
  echo "FAIL $label  (missing $needle in main or worker traces)" >&2
  exit 1
}

echo ""
echo "=== Trace event coverage (GDS-11/12/16/26/30/34/42) ==="
expect_event "GDS-11"  "main:git.diff.submodule-filter"
expect_event "GDS-12a" "main:git.diff.fs-watch-event"
expect_event "GDS-12b" "renderer:subpage.freshness-check"
# Snapshot service: capture is the meaningful "we routed through the
# service" signal. We deliberately do NOT assert cache-hit here — the
# request cache and snapshot cache are invalidated together by the
# watcher fan-out, so during a test session the cache-hit path requires
# a precise timing window (request cache TTL expired, watcher silent,
# snapshot still warm) that is not worth defending against test-runner
# flake. Cache health can still be inspected post-mortem in the trace.
expect_event "GDS-16"  "main:git.snapshot.capture"
expect_event "GDS-26a" "main:ipc.git.get-file-content"
expect_event "GDS-26b" "renderer:git-diff.file-load"
expect_event "GDS-30a" "renderer:git-diff.manual-refresh"
expect_event "GDS-30b" "renderer:git-diff.hunk-navigate"
expect_event "GDS-30c" "renderer:git-diff.hunk-action"
expect_event "GDS-34"  "renderer:git-diff.body-prefetch"
expect_event "GDS-42a" "renderer:git-diff.file-list-mode-change"
expect_event "GDS-42b" "renderer:git-diff.jump-to-editor"
expect_event "GDS-42c" "renderer:project-editor.jump-to-diff"

echo ""
echo "Git Diff staleness + submodule filter autotest passed"
echo "  Log:    $LOG_FILE"
echo "  Trace:  $TRACE_FILE"
