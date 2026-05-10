/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  doesModelUriMatchFilePath,
  normalizeOutlinePathForCompare,
  resolveOutlineParseSource
} from '../../src/components/ProjectEditor/Outline/outlineParseSource.ts'

function model(path: string, value: string, fsPath = path) {
  return {
    uri: {
      path,
      fsPath,
      toString: () => `file://${path}`
    },
    getValue: () => value
  }
}

test('OPS-U-01 normalizes URI encoding, leading slashes, and separators', () => {
  assert.equal(
    normalizeOutlinePathForCompare('/Users/dev/project/docs/Porting%20Diff.md'),
    'users/dev/project/docs/porting diff.md'
  )
  assert.equal(
    normalizeOutlinePathForCompare('C:\\repo\\docs\\Porting Diff.md'),
    'c:/repo/docs/porting diff.md'
  )
})

test('OPS-U-02 matched Monaco model wins so live edits update outline', () => {
  const source = resolveOutlineParseSource({
    filePath: 'docs/porting-diff-analysis.md',
    contentPath: 'docs/porting-diff-analysis.md',
    content: '# Snapshot',
    model: model('/Users/dev/repo/docs/porting-diff-analysis.md', '# Live edit')
  })

  assert.equal(source.ready, true)
  assert.equal(source.source, 'matched-model')
  assert.equal(source.content, '# Live edit')
  assert.ok(source.model)
})

test('OPS-U-03 stale Monaco model is ignored during file switch', () => {
  const source = resolveOutlineParseSource({
    filePath: 'docs/porting-diff-analysis.md',
    contentPath: 'docs/porting-diff-analysis.md',
    content: '# Correct file\n\n## Section',
    model: model('/Users/dev/repo/test/autotest/fixtures/markdown-image-preview.md', '# Old file')
  })

  assert.equal(source.ready, true)
  assert.equal(source.source, 'snapshot')
  assert.equal(source.content, '# Correct file\n\n## Section')
  assert.equal(source.model, null)
})

test('OPS-U-04 waits instead of parsing old content when snapshot belongs to another file', () => {
  const source = resolveOutlineParseSource({
    filePath: 'docs/porting-diff-analysis.md',
    contentPath: 'test/autotest/fixtures/markdown-image-preview.md',
    content: '# Old file',
    model: model('/Users/dev/repo/test/autotest/fixtures/markdown-image-preview.md', '# Old file')
  })

  assert.equal(source.ready, false)
  assert.equal(source.source, 'waiting-for-snapshot')
})

test('OPS-U-05 Windows-style model path matches repo-relative file path', () => {
  assert.equal(
    doesModelUriMatchFilePath(
      model('/c:/repo/docs/porting-diff-analysis.md', '', 'C:\\repo\\docs\\porting-diff-analysis.md'),
      'docs\\porting-diff-analysis.md'
    ),
    true
  )
})
