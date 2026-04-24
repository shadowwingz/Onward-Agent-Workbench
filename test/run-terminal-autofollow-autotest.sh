#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/test/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/terminal-autofollow-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting terminal autofollow autotest..."

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=terminal-autofollow \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Terminal autofollow autotest failed. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "TA-13-fixture-completed" "$LOG_FILE"; then
  echo "Terminal autofollow autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

echo "Terminal autofollow autotest passed. Log: $LOG_FILE"
