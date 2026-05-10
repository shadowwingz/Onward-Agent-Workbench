#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'onward-gdcl-fixture-'))

function git(args) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

function write(relativePath, content) {
  const fullPath = join(root, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content)
}

const files = [
  ['.gitignore', 'out/\nrelease/\n*.log\n'],
  ['package.json', '{\n  "name": "gdcl-fixture",\n  "version": "1.0.0"\n}\n'],
  ['infra/trace.md', '# Trace Index\n\nInitial trace documentation.\n'],
  ['src/autotest/autotest-runner.ts', 'export function runSuite(name: string): string {\n  return `suite:${name}`\n}\n'],
  ['src/autotest/test-git-diff-click-latency.ts', 'export const CLICK_LATENCY_TARGET_MS = 7000\n'],
  ['src/autotest/types.ts', 'export interface FixtureShape {\n  name: string\n  count: number\n}\n'],
  ['src/components/GitDiffViewer/GitDiffDebugPanel.tsx', 'export function Panel(): string {\n  return "panel"\n}\n'],
  ['src/components/GitDiffViewer/GitDiffViewer.tsx', 'export function Viewer(): string {\n  return "viewer"\n}\n']
]

git(['init', '-q'])
git(['config', 'user.email', 'autotest@example.invalid'])
git(['config', 'user.name', 'Onward Autotest'])

for (const [relativePath, content] of files) {
  write(relativePath, content)
}

git(['add', '.'])
git(['commit', '-q', '-m', 'Initial fixture'])

for (let index = 0; index < files.length; index += 1) {
  const [relativePath, content] = files[index]
  const repeated = Array.from({ length: 8 + index }, (_, line) =>
    `export const fixtureLine${line} = ${line + index}`
  ).join('\n')
  write(relativePath, `${content}\n// Modified by GDCL fixture ${index}\n${repeated}\n`)
}

console.log(JSON.stringify({ root }))
