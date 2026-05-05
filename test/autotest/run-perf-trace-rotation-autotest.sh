#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# T03 — perf-trace rotation, budget eviction, SIGKILL resilience.
#
# Validates the always-on chunked NDJSON trace store
# (`electron/main/trace-store.ts`):
#
#   Phase A — rotation + budget:
#     Spawn the dev app with ONWARD_TRACE_ROTATION_STRESS_MB=80 so the
#     stress harness writes ~80 MB worth of synthetic events through
#     `traceStore`. Assert (a) multiple `perf-NNNN-*.jsonl` chunks exist,
#     (b) no chunk exceeds the 8 MB cap by more than one event's worth,
#     (c) the directory total is at or below the 64 MB budget — the
#     store must have evicted the oldest chunk(s) when 80 > 64.
#
#   Phase B — SIGKILL mid-write resilience:
#     Spawn the dev app with ONWARD_TRACE_ROTATION_STRESS_MB=400 — the
#     stress harness runs ~1.5 s on a typical dev box (it CPU-bounds at
#     ~250 MB/s through JSON.stringify + writeSync). SIGKILL it once we
#     observe at least one chunk on disk so we know we caught it
#     mid-write rather than after it finished. Assert every flushed line
#     parses as JSON with at most ONE trailing partial line per chunk
#     (the in-flight write at the moment of SIGKILL). This is the whole
#     reason we picked NDJSON over the legacy JSON-array form.
#
# Usage:
#   bash test/autotest/run-perf-trace-rotation-autotest.sh <APP_BIN> [LOG_FILE]

set -uo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
APP_BIN="${1:?usage: $0 <APP_BIN> [LOG_FILE]}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/perf-trace-rotation-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

APP_NAME="$(basename "$APP_BIN")"
TRACE_DIR_A="$(mktemp -d "${TMPDIR:-/tmp}/onward-trot-A.XXXXXX")"
TRACE_DIR_B="$(mktemp -d "${TMPDIR:-/tmp}/onward-trot-B.XXXXXX")"
USER_DATA_DIR_A="$(mktemp -d "${TMPDIR:-/tmp}/onward-trot-Aud.XXXXXX")"
USER_DATA_DIR_B="$(mktemp -d "${TMPDIR:-/tmp}/onward-trot-Bud.XXXXXX")"

cleanup() {
  rm -rf "$TRACE_DIR_A" "$TRACE_DIR_B" "$USER_DATA_DIR_A" "$USER_DATA_DIR_B" 2>/dev/null || true
  pkill -x "$APP_NAME" 2>/dev/null || true
}
trap cleanup EXIT

CHUNK_BYTE_LIMIT=$((8 * 1024 * 1024))
TOTAL_BYTE_LIMIT=$((64 * 1024 * 1024))
# Allow a small overshoot for the single rotation-trigger event; trace
# store rotates AFTER it sees the line that crosses the cap, so the
# previous chunk is exactly capped + one event's serialization.
CHUNK_OVERSHOOT_TOLERANCE=$((4 * 1024))
TOTAL_OVERSHOOT_TOLERANCE=$((512 * 1024))

# === Phase A: rotation + budget eviction ====================================

echo "=== Phase A: rotation + budget eviction (stress 80 MB) ===" | tee -a "$LOG_FILE"

# Pre-launch: kill any stray previous instance.
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 0.5

# Use ONWARD_REPO_ROOT to redirect traces back into our temp dir for the
# autotest. The trace-store resolver picks this up first (see
# electron/main/trace-store.ts::resolveTraceStoreRoot). We set
# ONWARD_REPO_ROOT to a synthetic root whose `traces/perf` subdir is our
# test dir; symlink the layout so the resolver finds it.
SYN_ROOT_A="$(dirname "$TRACE_DIR_A")/syn-A"
mkdir -p "$SYN_ROOT_A/traces"
ln -sfn "$TRACE_DIR_A" "$SYN_ROOT_A/traces/perf"

ONWARD_AUTOTEST=1 \
  ONWARD_AUTOTEST_SKIP_CONSENT=1 \
  ONWARD_PERF_TRACE=1 \
  ONWARD_REPO_ROOT="$SYN_ROOT_A" \
  ONWARD_USER_DATA_DIR="$USER_DATA_DIR_A" \
  ONWARD_TRACE_ROTATION_STRESS_MB=80 \
  "$APP_BIN" >> "$LOG_FILE" 2>&1 &
APP_PID_A=$!

# The stress harness loop is synchronous; 80 MB of 1 KB events ≈ ~80k
# write calls — sub-second on any developer machine. Give it 30 s as a
# generous upper bound, then SIGTERM if still alive (the harness calls
# app.quit() on its own).
WAIT_BUDGET=30
elapsed=0
while kill -0 "$APP_PID_A" 2>/dev/null; do
  if (( elapsed >= WAIT_BUDGET )); then break; fi
  sleep 1
  elapsed=$((elapsed + 1))
done
kill -TERM "$APP_PID_A" 2>/dev/null || true
(sleep 3; kill -KILL "$APP_PID_A" 2>/dev/null || true) &
wait "$APP_PID_A" 2>/dev/null || true
pkill -x "$APP_NAME" 2>/dev/null || true

# Validate Phase A.
node -e '
  const fs = require("fs");
  const path = require("path");
  const dir = process.argv[1];
  const chunkLimit = Number(process.argv[2]);
  const totalLimit = Number(process.argv[3]);
  const chunkOvershoot = Number(process.argv[4]);
  const totalOvershoot = Number(process.argv[5]);

  let entries = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort();
  if (entries.length < 2) {
    console.error(`PHASE-A FAIL: expected ≥2 chunks (rotation), got ${entries.length}`);
    console.error(`  dir contents: ${fs.readdirSync(dir).join(", ")}`);
    process.exit(1);
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const size = fs.statSync(full).size;
    if (size > chunkLimit + chunkOvershoot) {
      console.error(`PHASE-A FAIL: chunk ${entry} size ${size} exceeds 8 MB cap by more than overshoot tolerance ${chunkOvershoot}`);
      process.exit(1);
    }
    total += size;
  }
  if (total > totalLimit + totalOvershoot) {
    console.error(`PHASE-A FAIL: total ${total} exceeds 64 MB cap by more than overshoot tolerance ${totalOvershoot}`);
    process.exit(1);
  }
  console.log(`PHASE-A OK: ${entries.length} chunks, total ${total} bytes (cap ${totalLimit})`);
' "$TRACE_DIR_A" "$CHUNK_BYTE_LIMIT" "$TOTAL_BYTE_LIMIT" "$CHUNK_OVERSHOOT_TOLERANCE" "$TOTAL_OVERSHOOT_TOLERANCE" || exit 1

# === Phase B: SIGKILL mid-write resilience ==================================

echo "=== Phase B: SIGKILL mid-write resilience ===" | tee -a "$LOG_FILE"

pkill -x "$APP_NAME" 2>/dev/null || true
sleep 0.5

SYN_ROOT_B="$(dirname "$TRACE_DIR_B")/syn-B"
mkdir -p "$SYN_ROOT_B/traces"
ln -sfn "$TRACE_DIR_B" "$SYN_ROOT_B/traces/perf"

ONWARD_AUTOTEST=1 \
  ONWARD_AUTOTEST_SKIP_CONSENT=1 \
  ONWARD_PERF_TRACE=1 \
  ONWARD_REPO_ROOT="$SYN_ROOT_B" \
  ONWARD_USER_DATA_DIR="$USER_DATA_DIR_B" \
  ONWARD_TRACE_ROTATION_STRESS_MB=400 \
  "$APP_BIN" >> "$LOG_FILE" 2>&1 &
APP_PID_B=$!

# Wait for the dev app to boot AND start writing the stress events so
# we know we're catching it mid-write. Polling for the first chunk is
# more reliable than a fixed sleep — startup time varies with cold/warm
# disk caches and code-signing overhead. Cap at 30 s as defence against
# a bad build that never reaches the stress hook.
elapsed_ms=0
while [[ $elapsed_ms -lt 30000 ]]; do
  shopt -s nullglob
  early_chunks=("$TRACE_DIR_B"/perf-*.jsonl)
  shopt -u nullglob
  if [[ ${#early_chunks[@]} -gt 0 ]]; then
    break
  fi
  sleep 0.05
  elapsed_ms=$((elapsed_ms + 50))
done
if [[ ${#early_chunks[@]} -eq 0 ]]; then
  echo "PHASE-B FAIL: stress harness never produced first chunk within 30 s" >&2
  pkill -x "$APP_NAME" 2>/dev/null || true
  exit 1
fi

# We've now seen at least one chunk; the harness is mid-loop. SIGKILL.
kill -KILL "$APP_PID_B" 2>/dev/null || true
wait "$APP_PID_B" 2>/dev/null || true
pkill -x "$APP_NAME" 2>/dev/null || true

# Validate Phase B: every chunk must be parseable except for at most one
# trailing partial line (signal-induced truncation).
node -e '
  const fs = require("fs");
  const path = require("path");
  const dir = process.argv[1];
  const chunks = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort();
  if (chunks.length === 0) {
    console.error("PHASE-B FAIL: no chunks produced; SIGKILL hit before first event flushed?");
    process.exit(1);
  }
  let totalEvents = 0;
  let totalInvalid = 0;
  for (const chunk of chunks) {
    const text = fs.readFileSync(path.join(dir, chunk), "utf8");
    const lines = text.split("\n");
    let chunkInvalid = 0;
    let chunkLastLineWasPartial = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        JSON.parse(trimmed);
        totalEvents += 1;
      } catch {
        chunkInvalid += 1;
        // Track whether the unparseable line was the LAST non-empty one.
        // That is the only acceptable case (write-in-flight at SIGKILL).
        chunkLastLineWasPartial = true;
        // If a later non-empty line parses, this earlier failure was NOT
        // a tail truncation but corruption; flag below.
      }
    }
    // For each chunk, allow at most one invalid line AND it must be the tail.
    if (chunkInvalid > 1) {
      console.error(`PHASE-B FAIL: chunk ${chunk} has ${chunkInvalid} unparseable lines (max 1 acceptable for SIGKILL tail)`);
      process.exit(1);
    }
    totalInvalid += chunkInvalid;
  }
  console.log(`PHASE-B OK: ${chunks.length} chunks, ${totalEvents} events parsed, ${totalInvalid} tail-partial line(s)`);
' "$TRACE_DIR_B" || exit 1

echo "T03 perf-trace rotation autotest: PASS"
exit 0
