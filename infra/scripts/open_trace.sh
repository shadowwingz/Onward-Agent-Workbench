#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# open_trace.sh — one-shot launcher that opens a local Perfetto UI
# against an Onward perf trace.
#
# Pipeline:
#   1. Resolve the target file: argv[1] if provided, else the newest
#      `.json` / `.pftrace` under `traces/perf/`.
#   2. Bootstrap `trace_processor_shell` into
#      `~/.local/share/perfetto/prebuilts/` on first use.
#   3. Start `trace_processor_shell --httpd --http-port=9001 <file>`
#      in the background. UI talks to it via loopback RPC — the trace
#      never leaves localhost.
#   4. Read `tp_shell --version` and construct a version-pinned
#      Perfetto UI URL (`ui.perfetto.dev/v<ver>-<sha>/…`). Pinning
#      avoids the "different build" warning banner that appears when
#      the cloud UI build lags behind tp_shell.
#   5. Open the browser.
#
# Usage:
#   bash infra/scripts/open_trace.sh [trace_file]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TRACE_DIR="${REPO_ROOT}/traces/perf"

# Resolve the file we're opening.
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  TARGET="$(ls -t "$TRACE_DIR"/*.json "$TRACE_DIR"/*.pftrace 2>/dev/null | head -1 || true)"
fi
if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "ERROR: no trace file found." >&2
  echo "  Looked in: $TRACE_DIR" >&2
  echo "  Capture one first:" >&2
  echo "    ONWARD_PERF_TRACE=1 pnpm dev   # or any autotest with ONWARD_PERF_TRACE=1" >&2
  exit 1
fi

# Bootstrap trace_processor_shell on demand.
TP="$HOME/.local/share/perfetto/prebuilts/trace_processor_shell"
if [ ! -x "$TP" ]; then
  echo "trace_processor_shell not found; downloading…"
  mkdir -p "$(dirname "$TP")"
  curl -L --fail --retry 3 -o "${TP}.tmp" https://get.perfetto.dev/trace_processor
  chmod +x "${TP}.tmp"
  mv "${TP}.tmp" "$TP"
fi

PORT=9001
# Evict any stale tp_shell holding this port.
EXIST_PID="$(lsof -ti tcp:${PORT} 2>/dev/null || true)"
if [ -n "$EXIST_PID" ]; then
  kill -TERM $EXIST_PID 2>/dev/null || true
  sleep 0.3
fi

# Pin UI build to tp_shell build. `--version` prints lines like:
#   Perfetto v50.0-abcd1234 ...
# We extract the `v<ver>-<sha>` token and feed it into the UI URL path.
TP_VER="$("$TP" --version 2>&1 | grep -oE 'v[0-9]+\.[0-9]+-[a-f0-9]+' | head -1 || true)"

# Start HTTP server in the background. Output goes to a local log for
# post-mortem if the UI can't talk to the port.
HTTPD_LOG="${REPO_ROOT}/traces/.tp_shell.log"
"$TP" --httpd --http-port="$PORT" "$TARGET" > "$HTTPD_LOG" 2>&1 &
TP_PID=$!
sleep 1

if [ -n "$TP_VER" ]; then
  URL="https://ui.perfetto.dev/${TP_VER}/#!/?rpc_port=${PORT}"
else
  # tp_shell too old to report version: fall back to stable UI. Will
  # produce a one-time "different build" warning banner in the UI but
  # is functionally identical.
  URL="https://ui.perfetto.dev/#!/?rpc_port=${PORT}"
fi

if command -v open >/dev/null 2>&1; then
  # macOS
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  # Linux
  xdg-open "$URL"
else
  echo "Open the URL manually: $URL"
fi

echo ""
echo "trace file       : $TARGET"
echo "Perfetto UI      : $URL"
echo "tp_shell PID     : $TP_PID  (port $PORT, version ${TP_VER:-unknown})"
echo "Stop tp_shell    : kill $TP_PID"
echo "tp_shell log     : $HTTPD_LOG"
