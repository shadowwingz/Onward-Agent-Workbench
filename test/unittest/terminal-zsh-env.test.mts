/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for zsh shell-integration environment selection. Pair with
 * `run-terminal-autofollow` TA-00c, which proves the packaged Task PTY
 * loads the selected user ZDOTDIR through the zsh wrapper.
 *
 * Usage: node --experimental-strip-types --test test/unittest/terminal-zsh-env.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isOnwardZshIntegrationZdotdir,
  resolveUserZdotdirForShellIntegration
} from '../../electron/main/terminal-env.ts'

const HOME_DIR = '/Users/example'
const CURRENT_WRAPPER = '/Applications/Onward.app/Contents/Resources/resources/shell-integration/zsh-zdotdir'
const OTHER_WRAPPER = '/Users/example/worktree/release/mac-arm64/Under Development.app/Contents/Resources/resources/shell-integration/zsh-zdotdir'

test('TZE-U-01 detects current and inherited Onward zsh wrapper ZDOTDIR values', () => {
  assert.equal(isOnwardZshIntegrationZdotdir(CURRENT_WRAPPER, CURRENT_WRAPPER), true)
  assert.equal(isOnwardZshIntegrationZdotdir(OTHER_WRAPPER, CURRENT_WRAPPER), true)
  assert.equal(isOnwardZshIntegrationZdotdir(`${OTHER_WRAPPER}/`, CURRENT_WRAPPER), true)
})

test('TZE-U-02 preserves a real custom user ZDOTDIR', () => {
  const env = { ZDOTDIR: '/Users/example/.config/zsh' }

  assert.equal(resolveUserZdotdirForShellIntegration(env, HOME_DIR, CURRENT_WRAPPER), '/Users/example/.config/zsh')
})

test('TZE-U-03 rejects inherited Onward wrapper ZDOTDIR and falls back to home', () => {
  const env = { ZDOTDIR: OTHER_WRAPPER }

  assert.equal(resolveUserZdotdirForShellIntegration(env, HOME_DIR, CURRENT_WRAPPER), HOME_DIR)
})

test('TZE-U-04 prefers explicit USER_ZDOTDIR over an inherited Onward wrapper', () => {
  const env = {
    ZDOTDIR: OTHER_WRAPPER,
    USER_ZDOTDIR: '/tmp/onward-autotest-user-zdotdir'
  }

  assert.equal(
    resolveUserZdotdirForShellIntegration(env, HOME_DIR, CURRENT_WRAPPER),
    '/tmp/onward-autotest-user-zdotdir'
  )
})

test('TZE-U-05 rejects inherited wrapper values on Windows-style paths', () => {
  const current = 'C:\\Program Files\\Onward\\resources\\shell-integration\\zsh-zdotdir'
  const inherited = 'D:\\worktrees\\Onward\\resources\\shell-integration\\zsh-zdotdir'

  assert.equal(isOnwardZshIntegrationZdotdir(inherited, current), true)
  assert.equal(resolveUserZdotdirForShellIntegration({ ZDOTDIR: inherited }, 'C:\\Users\\example', current), 'C:\\Users\\example')
})
