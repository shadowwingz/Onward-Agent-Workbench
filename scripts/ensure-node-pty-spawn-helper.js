#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { chmodSync, existsSync, statSync } = require('fs')
const { join } = require('path')

const rootDir = join(__dirname, '..')
const helperPaths = [
  join(rootDir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
  join(rootDir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-x64', 'spawn-helper')
]

let checked = 0
let fixed = 0

for (const helperPath of helperPaths) {
  if (!existsSync(helperPath)) {
    continue
  }

  checked += 1
  const stat = statSync(helperPath)
  const nextMode = stat.mode | 0o111
  if ((stat.mode & 0o111) === 0o111) {
    continue
  }

  chmodSync(helperPath, nextMode)
  fixed += 1
  console.log(`[node-pty] Added executable bit to ${helperPath}`)
}

if (checked === 0) {
  console.log('[node-pty] No macOS spawn-helper prebuilds found; skipping executable-bit check')
} else if (fixed === 0) {
  console.log(`[node-pty] spawn-helper executable-bit check passed (${checked} file${checked === 1 ? '' : 's'})`)
}
