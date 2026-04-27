/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

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

const label = args.get('label') || 'terminal-baseline'
const intervalMs = numberArg('interval-ms', 12)
const batchSize = numberArg('batch', 64)
const durationMs = numberArg('duration-ms', 0)
const payload = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
let count = 0

function emitBatch() {
  let output = ''
  for (let i = 0; i < batchSize; i++) {
    output += `${label} output ${String(count++).padStart(8, '0')} ${payload}\n`
  }
  process.stdout.write(output)
}

const interval = setInterval(emitBatch, intervalMs)
emitBatch()

if (durationMs > 0) {
  setTimeout(() => {
    clearInterval(interval)
    process.exit(0)
  }, durationMs)
}

process.on('SIGINT', () => {
  clearInterval(interval)
  process.exit(0)
})
