#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Shell-integration cwd OSC autotest.
#
# Spawns the host's real default shell through node-pty (the same way
# electron/main/pty-manager.ts does), drives a sequence of real `cd` commands,
# and asserts the shell emits a cwd-bearing OSC (633 / 7 / 9;9) for each one.
# Locks the regression where pwsh.ps1's `$host` assignment silenced all cwd OSC
# on Windows, so the Task status bar never reflected `cd`.
#
# Runs the test under Electron's ABI (ELECTRON_RUN_AS_NODE=1) so node-pty's
# native binary matches the one the app uses — no full app build required.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_ROOT="${REPO_ROOT:-$ROOT_DIR}"
# Orchestrator arg contract (parity with every other runner): $1 = APP_BIN,
# $2 = LOG_FILE. This suite drives Electron-as-node (ELECTRON_RUN_AS_NODE=1) and
# does NOT use the packaged app, so it ignores $1 — but it MUST read the log path
# from $2, not $1. Reading $1 made LOG_FILE the app binary path, and the `rm -f
# "$LOG_FILE"` + log redirect below then DESTROYED the dev app exe, spuriously
# failing every app-launching runner that ran after this one in a full regression.
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/shell-integration-cwd.log}"
TEST_SRC="$ROOT_DIR/test/autotest/test-shell-integration-cwd.mjs"

mkdir -p "$(dirname "$LOG_FILE")"
rm -f "$LOG_FILE"

# Defense-in-depth sweep: remove any __autotest_* entries a crashing run might
# leave in the repo root (CLAUDE.md autotest fixture sweep). This test writes
# its scratch under the OS temp dir and self-cleans, so this is belt-and-braces.
cleanup() {
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT

# Resolve the Electron binary (the `electron` package's main export is the path
# to the executable). Cross-platform: works on macOS / Linux / Windows.
ELECTRON_BIN="$(node -p "require('electron')" 2>/dev/null || true)"
if [[ -z "$ELECTRON_BIN" || ! -e "$ELECTRON_BIN" ]]; then
  echo "ERROR: could not resolve the Electron binary via require('electron')." >&2
  echo "Run 'pnpm install' first so node_modules/electron is present." >&2
  exit 1
fi

echo "Starting shell-integration cwd autotest..."
echo "  Electron: $ELECTRON_BIN"
echo "  Test:     $TEST_SRC"
echo "  Log:      $LOG_FILE"

ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" "$TEST_SRC" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Shell-integration cwd autotest FAILED. Log: $LOG_FILE" >&2
  tail -n 80 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "shell-integration-cwd:complete" "$LOG_FILE"; then
  echo "Shell-integration cwd autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 80 "$LOG_FILE" >&2
  exit 1
fi

echo "Shell-integration cwd autotest passed. Log: $LOG_FILE"
