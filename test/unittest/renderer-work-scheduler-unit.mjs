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
const schedulerPath = resolve(repoRoot, 'src', 'utils', 'renderer-work-scheduler.ts')

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function loadScheduler(isInputPending = () => false) {
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
  const sandboxWindow = {
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id)
  }
  const sandbox = {
    module,
    exports: module.exports,
    require: requireFromTest,
    performance,
    navigator: {
      scheduling: {
        isInputPending
      }
    },
    window: sandboxWindow
  }
  vm.runInNewContext(compiled, sandbox, { filename: schedulerPath })
  return module.exports.RendererWorkScheduler ?? sandboxWindow.__onwardRendererWorkScheduler?.constructor
}

async function testPromptInputRunsBeforeVisibleUi() {
  const RendererWorkScheduler = loadScheduler()
  const scheduler = new RendererWorkScheduler()
  const order = []
  scheduler.enqueue('visible-ui', () => order.push('visible-ui'))
  scheduler.enqueue('prompt-input', () => order.push('prompt-input'))
  await sleep(50)
  assert.deepEqual(order, ['prompt-input', 'visible-ui'])
}

async function testVisibleWorkYieldsToPendingInput() {
  let pending = true
  const RendererWorkScheduler = loadScheduler(() => pending)
  const scheduler = new RendererWorkScheduler()
  const order = []
  scheduler.enqueue('visible-ui', () => order.push('visible-ui'))
  await sleep(50)
  assert.deepEqual(order, [], 'visible-ui work must yield while input is pending')
  pending = false
  await sleep(50)
  assert.deepEqual(order, ['visible-ui'])
  assert.equal(scheduler.getMetrics().yieldedToInput > 0, true)
}

await testPromptInputRunsBeforeVisibleUi()
await testVisibleWorkYieldsToPendingInput()

console.log('renderer-work-scheduler-unit: PASS')
