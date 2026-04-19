/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const fs = require('fs')
const path = require('path')

const outputPath = process.argv[2]

if (!outputPath) {
  console.error('[PROMPT_SHELL_READY] missing output path')
  process.exit(1)
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, 'ready')
process.stdout.write(`[PROMPT_SHELL_READY] ${path.basename(outputPath)}`)
