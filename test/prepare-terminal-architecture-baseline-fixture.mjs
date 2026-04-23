/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = resolve(repoRoot, 'test', 'fixtures', 'terminal-architecture-baseline')
const seedDir = resolve(fixtureRoot, 'seed')
const workdir = resolve(fixtureRoot, 'workdir')
const marker = 'ONWARD_TERMINAL_BASELINE_TOKEN'

function assertInsideFixture(target) {
  const rel = relative(fixtureRoot, target)
  if (rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || rel === '') {
    throw new Error(`Refusing to operate outside fixture root: ${target}`)
  }
}

function clearWorkdir() {
  assertInsideFixture(workdir)
  mkdirSync(workdir, { recursive: true })
  for (const entry of readdirSync(workdir, { withFileTypes: true })) {
    if (entry.name === '.gitignore' || entry.name === '.gitkeep') continue
    const fullPath = join(workdir, entry.name)
    rmSync(fullPath, { recursive: true, force: true })
  }
}

function runGit(args, allowFailure = false) {
  const result = spawnSync('git', args, {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result
}

clearWorkdir()
cpSync(seedDir, workdir, { recursive: true })

const generatedSrc = join(workdir, 'src', 'generated')
const generatedDocs = join(workdir, 'docs', 'generated')
mkdirSync(generatedSrc, { recursive: true })
mkdirSync(generatedDocs, { recursive: true })

for (let i = 0; i < 80; i++) {
  const padded = String(i).padStart(3, '0')
  writeFileSync(
    join(generatedSrc, `baseline-module-${padded}.ts`),
    [
      '/*',
      ' * SPDX-FileCopyrightText: 2026 OPPO',
      ' * SPDX-License-Identifier: Apache-2.0',
      ' */',
      '',
      `export const BASELINE_VALUE_${padded} = '${marker}_${padded}'`,
      '',
      `export function baselineFunction${padded}(input: string): string {`,
      `  return input + ':' + BASELINE_VALUE_${padded}`,
      '}',
      ''
    ].join('\n')
  )
}

for (let i = 0; i < 40; i++) {
  const padded = String(i).padStart(3, '0')
  writeFileSync(
    join(generatedDocs, `baseline-note-${padded}.md`),
    [
      '<!-- SPDX-FileCopyrightText: 2026 OPPO -->',
      '<!-- SPDX-License-Identifier: Apache-2.0 -->',
      '',
      `# Baseline Note ${padded}`,
      '',
      `${marker} appears here for deterministic project search pressure.`,
      ''
    ].join('\n')
  )
}

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0
let gitPrepared = false

if (gitAvailable) {
  runGit(['init'])
  runGit(['config', 'user.name', 'Onward Baseline'])
  runGit(['config', 'user.email', 'baseline@example.com'])
  runGit(['add', '-f', '.'])
  runGit(['commit', '-m', 'baseline fixture'])

  for (let i = 0; i < 40; i++) {
    const padded = String(i).padStart(3, '0')
    writeFileSync(
      join(generatedSrc, `baseline-module-${padded}.ts`),
      [
        '/*',
        ' * SPDX-FileCopyrightText: 2026 OPPO',
        ' * SPDX-License-Identifier: Apache-2.0',
        ' */',
        '',
        `export const BASELINE_VALUE_${padded} = '${marker}_${padded}_modified'`,
        '',
        `export function baselineFunction${padded}(input: string): string {`,
        `  return input.toUpperCase() + ':' + BASELINE_VALUE_${padded}`,
        '}',
        ''
      ].join('\n')
    )
  }

  for (let i = 0; i < 20; i++) {
    const padded = String(i).padStart(3, '0')
    writeFileSync(
      join(workdir, `untracked-baseline-${padded}.txt`),
      `${marker} untracked baseline file ${padded}\n`
    )
  }
  gitPrepared = true
}

copyFileSync(
  join(fixtureRoot, 'load-generator.mjs'),
  join(workdir, 'load-generator.mjs')
)

const summary = {
  fixtureRoot,
  workdir,
  marker,
  generatedSourceFiles: 80,
  generatedMarkdownFiles: 40,
  gitAvailable,
  gitPrepared
}

writeFileSync(join(workdir, 'fixture-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
