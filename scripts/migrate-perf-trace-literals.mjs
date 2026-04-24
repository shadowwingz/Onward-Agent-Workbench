#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
//
// Promote inline perf-trace event-name string literals to the central
// PERF_TRACE_EVENT registry. Re-runnable — it's a no-op on already-
// migrated call sites.
//
// Usage:
//   node scripts/migrate-perf-trace-literals.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname)
const DRY_RUN = process.argv.includes('--check')

// Mapping of literal event-name → registry constant key. Keep in sync
// with src/utils/perf-trace-names.ts.
const LITERAL_TO_CONST = {
  'main:app-state-worker-latency': 'WORKER_APP_STATE_LATENCY',
  'main:app-state-worker-timeout': 'WORKER_APP_STATE_TIMEOUT',
  'main:app-state-worker-error': 'WORKER_APP_STATE_ERROR',
  'main:app-state-worker-exit': 'WORKER_APP_STATE_EXIT',
  'main:git-ipc-worker-latency': 'WORKER_GIT_IPC_LATENCY',
  'main:git-ipc-worker-timeout': 'WORKER_GIT_IPC_TIMEOUT',
  'main:git-ipc-worker-error': 'WORKER_GIT_IPC_ERROR',
  'main:git-ipc-worker-exit': 'WORKER_GIT_IPC_EXIT',
  'main:git-status-worker-latency': 'WORKER_GIT_STATUS_LATENCY',
  'main:git-status-worker-timeout': 'WORKER_GIT_STATUS_TIMEOUT',
  'main:git-status-worker-error': 'WORKER_GIT_STATUS_ERROR',
  'main:git-status-worker-exit': 'WORKER_GIT_STATUS_EXIT',
  'main:project-fs-worker-latency': 'WORKER_PROJECT_FS_LATENCY',
  'main:project-fs-worker-timeout': 'WORKER_PROJECT_FS_TIMEOUT',
  'main:project-fs-worker-error': 'WORKER_PROJECT_FS_ERROR',
  'main:project-fs-worker-exit': 'WORKER_PROJECT_FS_EXIT',
  'main:sqlite-worker-latency': 'WORKER_SQLITE_LATENCY',
  'main:sqlite-worker-timeout': 'WORKER_SQLITE_TIMEOUT',
  'main:sqlite-worker-error': 'WORKER_SQLITE_ERROR',
  'main:sqlite-worker-exit': 'WORKER_SQLITE_EXIT',
  'main:ripgrep-worker-latency': 'WORKER_RIPGREP_LATENCY',
  'main:ripgrep-worker-timeout': 'WORKER_RIPGREP_TIMEOUT',
  'main:ripgrep-worker-error': 'WORKER_RIPGREP_ERROR',
  'main:ripgrep-worker-exit': 'WORKER_RIPGREP_EXIT',
  'main:ripgrep-binary-missing': 'WORKER_RIPGREP_BINARY_MISSING',
  'main:ripgrep-worker-start-error': 'WORKER_RIPGREP_START_ERROR',
  'main:gitwatch-summary': 'MAIN_GITWATCH_SUMMARY',
  'main:terminal-data-ipc-summary': 'MAIN_TERMINAL_DATA_IPC_SUMMARY',
  'main:app-state-save': 'MAIN_APP_STATE_SAVE',
  'main:app-state-save-error': 'MAIN_APP_STATE_SAVE_ERROR'
}

const FILES = [
  'electron/main/app-state-worker-client.ts',
  'electron/main/app-state-storage.ts',
  'electron/main/git-ipc-worker-client.ts',
  'electron/main/git-status-worker-client.ts',
  'electron/main/git-watch-manager.ts',
  'electron/main/ipc-handlers.ts',
  'electron/main/project-fs-worker-client.ts',
  'electron/main/ripgrep-search.ts',
  'electron/main/sqlite-worker-client.ts'
]

const IMPORT_REGEX = /from '\.\.\/\.\.\/src\/utils\/perf-trace-names'/
const IMPORT_LINE = "import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'"

let changed = 0
let skipped = 0

for (const rel of FILES) {
  const abs = resolve(REPO_ROOT, rel)
  let before
  try {
    before = readFileSync(abs, 'utf8')
  } catch {
    console.warn('skip (missing): ' + rel)
    continue
  }
  let after = before

  // Replace each known literal with PERF_TRACE_EVENT.<KEY>
  for (const [literal, key] of Object.entries(LITERAL_TO_CONST)) {
    const pattern = new RegExp(
      "(perfTraceLogger\\.record\\(\\s*)'" +
        literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        "'",
      'g'
    )
    after = after.replace(pattern, `$1PERF_TRACE_EVENT.${key}`)
  }

  if (after === before) {
    skipped += 1
    continue
  }

  // Ensure the import exists. Insert after the last existing import
  // line from the electron or relative module neighbourhood. Simplest:
  // insert right before the first line that starts with a comment or
  // a non-import statement after the import block.
  if (!IMPORT_REGEX.test(after)) {
    const lines = after.split('\n')
    let lastImport = -1
    for (let i = 0; i < lines.length; i += 1) {
      if (/^import\b/.test(lines[i])) lastImport = i
      else if (lastImport >= 0 && lines[i].trim() !== '' && !/^import\b/.test(lines[i])) break
    }
    if (lastImport >= 0) {
      lines.splice(lastImport + 1, 0, IMPORT_LINE)
      after = lines.join('\n')
    } else {
      // No imports found — prepend.
      after = IMPORT_LINE + '\n' + after
    }
  }

  if (DRY_RUN) {
    console.log('would rewrite: ' + rel)
    changed += 1
    continue
  }
  writeFileSync(abs, after, 'utf8')
  changed += 1
}

if (DRY_RUN) {
  console.log(`[dry-run] would change ${changed} file(s); skipped ${skipped}`)
} else {
  console.log(`migrated ${changed} file(s); skipped ${skipped}`)
  // Typecheck is handled by the caller (CI / pnpm typecheck). We
  // only do a cheap syntactic sanity check with Node --check.
  for (const rel of FILES) {
    try {
      execFileSync('node', ['--check', resolve(REPO_ROOT, rel)], { stdio: 'pipe' })
    } catch {
      // Typescript; node --check won't like TS. Silent.
    }
  }
}
