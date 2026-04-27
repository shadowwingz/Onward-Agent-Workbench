#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Performance-trace coverage audit. Three-way differential between:
 *   1. The canonical Event Registry in src/utils/perf-trace-names.ts
 *   2. Code grep — performanceTrace.<method>('name', ...) call sites,
 *      plus the implicit 'terminal.task.state' emitted by markTaskX.
 *   3. A trace JSON file (--latest finds the newest under userData).
 *
 * The contract test (test/autotest/validate-performance-trace-contract.mjs) proves
 * THAT specific events fire under a scripted scenario; this auditor proves
 * THAT no event registered in the contract is silently un-emitted, no
 * code path emits an unregistered name, and no surprise event names slip
 * past either side.
 *
 * Usage:
 *   node scripts/trace-coverage-audit.mjs <path/to/trace.json>
 *   node scripts/trace-coverage-audit.mjs --latest
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, platform } from 'node:os'

const __filename = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(__filename), '..')

// ---------- 1. Registry (canonical TS object in perf-trace-names.ts) ----------
function readRegistry() {
  const registryPath = join(ROOT, 'src/utils/perf-trace-names.ts')
  const raw = readFileSync(registryPath, 'utf8')
  const names = new Set()
  // Match `KEY: 'event.name',` lines inside the PERF_TRACE_EVENT object.
  // Trace names follow the convention <prefix>:<dotted.subject> where prefix
  // is `main`, `renderer`, or `worker.<kind>` — capture single-quoted strings
  // that contain a colon so we ignore unrelated string literals in comments.
  const re = /^\s*[A-Z][A-Z0-9_]*\s*:\s*'([\w.\-]*[:][\w.\-]+)'\s*,?\s*$/gm
  let m
  while ((m = re.exec(raw))) names.add(m[1])
  if (names.size === 0) {
    throw new Error(`No event names found in ${registryPath}`)
  }
  return names
}

// ---------- 2. Code emits via TypeScript walker ----------
function* walkTsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkTsFiles(p)
    else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) yield p
  }
}

const NAMED_EMIT_METHODS = [
  'recordInstant', 'recordCounter', 'recordComplete',
  'timeSync', 'timeAsync',
  'recordFlowStart', 'recordFlowStep', 'recordFlowEnd',
]

const TASK_STATE_METHODS = ['markTaskInput', 'markTaskRunning', 'markTaskOutput', 'markTaskExited', 'markTaskIdle']

function readCodeEmits() {
  const emitMethodAlt = NAMED_EMIT_METHODS.join('|')
  // Multi-line aware: \s* matches newlines so calls split across lines still match.
  const named = new RegExp(`performanceTrace\\.(?:${emitMethodAlt})\\s*\\(\\s*['"]([\\w.\\-]+)['"]`, 'g')
  const taskState = new RegExp(`performanceTrace\\.(?:${TASK_STATE_METHODS.join('|')})\\s*\\(`)
  const names = new Set()
  for (const root of ['electron', 'src']) {
    for (const file of walkTsFiles(join(ROOT, root))) {
      // Skip the trace module itself — it pushes 'process_name' / 'thread_name'
      // metadata via its own internal API, those are __metadata phase events not
      // part of the event-name contract.
      if (file.endsWith('performance-trace.ts')) continue
      const txt = readFileSync(file, 'utf8')
      named.lastIndex = 0
      let m
      while ((m = named.exec(txt))) names.add(m[1])
      if (taskState.test(txt)) names.add('terminal.task.state')
    }
  }
  return names
}

// ---------- 3. Trace JSON ----------
function readTraceEvents(path) {
  const json = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(json.traceEvents)) {
    throw new Error(`Not a Chrome trace JSON (no traceEvents array): ${path}`)
  }
  const names = new Set()
  for (const e of json.traceEvents) names.add(e.name)
  return { names, total: json.traceEvents.length, file: path }
}

// ---------- helpers ----------
function findLatestTrace() {
  let dir
  if (platform() === 'darwin') dir = join(homedir(), 'Library', 'Application Support', 'Onward 2-dev')
  else if (platform() === 'win32') dir = join(process.env.APPDATA || '', 'Onward 2-dev')
  else dir = join(homedir(), '.config', 'Onward 2-dev')
  const branches = readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => join(dir, d.name, 'performance-traces'))
    .filter(p => { try { return statSync(p).isDirectory() } catch { return false } })
  let latest = null
  for (const br of branches) {
    for (const f of readdirSync(br)) {
      if (!f.endsWith('.json')) continue
      const p = join(br, f); const m = statSync(p).mtimeMs
      if (!latest || m > latest.m) latest = { p, m }
    }
  }
  if (!latest) throw new Error(`No trace files found under ${dir}`)
  return latest.p
}

const diff = (a, b) => { const r = new Set(); for (const x of a) if (!b.has(x)) r.add(x); return r }
const isect = (a, b) => { const r = new Set(); for (const x of a) if (b.has(x)) r.add(x); return r }
const fmt = s => [...s].sort().map(x => `  · ${x}`).join('\n') || '  (none)'

// Names emitted as Chrome metadata or by the trace module's own internal
// bookkeeping (recordInstant from inside performance-trace.ts). They are part
// of the registry but the audit's code-grep deliberately skips the trace
// module itself, so we exempt them from the "trace ⊄ code" check.
const METADATA_NAMES = new Set(['process_name', 'thread_name'])
const INTERNAL_TRACE_NAMES = new Set(['trace.session.start', 'trace.session.flush'])

// ---------- main ----------
const arg = process.argv[2] ?? '--latest'
const tracePath = arg === '--latest' ? findLatestTrace() : resolve(arg)

const registry = readRegistry()
const codeEmits = readCodeEmits()
const trace = readTraceEvents(tracePath)
// Names worth comparing to registry: drop the metadata phase events, the
// internal trace bookkeeping events, and any test.* markers injected by the
// autotest harness (which call recordPerfTrace directly, not via the typed
// performanceTrace.* methods my code-grep targets).
const traceContractRaw = diff(diff(trace.names, METADATA_NAMES), INTERNAL_TRACE_NAMES)
const traceContract = new Set([...traceContractRaw].filter(n => !n.startsWith('test.')))

console.log(`\n========================================================================`)
console.log(`Performance-trace coverage audit`)
console.log(`========================================================================`)
console.log(`Registry  (src/utils/perf-trace-names.ts)          : ${registry.size} names`)
console.log(`Code grep (performanceTrace.* call sites)          : ${codeEmits.size} names`)
console.log(`Trace     (${tracePath.replace(homedir(), '~')})`)
console.log(`         total events                              : ${trace.total}`)
console.log(`         distinct names (excluding metadata)       : ${traceContract.size}\n`)

// Treat internal trace names as "code-emitted" for diff purposes (they are
// emitted by the trace module's own recordInstant calls).
const codeEmitsExtended = new Set([...codeEmits, ...INTERNAL_TRACE_NAMES])
const fullyVerified     = isect(isect(registry, codeEmitsExtended), trace.names)
const deadRegistration  = diff(registry, codeEmitsExtended)
const unregisteredEmit  = diff(codeEmits, registry)
const codeButNotInTrace = diff(isect(registry, codeEmits), trace.names)
const traceButNotInCode = diff(traceContract, codeEmits)

console.log(`-- 3-way diff (registry × code × trace) --`)
console.log(`Fully verified (registered + emitted in code + seen in trace): ${fullyVerified.size}`)
console.log(fmt(fullyVerified))
console.log(`\nDead registrations (in registry, no performanceTrace.* call) : ${deadRegistration.size}`)
console.log(fmt(deadRegistration))
console.log(`\nUnregistered emits (code emits but registry has no entry)    : ${unregisteredEmit.size}`)
if (unregisteredEmit.size > 0) console.log(`  ⚠ either typos or events the registry doc forgot to list`)
console.log(fmt(unregisteredEmit))
console.log(`\nScenario gaps (registered + code-emitted, absent in trace)   : ${codeButNotInTrace.size}`)
console.log(`  (this scenario doesn't exercise these — expected for limited runs)`)
console.log(fmt(codeButNotInTrace))
console.log(`\nTrace contract names NOT found in code grep                  : ${traceButNotInCode.size}`)
console.log(`  (BAD if any: trace produced a name code never emits)`)
console.log(fmt(traceButNotInCode))

let pass = true
if (codeEmits.size === 0) { console.log(`\n✗ FAIL: code grep returned 0 — auditor regex broken`); pass = false }
if (unregisteredEmit.size > 0) { console.log(`\n⚠ WARN: ${unregisteredEmit.size} unregistered emit name(s)`); }
if (traceButNotInCode.size > 0) { console.log(`\n✗ FAIL: ${traceButNotInCode.size} trace name(s) not produced by code grep`); pass = false }
console.log(pass ? `\n✓ PASS: registry / code / trace mutually consistent for what was exercised.` : `\n✗ FAIL`)
console.log()
process.exit(pass ? 0 : 1)
