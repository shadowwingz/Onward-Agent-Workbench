#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# T02 — trace infrastructure self-check (required baseline test).
#
# Launches the packaged app with ONWARD_PERF_TRACE=1 for a short burst,
# then asserts that (a) a Chrome trace JSON landed under
# `<repoRoot>/traces/perf/`, (b) it is valid JSON with a non-empty
# `traceEvents` array, (c) it contains at least one `main:*` event
# (the `main:trace-start` metadata packet always fires so this is a
# reliable canary). If `trace_processor_shell` is already installed on
# the machine we additionally let it parse-verify the file — that's
# the authoritative Perfetto parser and is a stronger check.
#
# Usage:
#   bash test/autotest/run-trace-infra-self-check-autotest.sh <APP_BIN> [LOG_FILE]

set -uo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
APP_BIN="${1:?usage: $0 <APP_BIN> [LOG_FILE]}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/trace-infra-self-check-autotest.log}"
TRACE_DIR="$REPO_ROOT/traces/perf"
USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-tracechk.XXXXXX")"
TRACECHK_CWD="$USER_DATA_DIR/workspace"
mkdir -p "$(dirname "$LOG_FILE")" "$TRACE_DIR"
mkdir -p "$TRACECHK_CWD"

# Cleanup shield — even on SIGINT the user's mktemp scratch is removed.
cleanup() {
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Start with a clean perf directory so we can pick the newest file
# without ambiguity.
rm -f "$TRACE_DIR"/*.json "$TRACE_DIR"/latest.txt

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

APP_NAME="$(basename "$APP_BIN")"
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 0.5

ONWARD_AUTOTEST=1 \
  ONWARD_AUTOTEST_SKIP_CONSENT=1 \
  ONWARD_PERF_TRACE=1 \
  ONWARD_REPO_ROOT="$REPO_ROOT" \
  ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
  ONWARD_AUTOTEST_CWD="$TRACECHK_CWD" \
  "$APP_BIN" > "$LOG_FILE" 2>&1 &
APP_PID=$!

# Give the main process enough time to reach its first event-loop
# interval fire (250 ms) and settle — 6 seconds is plenty and keeps
# the total test under the 5-minute checklist cap with headroom.
sleep 6

# Graceful first, SIGKILL fallback.
kill -TERM "$APP_PID" 2>/dev/null || true
(sleep 3; kill -KILL "$APP_PID" 2>/dev/null || true) &
wait "$APP_PID" 2>/dev/null || true
pkill -x "$APP_NAME" 2>/dev/null || true

FAILED=0
newest="$(ls -t "$TRACE_DIR"/*.json 2>/dev/null | head -1 || true)"

if [[ -z "$newest" || ! -s "$newest" ]]; then
  echo "FAIL: no Chrome trace JSON produced in $TRACE_DIR" >&2
  echo "      last 40 lines of app output:" >&2
  tail -n 40 "$LOG_FILE" >&2 || true
  exit 1
fi

# Parse-validate. The main process may not have had a chance to write
# the closing `]}` (we sent SIGTERM); Perfetto UI is lenient about
# this, so we also re-close in memory before JSON.parse.
node -e '
  const fs = require("fs");
  let text = fs.readFileSync(process.argv[1], "utf8").trim();
  if (!text.endsWith("]}")) {
    text = text.replace(/,\s*$/, "") + "]}";
  }
  const obj = JSON.parse(text);
  if (!Array.isArray(obj.traceEvents)) throw new Error("no traceEvents array");
  if (obj.traceEvents.length === 0) throw new Error("traceEvents array is empty");
  const hasMain = obj.traceEvents.some(e => typeof e.name === "string" && e.name.startsWith("main:"));
  if (!hasMain) throw new Error("no main:* event recorded (main:trace-start canary missing)");
  console.log("OK:", obj.traceEvents.length, "events, first main event found");
' "$newest" || {
  echo "FAIL: trace validation failed for $newest" >&2
  FAILED=1
}

# Authoritative parse check via the Perfetto parser itself, but only if
# trace_processor_shell is already installed locally (avoids pulling
# 20 MB from the network inside a regression run).
#
# Caveat: tp_shell is strict about a closing `]}`. If Electron's
# graceful shutdown handler didn't fire (signals racing electron-builder's
# packaged launcher in CI), our file ends on a trailing comma. Stage a
# re-closed copy for tp_shell instead of rejecting a structurally OK
# trace.
TP="$HOME/.local/share/perfetto/prebuilts/trace_processor_shell"
if [[ -x "$TP" && -n "$newest" ]]; then
  sealed="${newest%.json}.sealed.json"
  node -e '
    const fs = require("fs");
    let text = fs.readFileSync(process.argv[1], "utf8").trim();
    if (!text.endsWith("]}")) {
      text = text.replace(/,\s*$/, "") + "\n]}";
    }
    fs.writeFileSync(process.argv[2], text);
  ' "$newest" "$sealed"
  if ! "$TP" --run-metrics trace_stats --metrics-output=binary "$sealed" > /dev/null 2>&1; then
    echo "FAIL: trace_processor_shell rejected $sealed" >&2
    FAILED=1
  fi
  rm -f "$sealed"
fi

if [[ "$FAILED" == "0" ]]; then
  echo "T02 trace infrastructure self-check: PASS (file=$newest)"
fi
exit $FAILED
