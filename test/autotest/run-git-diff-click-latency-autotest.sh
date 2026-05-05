#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Click → render latency localisation suite. Walks every file in the host
# repo's working set, simulates a click, and asserts the click→paint
# duration stays under the target. Output lands in
# <repoRoot>/traces/test-logs/git-diff-click-latency-autotest.log so a
# post-mortem can read it without rerunning the build.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$REPO_ROOT"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/git-diff-click-latency-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-gdcl-userdata.XXXXXX")"

cleanup() {
  # Sweep `__autotest_*` debris at the repo root left over by other suites
  # we did NOT run (defensive, per CLAUDE.md autotest cleanup contract).
  find "$REPO_ROOT" -maxdepth 1 -name "__autotest_*" -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

echo "Starting Git Diff click→render latency autotest..."
echo "  Binary:        $APP_BIN"
echo "  Repo:          $REPO_ROOT"
echo "  User data dir: $USER_DATA_DIR"
echo "  Log:           $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_PERF_TRACE=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=git-diff-click-latency \
ONWARD_AUTOTEST_CWD="$REPO_ROOT" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "=== Test log (last 120 lines) ==="
tail -n 120 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Click→render latency autotest reported FAIL" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL\|gdcl:" "$LOG_FILE" >&2 || true
  exit 1
fi

echo "Click→render latency autotest PASS"
