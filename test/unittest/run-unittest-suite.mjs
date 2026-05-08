/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const unitDir = join(repoRoot, 'test', 'unittest')
const files = readdirSync(unitDir).sort()

const mtsTests = files
  .filter((name) => name.endsWith('.test.mts'))
  .map((name) => join(unitDir, name))
const mjsNodeTests = files
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => join(unitDir, name))
const standaloneUnits = files
  .filter((name) => name.endsWith('-unit.mjs'))
  .map((name) => join(unitDir, name))

function run(label, args) {
  console.log(`\n[unittest-suite] ${label}`)
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

if (mtsTests.length > 0) {
  run('Node TS strip tests', ['--experimental-strip-types', '--test', ...mtsTests])
}
if (mjsNodeTests.length > 0) {
  run('Node mjs tests', ['--test', ...mjsNodeTests])
}
for (const unit of standaloneUnits) {
  run(`Standalone ${unit.slice(unitDir.length + 1)}`, [unit])
}

console.log('\n[unittest-suite] PASS')
