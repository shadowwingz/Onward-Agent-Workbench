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
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const schedulerPath = resolve(repoRoot, 'src', 'terminal', 'terminal-output-scheduler.ts')

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function loadScheduler(fakeInputLane) {
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
    require: (specifier) => {
      if (specifier === './input-priority-lane') {
        return { inputPriorityLane: fakeInputLane }
      }
      // The scheduler took on a perf-trace dependency in master commit
      // c4625ef. The test sandbox mocks the imports so the scheduler can
      // load without the real renderer-side trace stack.
      if (specifier === '../utils/perf-trace') {
        return {
          perfTrace: () => {},
          perfTraceTask: () => {}
        }
      }
      if (specifier === '../utils/perf-trace-names') {
        return {
          PERF_TRACE_EVENT: new Proxy({}, { get: (_target, prop) => String(prop) })
        }
      }
      return requireFromTest(specifier)
    },
    performance,
    requestAnimationFrame: (callback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    window: {
      setTimeout,
      clearTimeout
    }
  }

  vm.runInNewContext(compiled, sandbox, { filename: schedulerPath })
  return module.exports.TerminalOutputScheduler
}

function createTarget(id, writes, options = {}) {
  const pending = []
  return {
    id,
    pending,
    target: {
      id,
      hasPendingData: () => pending.length > 0,
      isOutputActive: () => options.outputActive !== false,
      isInteractive: () => Boolean(options.interactive?.()),
      consumeChunk: () => pending.shift() ?? null,
      writeData: (data) => writes.push({ id, data })
    }
  }
}

async function testVisibleOutputUsesBatchCadence() {
  const fakeInputLane = {
    shouldYieldToPromptInput: () => false,
    hasRecentFocusedTaskInput: () => false
  }
  const TerminalOutputScheduler = loadScheduler(fakeInputLane)
  const scheduler = new TerminalOutputScheduler({ batchIntervalMs: 20, visibleFrameBudgetMs: 100 })
  const writes = []
  const visible = createTarget('visible', writes)
  scheduler.registerTarget(visible.target)

  visible.pending.push('a')
  scheduler.markDirty('visible')
  await sleep(10)
  assert.equal(writes.length, 0, 'visible output must wait for the batch cadence')

  await sleep(40)
  assert.deepEqual(writes, [{ id: 'visible', data: 'a' }])
}

async function testPromptInputPreemptsFocusedTaskOutput() {
  let promptPressure = true
  const fakeInputLane = {
    shouldYieldToPromptInput: () => promptPressure,
    hasRecentFocusedTaskInput: () => false
  }
  const TerminalOutputScheduler = loadScheduler(fakeInputLane)
  const scheduler = new TerminalOutputScheduler({
    batchIntervalMs: 20,
    promptInputMaxYieldMs: 80,
    focusedFrameBudgetMs: 100
  })
  const writes = []
  const focused = createTarget('focused', writes, { interactive: () => true })
  scheduler.registerTarget(focused.target)

  focused.pending.push('focused-output')
  scheduler.markDirty('focused', true)
  await sleep(40)
  assert.equal(writes.length, 0, 'Prompt input pressure must preempt focused Task output')

  promptPressure = false
  await sleep(60)
  assert.deepEqual(writes, [{ id: 'focused', data: 'focused-output' }])
}

async function testFocusedTaskQueuePreemptsVisibleOutput() {
  const fakeInputLane = {
    shouldYieldToPromptInput: () => false,
    hasRecentFocusedTaskInput: () => false
  }
  const TerminalOutputScheduler = loadScheduler(fakeInputLane)
  const scheduler = new TerminalOutputScheduler({ batchIntervalMs: 20, focusedFrameBudgetMs: 100, visibleFrameBudgetMs: 100 })
  const writes = []
  const visible = createTarget('visible', writes)
  const focused = createTarget('focused', writes, { interactive: () => true })
  scheduler.registerTarget(visible.target)
  scheduler.registerTarget(focused.target)

  visible.pending.push('visible-output')
  focused.pending.push('focused-output')
  scheduler.markDirty('visible')
  scheduler.markDirty('focused', true)

  await sleep(40)
  assert.equal(writes[0]?.id, 'focused', 'focused Task output must flush before visible Task output')
  assert.equal(writes[1]?.id, 'visible')
}

await testVisibleOutputUsesBatchCadence()
await testPromptInputPreemptsFocusedTaskOutput()
await testFocusedTaskQueuePreemptsVisibleOutput()

console.log('terminal-output-scheduler-unit: PASS')
