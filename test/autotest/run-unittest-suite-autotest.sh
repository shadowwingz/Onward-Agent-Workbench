#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Unit-test suite runner. Wraps the cross-platform Node driver
# `test/autotest/run-unittest-suite.mjs`, which discovers every
# `*.{mjs,mts}` under `test/unittest/` and runs each in a fresh
# child process so the four authoring styles (node:test runner,
# standalone assertion script, custom collector, child-process
# spawn) all execute uniformly.
#
# Why this lives in `test/autotest/` even though the harnesses
# live in `test/unittest/`: the Full Regression orchestrator's
# `SCRIPTS` list only invokes `test/autotest/run-*-autotest.sh`
# entries. Wrapping the unit suite in a runner of that shape lets
# the orchestrator pick it up without special-casing.
#
# The first positional argument (`APP_BIN`) is intentionally
# ignored — unit tests do not need a packaged Electron app. The
# orchestrator passes it because every other runner needs it.
#
# Usage:
#   bash test/autotest/run-unittest-suite-autotest.sh [APP_BIN] [LOG_FILE]

set -uo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/unittest-suite-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"

# Cleanup shield — the Node driver does not write fixtures, but
# defence-in-depth: sweep any __autotest_* leftovers that an
# upstream legacy unit test might have leaked into the repo root.
cleanup() {
  find "$REPO_ROOT" -maxdepth 1 -name '__autotest_*' -prune -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT

cd "$REPO_ROOT"
node test/autotest/run-unittest-suite.mjs 2>&1 | tee "$LOG_FILE"
exit "${PIPESTATUS[0]}"
