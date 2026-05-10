#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
//
// Node wrapper that runs a child command with a wall-clock timeout.
// Fresh macOS hosts ship without `gtimeout`; this keeps the full
// regression reproducible on any dev machine.
//
// Usage:
//   node test/autotest/run-with-timeout.mjs <seconds> <cmd> [args...]
//
// Behaviour:
//   - Spawns <cmd> [args...] with stdio inherited.
//   - Starts a timer at <seconds>. On fire, terminates the whole child
//     process tree; 10 s later, force-kills anything still alive.
//   - Exits 124 on timeout, 127 on spawn error, otherwise the child's
//     exit code. Signal-caused exits are reported as 128 + (9 or 15).

import { spawn, spawnSync } from 'node:child_process'

const timeoutSec = Number(process.argv[2])
const cmd = process.argv[3]
const args = process.argv.slice(4)

if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
  console.error('usage: node run-with-timeout.mjs <seconds> <cmd> [args...]')
  process.exit(2)
}

const isWindows = process.platform === 'win32'
const child = spawn(cmd, args, {
  stdio: 'inherit',
  detached: !isWindows
})
let timedOut = false
let forceTimer = null

function terminateChild(signal) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (isWindows) {
    const taskkillArgs = ['/PID', String(child.pid), '/T']
    if (signal === 'SIGKILL') taskkillArgs.push('/F')
    spawnSync('taskkill.exe', taskkillArgs, { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* already exited */ }
  }
}

const killTimer = setTimeout(() => {
  timedOut = true
  console.error(`run-with-timeout: command exceeded ${timeoutSec}s, terminating process tree`)
  terminateChild('SIGTERM')
  forceTimer = setTimeout(() => {
    terminateChild('SIGKILL')
  }, 10_000).unref()
}, timeoutSec * 1000)

child.on('exit', (code, signal) => {
  clearTimeout(killTimer)
  if (forceTimer !== null) clearTimeout(forceTimer)
  if (timedOut) process.exit(124)
  if (typeof code === 'number') process.exit(code)
  if (signal) process.exit(128 + (signal === 'SIGKILL' ? 9 : 15))
  process.exit(1)
})

child.on('error', (err) => {
  clearTimeout(killTimer)
  if (forceTimer !== null) clearTimeout(forceTimer)
  console.error(err)
  process.exit(127)
})
