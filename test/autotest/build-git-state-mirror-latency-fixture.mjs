#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot fixture builder for the git-state-mirror-latency autotest.
 *
 * Run once at fixture-authoring time:
 *   node test/autotest/build-git-state-mirror-latency-fixture.mjs
 *
 * Produces 6 *.tar.gz tarballs under test/autotest/fixtures/git-state-mirror-latency/,
 * which are then committed to the repo. The runner extracts them at every
 * autotest session start, so the runtime cost is a few `tar xzf` calls
 * (no git invocations, no fixture rebuild).
 *
 * Each repo embodies a distinct (branch, status) tuple so the latency suite
 * can verify both the branch text and the status colour transition at a single
 * cd boundary:
 *
 *   repo-A             clean       branch=feature-a
 *   repo-B             clean       branch=main
 *   repo-modified      M           branch=dirty-yellow
 *   repo-untracked     ??          branch=dirty-purple
 *   repo-mixed         M+A+??      branch=dirty-mixed   (added wins → purple)
 *   non-git-dir        n/a         not a git repo
 *
 * Re-running this script wipes and rebuilds; intended only when the fixture
 * shape changes (a new state needs covering, etc.). The committed tarballs
 * remain the source of truth for CI and developers.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = resolve(__dirname, 'fixtures', 'git-state-mirror-latency')
const stagingRoot = join(tmpdir(), `onward-gsm-fixture-${process.pid}`)

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Onward AutoTest',
      GIT_AUTHOR_EMAIL: 'autotest@example.com',
      GIT_COMMITTER_NAME: 'Onward AutoTest',
      GIT_COMMITTER_EMAIL: 'autotest@example.com'
    }
  })
}

function initRepo(absPath, branch, files, commitMessage) {
  mkdirSync(absPath, { recursive: true })
  git(absPath, ['init', '-b', branch])
  for (const [rel, content] of Object.entries(files)) {
    const full = join(absPath, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  git(absPath, ['add', '.'])
  git(absPath, ['commit', '-m', commitMessage])
}

function writeFile(absRepo, rel, content) {
  const full = join(absRepo, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

function tarball(repoName) {
  // GNU tar / bsd tar / Windows tar accept -czf consistently. We tarball
  // the entire `repoName/` directory (including .git/) so extraction
  // restores the repo as-is. --sort=name keeps the tarball deterministic
  // when GNU tar is in use; bsd tar (macOS default) silently ignores it.
  const tarPath = join(fixtureRoot, `${repoName}.tar.gz`)
  const result = spawnSync(
    'tar',
    ['--sort=name', '-czf', tarPath, '-C', stagingRoot, repoName],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  if (result.status !== 0) {
    // Retry without --sort=name for bsd tar on older macOS where the flag
    // triggers an error rather than being silently ignored.
    const fallback = spawnSync(
      'tar',
      ['-czf', tarPath, '-C', stagingRoot, repoName],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    if (fallback.status !== 0) {
      throw new Error(`tar failed for ${repoName}: ${fallback.stderr?.toString()}`)
    }
  }
  return tarPath
}

// --- Wipe staging + previous tarballs, recreate fixture root ---
rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(stagingRoot, { recursive: true })
mkdirSync(fixtureRoot, { recursive: true })
for (const old of ['repo-A.tar.gz', 'repo-B.tar.gz', 'repo-modified.tar.gz', 'repo-untracked.tar.gz', 'repo-mixed.tar.gz', 'non-git-dir.tar.gz']) {
  const oldPath = join(fixtureRoot, old)
  if (existsSync(oldPath)) rmSync(oldPath)
}

// --- repo-A: clean, branch feature-a ---
{
  const repo = join(stagingRoot, 'repo-A')
  initRepo(repo, 'feature-a', {
    'README.md': '# repo-A\n\nClean fixture, branch feature-a.\n',
    'src/main.ts': 'export const REPO = "A"\n'
  }, 'Initial commit on feature-a')
  tarball('repo-A')
}

// --- repo-B: clean, branch main ---
{
  const repo = join(stagingRoot, 'repo-B')
  initRepo(repo, 'main', {
    'README.md': '# repo-B\n\nClean fixture, branch main.\n',
    'app.ts': 'export const REPO = "B"\n'
  }, 'Initial commit on main')
  tarball('repo-B')
}

// --- repo-modified: M only, branch dirty-yellow ---
{
  const repo = join(stagingRoot, 'repo-modified')
  initRepo(repo, 'dirty-yellow', {
    'README.md': '# repo-modified\n\nFixture for the modified (yellow) status colour.\n',
    'src/main.ts': 'export const VERSION = "v0"\n'
  }, 'Initial commit on dirty-yellow')
  // Modify a tracked file without staging — produces porcelain " M" status.
  writeFile(repo, 'src/main.ts', 'export const VERSION = "v1-modified"\n')
  tarball('repo-modified')
}

// --- repo-untracked: ?? only, branch dirty-purple ---
{
  const repo = join(stagingRoot, 'repo-untracked')
  initRepo(repo, 'dirty-purple', {
    'README.md': '# repo-untracked\n\nFixture for the added (purple) status colour via an untracked file.\n'
  }, 'Initial commit on dirty-purple')
  // Drop an untracked file — produces porcelain "??" status.
  writeFile(repo, 'untracked.txt', 'not yet tracked\n')
  tarball('repo-untracked')
}

// --- repo-mixed: M + A staged + ??, branch dirty-mixed (verifies "added > modified" precedence) ---
{
  const repo = join(stagingRoot, 'repo-mixed')
  initRepo(repo, 'dirty-mixed', {
    'README.md': '# repo-mixed\n\nFixture for "added wins" colour precedence over modified.\n',
    'src/main.ts': 'export const VERSION = "v0"\n'
  }, 'Initial commit on dirty-mixed')
  // Modify tracked → " M".
  writeFile(repo, 'src/main.ts', 'export const VERSION = "v1-modified"\n')
  // Add a new file to the index → "A " staged.
  writeFile(repo, 'src/added.ts', 'export const ADDED = true\n')
  git(repo, ['add', 'src/added.ts'])
  // Drop another untracked file → "??".
  writeFile(repo, 'untracked.txt', 'still untracked\n')
  tarball('repo-mixed')
}

// --- non-git-dir: plain directory, no .git ---
{
  const repo = join(stagingRoot, 'non-git-dir')
  mkdirSync(repo, { recursive: true })
  writeFile(repo, 'README.md', '# non-git-dir\n\nNot a git repository — fixture for the unknown / no-status code path.\n')
  writeFile(repo, 'note.txt', 'plain text file outside any repo\n')
  tarball('non-git-dir')
}

// --- Manifest the runner reads at startup ---
const manifest = {
  repos: [
    { name: 'repo-A',          branch: 'feature-a',    expectedStatus: 'clean'    },
    { name: 'repo-B',          branch: 'main',         expectedStatus: 'clean'    },
    { name: 'repo-modified',   branch: 'dirty-yellow', expectedStatus: 'modified' },
    { name: 'repo-untracked',  branch: 'dirty-purple', expectedStatus: 'added'    },
    { name: 'repo-mixed',      branch: 'dirty-mixed',  expectedStatus: 'added'    },
    { name: 'non-git-dir',     branch: null,           expectedStatus: 'unknown'  }
  ]
}
writeFileSync(join(fixtureRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

// Cleanup the staging dir; tarballs are the committed artefacts.
rmSync(stagingRoot, { recursive: true, force: true })

console.log('Built tarballs in:', fixtureRoot)
for (const repo of manifest.repos) {
  console.log(`  - ${repo.name}.tar.gz   (branch=${repo.branch ?? 'n/a'}, expectedStatus=${repo.expectedStatus})`)
}
console.log('  - manifest.json')
console.log('\nNow `git add` the tarballs + manifest.json and commit.')
