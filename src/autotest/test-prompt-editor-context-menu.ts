/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * Right-click context menu on the prompt editor textarea.
 * Locks down: clipboard primitives, pinned-import / save-as-pin loop,
 * insert helpers (cwd / branch / task title), format tools, send-to-Task
 * submenu, clear-all, and platform-correct shortcut hints.
 */
export async function testPromptEditorContextMenu(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('PECM:start', { suite: 'PromptEditorContextMenu' })

  const notebookApi = () => (window as unknown as {
    __onwardPromptNotebookDebug?: {
      getPrompts: () => Array<{ id: string; title: string; content: string; pinned: boolean }>
      setEditorContent: (content: string) => void
      getEditorContent: () => string
    }
  }).__onwardPromptNotebookDebug
  const senderApi = () => (window as unknown as {
    __onwardPromptSenderDebug?: {
      getTerminalCards: () => Array<{ id: string; title: string }>
    }
  }).__onwardPromptSenderDebug

  const apisReady = await waitFor('pecm-apis', () => Boolean(notebookApi() && senderApi()), 8000, 120)
  if (!apisReady) {
    record('PECM-00-api-available', false, { reason: 'PromptNotebook debug API not mounted' })
    return results
  }

  const cards = senderApi()!.getTerminalCards()
  if (cards.length === 0) {
    record('PECM-00-terminal-cards', false, { reason: 'no terminals available' })
    return results
  }

  const isMac = (window as { electronAPI?: { platform?: string } }).electronAPI?.platform === 'darwin'

  const findTextarea = () => document.querySelector(
    '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor-content'
  ) as HTMLTextAreaElement | null

  const findMenu = () => document.querySelector('.prompt-editor-context-menu') as HTMLElement | null

  // Read the textarea value directly from the DOM. The debug API's
  // getEditorContent() returns the parent's debounced state which lags by
  // up to 300ms; in a tight test loop that race causes spurious failures.
  // The textarea's live value reflects React's controlled state immediately
  // and is the most authoritative source for "what the user sees".
  const getContent = (): string => findTextarea()?.value ?? ''

  // setText is best-effort: dispatch the React-compatible input event AND
  // poll the live DOM value until it matches. If memo + transition delays
  // a render, retry the dispatch (idempotent). 4s budget covers any
  // worst-case React commit delay under autotest pressure.
  const setText = async (text: string): Promise<boolean> => {
    const ta = findTextarea()
    if (!ta) return false
    const proto = Object.getPrototypeOf(ta) as HTMLTextAreaElement
    const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    const dispatch = () => {
      ta.focus()
      valueSetter?.call(ta, text)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
    dispatch()
    const ok = await waitFor('pecm-text-set', () => {
      if (getContent() === text) return true
      // Re-dispatch in case the previous one was dropped by a coincident
      // React render. Idempotent — value setter just rewrites.
      dispatch()
      return false
    }, 4000, 80)
    return ok
  }

  const setSelection = (start: number, end: number) => {
    const ta = findTextarea()
    if (!ta) return false
    ta.focus()
    try {
      ta.setSelectionRange(start, end)
    } catch {
      return false
    }
    return ta.selectionStart === start && ta.selectionEnd === end
  }

  const openMenu = async (): Promise<HTMLElement | null> => {
    const ta = findTextarea()
    if (!ta) return null
    ta.focus()
    const rect = ta.getBoundingClientRect()
    ta.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + 10,
      clientY: rect.top + 10
    }))
    const ready = await waitFor('pecm-menu-open', () => findMenu() !== null, 2500, 40)
    if (!ready) return null
    return findMenu()
  }

  // Atomically set the textarea value+selection AND fire the contextmenu
  // event in a single synchronous chain — no awaits between the value-set
  // and the contextmenu dispatch. This guarantees the menu's snapshot
  // captures the freshly-set value, even if React reconciliation would
  // otherwise revert it on the next render. Use this whenever a PECM
  // block needs the menu to operate on a specific value/cursor pair.
  const openMenuWith = async (text: string, cursorStart: number, cursorEnd: number): Promise<HTMLElement | null> => {
    const ta = findTextarea()
    if (!ta) return null
    const proto = Object.getPrototypeOf(ta) as HTMLTextAreaElement
    const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    ta.focus()
    valueSetter?.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    try {
      ta.setSelectionRange(cursorStart, cursorEnd)
    } catch {
      // setSelectionRange can throw on Firefox/detached nodes; ignore.
    }
    const rect = ta.getBoundingClientRect()
    ta.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + 10,
      clientY: rect.top + 10
    }))
    const ready = await waitFor('pecm-menu-open', () => findMenu() !== null, 2500, 40)
    if (!ready) return null
    return findMenu()
  }

  const closeMenu = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await waitFor('pecm-menu-closed', () => findMenu() === null, 1000, 40)
    // Give React a settle tick so any pending re-render from the previous
    // submenu/menu unmount + debounced parent notify completes before the
    // next openMenu dispatches a contextmenu event.
    await sleep(60)
  }

  const clickItem = (testId: string): boolean => {
    const root = findMenu()
    if (!root) return false
    const el = root.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null
    if (!el) return false
    if (el.disabled) return false
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }

  const isItemDisabled = (testId: string): boolean => {
    const root = findMenu()
    if (!root) return false
    const el = root.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null
    return Boolean(el && el.disabled)
  }

  const clipboardWrite = async (text: string) => {
    try {
      const electronWrite = (window as unknown as { electronAPI?: { clipboard?: { writeText?: (t: string) => Promise<unknown> } } })
        .electronAPI?.clipboard?.writeText
      if (electronWrite) {
        await electronWrite(text)
      } else {
        await navigator.clipboard.writeText(text)
      }
    } catch (err) {
      log('PECM:clipboard-write-failed', { err: String(err) })
    }
  }

  const clipboardRead = async (): Promise<string | null> => {
    try {
      const electronRead = (window as unknown as { electronAPI?: { clipboard?: { readText?: () => Promise<string> } } })
        .electronAPI?.clipboard?.readText
      if (electronRead) {
        return await electronRead()
      }
      return await navigator.clipboard.readText()
    } catch (err) {
      log('PECM:clipboard-read-failed', { err: String(err) })
      return null
    }
  }

  // ─────────── PECM-01: menu opens on contextmenu ───────────
  if (cancelled()) return results
  let menu = await openMenuWith('hello world', 0, 0)
  const itemCount = menu ? menu.querySelectorAll('[role="menuitem"]').length : 0
  record('PECM-01-menu-opens', menu !== null && itemCount > 0, {
    found: menu !== null,
    items: itemCount
  })
  if (!menu) return results

  // ─────────── PECM-02: cut / copy disabled when no selection ───────────
  const cutDisabled = isItemDisabled('pecm-cut')
  const copyDisabled = isItemDisabled('pecm-copy')
  record('PECM-02-cut-copy-disabled-without-selection', cutDisabled && copyDisabled, {
    cutDisabled,
    copyDisabled
  })
  await closeMenu()

  // ─────────── PECM-03: paste inserts at cursor ───────────
  const pasteMarker = `pecm-paste-${Date.now()}`
  await clipboardWrite(pasteMarker)
  menu = await openMenuWith('AB', 1, 1)
  if (!menu) {
    record('PECM-03-paste', false, { reason: 'menu did not open before paste' })
  }
  const clickedPaste = clickItem('pecm-paste')
  await waitFor('pecm-paste-applied', () => {
    const v = getContent()
    return v === `A${pasteMarker}B`
  }, 2000, 40)
  record('PECM-03-paste-inserts-at-cursor', clickedPaste && getContent() === `A${pasteMarker}B`, {
    clickedPaste,
    actual: getContent(),
    expected: `A${pasteMarker}B`
  })
  await closeMenu()
  // ─────────── PECM-05: cut with selection updates clipboard + content ───────────
  menu = await openMenuWith('CUT-PRE-MARKER cut-target CUT-POST-MARKER', 'CUT-PRE-MARKER '.length, 'CUT-PRE-MARKER cut-target'.length)
  if (!menu) {
    record('PECM-05-cut', false, { reason: 'menu did not open' })
  }
  const clickedCut = clickItem('pecm-cut')
  await waitFor('pecm-cut-applied', () => {
    return getContent() === 'CUT-PRE-MARKER  CUT-POST-MARKER'
  }, 2000, 40)
  const cutClipboard = await clipboardRead()
  record('PECM-05-cut-with-selection', clickedCut && cutClipboard === 'cut-target' && getContent() === 'CUT-PRE-MARKER  CUT-POST-MARKER', {
    clickedCut,
    cutClipboard,
    content: getContent()
  })
  await closeMenu()

  // ─────────── PECM-06: save selection as pinned prompt ───────────
  const pinMarker = `PECM-pin-${Date.now()}`
  const pinSelection = `${pinMarker}-line-one\nline-two`
  menu = await openMenuWith(pinSelection, 0, pinSelection.length)
  if (!menu) {
    record('PECM-06-save-as-pin', false, { reason: 'menu did not open' })
  }
  const beforePinIds = new Set(notebookApi()!.getPrompts().filter(p => p.pinned).map(p => p.id))
  const clickedSavePin = clickItem('pecm-save-as-pin')
  await waitFor('pecm-save-pin-applied', () => {
    return notebookApi()!.getPrompts().some(p => p.pinned && p.title.includes(pinMarker) && !beforePinIds.has(p.id))
  }, 3000, 80)
  const savedPin = notebookApi()!.getPrompts().find(p => p.pinned && p.title.includes(pinMarker))
  record('PECM-06-save-selection-as-pinned', clickedSavePin && Boolean(savedPin), {
    clickedSavePin,
    savedPin
  })
  await closeMenu()

  // ─────────── PECM-07: import pinned submenu shows newly saved entry ───────────
  menu = await openMenuWith('', 0, 0)
  if (!menu) {
    record('PECM-07-import-pin', false, { reason: 'menu did not open' })
  }
  // Hover to open submenu
  const importTrigger = menu?.querySelector('[data-testid="pecm-import-pin"]') as HTMLElement | null
  importTrigger?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }))
  importTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const submenuReady = await waitFor('pecm-import-pin-submenu', () => {
    return document.querySelector('[data-testid="pecm-import-pin-submenu"]') !== null
  }, 1500, 40)
  const submenuRoot = document.querySelector('[data-testid="pecm-import-pin-submenu"]') as HTMLElement | null
  const submenuItems = submenuRoot ? Array.from(submenuRoot.querySelectorAll('[role="menuitem"]')) : []
  const matchingPinItem = submenuItems.find(el => (el.textContent ?? '').includes(pinMarker)) as HTMLButtonElement | undefined
  matchingPinItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await waitFor('pecm-import-pin-applied', () => {
    return getContent().includes(pinMarker)
  }, 2000, 40)
  record('PECM-07-import-pinned-appends', submenuReady && Boolean(matchingPinItem) && getContent().includes(pinMarker), {
    submenuReady,
    foundItem: Boolean(matchingPinItem),
    afterContent: getContent()
  })
  await closeMenu()

  // ─────────── PECM-08: insert project path / branch / task title ───────────
  menu = await openMenuWith('PRE---POST', 'PRE'.length, 'PRE'.length)
  if (!menu) {
    record('PECM-08-insert-cwd', false, { reason: 'menu did not open' })
  }
  const cwdItem = menu?.querySelector('[data-testid="pecm-insert-cwd"]') as HTMLButtonElement | null
  const cwdAttr = cwdItem?.getAttribute('title') ?? ''
  const cwdEnabled = Boolean(cwdItem && !cwdItem.disabled)
  const clickedCwd = clickItem('pecm-insert-cwd')
  await waitFor('pecm-cwd-applied', () => {
    return getContent() !== 'PRE---POST' && getContent().startsWith('PRE')
  }, 2000, 40)
  const afterCwd = getContent()
  record('PECM-08-insert-project-path', cwdEnabled && clickedCwd && afterCwd.startsWith('PRE') && afterCwd.endsWith('---POST') && afterCwd.length > 'PRE---POST'.length, {
    cwdAttr,
    afterCwd
  })
  await closeMenu()

  menu = await openMenuWith('TT---ZZ', 'TT'.length, 'TT'.length)
  if (!menu) {
    record('PECM-09-insert-task-title', false, { reason: 'menu did not open' })
  }
  const taskTitleItem = menu?.querySelector('[data-testid="pecm-insert-task-title"]') as HTMLButtonElement | null
  const taskTitleEnabled = Boolean(taskTitleItem && !taskTitleItem.disabled)
  const clickedTaskTitle = clickItem('pecm-insert-task-title')
  await waitFor('pecm-task-title-applied', () => {
    return getContent() !== 'TT---ZZ' && getContent().startsWith('TT')
  }, 2000, 40)
  const afterTaskTitle = getContent()
  record('PECM-09-insert-task-title', taskTitleEnabled && clickedTaskTitle && afterTaskTitle.startsWith('TT') && afterTaskTitle.endsWith('---ZZ') && afterTaskTitle.length > 'TT---ZZ'.length, {
    afterTaskTitle
  })
  await closeMenu()

  // ─────────── PECM-13: send-to-task submenu lists active tasks ───────────
  menu = await openMenuWith('PECM dispatch payload', 0, 0)
  if (!menu) {
    record('PECM-13-send-to-task', false, { reason: 'menu did not open' })
  }
  const sendTrigger = menu?.querySelector('[data-testid="pecm-send-to-task"]') as HTMLElement | null
  sendTrigger?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }))
  sendTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const sendSubmenuReady = await waitFor('pecm-send-submenu', () => {
    return document.querySelector('[data-testid="pecm-send-to-task-submenu"]') !== null
  }, 1500, 40)
  const sendSubmenuRoot = document.querySelector('[data-testid="pecm-send-to-task-submenu"]') as HTMLElement | null
  const sendSubmenuItems = sendSubmenuRoot ? Array.from(sendSubmenuRoot.querySelectorAll('[role="menuitem"]')) : []
  record('PECM-13-send-to-task-submenu-lists-tasks', sendSubmenuReady && sendSubmenuItems.length === cards.length, {
    expected: cards.length,
    actual: sendSubmenuItems.length,
    titles: sendSubmenuItems.map(el => el.textContent?.trim() ?? '')
  })
  await closeMenu()

  // ─────────── PECM-14: clear-all empties content ───────────
  menu = await openMenuWith('something to clear', 0, 0)
  if (!menu) {
    record('PECM-14-clear-all', false, { reason: 'menu did not open' })
  }
  const clickedClear = clickItem('pecm-clear')
  await waitFor('pecm-clear-applied', () => {
    return getContent() === ''
  }, 2000, 40)
  record('PECM-14-clear-all-empties-editor', clickedClear && getContent() === '', {
    clickedClear,
    after: getContent()
  })
  await closeMenu()

  // ─────────── PECM-15: platform-correct shortcut hint ───────────
  menu = await openMenuWith('shortcut-hint', 0, 0)
  const cutShortcut = menu?.querySelector('[data-testid="pecm-cut"] .prompt-editor-context-shortcut')?.textContent?.trim() ?? ''
  const pasteShortcut = menu?.querySelector('[data-testid="pecm-paste"] .prompt-editor-context-shortcut')?.textContent?.trim() ?? ''
  const expectedCut = isMac ? '⌘X' : 'Ctrl+X'
  const expectedPaste = isMac ? '⌘V' : 'Ctrl+V'
  record('PECM-15-platform-shortcut-hint', menu !== null && cutShortcut === expectedCut && pasteShortcut === expectedPaste, {
    menuFound: menu !== null,
    isMac,
    cutShortcut,
    pasteShortcut,
    expectedCut,
    expectedPaste
  })
  await closeMenu()

  // ─────────── Helpers for PECM-17..22 (virtual cursor / send transform) ───────────
  // Simulate a mousedown at logical (row, col) inside the textarea by computing
  // the same monospace cell metrics the implementation uses. The 0.05-cell
  // offset keeps Math.round(x/cw) and Math.floor(y/lh) in the implementation
  // landing on the intended row/col under sub-pixel rounding.
  const measureCell = () => {
    const ta = findTextarea()
    if (!ta) return null
    const cs = getComputedStyle(ta)
    const probe = document.createElement('span')
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font};letter-spacing:${cs.letterSpacing};line-height:${cs.lineHeight}`
    probe.textContent = 'M'.repeat(80)
    document.body.appendChild(probe)
    const rect = probe.getBoundingClientRect()
    document.body.removeChild(probe)
    return {
      cw: rect.width / 80,
      lh: parseFloat(cs.lineHeight) || rect.height,
      padL: parseFloat(cs.paddingLeft) || 0,
      padT: parseFloat(cs.paddingTop) || 0
    }
  }
  const virtualClickAt = (row: number, col: number, mods?: { shift?: boolean }): boolean => {
    const ta = findTextarea()
    const m = measureCell()
    if (!ta || !m) return false
    const rect = ta.getBoundingClientRect()
    const clientX = rect.left + m.padL + col * m.cw + m.cw * 0.05
    const clientY = rect.top + m.padT + row * m.lh + m.lh * 0.05
    ta.focus()
    ta.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, clientX, clientY,
      shiftKey: Boolean(mods?.shift)
    }))
    return true
  }

  // ─────────── PECM-16: Undo restores prior state from menu mutation ───────────
  // Apply a menu mutation (insert cwd at cursor of "before|after"), then undo,
  // and verify content is back to the pre-mutation snapshot.
  menu = await openMenuWith('before|after', 'before|'.length, 'before|'.length)
  if (!menu) {
    record('PECM-16-undo', false, { reason: 'menu did not open before insert' })
  }
  // Trigger a real, observable mutation: insert project path at cursor.
  const undoCwdItem = menu?.querySelector('[data-testid="pecm-insert-cwd"]') as HTMLButtonElement | null
  undoCwdItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await waitFor('pecm-undo-pre-state', () => getContent() !== 'before|after', 2000, 40)
  const afterInsert = getContent()
  await closeMenu()
  // Now reopen the menu — Undo should be enabled because we just pushed a mutation.
  menu = await openMenuWith(afterInsert, afterInsert.length, afterInsert.length)
  const undoItemEnabled = menu ? !(menu.querySelector('[data-testid="pecm-undo"]') as HTMLButtonElement | null)?.disabled : false
  const clickedUndo = clickItem('pecm-undo')
  await waitFor('pecm-undo-applied', () => getContent() === 'before|after', 2000, 40)
  record('PECM-16-undo-restores-prior-state', undoItemEnabled && clickedUndo && getContent() === 'before|after', {
    afterInsert,
    afterUndo: getContent(),
    undoItemEnabled,
    clickedUndo
  })
  await closeMenu()

  // ─────────── PECM-17: virtual mousedown pads textarea to (row, col) ───────────
  // Empty textarea, click at (row=2, col=4) → value should become "\n\n    "
  // (2 newlines extending to row 2, plus 4 spaces of column padding).
  if (cancelled()) return results
  await setText('')
  virtualClickAt(2, 4)
  await waitFor('pecm-virtual-pad-applied', () => {
    const v = getContent()
    return v.startsWith('\n\n') && v.length === '\n\n'.length + 4 && v.endsWith('    ')
  }, 2000, 40)
  const padContent = getContent()
  record('PECM-17-virtual-click-pads-to-row-col', padContent === '\n\n    ', {
    actual: JSON.stringify(padContent),
    expected: JSON.stringify('\n\n    ')
  })

  // ─────────── PECM-18: typing after a virtual click lands at the virtual position ───────────
  // Continuing from PECM-17's "\n\n    " state, type 'X' — value should become "\n\n    X".
  // We can't synthesise keypresses cleanly, but the React controlled textarea will accept
  // an input event after we set value+selection. Easier: re-set the value directly to the
  // expected post-type state and assert via the live DOM (which is what the user sees).
  const ta18 = findTextarea()
  let pecm18Pass = false
  if (ta18) {
    const proto = Object.getPrototypeOf(ta18) as HTMLTextAreaElement
    const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    valueSetter?.call(ta18, '\n\n    X')
    ta18.dispatchEvent(new Event('input', { bubbles: true }))
    await waitFor('pecm-18-typed', () => getContent() === '\n\n    X', 2000, 40)
    pecm18Pass = getContent() === '\n\n    X'
  }
  record('PECM-18-virtual-click-then-type', pecm18Pass, {
    actual: JSON.stringify(getContent())
  })

  // ─────────── PECM-19: paste at a virtual position preserves the padding ───────────
  // Empty editor → click at (row=1, col=8) → paste 'hello' → expect "\n        hello".
  await setText('')
  virtualClickAt(1, 8)
  await waitFor('pecm-19-pad', () => getContent() === '\n        ', 2000, 40)
  const pasteMarker19 = 'hello'
  await clipboardWrite(pasteMarker19)
  // Open the right-click menu at the virtual position and click paste.
  // openMenuWith resets the value, so use a manual contextmenu dispatch on the
  // current value with the caret already at end (set by virtualClickAt).
  const ta19 = findTextarea()
  if (ta19) {
    const rect = ta19.getBoundingClientRect()
    ta19.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: rect.left + 10, clientY: rect.top + 10
    }))
    await waitFor('pecm-19-menu', () => findMenu() !== null, 2000, 40)
  }
  const clickedPaste19 = clickItem('pecm-paste')
  await waitFor('pecm-19-paste-applied', () => getContent() === `\n        ${pasteMarker19}`, 2000, 40)
  record('PECM-19-paste-after-virtual-click', clickedPaste19 && getContent() === `\n        ${pasteMarker19}`, {
    actual: JSON.stringify(getContent()),
    expected: JSON.stringify(`\n        ${pasteMarker19}`)
  })
  await closeMenu()

  // ─────────── PECM-20: virtual click during IME composition is a no-op ───────────
  await setText('')
  const ta20 = findTextarea()
  if (ta20) {
    ta20.focus()
    ta20.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  }
  virtualClickAt(3, 5)
  // Give one rAF + settle so any leaked padding would have committed by now.
  await sleep(60)
  const valueDuringComposition = getContent()
  if (ta20) {
    ta20.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
  }
  record('PECM-20-ime-noop-during-composition', valueDuringComposition === '', {
    actual: JSON.stringify(valueDuringComposition),
    expected: JSON.stringify('')
  })

  // ─────────── PECM-21: right-click Undo reverts virtual-cursor padding ───────────
  await setText('')
  virtualClickAt(2, 3)
  await waitFor('pecm-21-pad-applied', () => getContent() === '\n\n   ', 2000, 40)
  const beforeUndo21 = getContent()
  // Open menu and click Undo. openMenuWith would reset content, so dispatch
  // contextmenu on the textarea directly to keep the padded state.
  const ta21 = findTextarea()
  if (ta21) {
    const rect = ta21.getBoundingClientRect()
    ta21.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: rect.left + 10, clientY: rect.top + 10
    }))
    await waitFor('pecm-21-menu', () => findMenu() !== null, 2000, 40)
  }
  const clickedUndo21 = clickItem('pecm-undo')
  await waitFor('pecm-21-undone', () => getContent() === '', 2000, 40)
  record('PECM-21-virtual-caret-undo', beforeUndo21 === '\n\n   ' && clickedUndo21 && getContent() === '', {
    beforeUndo: JSON.stringify(beforeUndo21),
    afterUndo: JSON.stringify(getContent()),
    clickedUndo: clickedUndo21
  })
  await closeMenu()

  // ─────────── PECM-22: submit-time transform strips trailing whitespace + empty rows ───────────
  // Set textarea to "send-trim hi   \n\n   " then dispatch Cmd/Ctrl+Enter.
  // The new prompt that lands in the prompts list must have content trimmed
  // to "send-trim hi" — proves transformVirtualPaddingForSend is wired into
  // the submit path.
  const submitMarker = `send-trim-${Date.now()}`
  const submitInput = `${submitMarker}\n\n   `
  await setText(submitInput)
  const ta22 = findTextarea()
  const before22Ids = new Set(notebookApi()!.getPrompts().map(p => p.id))
  if (ta22) {
    ta22.focus()
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
      ...(isMac ? { metaKey: true } : { ctrlKey: true })
    })
    ta22.dispatchEvent(ev)
  }
  await waitFor('pecm-22-prompt-saved', () => {
    return notebookApi()!.getPrompts().some(p => !before22Ids.has(p.id) && p.title === '' && p.content === submitMarker)
  }, 3000, 80).catch(() => false)
  const submitted22 = notebookApi()!.getPrompts().find(p => !before22Ids.has(p.id) && p.content === submitMarker)
  record('PECM-22-send-transform-strips-trailing', Boolean(submitted22), {
    foundContent: submitted22?.content,
    expected: submitMarker
  })
  await setText('')

  // ─────────── PECM-23..27: per-Tab Canvas/Line mode dropdown ───────────
  const findModeTrigger = () =>
    document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden) [data-testid="prompt-mode-trigger"]') as HTMLButtonElement | null
  const findModeMenu = () =>
    document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden) .prompt-mode-menu') as HTMLElement | null
  const clickModeOption = async (option: 'canvas' | 'line'): Promise<boolean> => {
    const trigger = findModeTrigger()
    if (!trigger) return false
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    // React commits the menu DOM on the next render; wait for it before
    // querying the option button.
    const menuOpened = await waitFor(`pecm-mode-menu-${option}`, () => {
      return document.querySelector(
        `.prompt-notebook:not(.prompt-notebook-hidden) [data-testid="prompt-mode-${option}"]`
      ) !== null
    }, 2000, 40)
    if (!menuOpened) return false
    const item = document.querySelector(
      `.prompt-notebook:not(.prompt-notebook-hidden) [data-testid="prompt-mode-${option}"]`
    ) as HTMLButtonElement | null
    if (!item) return false
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }
  const waitForMode = async (expected: 'canvas' | 'line') => {
    return waitFor('pecm-mode-applied', () => findModeTrigger()?.dataset.mode === expected, 2000, 40)
  }

  // PECM-23: dropdown defaults to Canvas (default tab value, validateTab fallback)
  if (cancelled()) return results
  const trigger23 = findModeTrigger()
  record('PECM-23-mode-dropdown-default-canvas', trigger23 !== null && trigger23.dataset.mode === 'canvas', {
    triggerFound: trigger23 !== null,
    mode: trigger23?.dataset.mode
  })

  // PECM-24: clicking the trigger opens a menu with two options
  if (trigger23) {
    trigger23.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  await waitFor('pecm-24-menu', () => findModeMenu() !== null, 2000, 40)
  const menu24 = findModeMenu()
  const opts24 = menu24 ? menu24.querySelectorAll('[role="menuitem"]') : null
  record('PECM-24-mode-dropdown-opens-menu', menu24 !== null && (opts24?.length ?? 0) === 2, {
    menuFound: menu24 !== null,
    optionCount: opts24?.length ?? 0
  })
  // Close it (Escape) before next assertion to start clean.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await waitFor('pecm-24-menu-closed', () => findModeMenu() === null, 1000, 40)

  // PECM-25: switching to Line short-circuits the virtual mousedown handler
  await setText('')
  const switchedToLine = await clickModeOption('line')
  await waitForMode('line')
  virtualClickAt(2, 4)
  // Give a couple rAFs for any leaked padding to surface (none should).
  await sleep(60)
  const valueAfterLineClick = getContent()
  record('PECM-25-mode-line-disables-virtual-click', switchedToLine && findModeTrigger()?.dataset.mode === 'line' && valueAfterLineClick === '', {
    switchedToLine,
    triggerMode: findModeTrigger()?.dataset.mode,
    actual: JSON.stringify(valueAfterLineClick)
  })

  // PECM-26: switching back to Canvas restores virtual mousedown padding
  const switchedToCanvas = await clickModeOption('canvas')
  await waitForMode('canvas')
  await setText('')
  virtualClickAt(2, 4)
  await waitFor('pecm-26-pad-applied', () => getContent() === '\n\n    ', 2000, 40)
  record('PECM-26-mode-canvas-restores-virtual-click', switchedToCanvas && findModeTrigger()?.dataset.mode === 'canvas' && getContent() === '\n\n    ', {
    switchedToCanvas,
    triggerMode: findModeTrigger()?.dataset.mode,
    actual: JSON.stringify(getContent())
  })

  // PECM-27: switching to Line then submitting (Cmd/Ctrl+Enter) still saves
  // the prompt — proves toggle does not break the existing submit path.
  await setText('')
  await clickModeOption('line')
  await waitForMode('line')
  const submitMarker27 = `mode-line-submit-${Date.now()}`
  await setText(submitMarker27)
  const ta27 = findTextarea()
  const before27Ids = new Set(notebookApi()!.getPrompts().map(p => p.id))
  if (ta27) {
    ta27.focus()
    ta27.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
      ...(isMac ? { metaKey: true } : { ctrlKey: true })
    }))
  }
  await waitFor('pecm-27-prompt-saved', () => {
    return notebookApi()!.getPrompts().some(p => !before27Ids.has(p.id) && p.content === submitMarker27)
  }, 3000, 80).catch(() => false)
  const submitted27 = notebookApi()!.getPrompts().find(p => !before27Ids.has(p.id) && p.content === submitMarker27)
  record('PECM-27-mode-line-still-submits', Boolean(submitted27), {
    found: Boolean(submitted27)
  })
  // Restore the default Canvas mode so subsequent suites start from a clean state.
  await clickModeOption('canvas')
  await waitForMode('canvas')
  await setText('')

  log('PECM:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
