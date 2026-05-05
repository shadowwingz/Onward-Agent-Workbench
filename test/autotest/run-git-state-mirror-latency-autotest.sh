#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$REPO_ROOT"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/git-state-mirror-latency-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# CLAUDE.md "Test fixture isolation": every runner gets a fresh user-data
# scratch dir and unpacks its own copy of the committed fixture tarballs into
# a per-run staging dir under ${TMPDIR:-/tmp}. The fixture tarballs themselves
# are committed under test/autotest/fixtures/git-state-mirror-latency/ and
# treated as read-only — we never write back into them.
# ---------------------------------------------------------------------------
USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-gsm-userdata.XXXXXX")"
FIXTURE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/onward-gsm-fixture.XXXXXX")"
FIXTURE_SRC="$REPO_ROOT/test/autotest/fixtures/git-state-mirror-latency"

cleanup() {
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
  rm -rf "$FIXTURE_TMP" 2>/dev/null || true
  # Defence-in-depth: sweep any __autotest_* leftover at the repo root per
  # CLAUDE.md "__autotest_* sweep" hard rule.
  find "$REPO_ROOT" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} \; 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Extract every fixture tarball from the committed fixture dir into the
# per-run staging dir. Tarballs were produced by
# `node test/autotest/build-git-state-mirror-latency-fixture.mjs` once at
# fixture-authoring time and are committed verbatim — extraction here is
# deterministic and side-effect-free.
# ---------------------------------------------------------------------------
for tarball in "$FIXTURE_SRC"/*.tar.gz; do
  if [[ ! -f "$tarball" ]]; then continue; fi
  tar xzf "$tarball" -C "$FIXTURE_TMP"
done

if [[ ! -d "$FIXTURE_TMP/repo-A" ]]; then
  echo "ERROR: fixture extraction failed; expected $FIXTURE_TMP/repo-A to exist" >&2
  echo "Source dir: $FIXTURE_SRC" >&2
  ls "$FIXTURE_SRC" >&2 || true
  exit 1
fi

# Pass the staging dir + manifest path to the autotest TS via env. The
# autotest reads ONWARD_AUTOTEST_FIXTURE_EXTRA as the manifest path (already
# bridged through the existing debug API) and walks repos relative to its
# `tempRoot` field.
MANIFEST_PATH="$FIXTURE_TMP/manifest.json"
node -e "
  const { readFileSync, writeFileSync } = require('fs')
  const src = require('path').join('$FIXTURE_SRC', 'manifest.json')
  const m = JSON.parse(readFileSync(src, 'utf8'))
  m.tempRoot = '$FIXTURE_TMP'
  writeFileSync('$MANIFEST_PATH', JSON.stringify(m, null, 2))
"

rm -f "$LOG_FILE"

echo "Starting Git State Mirror latency autotest..."
echo "  Binary:        $APP_BIN"
echo "  Fixture src:   $FIXTURE_SRC"
echo "  Fixture tmp:   $FIXTURE_TMP"
echo "  Manifest:      $MANIFEST_PATH"
echo "  User data dir: $USER_DATA_DIR"
echo "  Log:           $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_PERF_TRACE=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=git-state-mirror-latency \
ONWARD_AUTOTEST_CWD="$FIXTURE_TMP/repo-A" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "=== Test log (last 60 lines) ==="
tail -n 60 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Git State Mirror latency autotest failed" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "GSM-00-fixture-loaded" "$LOG_FILE"; then
  echo "Missing GSM-00 marker; the test may not have executed correctly" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "GSM-13-trace-marker-mirror-events-expected" "$LOG_FILE"; then
  echo "Missing GSM-13 marker; the mirror trace coverage test did not run to completion" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "git-state-mirror-latency:done" "$LOG_FILE"; then
  echo "Missing git-state-mirror-latency:done marker; the suite did not finish cleanly" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

echo "Git State Mirror latency autotest passed"
echo "  Log: $LOG_FILE"
