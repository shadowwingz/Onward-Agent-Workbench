/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the pure terminal environment sanitizer. Pair with
 * `run-terminal-autofollow` TA-14/TA-15, which proves the packaged Task PTY
 * receives the sanitized environment and still transports ANSI color output.
 *
 * Usage: node --experimental-strip-types --test test/unittest/terminal-color-env.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyTerminalUserEnvVars,
  buildColorCapableTerminalEnv
} from '../../electron/main/terminal-env.ts'

test('TCE-U-01 inherited no-color flags are removed and color capability is advertised', () => {
  const env = buildColorCapableTerminalEnv({
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CLICOLOR: '0',
    COLORTERM: ''
  })

  assert.equal(env.NO_COLOR, undefined)
  assert.equal(env.FORCE_COLOR, undefined)
  assert.equal(env.CLICOLOR, '1')
  assert.equal(env.COLORTERM, 'truecolor')
})

test('TCE-U-02 non-disabling color flags are preserved', () => {
  const env = buildColorCapableTerminalEnv({
    FORCE_COLOR: '1',
    CLICOLOR: '1',
    COLORTERM: '24bit'
  })

  assert.equal(env.FORCE_COLOR, '1')
  assert.equal(env.CLICOLOR, '1')
  assert.equal(env.COLORTERM, '24bit')
})

test('TCE-U-03 environment key matching is case-insensitive', () => {
  const env = buildColorCapableTerminalEnv({
    no_color: '1',
    clicolor: '0',
    colorterm: ''
  })

  assert.equal(env.no_color, undefined)
  assert.equal(env.clicolor, undefined)
  assert.equal(env.colorterm, undefined)
  assert.equal(env.CLICOLOR, '1')
  assert.equal(env.COLORTERM, 'truecolor')
})

test('TCE-U-04 user-specified environment variables are applied after sanitizing', () => {
  const sanitized = buildColorCapableTerminalEnv({
    NO_COLOR: '1',
    CLICOLOR: '0'
  })
  const env = applyTerminalUserEnvVars(sanitized, [
    { key: '"NO_COLOR"', value: '"1"' },
    { key: 'CLICOLOR', value: '0' }
  ])

  assert.equal(env.NO_COLOR, '1')
  assert.equal(env.CLICOLOR, '0')
})
