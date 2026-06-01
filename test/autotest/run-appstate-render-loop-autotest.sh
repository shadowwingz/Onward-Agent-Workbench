#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# AppState render-loop regression autotest (CDP smoke test, hang-proof).
#
# Locks the Windows idle-CPU fix: the terminal cwd used to ping-pong between
# 'D:/x' and 'D:\x' (OSC writer vs git-watcher writer disagreeing on the path
# separator), defeating setTerminalLastCwd's idempotency check and pinning the
# renderer JS thread by re-rendering the whole tree ~100x/s. The fix
# canonicalizes the persisted cwd to '/' (normalizePersistedTerminalCwd) so both
# writers converge, and updateState bails out on the resulting no-op.
#
# This runner delegates to check-renderer-idle-churn.mjs, which launches the dev
# build with a CDP port, measures the renderer's idle render churn, asserts it
# is near zero, and ALWAYS kills the app (with hard internal deadlines, so it
# cannot hang the way the in-app suite harness did). Paired with the pure-logic
# unit tests test/unittest/terminal-cwd-persist-canonical.test.mts and
# appstate-update-bailout.test.mts.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_ROOT="${REPO_ROOT:-$ROOT_DIR}"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/appstate-render-loop.log}"
PORT="${ONWARD_RENDER_CHURN_PORT:-9344}"

mkdir -p "$(dirname "$LOG_FILE")"
rm -f "$LOG_FILE"

cleanup() {
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

echo "Starting appstate render-loop autotest (CDP idle-churn smoke test)..."
echo "  App:  $APP_BIN"
echo "  Port: $PORT"
echo "  Log:  $LOG_FILE"

# The .mjs self-terminates (90s internal deadline) and always kills the app.
node "$ROOT_DIR/test/autotest/check-renderer-idle-churn.mjs" "$APP_BIN" "$PORT" "$ROOT_DIR" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "AppState render-loop autotest FAILED. Log: $LOG_FILE" >&2
  tail -n 60 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "appstate-render-loop:complete" "$LOG_FILE"; then
  echo "AppState render-loop autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 60 "$LOG_FILE" >&2
  exit 1
fi

echo "AppState render-loop autotest passed. Log: $LOG_FILE"
cat "$LOG_FILE"
