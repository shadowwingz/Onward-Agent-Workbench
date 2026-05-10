/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveMonacoLanguageId,
  MONACO_PLAINTEXT_LANGUAGE_ID
} from '../../src/components/GitDiffViewer/monacoLanguageMap.ts'

test('resolveMonacoLanguageId: extension cases', () => {
  assert.equal(resolveMonacoLanguageId('foo.py'), 'python')
  assert.equal(resolveMonacoLanguageId('script.PY'), 'python')
  assert.equal(resolveMonacoLanguageId('lib/foo/bar.go'), 'go')
  assert.equal(resolveMonacoLanguageId('main.rs'), 'rust')
  assert.equal(resolveMonacoLanguageId('App.tsx'), 'typescript')
  assert.equal(resolveMonacoLanguageId('a.spec.ts'), 'typescript')
  assert.equal(resolveMonacoLanguageId('alpha.cjs'), 'javascript')
  assert.equal(resolveMonacoLanguageId('table.sql'), 'sql')
  assert.equal(resolveMonacoLanguageId('Hello.java'), 'java')
  assert.equal(resolveMonacoLanguageId('Buddy.kt'), 'kotlin')
  assert.equal(resolveMonacoLanguageId('plate.swift'), 'swift')
  assert.equal(resolveMonacoLanguageId('legacy.m'), 'objective-c')
  assert.equal(resolveMonacoLanguageId('main.cpp'), 'cpp')
  assert.equal(resolveMonacoLanguageId('helper.hpp'), 'cpp')
  assert.equal(resolveMonacoLanguageId('plain.h'), 'c')
  assert.equal(resolveMonacoLanguageId('ship.cs'), 'csharp')
  assert.equal(resolveMonacoLanguageId('runner.sh'), 'shell')
  assert.equal(resolveMonacoLanguageId('runner.PS1'), 'powershell')
  assert.equal(resolveMonacoLanguageId('runner.bat'), 'bat')
  assert.equal(resolveMonacoLanguageId('site.php'), 'php')
  assert.equal(resolveMonacoLanguageId('rocket.rb'), 'ruby')
  assert.equal(resolveMonacoLanguageId('snippets.lua'), 'lua')
  assert.equal(resolveMonacoLanguageId('component.vue'), 'html')
  assert.equal(resolveMonacoLanguageId('snippet.svelte'), 'html')
  assert.equal(resolveMonacoLanguageId('schema.graphql'), 'graphql')
  assert.equal(resolveMonacoLanguageId('plan.proto'), 'proto')
})

test('resolveMonacoLanguageId: stylesheet/markup', () => {
  assert.equal(resolveMonacoLanguageId('a.css'), 'css')
  assert.equal(resolveMonacoLanguageId('a.scss'), 'scss')
  assert.equal(resolveMonacoLanguageId('a.less'), 'less')
  assert.equal(resolveMonacoLanguageId('index.html'), 'html')
  assert.equal(resolveMonacoLanguageId('img.svg'), 'xml')
  assert.equal(resolveMonacoLanguageId('payload.xml'), 'xml')
  assert.equal(resolveMonacoLanguageId('readme.md'), 'markdown')
  assert.equal(resolveMonacoLanguageId('config.toml'), 'ini')
  assert.equal(resolveMonacoLanguageId('tsconfig.json'), 'json')
  assert.equal(resolveMonacoLanguageId('tsconfig.jsonc'), 'json')
})

test('resolveMonacoLanguageId: basename cases (no extension)', () => {
  assert.equal(resolveMonacoLanguageId('Dockerfile'), 'dockerfile')
  assert.equal(resolveMonacoLanguageId('docker/Dockerfile'), 'dockerfile')
  assert.equal(resolveMonacoLanguageId('docker\\Dockerfile'), 'dockerfile')
  assert.equal(resolveMonacoLanguageId('Containerfile'), 'dockerfile')
  assert.equal(resolveMonacoLanguageId('Makefile'), 'makefile')
  assert.equal(resolveMonacoLanguageId('GNUmakefile'), 'makefile')
  assert.equal(resolveMonacoLanguageId('Jenkinsfile'), 'groovy')
  assert.equal(resolveMonacoLanguageId('Rakefile'), 'ruby')
  assert.equal(resolveMonacoLanguageId('Gemfile'), 'ruby')
  assert.equal(resolveMonacoLanguageId('Podfile'), 'ruby')
  assert.equal(resolveMonacoLanguageId('Vagrantfile'), 'ruby')
  assert.equal(resolveMonacoLanguageId('CMakeLists.txt'), 'cmake')
  assert.equal(resolveMonacoLanguageId('.gitconfig'), 'ini')
  assert.equal(resolveMonacoLanguageId('.editorconfig'), 'ini')
})

test('resolveMonacoLanguageId: edge cases', () => {
  assert.equal(resolveMonacoLanguageId(null), MONACO_PLAINTEXT_LANGUAGE_ID)
  assert.equal(resolveMonacoLanguageId(undefined), MONACO_PLAINTEXT_LANGUAGE_ID)
  assert.equal(resolveMonacoLanguageId(''), MONACO_PLAINTEXT_LANGUAGE_ID)
  assert.equal(resolveMonacoLanguageId('NOTES'), MONACO_PLAINTEXT_LANGUAGE_ID)
  assert.equal(resolveMonacoLanguageId('archive.unknown'), MONACO_PLAINTEXT_LANGUAGE_ID)
  // Trailing dot must not be confused with extension.
  assert.equal(resolveMonacoLanguageId('weird.'), MONACO_PLAINTEXT_LANGUAGE_ID)
  // Leading dot files: rely on basename map for known ones, plaintext otherwise.
  assert.equal(resolveMonacoLanguageId('.bashrc'), 'shell')
  assert.equal(resolveMonacoLanguageId('.something_unknown'), MONACO_PLAINTEXT_LANGUAGE_ID)
})

test('resolveMonacoLanguageId: case-insensitivity', () => {
  assert.equal(resolveMonacoLanguageId('FOO.PY'), 'python')
  assert.equal(resolveMonacoLanguageId('foo.PYW'), 'python')
  assert.equal(resolveMonacoLanguageId('BUILD.YAML'), 'yaml')
  assert.equal(resolveMonacoLanguageId('build.YML'), 'yaml')
  assert.equal(resolveMonacoLanguageId('makefile'), 'makefile')
  assert.equal(resolveMonacoLanguageId('DOCKERFILE'), 'dockerfile')
})
