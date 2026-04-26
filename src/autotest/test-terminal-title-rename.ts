/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TerminalDebugApi, TestResult } from './types'

const MENU_SELECTOR = '[data-testid="terminal-title-menu"]'
const DELAY_MS = 220

function menuElement(): HTMLElement | null {
  return document.querySelector(MENU_SELECTOR) as HTMLElement | null
}

function menuItems(): HTMLButtonElement[] {
  const root = menuElement()
  if (!root) return []
  return Array.from(root.querySelectorAll('button[role="menuitem"]')) as HTMLButtonElement[]
}

function itemByAction(action: 'rename' | 'use-branch' | 'use-repo'): HTMLButtonElement | null {
  const items = menuItems()
  return items.find((el) => el.getAttribute('data-action') === action) ?? null
}

export async function testTerminalTitleRename(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, sleep, terminalId, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const debugApi = () => window.__onwardTerminalDebug as TerminalDebugApi | undefined

  const apiReady = await waitFor('terminal-debug-api', () => Boolean(debugApi()), 8000)
  record('TTM-00-terminal-debug-api', apiReady, { available: apiReady })
  if (!apiReady || cancelled()) return results

  const api = debugApi()!
  const sessionReady = await waitFor(
    'terminal-session-ready',
    () => Boolean(api.getSessionState(terminalId)?.status === 'ready'),
    12000,
    120
  )
  record('TTM-00a-terminal-session-ready', sessionReady, {
    sessionState: api.getSessionState(terminalId)
  })
  if (!sessionReady || cancelled()) return results

  const resetState = async () => {
    // Autotest mode auto-opens the Project Editor on boot, which makes
    // globalOverlayActive=true and force-closes the title menu. Close all
    // subpages first so the terminal grid header (and our menu) are visible.
    api.closeAllSubpages()
    api.closeTitleMenu()
    api.cancelInlineRename()
    // Clear any override so subsequent tests see a deterministic starting point
    api.setTerminalGitInfoOverride(terminalId, null)
    // Give React a tick to flush
    await sleep(60)
  }

  // ================= TTM-01: single click with 220ms delay =================
  await resetState()
  api.simulateTitleSingleClick(terminalId)
  await sleep(80)
  const beforeOpen = api.getTitleMenuState(terminalId)
  await sleep(DELAY_MS + 60)
  const afterOpen = api.getTitleMenuState(terminalId)
  record('TTM-01-delayed-menu-open', beforeOpen?.open === false && afterOpen?.open === true, {
    before: beforeOpen,
    after: afterOpen
  })

  // ================= TTM-02: menu contains three items in the expected order =================
  const itemsNow = menuItems()
  const actions = itemsNow.map((el) => el.getAttribute('data-action'))
  record(
    'TTM-02-menu-items-order',
    itemsNow.length === 3 && actions[0] === 'rename' && actions[1] === 'use-branch' && actions[2] === 'use-repo',
    { actions }
  )

  // ================= TTM-03: rename item triggers inline edit =================
  const renameBefore = api.getTerminalCustomName(terminalId)
  api.clickTitleMenuItem('rename', terminalId)
  await sleep(30)
  const editingAfterRename = api.getInlineRenameState()
  const titleMenuClosed = api.getTitleMenuState(terminalId)?.open === false
  record(
    'TTM-03-rename-opens-inline-edit',
    editingAfterRename.editingId === terminalId && titleMenuClosed,
    { editingAfterRename, titleMenuClosed, nameBefore: renameBefore }
  )
  api.cancelInlineRename()
  await sleep(20)

  // ================= TTM-04: Use branch name sets customName to branch snapshot =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: 'ttm-branch-snapshot', repoName: 'ttm-repo-snapshot' })
  await sleep(30)
  api.openTitleMenu(terminalId)
  await sleep(20)
  const clickedBranch = api.clickTitleMenuItem('use-branch', terminalId)
  await sleep(40)
  const customAfterBranch = api.getTerminalCustomName(terminalId)
  const titleAfterBranch = api.getTerminalTitle(terminalId)
  record('TTM-04-use-branch-snapshot', clickedBranch === true && customAfterBranch === 'ttm-branch-snapshot', {
    clickedBranch,
    customAfterBranch,
    titleAfterBranch
  })

  // ================= TTM-05: Use Git folder name sets customName to repoName snapshot =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: 'ttm-branch-x', repoName: 'ttm-repo-y' })
  await sleep(30)
  api.openTitleMenu(terminalId)
  await sleep(20)
  const clickedRepo = api.clickTitleMenuItem('use-repo', terminalId)
  await sleep(40)
  const customAfterRepo = api.getTerminalCustomName(terminalId)
  const titleAfterRepo = api.getTerminalTitle(terminalId)
  record('TTM-05-use-repo-snapshot', clickedRepo === true && customAfterRepo === 'ttm-repo-y', {
    clickedRepo,
    customAfterRepo,
    titleAfterRepo
  })

  // ================= TTM-06: both null disables items + tooltip text =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: null, repoName: null })
  await sleep(30)
  api.openTitleMenu(terminalId)
  await sleep(30)
  const branchItem = itemByAction('use-branch')
  const repoItem = itemByAction('use-repo')
  const branchTip = branchItem?.getAttribute('title') ?? ''
  const repoTip = repoItem?.getAttribute('title') ?? ''
  const branchDisabled = Boolean(branchItem?.disabled)
  const repoDisabled = Boolean(repoItem?.disabled)
  record(
    'TTM-06-no-git-items-disabled',
    branchDisabled && repoDisabled && branchTip.length > 0 && repoTip.length > 0,
    { branchDisabled, repoDisabled, branchTip, repoTip }
  )

  // ================= TTM-07: branch present, repoName empty — only branch item enabled =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: 'only-branch', repoName: null })
  await sleep(30)
  api.openTitleMenu(terminalId)
  await sleep(30)
  const branchItem2 = itemByAction('use-branch')
  const repoItem2 = itemByAction('use-repo')
  record(
    'TTM-07-partial-git-info',
    Boolean(branchItem2) && branchItem2?.disabled === false && Boolean(repoItem2) && repoItem2?.disabled === true,
    { branchDisabled: branchItem2?.disabled, repoDisabled: repoItem2?.disabled }
  )

  // ================= TTM-08: snapshot survives post-click branch mutation =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: 'snapshot-original', repoName: 'snapshot-repo' })
  await sleep(30)
  api.openTitleMenu(terminalId)
  api.clickTitleMenuItem('use-branch', terminalId)
  await sleep(40)
  const customSnapshot1 = api.getTerminalCustomName(terminalId)
  api.setTerminalGitInfoOverride(terminalId, { branch: 'snapshot-changed' })
  await sleep(40)
  const customSnapshot2 = api.getTerminalCustomName(terminalId)
  record(
    'TTM-08-snapshot-is-frozen',
    customSnapshot1 === 'snapshot-original' && customSnapshot2 === 'snapshot-original',
    { customSnapshot1, customSnapshot2 }
  )

  // ================= TTM-09: long branch name does not crash =================
  await resetState()
  const longBranch = 'ttm-' + 'x'.repeat(140)
  api.setTerminalGitInfoOverride(terminalId, { branch: longBranch, repoName: 'repo-for-long' })
  await sleep(30)
  api.openTitleMenu(terminalId)
  const clickedLong = api.clickTitleMenuItem('use-branch', terminalId)
  await sleep(40)
  const customLong = api.getTerminalCustomName(terminalId)
  record(
    'TTM-09-long-branch-name',
    clickedLong === true && customLong === longBranch,
    { customLength: customLong?.length ?? 0, clickedLong }
  )

  // ================= TTM-10: disabled items cannot be triggered via debug API =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: null, repoName: null })
  await sleep(30)
  api.openTitleMenu(terminalId)
  const forcedBranch = api.clickTitleMenuItem('use-branch', terminalId)
  const forcedRepo = api.clickTitleMenuItem('use-repo', terminalId)
  const customDisabled = api.getTerminalCustomName(terminalId)
  record(
    'TTM-10-disabled-items-no-op',
    forcedBranch === false && forcedRepo === false,
    { forcedBranch, forcedRepo, customDisabled }
  )

  // ================= TTM-11: double-click within 220ms cancels pending menu =================
  await resetState()
  api.simulateTitleSingleClick(terminalId)
  await sleep(80)
  api.simulateTitleDoubleClick(terminalId)
  // Check editing state BEFORE any long sleep — terminal focus logic may
  // blur the input during long waits and commit the inline rename.
  await sleep(30)
  const editingAfterDbl = api.getInlineRenameState()
  // Wait past the original 220ms timer threshold to verify menu never opened.
  await sleep(DELAY_MS + 80)
  const menuOpenAfterDbl = api.getTitleMenuState(terminalId)?.open
  record(
    'TTM-11-dblclick-preempts-menu',
    menuOpenAfterDbl === false && editingAfterDbl.editingId === terminalId,
    { menuOpenAfterDbl, editingAfterDbl }
  )
  api.cancelInlineRename()

  // ================= TTM-12: single click > 240ms opens menu =================
  await resetState()
  api.simulateTitleSingleClick(terminalId)
  // Poll for up to 1200ms to absorb render jitter — the 220ms timer should
  // have fired well within this window.
  const menuOpenedSlow = await waitFor(
    'ttm12-menu-open',
    () => api.getTitleMenuState(terminalId)?.open === true,
    1200,
    30
  )
  const menuOpenSlow = api.getTitleMenuState(terminalId)?.open
  const menuDomAtSlow = menuElement() !== null
  record(
    'TTM-12-slow-single-click-opens',
    menuOpenedSlow === true && menuOpenSlow === true,
    { menuOpenedSlow, menuOpenSlow, menuDomAtSlow }
  )
  api.closeTitleMenu()
  await sleep(20)

  // ================= TTM-13: click different terminals — only last opens =================
  const visibleIds = api.getVisibleTerminalIds()
  if (visibleIds.length >= 2) {
    await resetState()
    const a = visibleIds[0]
    const b = visibleIds[1]
    api.simulateTitleSingleClick(a)
    await sleep(40)
    api.simulateTitleSingleClick(b)
    await sleep(DELAY_MS + 80)
    const stateA = api.getTitleMenuState(a)
    const stateB = api.getTitleMenuState(b)
    record(
      'TTM-13-only-last-terminal-menu-opens',
      stateA?.open === false && stateB?.open === true,
      { stateA, stateB }
    )
  } else {
    record('TTM-13-only-last-terminal-menu-opens', true, { skipped: 'need 2+ terminals', visibleIds })
  }

  // ================= TTM-14: pure double-click still enters inline rename =================
  await resetState()
  api.simulateTitleDoubleClick(terminalId)
  await sleep(30)
  const editingAfterPureDbl = api.getInlineRenameState()
  record(
    'TTM-14-pure-double-click-renames',
    editingAfterPureDbl.editingId === terminalId,
    { editingAfterPureDbl }
  )
  api.cancelInlineRename()

  // ================= TTM-15: left TerminalDropdown trigger still present =================
  await resetState()
  const leftTrigger = document.querySelector('.terminal-dropdown-trigger') as HTMLElement | null
  record(
    'TTM-15-left-dropdown-trigger-present',
    leftTrigger !== null && typeof leftTrigger.click === 'function',
    { leftTriggerTag: leftTrigger?.tagName ?? null }
  )

  // ================= TTM-16: inline rename finish & cancel via debug API =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: 'ttm-inline-rename', repoName: 'repo-inline' })
  await sleep(30)
  api.simulateTitleDoubleClick(terminalId)
  await sleep(20)
  const finishOk = api.finishInlineRename('ttm-inline-typed')
  await sleep(30)
  const customAfterFinish = api.getTerminalCustomName(terminalId)
  const editingAfterFinish = api.getInlineRenameState()

  api.simulateTitleDoubleClick(terminalId)
  await sleep(20)
  const cancelOk = api.cancelInlineRename()
  await sleep(30)
  const customAfterCancel = api.getTerminalCustomName(terminalId)
  const editingAfterCancel = api.getInlineRenameState()
  record(
    'TTM-16-inline-rename-finish-and-cancel',
    finishOk === true &&
      customAfterFinish === 'ttm-inline-typed' &&
      editingAfterFinish.editingId === null &&
      cancelOk === true &&
      customAfterCancel === 'ttm-inline-typed' &&
      editingAfterCancel.editingId === null,
    { finishOk, customAfterFinish, cancelOk, customAfterCancel }
  )

  // ================= TTM-17: closeTitleMenu API closes the menu (forceClose analogue) =================
  await resetState()
  api.openTitleMenu(terminalId)
  await sleep(20)
  const openedForClose = api.getTitleMenuState(terminalId)?.open
  api.closeTitleMenu()
  await sleep(20)
  const closedAfterApi = api.getTitleMenuState(terminalId)?.open
  record(
    'TTM-17-close-menu-api',
    openedForClose === true && closedAfterApi === false,
    { openedForClose, closedAfterApi }
  )

  // ================= TTM-18: pressing Escape closes the menu =================
  await resetState()
  api.openTitleMenu(terminalId)
  await sleep(30)
  const openedForEsc = api.getTitleMenuState(terminalId)?.open
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(30)
  const closedAfterEsc = api.getTitleMenuState(terminalId)?.open
  record(
    'TTM-18-escape-closes-menu',
    openedForEsc === true && closedAfterEsc === false,
    { openedForEsc, closedAfterEsc }
  )

  // ================= TTM-19: outside mousedown closes the menu =================
  await resetState()
  api.openTitleMenu(terminalId)
  await sleep(30)
  const openedForOutside = api.getTitleMenuState(terminalId)?.open
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await sleep(30)
  const closedAfterOutside = api.getTitleMenuState(terminalId)?.open
  record(
    'TTM-19-outside-click-closes-menu',
    openedForOutside === true && closedAfterOutside === false,
    { openedForOutside, closedAfterOutside }
  )

  // ================= TTM-20: trace events emit on click / snapshot / rename =================
  // Drive every step via real DOM events so we exercise the production
  // handlers that own the trace points (the debug API methods bypass those
  // handlers by design — they are state shortcuts for other tests).
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: 'ttm-trace-branch', repoName: 'ttm-trace-repo' })
  await sleep(50)

  const captured: Array<{ message: string; data: unknown }> = []
  const originalConsoleLog = console.log
  console.log = (...args: unknown[]) => {
    if (
      typeof args[0] === 'string' &&
      args[0] === '[TerminalGrid]' &&
      typeof args[1] === 'string' &&
      args[1].startsWith('titleMenu:')
    ) {
      captured.push({ message: args[1], data: args[2] })
    }
    return originalConsoleLog.apply(console, args)
  }

  const getAnchor = () =>
    document.querySelector(`[data-terminal-id="${terminalId}"] .terminal-grid-title`) as HTMLElement | null
  const getInput = () =>
    document.querySelector(`[data-terminal-id="${terminalId}"] .terminal-grid-title-input`) as HTMLInputElement | null
  const getMenuButton = (action: 'rename' | 'use-branch' | 'use-repo') =>
    document.querySelector(`[data-testid="terminal-title-menu"] [data-action="${action}"]`) as HTMLButtonElement | null

  let traceError: string | null = null
  try {
    // 1) Real single-click on the title — exercises handleTitleClick → setTimeout → titleMenu:open.
    const anchor1 = getAnchor()
    if (!anchor1) throw new Error('initial title anchor not found')
    anchor1.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(DELAY_MS + 80)

    // 2) Real click on the "Use branch name" menu item — exercises handleTitleSnapshotRename → titleMenu:snapshot.
    const branchBtn = getMenuButton('use-branch')
    if (!branchBtn) throw new Error('use-branch menu button not found')
    branchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(50)

    // 3) Real dblclick on the title — exercises handleTitleDoubleClick → titleMenu:rename stage:start.
    const anchor3 = getAnchor()
    if (!anchor3) throw new Error('title anchor missing before first dblclick')
    anchor3.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    await sleep(50)

    // 4) Enter on the inline input — exercises handleKeyDown → handleFinishEdit → titleMenu:rename stage:commit.
    const input4 = getInput()
    if (!input4) throw new Error('inline input missing after first dblclick')
    input4.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await sleep(50)

    // 5) Real dblclick again — exercises titleMenu:rename stage:start a second time.
    const anchor5 = getAnchor()
    if (!anchor5) throw new Error('title anchor missing before second dblclick')
    anchor5.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    await sleep(50)

    // 6) Escape on the inline input — exercises handleCancelEdit → titleMenu:rename stage:cancel.
    const input6 = getInput()
    if (!input6) throw new Error('inline input missing after second dblclick')
    input6.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await sleep(50)
  } catch (err) {
    traceError = err instanceof Error ? err.message : String(err)
  } finally {
    console.log = originalConsoleLog
  }

  const opens = captured.filter((c) => c.message === 'titleMenu:open')
  const snapshots = captured.filter((c) => c.message === 'titleMenu:snapshot')
  const renames = captured.filter((c) => c.message === 'titleMenu:rename')
  const stages = renames.map((c) => (c.data as { stage?: string } | undefined)?.stage ?? null)
  const openSourceClick = opens.some((c) => (c.data as { source?: string } | undefined)?.source === 'click')
  const snapshotSourceBranch = snapshots.some((c) => (c.data as { source?: string } | undefined)?.source === 'branch')
  const startWithDoubleClick = renames.some((c) => {
    const d = c.data as { stage?: string; source?: string } | undefined
    return d?.stage === 'start' && d?.source === 'doubleClick'
  })
  record(
    'TTM-20-trace-events-emit',
    traceError === null &&
      openSourceClick &&
      snapshotSourceBranch &&
      startWithDoubleClick &&
      stages.includes('commit') &&
      stages.includes('cancel'),
    {
      traceError,
      messages: captured.map((c) => c.message),
      stagesObserved: stages,
      openCount: opens.length,
      snapshotCount: snapshots.length,
      renameCount: renames.length
    }
  )

  await resetState()
  log('terminal-title-rename:complete', { total: results.length })

  return results
}
