#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# open_trace.sh — one-shot launcher that opens a local Perfetto UI
# against an Onward perf trace.
#
# Input forms (auto-detected):
#   1. A directory of NDJSON chunks  (`perf-NNNN-*.jsonl`) — the new
#      always-on trace store layout. We concatenate all chunks by
#      sequence number and wrap them into the standard Chrome Trace
#      Event Format `{"traceEvents":[…]}` envelope that
#      `trace_processor_shell` expects.
#   2. A single `.jsonl` file — wrapped the same way.
#   3. A single `.json` / `.pftrace` file — the legacy single-file
#      Chrome trace; used as-is.
#
# Pipeline:
#   1. Resolve the target: argv[1] if provided; else newest entry under
#      `traces/perf/` (chunk dir, jsonl chunk, or legacy json).
#   2. Wrap NDJSON inputs into a Chrome Trace Event Format temp file.
#   3. Bootstrap `trace_processor_shell` into
#      `~/.local/share/perfetto/prebuilts/` on first use.
#   4. Start `trace_processor_shell --httpd --http-port=9001 <file>`
#      in the background. UI talks to it via loopback RPC — the trace
#      never leaves localhost.
#   5. Read `tp_shell --version` and construct a version-pinned
#      Perfetto UI URL. Pinning avoids the "different build" warning
#      banner that appears when the cloud UI build lags behind tp_shell.
#   6. Open the browser.
#
# Usage:
#   bash infra/scripts/open_trace.sh [trace_dir_or_file]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TRACE_DIR="${REPO_ROOT}/traces/perf"

# Resolve the input. Newest-first preference order:
#   (a) explicit argv[1] (file or dir)
#   (b) newest `.jsonl` chunk under TRACE_DIR (always-on store)
#   (c) newest legacy `.json` / `.pftrace` under TRACE_DIR
INPUT="${1:-}"
if [ -z "$INPUT" ]; then
  INPUT="$(ls -t "$TRACE_DIR"/*.jsonl 2>/dev/null | head -1 || true)"
  if [ -z "$INPUT" ]; then
    INPUT="$(ls -t "$TRACE_DIR"/*.json "$TRACE_DIR"/*.pftrace 2>/dev/null | head -1 || true)"
  fi
fi
if [ -z "$INPUT" ] || { [ ! -f "$INPUT" ] && [ ! -d "$INPUT" ]; }; then
  echo "ERROR: no trace file or chunk dir found." >&2
  echo "  Looked in: $TRACE_DIR" >&2
  echo "  Capture one first:" >&2
  echo "    pnpm dist:dev   # always-on trace, write to traces/perf/perf-*.jsonl" >&2
  exit 1
fi

# If INPUT is a directory of jsonl chunks, or a single .jsonl, materialize
# a Chrome Trace Event Format temp file. Otherwise pass through unchanged.
TARGET="$INPUT"
TARGET_TMP=""
if [ -d "$INPUT" ] || [[ "$INPUT" == *.jsonl ]]; then
  TARGET_TMP="$(mktemp -t onward-trace-merged.XXXXXX.json)"
  # node here is reliable across mac/linux developers; gives us a
  # stable, dependency-free way to emit a valid JSON envelope.
  node -e '
    const fs = require("fs");
    const path = require("path");
    const input = process.argv[1];
    const output = process.argv[2];
    let files = [];
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      files = fs.readdirSync(input)
        .filter(f => f.endsWith(".jsonl"))
        .sort()  // perf-NNNN-…-PID.jsonl sorts in chunk order
        .map(f => path.join(input, f));
    } else {
      files = [input];
    }
    const out = fs.createWriteStream(output);
    out.write("{\"traceEvents\":[\n");
    let first = true;
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          // Validate the line parses; a partial last line from SIGKILL
          // is silently skipped rather than corrupting the envelope.
          JSON.parse(trimmed);
        } catch { continue; }
        if (!first) out.write(",\n");
        out.write("  " + trimmed);
        first = false;
      }
    }
    out.write("\n]}\n");
    out.end();
  ' "$INPUT" "$TARGET_TMP"
  TARGET="$TARGET_TMP"
  echo "Merged NDJSON chunks → $TARGET"
fi
if [ ! -f "$TARGET" ]; then
  echo "ERROR: merged trace file missing: $TARGET" >&2
  exit 1
fi
# Cleanup of the merged temp on script exit (kill the tp_shell first
# so it doesn't keep a handle to the temp file on Linux).
cleanup_merged() {
  if [ -n "${TARGET_TMP:-}" ] && [ -f "$TARGET_TMP" ]; then
    rm -f "$TARGET_TMP" 2>/dev/null || true
  fi
}
trap cleanup_merged EXIT

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
