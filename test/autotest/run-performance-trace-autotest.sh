#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Performance trace autotest runner.
# Works on macOS and Linux. For Windows, use run-performance-trace-autotest.ps1.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-/tmp/onward-performance-trace-autotest.log}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting Performance Trace autotest..."
echo "  Binary:   $APP_BIN"
echo "  CWD:      $ROOT_DIR"
echo "  Platform:  $(uname -s)"
echo "  Log:      $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_PERF_TRACE=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=performance-trace \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "=== Test log (last 120 lines) ==="
tail -n 120 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Performance Trace autotest FAILED" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "PT-09-no-dropped-events" "$LOG_FILE"; then
  echo "Missing PT-09 result; the test may not have executed correctly" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

# The log now emits: [PerfTrace] enabled format=ndjson-chunked dir=<dir> (<kind>)
# Two-stage sed: first extract everything after 'dir=', then strip the
# trailing ' (<kind>)' suffix.  Two passes avoids BRE greedy-match issues
# across BSD (macOS) and GNU sed.
TRACE_DIR="$(sed -n 's/.*\[PerfTrace\] enabled format=ndjson-chunked dir=//p' "$LOG_FILE" | \
  sed 's/ ([^)]*$//' | tail -n 1)"
if [[ -z "$TRACE_DIR" || ! -d "$TRACE_DIR" ]]; then
  echo "Performance trace directory not found in log (expected [PerfTrace] enabled ...)" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

# Pick the most recently written chunk for contract validation.
TRACE_FILE="$(ls -t "$TRACE_DIR"/perf-*.jsonl 2>/dev/null | head -n 1)"
if [[ -z "$TRACE_FILE" || ! -f "$TRACE_FILE" ]]; then
  echo "No performance trace chunks found in $TRACE_DIR" >&2
  ls -la "$TRACE_DIR" >&2
  exit 1
fi

node "$ROOT_DIR/test/autotest/validate-performance-trace-contract.mjs" "$TRACE_FILE"

echo "Performance Trace autotest PASSED"
echo "  Log:   $LOG_FILE"
echo "  Trace: $TRACE_FILE"
