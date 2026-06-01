/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// fileURLToPath converts file:///D:/... to D:\... on Windows, avoiding the
// double-drive-letter (D:\D:\...) that .pathname produces on that platform.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

async function readRepoFile(path: string): Promise<string> {
  return await readFile(join(repoRoot, path), 'utf8')
}

test('autotest fixture repos are not created beside the checkout', async () => {
  const sources = [
    'src/autotest/test-subpage-navigation.ts',
    'src/autotest/test-git-history-multi-terminal-scope.ts'
  ]

  for (const sourcePath of sources) {
    const source = await readRepoFile(sourcePath)
    assert.doesNotMatch(
      source,
      /joinPath\(\s*dirname\(\s*(?:ctx\.)?rootPath\s*\)\s*,\s*`onward-autotest-/,
      `${sourcePath} must use an isolated fixture base instead of dirname(rootPath)`
    )
  }
})

test('affected autotest runners own and clean their fixture base', async () => {
  const runners = [
    {
      path: 'test/autotest/run-subpage-navigation-autotest.sh',
      fixtureVar: 'FIXTURE_BASE',
      cleanupPattern: /rm -rf "\$FIXTURE_BASE"/
    },
    {
      path: 'test/autotest/run-git-history-multi-terminal-scope-autotest.sh',
      fixtureVar: 'FIXTURE_BASE',
      cleanupPattern: /rm -rf "\$FIXTURE_BASE"/
    },
    {
      path: 'test/autotest/run-subpage-navigation-autotest.ps1',
      fixtureVar: '$FixtureBase',
      cleanupPattern: /Remove-Item -Recurse -Force \$UserDataDir, \$FixtureBase/
    },
    {
      path: 'test/autotest/run-git-history-multi-terminal-scope-autotest.ps1',
      fixtureVar: '$FixtureBase',
      cleanupPattern: /Remove-Item -Recurse -Force \$UserDataDir, \$FixtureBase/
    }
  ]

  for (const runner of runners) {
    const source = await readRepoFile(runner.path)
    assert.match(source, /ONWARD_AUTOTEST_FIXTURE_EXTRA/, `${runner.path} must pass a fixture base to the app`)
    assert.match(source, runner.cleanupPattern, `${runner.path} must delete its fixture base on exit`)
    assert.match(source, new RegExp(runner.fixtureVar.replace('$', '\\$')), `${runner.path} must declare a fixture base variable`)
  }
})
