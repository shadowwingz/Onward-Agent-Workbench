/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeTerminalCwdCandidate,
  parseOsc1337Cwd,
  parseOsc633Cwd,
  parseOsc7Cwd,
  parseOsc9Cwd,
  parseTerminalCwdOsc
} from '../../src/utils/terminal-cwd-osc.ts'

test('terminal cwd candidates accept absolute, home, and Windows roots only', () => {
  assert.equal(normalizeTerminalCwdCandidate('/Users/example/repo'), '/Users/example/repo')
  assert.equal(normalizeTerminalCwdCandidate('~/Projects/repo'), '~/Projects/repo')
  assert.equal(normalizeTerminalCwdCandidate('C:\\Users\\example\\repo'), 'C:\\Users\\example\\repo')
  assert.equal(normalizeTerminalCwdCandidate('C:/Users/example/repo'), 'C:/Users/example/repo')
  assert.equal(normalizeTerminalCwdCandidate('relative/repo'), null)
  assert.equal(normalizeTerminalCwdCandidate('Claude is waiting for your input'), null)
  assert.equal(normalizeTerminalCwdCandidate('/Users/example/repo\nbad'), null)
})

test('OSC 9 cwd parser rejects non-cwd terminal notifications', () => {
  assert.equal(parseOsc9Cwd('/Claude is waiting for your input'), null)
  assert.equal(parseOsc9Cwd('Claude is waiting for your input'), null)
  assert.equal(parseOsc9Cwd('9;/Users/example/repo'), '/Users/example/repo')
  assert.equal(parseOsc9Cwd('9;C:\\Users\\example\\repo'), 'C:\\Users\\example\\repo')
})

test('terminal cwd OSC parsers keep supported cwd dialects intact', () => {
  assert.equal(parseOsc633Cwd('P;Cwd=~/Projects/repo'), '~/Projects/repo')
  assert.equal(parseOsc633Cwd('P;Prompt=ready'), null)
  assert.equal(parseOsc7Cwd('file://host/Users/example/Project%20Forward'), '/Users/example/Project Forward')
  assert.equal(parseOsc7Cwd('file://host/C:/Users/example/repo'), 'C:/Users/example/repo')
  assert.equal(parseOsc1337Cwd('CurrentDir=/Users/example/repo'), '/Users/example/repo')
  assert.equal(parseTerminalCwdOsc('osc9', '9;/Users/example/repo'), '/Users/example/repo')
})
