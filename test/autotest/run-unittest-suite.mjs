#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cross-platform driver that runs every unit test under `test/unittest/`.
 *
 * Why a custom driver instead of `node --test test/unittest/`:
 *   - 5 files use the `node:test` runner (`*.test.mts`).
 *   - 3 files are standalone scripts that call `assert(...)` at top level
 *     (`*-unit.mjs`).
 *   - 2 files (`coding-agent-*.test.mjs`) define their own collector or
 *     spawn child processes.
 * `node --test` only auto-discovers files matching specific patterns, so
 * the standalone scripts would be silently skipped. Running each file
 * with plain `node --experimental-strip-types <file>` works for all four
 * styles uniformly: a `node:test` import still self-runs in this mode.
 *
 * Usage:
 *   node test/autotest/run-unittest-suite.mjs
 *   pnpm test:unit
 */

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const UNITTEST_DIR = resolve(REPO_ROOT, 'test', 'unittest')
const PER_FILE_TIMEOUT_MS = 60_000

async function discoverUnitTests() {
  const entries = await readdir(UNITTEST_DIR, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && (e.name.endsWith('.mjs') || e.name.endsWith('.mts')))
    .map((e) => e.name)
    .sort()
}

function runOne(file) {
  return new Promise((resolveResult) => {
    const start = Date.now()
    const filePath = resolve(UNITTEST_DIR, file)
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', filePath],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    )
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3000).unref()
    }, PER_FILE_TIMEOUT_MS)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      const elapsed = ((Date.now() - start) / 1000).toFixed(2)
      resolveResult({
        file,
        ok: !timedOut && code === 0,
        code,
        signal,
        timedOut,
        elapsed,
      })
    })
  })
}

async function main() {
  const files = await discoverUnitTests()
  if (files.length === 0) {
    console.error(`ERROR: no unit-test files found under ${UNITTEST_DIR}`)
    process.exit(1)
  }

  console.log(`=== Unit-test suite: ${files.length} file(s) ===`)
  console.log(`Working dir: ${REPO_ROOT}`)
  console.log(`Per-file timeout: ${PER_FILE_TIMEOUT_MS / 1000}s`)
  console.log('')

  const results = []
  for (const file of files) {
    console.log(`--- ${file} ---`)
    const r = await runOne(file)
    results.push(r)
    const tag = r.ok
      ? 'PASS'
      : r.timedOut
        ? 'TIMEOUT'
        : `FAIL(exit=${r.code}${r.signal ? `, signal=${r.signal}` : ''})`
    console.log(`[${tag}] ${file} (${r.elapsed}s)`)
    console.log('')
  }

  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log('=== Result List ===')
  for (const r of results) {
    const tag = r.ok ? 'PASS' : r.timedOut ? 'TIMEOUT' : 'FAIL'
    console.log(`  [${tag}] ${r.file} (${r.elapsed}s)`)
  }
  console.log('')
  console.log(`Summary: ${passed}/${results.length} passed, ${failed} failed`)

  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
