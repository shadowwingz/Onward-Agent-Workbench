#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"

APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/subpage-cdp-clicks-autotest.log}"
CDP_PORT="${ONWARD_SUBPAGE_CDP_PORT:-9339}"
mkdir -p "$(dirname "$LOG_FILE")"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"
USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-subpage-cdp-user.XXXXXX")"
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/onward-subpage-cdp-fixture.XXXXXX")"
USER_DATA_DIR="$(cd "$USER_DATA_DIR" && pwd -P)"
FIXTURE_ROOT="$(cd "$FIXTURE_ROOT" && pwd -P)"
APP_PID=""

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  rm -rf "$USER_DATA_DIR" "$FIXTURE_ROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cat > "$FIXTURE_ROOT/notes.md" <<'EOF'
# Notes

Intro paragraph.

## Section 1
Line 1

## Section 2
Line 2

## Section 3
Line 3

## Section 4
Line 4

## Section 5
Line 5

## Section 6
Line 6

## Section 7
Line 7

## Section 8
Line 8

## Section 9
Line 9

## Section 10
Line 10

## Section 11
Line 11

## Section 12
Line 12

## Section 13
Line 13

## Section 14
Line 14

## Section 15
Line 15

## Section 16
Line 16

## Section 17
Line 17

## Section 18
Line 18

## Section 19
Line 19

## Section 20
Line 20
EOF

(
  cd "$FIXTURE_ROOT"
  git init >/dev/null 2>&1
  git add notes.md
  git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" -c commit.gpgsign=false commit -m "base notes" >/dev/null 2>&1
  printf '\nWorking tree line\n' >> notes.md
)

{
  echo "Starting subpage CDP click autotest..."
  echo "  Binary:        $APP_BIN"
  echo "  CWD:           $ROOT_DIR"
  echo "  Fixture:       $FIXTURE_ROOT"
  echo "  User data dir: $USER_DATA_DIR"
  echo "  CDP port:      $CDP_PORT"
  echo "  Log:           $LOG_FILE"
  echo ""
} | tee "$LOG_FILE"

(
  cd "$ROOT_DIR"
  ONWARD_DEBUG=1 \
  ONWARD_AUTOTEST=1 \
  ONWARD_AUTOTEST_SUITE=subpage-cdp-clicks-external \
  ONWARD_AUTOTEST_CWD="$FIXTURE_ROOT" \
  ONWARD_AUTOTEST_SKIP_CONSENT=1 \
  ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
  ONWARD_REPO_ROOT="$ROOT_DIR" \
  "$APP_BIN" "--remote-debugging-port=$CDP_PORT"
) >> "$LOG_FILE" 2>&1 &
APP_PID="$!"

set +e
node "$ROOT_DIR/test/autotest/test-subpage-cdp-clicks.mjs" \
  --port "$CDP_PORT" \
  --fixture-root "$FIXTURE_ROOT" >> "$LOG_FILE" 2>&1
DRIVER_STATUS="$?"
set -e

echo "" | tee -a "$LOG_FILE"
echo "=== Test log (last 120 lines) ==="
tail -n 120 "$LOG_FILE"
echo ""

if [[ "$DRIVER_STATUS" -ne 0 ]]; then
  echo "Subpage CDP click autotest failed with status $DRIVER_STATUS" >&2
  exit "$DRIVER_STATUS"
fi

if ! grep -q "RESULT: PASS" "$LOG_FILE"; then
  echo "Subpage CDP click autotest did not report PASS" >&2
  exit 1
fi

echo "Subpage CDP click autotest passed"
echo "  Log: $LOG_FILE"
