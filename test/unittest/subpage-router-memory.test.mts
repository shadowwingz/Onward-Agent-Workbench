/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSubpageRouteCommand,
  isSubpageSwitch,
  legacyNavigateDetailToRouteCommand,
  routeCommandToNavigateDetail,
  shouldApplySubpageTargetFile
} from '../../src/components/TerminalGrid/subpageRouter.ts'
import {
  buildSubpageMemoryScopeKey,
  createSubpageStateMemory,
  normalizeSubpageMemoryScope,
  type EditorSubpageSnapshot
} from '../../src/components/TerminalGrid/subpageStateMemory.ts'
import { createSubpageLifecycleRegistry } from '../../src/components/TerminalGrid/subpageLifecycle.ts'

describe('subpage route command semantics', () => {
  it('keeps switch separate from jump even when source and target are known', () => {
    const command = buildSubpageRouteCommand({
      intent: 'switch',
      entryPoint: 'subpage-switcher',
      terminalId: 'term-1',
      from: 'diff',
      target: 'editor',
      filePath: 'src/App.tsx',
      repoRoot: '/repo'
    })

    assert.equal(isSubpageSwitch(command), true)
    assert.equal(shouldApplySubpageTargetFile(command), false)
    assert.equal(routeCommandToNavigateDetail(command).filePath, null)
  })

  it('allows jump commands to carry a target file', () => {
    const command = buildSubpageRouteCommand({
      intent: 'jump',
      entryPoint: 'deep-link',
      terminalId: 'term-1',
      from: 'diff',
      target: 'editor',
      filePath: 'src/App.tsx',
      repoRoot: '/repo',
      returnTarget: 'diff'
    })

    assert.equal(shouldApplySubpageTargetFile(command), true)
    const detail = routeCommandToNavigateDetail(command)
    assert.equal(detail.filePath, 'src/App.tsx')
    assert.equal(detail.repoRoot, '/repo')
    assert.equal(detail.intent, 'jump')
    assert.equal(detail.entryPoint, 'deep-link')
  })

  it('infers legacy navigation without a file target as a switch', () => {
    const command = legacyNavigateDetailToRouteCommand(
      { terminalId: 'term-1', target: 'history' },
      'editor'
    )

    assert.ok(command)
    assert.equal(command.intent, 'switch')
    assert.equal(command.entryPoint, 'legacy-event')
    assert.equal(command.from, 'editor')
    assert.equal(command.target, 'history')
  })

  it('infers legacy navigation with a file target as a jump', () => {
    const command = legacyNavigateDetailToRouteCommand(
      { terminalId: 'term-1', target: 'editor', filePath: 'README.md', repoRoot: '/repo' },
      'diff'
    )

    assert.ok(command)
    assert.equal(command.intent, 'jump')
    assert.equal(command.targetFile?.filePath, 'README.md')
    assert.equal(command.targetFile?.repoRoot, '/repo')
  })
})

describe('subpage state memory', () => {
  it('normalizes scope keys across path separators and trailing slashes', () => {
    const a = buildSubpageMemoryScopeKey({ terminalId: 'term-1', root: '/repo/root/' }, 'editor')
    const b = buildSubpageMemoryScopeKey({ terminalId: 'term-1', root: '/repo/root' }, 'editor')
    const c = buildSubpageMemoryScopeKey({ terminalId: 'term-1', root: '\\repo\\root\\' }, 'editor')

    assert.equal(a, b)
    assert.equal(c.includes('/repo/root'), true)
  })

  it('stores independent snapshots per subpage under the same scope', () => {
    const memory = createSubpageStateMemory()
    const scope = normalizeSubpageMemoryScope({ terminalId: 'term-1', root: '/repo' })
    const editorSnapshot: EditorSubpageSnapshot = {
      subpage: 'editor',
      activeFilePath: 'docs/a.md',
      markdownPreviewOpen: true,
      markdownEditorVisible: true,
      markdownRenderedHtmlLength: 128,
      previewRestorePhase: 'idle'
    }

    memory.save(scope, editorSnapshot, 1)
    memory.save(scope, {
      subpage: 'diff',
      selectedFilePath: 'src/App.tsx',
      selectedFileKey: 'key-1',
      scrollTop: 80,
      splitRatio: 0.55
    }, 2)

    assert.equal(memory.read(scope, 'editor')?.snapshot.activeFilePath, 'docs/a.md')
    assert.equal(memory.read(scope, 'diff')?.snapshot.selectedFilePath, 'src/App.tsx')
    assert.equal(memory.list(scope).length, 2)
  })

  it('separates snapshots by tab when tab scope is supplied', () => {
    const memory = createSubpageStateMemory()
    memory.save({ terminalId: 'term-1', root: '/repo', tabId: 'tab-a' }, {
      subpage: 'history',
      selectedShas: ['a'],
      selectionAnchor: 'a',
      selectedFilePath: 'a.md'
    }, 1)
    memory.save({ terminalId: 'term-1', root: '/repo', tabId: 'tab-b' }, {
      subpage: 'history',
      selectedShas: ['b'],
      selectionAnchor: 'b',
      selectedFilePath: 'b.md'
    }, 2)

    assert.deepEqual(memory.read({ terminalId: 'term-1', root: '/repo', tabId: 'tab-a' }, 'history')?.snapshot.selectedShas, ['a'])
    assert.deepEqual(memory.read({ terminalId: 'term-1', root: '/repo', tabId: 'tab-b' }, 'history')?.snapshot.selectedShas, ['b'])
  })
})

describe('subpage lifecycle registry', () => {
  it('runs registered beforeLeave and afterEnter hooks', async () => {
    const registry = createSubpageLifecycleRegistry()
    let entered = false
    registry.register('editor', {
      beforeLeave: () => ({
        subpage: 'editor',
        activeFilePath: 'README.md',
        markdownPreviewOpen: true,
        markdownEditorVisible: true
      }),
      afterEnter: () => {
        entered = true
      }
    })
    const command = buildSubpageRouteCommand({
      intent: 'switch',
      entryPoint: 'subpage-switcher',
      terminalId: 'term-1',
      from: 'editor',
      target: 'diff'
    })

    const snapshot = await registry.beforeLeave('editor', { command })
    await registry.afterEnter('editor', { command })

    assert.equal(snapshot?.subpage, 'editor')
    assert.equal(entered, true)
  })
})
