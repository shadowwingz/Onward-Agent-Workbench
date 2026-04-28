/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fixtureRoot = resolve(repoRoot, 'test', 'autotest', 'fixtures', 'prompt-input-longtail')
const sharedFixtureRoot = resolve(repoRoot, 'test', 'autotest', 'fixtures', 'terminal-architecture-baseline')
const seedDir = resolve(sharedFixtureRoot, 'seed')
const loadGeneratorPath = resolve(sharedFixtureRoot, 'load-generator.mjs')
const taskWorkloadPath = resolve(fixtureRoot, 'task-workload.mjs')
const workdir = resolve(fixtureRoot, 'workdir')
const marker = 'ONWARD_PROMPT_INPUT_LONGTAIL_TOKEN'

function assertInsideFixture(target) {
  const rel = relative(fixtureRoot, target)
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || rel === '') {
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

if (!existsSync(seedDir)) {
  throw new Error(`Missing shared seed fixture: ${seedDir}`)
}
if (!existsSync(loadGeneratorPath)) {
  throw new Error(`Missing load generator fixture: ${loadGeneratorPath}`)
}
if (!existsSync(taskWorkloadPath)) {
  throw new Error(`Missing task workload fixture: ${taskWorkloadPath}`)
}

mkdirSync(fixtureRoot, { recursive: true })
clearWorkdir()
cpSync(seedDir, workdir, { recursive: true })

const trackedDir = join(workdir, 'src', 'longtail-tracked')
const modifiedDir = join(workdir, 'src', 'longtail-modified')
const docsDir = join(workdir, 'docs', 'longtail')
const untrackedDir = join(workdir, 'longtail-untracked')
mkdirSync(trackedDir, { recursive: true })
mkdirSync(modifiedDir, { recursive: true })
mkdirSync(docsDir, { recursive: true })
mkdirSync(untrackedDir, { recursive: true })

for (let i = 0; i < 1200; i++) {
  const padded = String(i).padStart(4, '0')
  writeFileSync(
    join(trackedDir, `tracked-${padded}.ts`),
    [
      '/*',
      ' * SPDX-FileCopyrightText: 2026 OPPO',
      ' * SPDX-License-Identifier: Apache-2.0',
      ' */',
      '',
      `export const LONGTAIL_TRACKED_${padded} = '${marker}_${padded}'`,
      ''
    ].join('\n')
  )
}

for (let i = 0; i < 300; i++) {
  const padded = String(i).padStart(4, '0')
  writeFileSync(
    join(modifiedDir, `modified-${padded}.ts`),
    [
      '/*',
      ' * SPDX-FileCopyrightText: 2026 OPPO',
      ' * SPDX-License-Identifier: Apache-2.0',
      ' */',
      '',
      `export const LONGTAIL_MODIFIED_${padded} = '${marker}_before_${padded}'`,
      ''
    ].join('\n')
  )
}

for (let i = 0; i < 200; i++) {
  const padded = String(i).padStart(4, '0')
  writeFileSync(
    join(docsDir, `note-${padded}.md`),
    [
      '<!-- SPDX-FileCopyrightText: 2026 OPPO -->',
      '<!-- SPDX-License-Identifier: Apache-2.0 -->',
      '',
      `# Longtail Fixture ${padded}`,
      '',
      `${marker} makes status and search pressure deterministic.`,
      ''
    ].join('\n')
  )
}

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0
let gitPrepared = false

if (gitAvailable) {
  runGit(['init'])
  runGit(['config', 'user.name', 'Onward Prompt Longtail'])
  runGit(['config', 'user.email', 'prompt-longtail@example.com'])
  runGit(['add', '-f', '.'])
  runGit(['commit', '-m', 'prompt input longtail fixture'])

  for (let i = 0; i < 40; i++) {
    const padded = String(i).padStart(3, '0')
    writeFileSync(
      join(docsDir, `history-${padded}.md`),
      [
        '<!-- SPDX-FileCopyrightText: 2026 OPPO -->',
        '<!-- SPDX-License-Identifier: Apache-2.0 -->',
        '',
        `# History Pressure ${padded}`,
        '',
        `${marker} history pressure commit ${padded}`,
        ''
      ].join('\n')
    )
    runGit(['add', '-f', join('docs', 'longtail', `history-${padded}.md`)])
    runGit(['commit', '-m', `prompt input longtail history ${padded}`])
  }

  for (let i = 0; i < 300; i++) {
    const padded = String(i).padStart(4, '0')
    writeFileSync(
      join(modifiedDir, `modified-${padded}.ts`),
      [
        '/*',
        ' * SPDX-FileCopyrightText: 2026 OPPO',
        ' * SPDX-License-Identifier: Apache-2.0',
        ' */',
        '',
        `export const LONGTAIL_MODIFIED_${padded} = '${marker}_after_${padded}'`,
        ''
      ].join('\n')
    )
  }

  for (let i = 0; i < 2400; i++) {
    const group = String(Math.floor(i / 100)).padStart(2, '0')
    const padded = String(i).padStart(4, '0')
    const dir = join(untrackedDir, group)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `untracked-${padded}.txt`),
      `${marker} untracked prompt longtail file ${padded}\n`
    )
  }
  gitPrepared = true
}

copyFileSync(loadGeneratorPath, join(fixtureRoot, 'load-generator.mjs'))
copyFileSync(loadGeneratorPath, join(workdir, 'load-generator.mjs'))
copyFileSync(taskWorkloadPath, join(workdir, 'task-workload.mjs'))

const summary = {
  fixtureRoot,
  workdir,
  marker,
  trackedSourceFiles: 1200,
  modifiedSourceFiles: 300,
  generatedMarkdownFiles: 200,
  historyCommits: 40,
  untrackedFiles: 2400,
  gitAvailable,
  gitPrepared
}

writeFileSync(join(workdir, 'fixture-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
