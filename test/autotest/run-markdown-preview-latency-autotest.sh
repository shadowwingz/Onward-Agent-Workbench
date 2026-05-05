#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/markdown-preview-latency-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"

# Per-run fixture working directory under the OS temp dir so the
# autotest's __autotest_md_latency_*.md scratch files never land in
# the repo root.
FIXTURE_ROOT_DEFAULT="$(mktemp -d "${TMPDIR:-/tmp}/onward-md-latency-XXXXXX")"
FIXTURE_ROOT="${3:-$FIXTURE_ROOT_DEFAULT}"

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

# Copy the committed fixtures into the per-run cwd so the autotest can
# read them via project.readFile against rootPath without leaking paths
# back into the source tree.
mkdir -p "$FIXTURE_ROOT/test/autotest/fixtures/markdown-preview-latency"
cp "$ROOT_DIR/test/autotest/fixtures/markdown-preview-latency/"*.md \
  "$FIXTURE_ROOT/test/autotest/fixtures/markdown-preview-latency/" 2>/dev/null || true

cleanup() {
  # Sweep any __autotest_* leftovers in the fixture root (defensive — the
  # autotest's finally block already deletes them).
  if [[ -d "$FIXTURE_ROOT" ]]; then
    find "$FIXTURE_ROOT" -maxdepth 1 -name '__autotest_*' -print0 2>/dev/null | xargs -0 rm -rf 2>/dev/null || true
  fi
  # Remove the per-run fixture dir if we created it ourselves (caller did
  # not pass an explicit one). Detect by comparing to the default we made.
  if [[ -z "${3:-}" && -d "$FIXTURE_ROOT" ]]; then
    rm -rf "$FIXTURE_ROOT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

rm -f "$LOG_FILE"

echo "Starting Markdown preview latency autotest..."
echo "  Binary:      $APP_BIN"
echo "  Fixture CWD: $FIXTURE_ROOT"
echo "  Log:         $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=markdown-preview-latency \
ONWARD_AUTOTEST_CWD="$FIXTURE_ROOT" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "=== Test log (last 120 lines) ==="
tail -n 120 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Markdown preview latency autotest failed" >&2
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if grep -Eq "totalFailed: [1-9]" "$LOG_FILE"; then
  echo "Markdown preview latency autotest reported failed cases in the summary" >&2
  grep -E "totalFailed: [1-9]" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "MPL-large-cache-hit-fast-path" "$LOG_FILE"; then
  echo "Missing MPL-large-cache-hit-fast-path assertion; the test may not have completed all 3 fixtures" >&2
  tail -n 80 "$LOG_FILE" >&2
  exit 1
fi

echo "Markdown preview latency autotest passed"
echo "  Log: $LOG_FILE"
