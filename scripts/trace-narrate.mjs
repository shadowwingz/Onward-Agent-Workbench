#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Performance-trace narrator: turns a Chrome trace JSON into one English
 * sentence per event in chronological order. The point is to answer
 * "could a stranger read this and tell what Onward was doing?" without
 * needing to load the file into Perfetto.
 *
 *   node scripts/trace-narrate.mjs --latest | head -80
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, platform } from 'node:os'

const __filename = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(__filename), '..')

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

const arg = process.argv[2] ?? '--latest'
const path = arg === '--latest' ? findLatestTrace() : resolve(arg)
const json = JSON.parse(readFileSync(path, 'utf8'))
const events = json.traceEvents.slice().sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))

// Choose t0 = first non-metadata event with a real timestamp
const firstReal = events.find(e => e.ph !== 'M' && (e.ts ?? 0) > 0)
const t0 = firstReal ? firstReal.ts : 0

const PROCESS_LABELS = new Map()  // pid → human label

function rel(ts) {
  if (!ts || ts === 0) return '   init '
  const ms = (ts - t0) / 1000
  if (Math.abs(ms) < 1000) return `${ms.toFixed(1).padStart(7)}ms`
  return `${(ms / 1000).toFixed(2).padStart(6)}s `
}
function dur(d) {
  if (d === undefined) return ''
  if (d < 1000) return ` (${d}μs)`
  return ` (${(d / 1000).toFixed(1)}ms)`
}
function trim(s, max = 60) {
  if (typeof s !== 'string') return ''
  const safe = s.replace(/\x1b/g, '\\e').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  return safe.length <= max ? safe : safe.slice(0, max) + '…'
}
function procLabel(pid) {
  return PROCESS_LABELS.get(pid) ?? `pid${pid}`
}
function flowTag(id) {
  return id ? ` flow=${id.length > 18 ? id.slice(-18) : id}` : ''
}

function narrate(e) {
  const t = rel(e.ts)
  const d = dur(e.dur)
  const a = e.args ?? {}
  const proc = procLabel(e.pid)

  switch (e.name) {
    case 'process_name':
      PROCESS_LABELS.set(e.pid, a.name ?? `pid${e.pid}`)
      return `${t}  [meta]  Process pid=${e.pid} named "${a.name}"`
    case 'thread_name':
      return `${t}  [meta]  Thread (pid=${e.pid}, tid=${e.tid}) named "${a.name}"`
    case 'trace.session.start':
      return `${t}  ${proc}/main  Trace session began — schema=${a.schema}, content=${a.contentCaptured}, flushSec=${a.flushIntervalSec ?? '?'}`
    case 'trace.session.flush':
      return `${t}  ${proc}/main  Trace flushed (${a.reason}): ${a.eventCount} events${a.droppedEvents ? ` — ${a.droppedEvents} dropped` : ''}${d}`
    case 'ui.prompt.edit':
      return `${t}  ${proc}/r  User edited prompt ${a.field} (${a.mode}) — ${a.payloadLength}B / ${a.payloadLineCount}lines, hash=${a.payloadHash}`
    case 'ui.prompt.task_select':
      return `${t}  ${proc}/r  User ${a.selected ? 'selected' : 'deselected'} task ${a.terminalId} (now ${a.selectedCount} active)`
    case 'ui.prompt.action':
      return `${t}  ${proc}/r  Prompt action '${a.action}' — ${(a.terminalIds || []).length} task(s)${flowTag(e.id)}${d}`
    case 'ui.prompt.action.done':
      return `${t}  ${proc}/r  Prompt action '${a.action}' finished — success=${a.successCount} failed=${a.failedCount}${flowTag(e.id)}`
    case 'ui.terminal.write':
      return `${t}  ${proc}/r  Wrote to terminal ${a.terminalId} (action=${a.action}, ${a.payloadLength}B)${flowTag(e.id)}`
    case 'ui.terminal.paste':
      return `${t}  ${proc}/r  Pasted to terminal ${a.terminalId} (${a.payloadLength}B)${flowTag(e.id)}`
    case 'ui.terminal.send_input_sequence':
      return `${t}  ${proc}/r  Sent input sequence to ${a.terminalId} (${a.kind}, ${a.payloadLength}B)${flowTag(e.id)}`
    case 'api.terminal.write':
      return `${t}  ${proc}/main  API terminal write started for ${a.terminalId} (${a.action}, ${a.payloadLength}B)${flowTag(e.id)}`
    case 'api.terminal.write.result':
      return `${t}  ${proc}/main  API terminal write result for ${a.terminalId}: status=${a.status}, delivered=${a.deliveredCount}, failed=${a.failedCount}${flowTag(e.id)}`
    case 'api.request':
      return `${t}  ${proc}/main  HTTP ${a.route} status=${a.status}${d}`
    case 'prompt.bridge':
      return `${t}  ${proc}/main  Prompt-bridge ${a.action} for ${a.terminalId} — ${a.result}${flowTag(e.id)}${d}`
    case 'prompt.bridge.send':
    case 'prompt.bridge.response':
    case 'prompt.bridge.timeout':
      return `${t}  ${proc}/main  Prompt-bridge ${e.name.split('.')[2]} for ${a.terminalId}${flowTag(e.id)}`
    case 'ipc.invoke':
      return `${t}  ${proc}/main  IPC '${a.channel}' for ${a.terminalId ?? 'global'} — ${a.result}${flowTag(e.id)}${d}`
    case 'ipc.terminal.write':
      return `${t}  ${proc}/main  IPC terminal.write for ${a.terminalId} — ${a.payloadLength}B${a.includesEnter ? ' +Enter' : ''}${flowTag(e.id)}`
    case 'ipc.terminal.send_input_sequence':
      return `${t}  ${proc}/main  IPC input-sequence for ${a.terminalId} (${a.kind}, ${a.payloadLength}B)${flowTag(e.id)}`
    case 'pty.spawn':
      return `${t}  ${proc}/main  PTY spawned ${a.terminalId} — ${a.cols}×${a.rows}, kind=${a.commandKind ?? 'shell'}${d}`
    case 'pty.write':
      return `${t}  ${proc}/main  PTY write to ${a.terminalId} — ${a.payloadLength}B${a.includesEnter ? ' +Enter' : ''} (${a.writeMode}) — ${a.result}${flowTag(e.id)}${d}`
    case 'pty.send_input_sequence':
      return `${t}  ${proc}/main  PTY input-sequence to ${a.terminalId} — ${a.payloadLength}B (phase=${a.phase})${flowTag(e.id)}${d}`
    case 'pty.resize':
      return `${t}  ${proc}/main  PTY resize ${a.terminalId} to ${a.cols}×${a.rows} — ${a.result}${d}`
    case 'pty.dispose':
      return `${t}  ${proc}/main  PTY disposed ${a.terminalId} — ${a.result}${d}`
    case 'pty.shutdown_all':
      return `${t}  ${proc}/main  PTY shutdown-all total=${a.total} closed=${a.closed} timedOut=${a.timedOut}${d}`
    case 'pty.output':
      return `${t}  ${proc}/main  PTY ${a.terminalId} emitted ${a.bytes}B${a.bracketedPasteMode ? ' [bracketed-paste]' : ''}${flowTag(e.id)}`
    case 'terminal.buffer.flush':
      return `${t}  ${proc}/main  Buffer flush ${a.terminalId} → renderer: ${a.bytes}B in ${a.chunkCount} chunks${d}`
    case 'terminal.ipc.send':
      return `${t}  ${proc}/main  webContents.send('terminal:data') ${a.terminalId}: ${a.bytes}B${flowTag(e.id)}`
    case 'terminal.render.receive':
      return `${t}  ${proc}/r  Renderer received ${a.terminalId} chunk: ${a.bytes}B (visible=${a.visible})${flowTag(e.id)}`
    case 'terminal.render.flush':
      return `${t}  ${proc}/r  xterm.write ${a.terminalId}: ${a.bytes}B (xtermDur=${a.xtermDurationMs}ms, pending=${a.pendingBytes ?? 0}B)${flowTag(e.id)}${d}`
    case 'terminal.render.hidden_buffer':
      return `${t}  ${proc}/r  Hidden terminal buffered ${a.terminalId}: ${a.pendingBytes}B pending`
    case 'terminal.input':
      return `${t}  ${proc}/r  User typed in terminal ${a.terminalId}: ${a.payloadLength ?? a.bytes}B${a.includesEnter ? ' +Enter' : ''}`
    case 'terminal.task.state':
      return `${t}  ${proc}/task  Task ${a.terminalId} → ${a.state}${a.reason ? ` (${a.reason})` : ''}${a.bytes ? ` ${a.bytes}B` : ''}${flowTag(a.flowId)}`
    case 'coding_agent.prepare':
      return `${t}  ${proc}/main  Coding-agent prepare ${a.commandKind} — ${a.result}${d}`
    case 'coding_agent.launch':
      return `${t}  ${proc}/main  Coding-agent launch ${a.commandKind} on ${a.terminalId} — ${a.result}${d}`
    case 'coding_agent.launch.error':
      return `${t}  ${proc}/main  Coding-agent launch failed on ${a.terminalId ?? 'unknown'}${a.reason ? ` — ${a.reason}` : ''}${flowTag(e.id)}`
    case 'coding_agent.pty.spawned':
      return `${t}  ${proc}/main  Coding-agent PTY spawned for ${a.terminalId}${flowTag(e.id)}`
    case 'perf.renderer.snapshot':
      return `${t}  ${proc}/r  Perf snapshot — fps=${a.fps} drops=${a.frameDrops} writes=${a.xtermWriteCount} ipc=${a.ipcDataMsgCount}`
    case 'git.runtime.task':
      return `${t}  ${proc}/main  Git runtime task ${a.kind}/${a.priority} — queue=${a.queueDepth} inflight=${a.inflight}, ${a.result ?? 'pending'}${d}`
    case 'markdown.render.worker':
      return `${t}  ${proc}/r  Markdown worker rendered ${a.contentLength}B to ${a.outputLength}B with ${a.imageCount} image(s)${d}`
    case 'project_editor.render.apply':
      return `${t}  ${proc}/r  Project Editor applied Markdown preview ${a.outputLength}B (${a.imageCount} image(s), dompurify=${a.dompurifyDurationMs}ms)${d}`
    default:
      return `${t}  ${proc}/${e.tid}  ${e.name} ph=${e.ph}${d} ${trim(JSON.stringify(a), 80)}`
  }
}

console.log(`# Performance-trace narration — ${path.replace(homedir(), '~')}`)
console.log(`# ${events.length} events; t0 = first non-metadata event\n`)
for (const e of events) console.log(narrate(e))
