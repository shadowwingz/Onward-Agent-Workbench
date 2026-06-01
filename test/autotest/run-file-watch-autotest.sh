#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"

APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR")}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/file-watch-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: App binary does not exist or is not executable: $APP_BIN" >&2
  echo "Build the development package first with: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "=== File Watch Autotest ==="
echo "App: $APP_BIN"
echo "Log: $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=file-watch \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "--- Results ---"

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "FAILED: at least one assertion failed" >&2
  grep "\[AutoTest\]" "$LOG_FILE" | grep -E "PASS|FAIL" >&2
  echo "" >&2
  echo "Full log: $LOG_FILE" >&2
  exit 1
fi

if ! grep -q "FW-05c-old-file-no-effect" "$LOG_FILE"; then
  echo "INCOMPLETE: final file watch assertion was not found" >&2
  grep "\[AutoTest\]" "$LOG_FILE" | tail -20 >&2
  echo "" >&2
  echo "Full log: $LOG_FILE" >&2
  exit 1
fi

PASS_COUNT=$(grep -c "\[AutoTest\] PASS" "$LOG_FILE" || echo "0")
echo "Passed ($PASS_COUNT assertions)"
echo "Log: $LOG_FILE"
