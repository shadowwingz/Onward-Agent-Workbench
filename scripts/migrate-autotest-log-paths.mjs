#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
//
// migrate-autotest-log-paths.mjs — one-shot helper committed alongside
// the v0.3 regression checklist.
//
// Rewrites every `test/run-*-autotest.sh` (and its `.ps1` peer) so
// LOG_FILE lands under `<repoRoot>/traces/test-logs/<suite>.log`
// instead of `/tmp/onward-<suite>-autotest.log`. The helper is kept in
// the repo for audit trail — running it a second time is a no-op
// because the pattern it looks for only matches pre-migration lines.
//
// Usage:
//   node scripts/migrate-autotest-log-paths.mjs [--check]
//
// --check  Prints the planned changes without touching any file. Used
//          by CI to verify the patch is stable.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, basename, join } from 'node:path'

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname)
const TEST_DIR = join(REPO_ROOT, 'test')
const DRY_RUN = process.argv.includes('--check')

// Matches any `<NAME>_LOG_FILE="${N:-/tmp/onward-<suite>.log}"` assignment.
// `LOG_FILE`, `SEED_LOG_FILE`, `VERIFY_LOG_FILE` all match. We don't
// touch the $2 / $3 argv index; only the default path changes.
const SHELL_PATTERN = /^([A-Z_]*LOG_FILE)="\$\{(\d+):-\/tmp\/(onward-[A-Za-z0-9\-]+)\.log\}"\s*$/gm

const SHELL_REPO_ROOT_PROBE = /REPO_ROOT=/
const PS1_PATTERN = /\$LogFile\s*=\s*Join-Path\s+\$env:TEMP\s+"(onward-[A-Za-z0-9\-]+)\.log"/m

let changed = 0
let skipped = 0
const diffs = []

for (const name of readdirSync(TEST_DIR).sort()) {
  if (!(name.startsWith('run-') && (name.endsWith('-autotest.sh') || name.endsWith('-autotest.ps1')))) continue
  const abs = join(TEST_DIR, name)
  const before = readFileSync(abs, 'utf8')
  let after = before

  if (name.endsWith('.sh')) {
    SHELL_PATTERN.lastIndex = 0
    const matches = [...before.matchAll(SHELL_PATTERN)]
    if (matches.length > 0) {
      const injectRepoRoot = !SHELL_REPO_ROOT_PROBE.test(before)
      if (injectRepoRoot) {
        // Insert a REPO_ROOT definition just after the first non-comment,
        // non-blank line of the shebang block. We look for the `set -e`
        // / `set -u` line or fall back to after the shebang.
        const lines = after.split('\n')
        const insertAt = (() => {
          let i = 0
          while (i < lines.length && (lines[i].startsWith('#') || lines[i].trim() === '' || /^set\s+-/.test(lines[i]))) i += 1
          return i
        })()
        lines.splice(insertAt, 0, `REPO_ROOT="\${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"`)
        after = lines.join('\n')
      }
      after = after.replace(SHELL_PATTERN, (_all, varName, argIdx, onwardSlug) => {
        // Strip the `onward-` prefix from the slug for the on-disk path.
        const cleanSlug = onwardSlug.replace(/^onward-/, '')
        return `${varName}="\${${argIdx}:-$REPO_ROOT/traces/test-logs/${cleanSlug}.log}"\nmkdir -p "$(dirname "$${varName}")"`
      })
    }
  } else {
    const match = PS1_PATTERN.exec(before)
    if (match) {
      const suiteSlug = match[1]
      const repoRootBlock = `$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$LogFile = Join-Path $RepoRoot "traces/test-logs/${suiteSlug}.log"
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null`
      after = before.replace(PS1_PATTERN, repoRootBlock)
    }
  }

  if (after !== before) {
    if (DRY_RUN) {
      diffs.push(name)
    } else {
      writeFileSync(abs, after, 'utf8')
      if (name.endsWith('.sh')) {
        try {
          execFileSync('bash', ['-n', abs], { stdio: 'ignore' })
        } catch (err) {
          // Roll back on syntax error.
          writeFileSync(abs, before, 'utf8')
          console.error(`SYNTAX ERROR after rewrite, rolled back: ${name}`)
          console.error(err.stderr?.toString() || err.message)
          process.exit(2)
        }
      }
    }
    changed += 1
  } else {
    skipped += 1
  }
}

if (DRY_RUN) {
  console.log(`[dry-run] would change ${changed} file(s):`)
  for (const d of diffs) console.log('  ' + d)
  console.log(`[dry-run] skipped (already migrated or non-matching): ${skipped}`)
} else {
  console.log(`migrated ${changed} runner(s); skipped ${skipped} (already on new path or not matched)`)
}
