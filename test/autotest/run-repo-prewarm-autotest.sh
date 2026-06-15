#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Repo prewarm-on-cwd-switch WIRING autotest (prewarm-cache decisions ⑥/⑦).
#
# Proves the end-to-end wiring of the prewarm coordinator:
#   TerminalGitInfoBridge.attachMirror → RepoPrewarmCoordinator.prewarm →
#   `main:git.prewarm.repo-triggered` perf-trace event.
#
# Why a SEPARATE, lean runner (not folded into run-git-diff-click-latency):
#   The click-latency suite gates on a COLD first `getDiff` settling within an
#   8s budget — which is impossible to meet, and irrelevant to wiring, when the
#   host's EDR/anti-malware minifilter taxes every `git.exe` spawn at multiple
#   SECONDS (a single `git rev-parse` was measured at 3-7s on the target host).
#   This runner instead asserts that the prewarm coordinator FIRED on a real
#   terminal attach — an event emitted the instant the bridge resolves a cwd,
#   BEFORE any git spawn — so it verifies the wiring independent of how slow the
#   machine's git is. The pure prewarm logic (dedup, lanes, key builders,
#   commit selection) is locked separately by the unit suite
#   (test/unittest/git-repo-prewarm.test.mts et al.).
#
# Output: <repoRoot>/traces/test-logs/repo-prewarm-autotest.log

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$REPO_ROOT"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/repo-prewarm-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
# Dwell long enough for app start + terminal attach + the prewarm trigger event
# to land in the trace, then the watchdog kills the app. The event fires on
# attach (no git wait), so this need not scale with the host's git slowness.
# Long enough for: app start + terminal attach + the mirror computing branchOid
# + the History prewarm firing its SINGLE `git log --raw --numstat` batch (A2).
# On EDR-throttled hosts each git op is multiple seconds, so be generous — the
# assertions are spawn-COUNT / event-PRESENCE (EDR-independent), only reaching
# them needs the chain to complete.
DWELL_SEC="${REPO_PREWARM_DWELL_SEC:-40}"
PREWARM_EVENT="main:git.prewarm.repo-triggered"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-prewarm-userdata.XXXXXX")"

cleanup() {
  find "$REPO_ROOT" -maxdepth 1 -name "__autotest_*" -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

echo "Starting repo prewarm wiring autotest..."
echo "  Binary:        $APP_BIN"
echo "  Repo (cwd):    $REPO_ROOT"
echo "  User data dir: $USER_DATA_DIR"
echo "  Dwell:         ${DWELL_SEC}s (watchdog-killed; expected)"
echo "  Event:         $PREWARM_EVENT"
echo "  Log:           $LOG_FILE"
echo ""

# Launch the app in autotest mode with perf tracing. No suite + no
# ONWARD_AUTOTEST_EXIT: the app just runs, its default terminal attaches to the
# repo root (a git repo) → the bridge fires the prewarm coordinator → the
# trigger event is written to the trace. The watchdog kills it after the dwell;
# exit code 124 (timeout) is the EXPECTED outcome for this runner.
APP_EXIT=0
ONWARD_DEBUG=1 \
ONWARD_PERF_TRACE=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE="repo-prewarm-wiring" \
node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$DWELL_SEC" "$APP_BIN" > "$LOG_FILE" 2>&1 || APP_EXIT=$?

echo "App exit code: $APP_EXIT (124 = watchdog dwell elapsed, expected)"
echo ""
echo "=== Test log (last 40 lines) ==="
tail -n 40 "$LOG_FILE"
echo ""

# A non-timeout, non-zero exit BEFORE the dwell elapsed means the app crashed on
# startup — a hard failure regardless of the trace.
if [[ "$APP_EXIT" -ne 0 && "$APP_EXIT" -ne 124 ]]; then
  echo "Repo prewarm autotest: app exited abnormally with code $APP_EXIT (not the watchdog)" >&2
  exit "$APP_EXIT"
fi

# Locate the newest perf trace chunk (ndjson-chunked perf-*.jsonl; older *.json fallback).
TRACE_DIR="$REPO_ROOT/traces/perf"
LATEST_POINTER="$TRACE_DIR/latest.txt"
LATEST_TRACE_PATH=""
if [[ -f "$LATEST_POINTER" ]]; then
  LATEST_TRACE_PATH="$(cat "$LATEST_POINTER")"
fi
if [[ -z "$LATEST_TRACE_PATH" || ! -f "$LATEST_TRACE_PATH" ]]; then
  LATEST_TRACE_PATH="$(ls -t "$TRACE_DIR"/perf-*.jsonl "$TRACE_DIR"/*.json 2>/dev/null | head -n 1 || true)"
fi

if [[ -z "$LATEST_TRACE_PATH" || ! -f "$LATEST_TRACE_PATH" ]]; then
  echo "ERROR: cannot locate perf trace file under $TRACE_DIR" >&2
  exit 1
fi

echo "Trace file: $LATEST_TRACE_PATH"

# Combined assertion (shared helper; see check-prewarm-aggregation.mjs):
#   (P3 wiring)  main:git.prewarm.repo-triggered — coordinator fired on attach.
#   (A2 aggreg.) main:git.prewarm.history-done with commitsWarmed > 0 — the
#               History prewarm warmed N commit-diffs in ONE `git log --raw
#               --numstat` spawn (not the old N×2 per-commit `git diff` spawns).
# All signals are event-PRESENCE / COUNT — EDR-independent.
node "$REPO_ROOT/test/autotest/check-prewarm-aggregation.mjs" "$LATEST_TRACE_PATH"
NODE_RC=$?

if [[ "$NODE_RC" -eq 0 ]]; then
  echo "Repo prewarm + git-op-aggregation autotest PASS"
  echo "  ✓ P3 wiring: coordinator fired on a real terminal attach (repo-triggered)"
  echo "  ✓ A1+A2 aggregation code launched cleanly (no crash); A2 history-batch end-to-end status in the SIGNALS JSON above (unit-pinned regardless)"
  exit 0
fi

echo "ERROR: prewarm / aggregation regression — required signals missing (see JSON above)" >&2
echo "  Expected: repo-triggered + history-done(commitsWarmed>0) + the single 'git log --raw --numstat' batch spawn." >&2
echo "  trace file: $LATEST_TRACE_PATH" >&2
exit 1
