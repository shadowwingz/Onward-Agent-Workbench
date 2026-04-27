#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs'

const traceFile = process.argv[2]
if (!traceFile) {
  console.error('Usage: node test/autotest/validate-performance-trace-contract.mjs <trace-file>')
  process.exit(2)
}

const raw = readFileSync(traceFile, 'utf8')
const parsed = JSON.parse(raw)
const events = Array.isArray(parsed.traceEvents) ? parsed.traceEvents : []
const failures = []
const rows = []

function hasArg(event, key) {
  return Boolean(event?.args && Object.prototype.hasOwnProperty.call(event.args, key))
}

function findEvent(name, options = {}) {
  return events.find((event) => {
    if (!event || event.name !== name) return false
    if (options.phase && event.ph !== options.phase) return false
    if (options.args && !options.args.every((key) => hasArg(event, key))) return false
    if (options.predicate && !options.predicate(event)) return false
    return true
  })
}

function addCheck(id, label, ok, detail) {
  const status = ok ? 'PASS' : 'FAIL'
  const line = `${status} ${id} ${label}${detail ? ` | ${detail}` : ''}`
  rows.push(line)
  if (!ok) failures.push(line)
}

function checkEvent(id, name, options = {}) {
  const event = findEvent(name, options)
  addCheck(
    id,
    name,
    Boolean(event),
    options.visible ? `visible: ${options.visible.join(', ')}` : undefined
  )
}

function checkAction(id, action) {
  const event = findEvent('ui.prompt.action', {
    phase: 'X',
    args: ['action', 'flowId', 'result'],
    predicate: (candidate) => candidate.args.action === action
  })
  addCheck(id, `ui.prompt.action:${action}`, Boolean(event), 'visible: action, flowId, result, dur')
}

function checkTaskState(id, state) {
  const event = findEvent('terminal.task.state', {
    args: ['terminalId', 'state'],
    predicate: (candidate) => candidate.args.state === state
  })
  addCheck(id, `terminal.task.state:${state}`, Boolean(event), 'visible: terminalId, state, flowId')
}

function flowContinuityOk() {
  const groups = new Map()
  for (const event of events) {
    if (!event?.id || !['s', 't', 'f'].includes(event.ph)) continue
    const names = groups.get(event.id) ?? new Set()
    names.add(event.name)
    groups.set(event.id, names)
  }

  for (const names of groups.values()) {
    const hasPromptStart = names.has('ui.prompt.action')
    const hasIpc = names.has('ipc.terminal.write') || names.has('ipc.terminal.send_input_sequence')
    const hasRender = names.has('terminal.render.receive') && names.has('terminal.render.flush')
    if (hasPromptStart && hasIpc && hasRender) {
      return true
    }
  }
  return false
}

addCheck('TC-00', 'traceEvents array exists', events.length > 0, `events=${events.length}`)
checkEvent('TC-01', 'trace.session.start', {
  args: ['schema', 'platform', 'appVersion', 'contentCaptured'],
  visible: ['schema', 'platform', 'appVersion', 'contentCaptured']
})
checkEvent('TC-02', 'test.performance_trace.marker', {
  visible: ['name', 'cat']
})
checkEvent('TC-03', 'ui.prompt.edit', {
  args: ['field', 'mode', 'payloadLength', 'payloadHash'],
  visible: ['field', 'mode', 'payloadLength', 'payloadHash']
})
checkEvent('TC-04', 'ui.prompt.task_select', {
  args: ['terminalId', 'selected', 'selectedCount'],
  visible: ['terminalId', 'selected', 'selectedCount']
})
checkAction('TC-05', 'send')
checkAction('TC-06', 'execute')
checkAction('TC-07', 'sendAndExecute')
checkEvent('TC-08', 'api.request', {
  phase: 'X',
  args: ['route', 'terminalId', 'action', 'status', 'deliveredCount'],
  predicate: (event) => event.args.route === 'POST /api/terminal/:id/write',
  visible: ['route', 'terminalId', 'action', 'status', 'deliveredCount', 'dur']
})
checkEvent('TC-09', 'prompt.bridge', {
  phase: 'X',
  args: ['requestId', 'terminalId', 'action', 'result'],
  visible: ['requestId', 'terminalId', 'action', 'result', 'dur']
})
checkEvent('TC-10', 'ipc.invoke', {
  phase: 'X',
  args: ['channel', 'terminalId', 'result'],
  predicate: (event) => ['terminal:write', 'terminal:send-input-sequence'].includes(event.args.channel),
  visible: ['channel', 'terminalId', 'result', 'dur']
})
checkEvent('TC-11', 'pty.write', {
  phase: 'X',
  args: ['terminalId', 'writeMode', 'includesEnter', 'payloadLength', 'result'],
  visible: ['terminalId', 'writeMode', 'includesEnter', 'payloadLength', 'result', 'dur']
})
checkEvent('TC-12', 'pty.output', {
  args: ['terminalId', 'bytes', 'bracketedPasteMode'],
  visible: ['terminalId', 'bytes', 'bracketedPasteMode']
})
checkEvent('TC-13', 'terminal.buffer.flush', {
  phase: 'X',
  args: ['terminalId', 'chunkCount', 'bytes'],
  visible: ['terminalId', 'chunkCount', 'bytes', 'dur']
})
checkEvent('TC-14', 'terminal.ipc.send', {
  args: ['terminalId', 'bytes'],
  visible: ['terminalId', 'bytes']
})
checkEvent('TC-15', 'terminal.render.receive', {
  args: ['terminalId', 'visible', 'bytes'],
  visible: ['terminalId', 'visible', 'bytes']
})
checkEvent('TC-16', 'terminal.render.flush', {
  phase: 'X',
  args: ['terminalId', 'visible', 'bytes', 'xtermDurationMs'],
  visible: ['terminalId', 'visible', 'bytes', 'xtermDurationMs', 'dur']
})
checkTaskState('TC-17', 'input_pending')
checkTaskState('TC-18', 'running')
checkTaskState('TC-19', 'output_active')
checkTaskState('TC-20', 'idle')
checkEvent('TC-21', 'perf.renderer.snapshot', {
  args: ['fps', 'xtermWriteCount', 'ipcDataMsgCount'],
  visible: ['fps', 'xtermWriteCount', 'ipcDataMsgCount']
})
addCheck('TC-22', 'flow continuity ui -> ipc -> renderer', flowContinuityOk(), 'requires one shared flowId across prompt, IPC, and render')
addCheck('TC-23', 'default trace redacts raw marker event content', !raw.includes('performance-trace-raw-content-should-not-appear'))
addCheck('TC-24', 'default trace redacts raw command content', !raw.includes('PTTRACE_RAW_SHOULD_NOT_APPEAR'))

console.log('=== Performance Trace Contract Report ===')
console.log(`Trace: ${traceFile}`)
for (const row of rows) {
  console.log(row)
}

if (failures.length > 0) {
  console.error('')
  console.error(`Performance trace contract FAILED: ${failures.length} failed check(s)`)
  process.exit(1)
}

console.log('')
console.log(`Performance trace contract PASSED: ${rows.length} checks`)
