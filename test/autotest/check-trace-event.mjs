#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

// Check whether a perf-trace event with a given `name` field exists in a
// Chrome Trace JSON file (or set of files in a worker dir).
//
// Why this exists instead of `grep -F '"name":"X"'`:
//   1. The trace writer emits `safeStringify(entry)` which uses `JSON.stringify`
//      with a stable key order — but `grep` would still false-positive if any
//      event payload happens to contain the literal byte sequence
//      `"name":"<event>"` inside an `args` field. We've already had one near-miss
//      where a forwarded worker event smuggled its own `name` into args.
//   2. Lines may exceed the default `grep` line-buffer threshold on Windows
//      MSYS2 builds when `args` is large.
//   3. JSON parsing makes the helper tolerant of formatting drift (trailing
//      comma, wrapped object form, NDJSON form) so the runner doesn't have to
//      know the writer's exact framing.
//
// Usage:
//   node test/autotest/check-trace-event.mjs --main <main-trace.json> [--worker-dir <dir>] --name <event>
//
// Exit codes:
//   0 — found (writes "main" or "worker:<file>" to stdout)
//   1 — not found
//   2 — invalid arguments

import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const args = process.argv.slice(2)
let mainPath = null
let workerDir = null
let needle = null

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--main') mainPath = args[++i]
  else if (args[i] === '--worker-dir') workerDir = args[++i]
  else if (args[i] === '--name') needle = args[++i]
}

if (!needle) {
  console.error('Usage: check-trace-event.mjs --main <path> [--worker-dir <dir>] --name <event>')
  process.exit(2)
}

function fileContainsEvent(file, eventName) {
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  // Form A: well-formed Chrome Trace JSON `{"traceEvents":[...]}`.
  try {
    const parsed = JSON.parse(content)
    if (parsed && Array.isArray(parsed.traceEvents)) {
      return parsed.traceEvents.some(e => e && e.name === eventName)
    }
    if (Array.isArray(parsed)) {
      return parsed.some(e => e && e.name === eventName)
    }
  } catch {
    // Trace file may be unfinished (process was killed before close marker
    // was written). Fall through to line-by-line.
  }
  // Form B: line-by-line. Each event was emitted as `  <json>,\n` so we strip
  // leading whitespace + trailing comma + skip wrapper / sentinel lines.
  for (let raw of content.split('\n')) {
    const line = raw.trim().replace(/,$/, '')
    if (!line) continue
    if (!line.startsWith('{')) continue
    if (line === '{}') continue
    if (line.startsWith('{"traceEvents"')) continue
    try {
      const obj = JSON.parse(line)
      if (obj && obj.name === eventName) return true
    } catch {
      // Truncated / partial line — keep scanning.
    }
  }
  return false
}

if (mainPath && existsSync(mainPath)) {
  if (fileContainsEvent(mainPath, needle)) {
    process.stdout.write('main\n')
    process.exit(0)
  }
}

if (workerDir && existsSync(workerDir)) {
  let entries
  try {
    entries = readdirSync(workerDir, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.json')) continue
    const file = join(workerDir, entry.name)
    try {
      if (statSync(file).size === 0) continue
    } catch {
      continue
    }
    if (fileContainsEvent(file, needle)) {
      process.stdout.write(`worker:${entry.name}\n`)
      process.exit(0)
    }
  }
}

process.exit(1)
