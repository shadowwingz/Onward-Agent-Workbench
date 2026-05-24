/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types test/unittest/project-editor-large-file-policy.test.mts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyProjectTextRead,
  PROJECT_TEXT_EAGER_LIMIT,
  PROJECT_TEXT_WARNING_SIZE
} from '../../electron/main/project-editor-large-file-policy.ts'

test('Project Editor opens text above the old warning threshold without confirmation', async () => {
  const policy = classifyProjectTextRead(PROJECT_TEXT_WARNING_SIZE + 1024)

  assert.equal(policy.requiresConfirmation, false)
  assert.equal(policy.eagerRead, true)
  assert.equal(policy.openMode, 'text')
  assert.equal(policy.readOnly, false)
})

test('Project Editor opens huge text directly in chunked read-only mode', async () => {
  const policy = classifyProjectTextRead(PROJECT_TEXT_EAGER_LIMIT + 1024)

  assert.equal(policy.requiresConfirmation, false)
  assert.equal(policy.eagerRead, false)
  assert.equal(policy.openMode, 'large-text')
  assert.equal(policy.readOnly, true)
})
