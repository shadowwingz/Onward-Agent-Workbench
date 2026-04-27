/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  const value = process.argv[i + 1]
  if (!key || !key.startsWith('--')) continue
  args.set(key.slice(2), value ?? '')
}

function numberArg(name, fallback) {
  const raw = args.get(name)
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const label = args.get('label') || 'prompt-longtail-task'
const intervalMs = numberArg('interval-ms', 250)
const payload = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
let count = 0
let stopped = false

function runGitStatus() {
  const startedAt = Date.now()
  const result = spawnSync(
    'git',
    ['-c', 'core.quotepath=false', 'status', '--porcelain=2', '--branch', '-uall'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    }
  )
  const durationMs = Date.now() - startedAt
  const stdout = result.stdout || ''
  const stderr = result.stderr || ''
  const lines = stdout ? stdout.split(/\r?\n/).filter(Boolean).length : 0
  const error = result.status === 0 ? '' : ` status=${result.status} stderr=${stderr.trim().slice(0, 120)}`
  process.stdout.write(`${label} status ${String(count++).padStart(6, '0')} duration=${durationMs}ms lines=${lines}${error} ${payload}\n`)
}

async function main() {
  while (!stopped) {
    runGitStatus()
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

process.on('SIGINT', () => {
  stopped = true
  process.exit(0)
})
process.on('SIGTERM', () => {
  stopped = true
  process.exit(0)
})

void main()
