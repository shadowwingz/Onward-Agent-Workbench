#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const requireFromTest = createRequire(import.meta.url)
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const schedulerPath = resolve(repoRoot, 'electron', 'main', 'main-work-scheduler.ts')

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function loadScheduler() {
  const source = readFileSync(schedulerPath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    },
    fileName: schedulerPath
  }).outputText

  const module = { exports: {} }
  const sandbox = {
    module,
    exports: module.exports,
    require: requireFromTest,
    process: { env: { ONWARD_MAIN_WORK_MAX_CONCURRENCY: '1' } },
    setImmediate,
    setTimeout,
    clearTimeout
  }
  vm.runInNewContext(compiled, sandbox, { filename: schedulerPath })
  return module.exports.MainWorkScheduler
}

async function testPriorityOrder() {
  const MainWorkScheduler = loadScheduler()
  const scheduler = new MainWorkScheduler()
  const order = []
  scheduler.enqueue({ lane: 'maintenance', label: 'low' }, async () => {
    order.push('maintenance')
  })
  scheduler.enqueue({ lane: 'realtime-input', label: 'high' }, async () => {
    order.push('realtime-input')
  })
  await sleep(40)
  assert.deepEqual(order, ['realtime-input', 'maintenance'])
}

async function testDedupeKeySharesPromise() {
  const MainWorkScheduler = loadScheduler()
  const scheduler = new MainWorkScheduler()
  let runs = 0
  const first = scheduler.enqueue({ lane: 'visible-ui', key: 'same' }, async () => {
    runs += 1
    await sleep(20)
    return 'ok'
  })
  const second = scheduler.enqueue({ lane: 'visible-ui', key: 'same' }, async () => {
    runs += 1
    return 'bad'
  })
  assert.equal(await first, 'ok')
  assert.equal(await second, 'ok')
  assert.equal(runs, 1)
  assert.equal(scheduler.getMetrics().scheduler.dedupeHits, 1)
}

async function testCancelOwnerRemovesQueuedWork() {
  const MainWorkScheduler = loadScheduler()
  const scheduler = new MainWorkScheduler()
  const blocker = scheduler.enqueue({ lane: 'realtime-input' }, async () => {
    await sleep(40)
  })
  const queued = scheduler.enqueue({ lane: 'maintenance', ownerId: 'owner-a' }, async () => 'must-not-run')
  await sleep(5)
  assert.equal(scheduler.cancelOwner('owner-a'), 1)
  await assert.rejects(queued, /owner cancelled/)
  await blocker
  assert.equal(scheduler.getMetrics().scheduler.totalCancelled, 1)
}

await testPriorityOrder()
await testDedupeKeySharesPromise()
await testCancelOwnerRemovesQueuedWork()

console.log('main-work-scheduler-unit: PASS')
