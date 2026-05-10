#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/project-editor-markdown-session-restore-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
FIXTURE_ROOT="${3:-$ROOT_DIR/test/autotest/fixtures/project-editor-markdown-session-restore}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

if [[ ! -d "$FIXTURE_ROOT" ]]; then
  if [[ $# -ge 3 ]]; then
    echo "ERROR: fixture root not found: $FIXTURE_ROOT" >&2
    exit 1
  fi
  mkdir -p "$FIXTURE_ROOT"
fi

rm -f "$LOG_FILE"

echo "Starting Project Editor Markdown session restore autotest..."
echo "  Binary:      $APP_BIN"
echo "  Fixture CWD: $FIXTURE_ROOT"
echo "  Log:         $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=project-editor-markdown-session-restore \
ONWARD_AUTOTEST_CWD="$FIXTURE_ROOT" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "=== Test log (last 100 lines) ==="
tail -n 100 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Project Editor Markdown session restore autotest failed" >&2
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if grep -Eq "totalFailed: [1-9]" "$LOG_FILE"; then
  echo "Project Editor Markdown session restore autotest reported failed cases in the summary" >&2
  grep -E "totalFailed: [1-9]" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "PMSR-11-editor-section-restored-after-reopen" "$LOG_FILE"; then
  echo "Missing PMSR-11 result; the test may not have executed correctly" >&2
  tail -n 60 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "PMSR-13-escape-and-shortcut-reopen-repeat" "$LOG_FILE"; then
  echo "Missing PMSR-13 shortcut reopen repeat result; the high-frequency shortcut path may not have executed" >&2
  tail -n 80 "$LOG_FILE" >&2
  exit 1
fi

echo "Project Editor Markdown session restore autotest passed"
echo "  Log: $LOG_FILE"
