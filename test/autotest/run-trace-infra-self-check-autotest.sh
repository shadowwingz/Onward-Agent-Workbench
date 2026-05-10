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

# Start with a clean perf directory so we can pick the newest chunks
# without ambiguity. The new always-on trace store writes NDJSON
# chunks (perf-NNNN-*.jsonl); the legacy single-file .json layout is
# also cleaned for backward-compatibility on older builds.
rm -f "$TRACE_DIR"/*.jsonl "$TRACE_DIR"/*.json "$TRACE_DIR"/latest.txt

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
# The always-on trace store writes NDJSON chunks. We collect every
# `perf-*.jsonl` in TRACE_DIR; if none exist, fall back to the legacy
# single-`.json` layout produced by older builds so this self-check can
# bisect a regression that changed the format unexpectedly.
shopt -s nullglob
chunks=("$TRACE_DIR"/perf-*.jsonl)
shopt -u nullglob

if [[ ${#chunks[@]} -eq 0 ]]; then
  legacy="$(ls -t "$TRACE_DIR"/*.json 2>/dev/null | head -1 || true)"
  if [[ -z "$legacy" || ! -s "$legacy" ]]; then
    echo "FAIL: no NDJSON chunks (perf-*.jsonl) and no legacy *.json in $TRACE_DIR" >&2
    echo "      last 40 lines of app output:" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    exit 1
  fi
  # Legacy validation path — kept so this self-check remains useful when
  # bisecting against pre-NDJSON commits.
  node -e '
    const fs = require("fs");
    let text = fs.readFileSync(process.argv[1], "utf8").trim();
    if (!text.endsWith("]}")) text = text.replace(/,\s*$/, "") + "]}";
    const obj = JSON.parse(text);
    if (!Array.isArray(obj.traceEvents)) throw new Error("no traceEvents array");
    if (obj.traceEvents.length === 0) throw new Error("traceEvents array is empty");
    const hasMain = obj.traceEvents.some(e => typeof e.name === "string" && e.name.startsWith("main:"));
    if (!hasMain) throw new Error("no main:* event recorded (main:trace-start canary missing)");
    console.log("OK (legacy):", obj.traceEvents.length, "events, first main event found");
  ' "$legacy" || {
    echo "FAIL: legacy trace validation failed for $legacy" >&2
    exit 1
  }
  echo "T02 trace infrastructure self-check: PASS (legacy file=$legacy)"
  exit 0
fi

# NDJSON validation: parse every line of every chunk; drop a partial
# last-line (signal-induced truncation) silently — that resilience is
# the whole reason we picked NDJSON. Then assert at least one main:*
# event landed across the chunks.
node -e '
  const fs = require("fs");
  const chunks = process.argv.slice(1);
  let total = 0;
  let mainSeen = false;
  let invalidLines = 0;
  for (const chunk of chunks) {
    const text = fs.readFileSync(chunk, "utf8");
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try { event = JSON.parse(trimmed); } catch { invalidLines += 1; continue; }
      total += 1;
      if (typeof event.name === "string" && event.name.startsWith("main:")) {
        mainSeen = true;
      }
    }
  }
  if (total === 0) throw new Error(`no events parsed across ${chunks.length} chunk(s)`);
  if (!mainSeen) throw new Error("no main:* event recorded (main:trace-start canary missing)");
  // One trailing partial line is acceptable (SIGKILL during a write).
  // More than that suggests a structural format bug.
  if (invalidLines > 1) throw new Error(`${invalidLines} unparseable lines — expected ≤1 from signal-truncated tail`);
  console.log("OK:", total, "events,", chunks.length, "chunk(s), main event found, invalid=" + invalidLines);
' "${chunks[@]}" || {
  echo "FAIL: NDJSON trace validation failed" >&2
  echo "      chunks scanned: ${chunks[*]}" >&2
  FAILED=1
}

# Authoritative parse check via the Perfetto parser, but only if
# trace_processor_shell is already installed locally (avoids pulling
# 20 MB from the network inside a regression run). For NDJSON we wrap
# the chunks into a Chrome Trace Event Format envelope first, since
# tp_shell wants the array form.
TP="$HOME/.local/share/perfetto/prebuilts/trace_processor_shell"
if [[ "$FAILED" == "0" && -x "$TP" && ${#chunks[@]} -gt 0 ]]; then
  sealed="$(mktemp -t onward-trace-merged.XXXXXX.json)"
  node -e '
    const fs = require("fs");
    const chunks = process.argv.slice(1, -1);
    const out = process.argv[process.argv.length - 1];
    const ws = fs.createWriteStream(out);
    ws.write("{\"traceEvents\":[\n");
    let first = true;
    for (const chunk of chunks) {
      const text = fs.readFileSync(chunk, "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { JSON.parse(trimmed); } catch { continue; }
        if (!first) ws.write(",\n");
        ws.write("  " + trimmed);
        first = false;
      }
    }
    ws.write("\n]}\n");
    ws.end();
  ' "${chunks[@]}" "$sealed"
  if ! "$TP" --run-metrics trace_stats --metrics-output=binary "$sealed" > /dev/null 2>&1; then
    echo "FAIL: trace_processor_shell rejected merged trace ($sealed)" >&2
    FAILED=1
  fi
  rm -f "$sealed"
fi

if [[ "$FAILED" == "0" ]]; then
  echo "T02 trace infrastructure self-check: PASS (chunks=${#chunks[@]})"
fi
exit $FAILED
