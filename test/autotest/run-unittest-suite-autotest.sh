#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
if [[ -n "${1:-}" && -x "${1:-}" ]]; then
  LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/unittest-suite.log}"
else
  LOG_FILE="${1:-$REPO_ROOT/traces/test-logs/unittest-suite.log}"
fi
WATCHDOG_SEC="${UNITTEST_WATCHDOG_SEC:-180}"
mkdir -p "$(dirname "$LOG_FILE")"

cleanup() {
  find "$REPO_ROOT" -maxdepth 1 -name "__autotest_*" -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"
echo "Starting unit test suite..."
echo "  Repo: $REPO_ROOT"
echo "  Watchdog: ${WATCHDOG_SEC}s"
echo "  Log:  $LOG_FILE"

if node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$WATCHDOG_SEC" \
  node "$REPO_ROOT/test/unittest/run-unittest-suite.mjs" > "$LOG_FILE" 2>&1; then
  tail -n 120 "$LOG_FILE"
  echo "Unit test suite PASS"
else
  status=$?
  tail -n 160 "$LOG_FILE" >&2 || true
  if [[ "$status" -eq 124 ]]; then
    echo "Unit test suite exceeded ${WATCHDOG_SEC}s watchdog. Log: $LOG_FILE" >&2
    exit "$status"
  fi
  echo "Unit test suite FAIL. Log: $LOG_FILE" >&2
  exit "$status"
fi
