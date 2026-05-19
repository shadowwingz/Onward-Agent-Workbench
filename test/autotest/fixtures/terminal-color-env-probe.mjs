#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const wantedKeys = [
  'TERM',
  'COLORTERM',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'FORCE_COLOR',
  'NO_COLOR',
]

function readEnvCaseInsensitive(key) {
  const actualKey = Object.keys(process.env).find(candidate => candidate.toLowerCase() === key.toLowerCase())
  return actualKey ? process.env[actualKey] : undefined
}

console.log('__AUTOTEST_COLOR_ENV_START__')
for (const key of wantedKeys) {
  const value = readEnvCaseInsensitive(key)
  if (value !== undefined) {
    console.log(`${key}=${value}`)
  }
}
process.stdout.write('\x1b[31m__AUTOTEST_COLOR_RED__\x1b[0m\n')
console.log('__AUTOTEST_COLOR_ENV_END__')
