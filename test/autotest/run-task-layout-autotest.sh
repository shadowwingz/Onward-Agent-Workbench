#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Task layout regression. Locks down the 8-grid + Custom + downsize
# extension shipped alongside the LayoutMode union type:
#   TLM-01  Sidebar exposes the 8-grid button.
#   TLM-02  Sidebar exposes the Custom button.
#   TLM-03  Clicking 8-grid flips terminal-grid[data-layout="8"].
#   TLM-04  Shrinking from 8 → 1 surfaces the downsize-confirm dialog.
#   TLM-05  Clicking Custom mounts the preset popover.
#
# Pure-function semantics (LayoutMode union, validator) are covered by the
# Node test runner suite test/unittest/task-layout-utils.test.mts to keep
# this Electron-side runner focused on the wiring.
#
# Usage:
#   bash test/autotest/run-task-layout-autotest.sh [APP_BIN] [LOG_FILE]

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$ROOT_DIR/traces/test-logs/task-layout-autotest.log}"
USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-task-layout.XXXXXX")"
mkdir -p "$(dirname "$LOG_FILE")"

# Cleanup shield — even on SIGINT the user's mktemp scratch is removed and
# every __autotest_* fixture potentially leaked into the repo root is swept
# (legacy autotest contract, see CLAUDE.md hard rule on autotest fixtures).
cleanup() {
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -prune -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

APP_NAME="$(basename "$APP_BIN")"
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 0.5

rm -f "$LOG_FILE"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=task-layout \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_AUTOTEST_SKIP_CONSENT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Task layout autotest failed. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "Autotest Completed" "$LOG_FILE"; then
  echo "Task layout autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

# Defensive: the autotest harness emits per-suite PASS/FAIL lines with the
# `[AutoTest]` prefix. If the suite reports zero TaskLayout passes (e.g.
# the registration lookup misses), the run is considered a regression even
# though Autotest Completed.
if ! grep -q "PASS TLM-00-sidebar-mounted" "$LOG_FILE"; then
  echo "Task layout autotest produced no TLM assertions. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

echo "Task layout autotest passed. Log: $LOG_FILE"
