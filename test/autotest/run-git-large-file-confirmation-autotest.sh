#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$REPO_ROOT"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/git-large-file-confirmation-autotest.log}"
SUITE_NAME="git-large-file-confirmation"
WATCHDOG_SEC="${GLF_WATCHDOG_SEC:-240}"

mkdir -p "$(dirname "$LOG_FILE")"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-glf-userdata.XXXXXX")"
FIXTURE_ROOT=""
MANIFEST_PATH=""

cleanup() {
  find "$REPO_ROOT" -maxdepth 1 -name "__autotest_*" -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

FIXTURE_JSON="$(node "$REPO_ROOT/test/autotest/create-git-large-file-confirmation-fixture.mjs")"
FIXTURE_ROOT="$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.fixtureRoot)' "$FIXTURE_JSON")"
MANIFEST_PATH="$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.manifestPath)' "$FIXTURE_JSON")"
if [[ -z "$FIXTURE_ROOT" || ! -d "$FIXTURE_ROOT/.git" || -z "$MANIFEST_PATH" || ! -f "$MANIFEST_PATH" ]]; then
  echo "ERROR: failed to create Git large-file confirmation fixture" >&2
  echo "Fixture JSON: $FIXTURE_JSON" >&2
  exit 1
fi

echo "Starting Git large-file confirmation autotest..."
echo "  Binary:        $APP_BIN"
echo "  Repo:          $REPO_ROOT"
echo "  Fixture repo:  $FIXTURE_ROOT"
echo "  Manifest:      $MANIFEST_PATH"
echo "  User data dir: $USER_DATA_DIR"
echo "  Suite:         $SUITE_NAME"
echo "  Watchdog:      ${WATCHDOG_SEC}s"
echo "  Log:           $LOG_FILE"
echo ""

APP_EXIT=0
ONWARD_DEBUG=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE="$SUITE_NAME" \
ONWARD_AUTOTEST_CWD="$FIXTURE_ROOT" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$WATCHDOG_SEC" "$APP_BIN" > "$LOG_FILE" 2>&1 || APP_EXIT=$?

echo ""
echo "=== Test log (last 120 lines) ==="
tail -n 120 "$LOG_FILE"
echo ""

if [[ "$APP_EXIT" -eq 124 ]]; then
  echo "Git large-file confirmation autotest exceeded ${WATCHDOG_SEC}s watchdog" >&2
  exit 124
fi

if [[ "$APP_EXIT" -ne 0 ]]; then
  echo "Git large-file confirmation autotest app exited with code $APP_EXIT" >&2
  exit "$APP_EXIT"
fi

if ! grep -q "\[AutoTest\] === Autotest Completed ===" "$LOG_FILE"; then
  echo "Git large-file confirmation autotest did not reach the completion marker" >&2
  exit 1
fi

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE" \
  || grep -Eq "totalFailed: [1-9][0-9]*" "$LOG_FILE"; then
  echo "Git large-file confirmation autotest reported FAIL" >&2
  grep "\[AutoTest\] FAIL\|totalFailed: [1-9]" "$LOG_FILE" >&2 || true
  exit 1
fi

if ! grep -q "GLF-13-history-displays-after-confirm" "$LOG_FILE"; then
  echo "Missing GLF-13-history-displays-after-confirm result. Log: $LOG_FILE" >&2
  exit 1
fi

for marker in \
  "GLF-03a-diff-close-cancels-pending-confirmation" \
  "GLF-03c-diff-prompts-after-close-cancel" \
  "GLF-09a-history-switch-repo-cancels-pending-confirmation" \
  "GLF-09c-history-prompts-after-switch-cancel"; do
  if ! grep -q "$marker" "$LOG_FILE"; then
    echo "Missing $marker result. Log: $LOG_FILE" >&2
    exit 1
  fi
done

echo "Git large-file confirmation autotest PASS"
