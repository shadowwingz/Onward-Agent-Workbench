#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const runtimeRoot = join(repoRoot, 'test/autotest/fixtures/git-large-file-confirmation/runtime')
const fixtureRoot = join(runtimeRoot, 'repo')
const largeFile = 'large.py'
const targetBytes = 3 * 1024 * 1024 + 128 * 1024

function runGit(args, cwd = fixtureRoot) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Onward AutoTest',
      GIT_AUTHOR_EMAIL: 'autotest@example.com',
      GIT_COMMITTER_NAME: 'Onward AutoTest',
      GIT_COMMITTER_EMAIL: 'autotest@example.com'
    }
  })
}

function buildLargePython(marker) {
  const header = `# ${marker}\nVALUE = "${marker}"\n`
  const line = `print("${marker}:${'x'.repeat(4096)}")\n`
  const repeats = Math.ceil((targetBytes - header.length) / line.length)
  return `${header}${line.repeat(repeats)}`.slice(0, targetBytes)
}

rmSync(runtimeRoot, { recursive: true, force: true })
mkdirSync(fixtureRoot, { recursive: true })

runGit(['init'])
runGit(['config', 'user.name', 'Onward AutoTest'])
runGit(['config', 'user.email', 'autotest@example.com'])
runGit(['config', 'commit.gpgsign', 'false'])

writeFileSync(join(fixtureRoot, largeFile), '# base\nprint("base")\n')
runGit(['add', largeFile])
runGit(['commit', '-m', 'base small file'])

writeFileSync(join(fixtureRoot, largeFile), buildLargePython('HISTORY_LARGE_MARKER'))
runGit(['add', largeFile])
runGit(['commit', '-m', 'history large file'])

writeFileSync(join(fixtureRoot, largeFile), buildLargePython('DIFF_LARGE_MARKER'))

const manifestPath = join(runtimeRoot, 'manifest.json')
const manifest = {
  fixtureRoot,
  largeFile,
  historyMarker: 'HISTORY_LARGE_MARKER',
  diffMarker: 'DIFF_LARGE_MARKER'
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

process.stdout.write(JSON.stringify({ ...manifest, manifestPath }))
