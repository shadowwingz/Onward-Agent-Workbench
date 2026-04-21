/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function isVisibleElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element.closest('[aria-hidden="true"]')) return false
  if (element.getClientRects().length === 0) return false
  const style = window.getComputedStyle(element)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

function getVisiblePanelShell(): HTMLElement | null {
  const shells = Array.from(document.querySelectorAll<HTMLElement>('[data-subpage-panel-shell="true"]'))
    .filter(isVisibleElement)
  return shells[0] ?? null
}

function getPanelCwdElement(): HTMLElement | null {
  const shell = getVisiblePanelShell()
  if (!shell) return null
  const el = shell.querySelector<HTMLElement>('.subpage-panel-shell-location.is-copyable')
  return isVisibleElement(el) ? el : null
}

function getPanelCwdPathText(): string | null {
  const shell = getVisiblePanelShell()
  if (!shell) return null
  const el = shell.querySelector<HTMLElement>('.subpage-panel-shell-location-path')
  return el?.textContent?.trim() ?? null
}

function getPanelCwdToastText(): { type: 'success' | 'error' | null; text: string | null } {
  const shell = getVisiblePanelShell()
  if (!shell) return { type: null, text: null }
  const toast = shell.querySelector<HTMLElement>('.subpage-panel-shell-location-feedback .path-copy-toast')
  if (!toast) return { type: null, text: null }
  const type = toast.classList.contains('success') ? 'success' : toast.classList.contains('error') ? 'error' : null
  return { type, text: toast.textContent?.trim() ?? null }
}

function dispatchDoubleClick(target: HTMLElement): void {
  const rect = target.getBoundingClientRect()
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    button: 0,
    buttons: 1,
    clientX: Math.max(0, rect.left + 2),
    clientY: Math.max(0, rect.top + 2),
    detail: 2
  }
  target.dispatchEvent(new MouseEvent('dblclick', init))
}

function getSubpageButton(target: 'diff' | 'editor' | 'history'): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(`[data-subpage-button="${target}"]`))
    .filter((button) => isVisibleElement(button))
  return buttons[0] ?? null
}

function clickSubpageButton(target: 'diff' | 'editor' | 'history'): boolean {
  const button = getSubpageButton(target)
  if (!button || button.disabled) return false
  button.click()
  return true
}

function dispatchEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true
  }))
}

async function readClipboardTextSafe(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText()
  } catch {
    return null
  }
}

interface PathCopyProbe {
  cwdEl: HTMLElement
  expectedPath: string
}

async function probePanelCwdCopy(
  ctx: AutotestContext,
  suiteTag: string
): Promise<{ ok: boolean; detail: Record<string, unknown>; probe: PathCopyProbe | null }> {
  const { waitFor } = ctx

  const shellReady = await waitFor(`${suiteTag}:panel-shell-visible`, () => Boolean(getPanelCwdElement()), 8000)
  if (!shellReady) {
    return {
      ok: false,
      detail: { reason: 'panel-shell-not-visible' },
      probe: null
    }
  }

  const cwdEl = getPanelCwdElement()
  const pathText = getPanelCwdPathText()
  if (!cwdEl || !pathText || pathText === '-') {
    return {
      ok: false,
      detail: { reason: 'cwd-element-missing-or-empty', pathText },
      probe: null
    }
  }

  dispatchDoubleClick(cwdEl)

  const toastReady = await waitFor(`${suiteTag}:toast-visible`, () => {
    const { type } = getPanelCwdToastText()
    return type !== null
  }, 3000)
  if (!toastReady) {
    return {
      ok: false,
      detail: { reason: 'toast-did-not-appear', pathText },
      probe: { cwdEl, expectedPath: pathText }
    }
  }

  const toast = getPanelCwdToastText()
  const clipboardText = await readClipboardTextSafe()
  const clipboardMatches = clipboardText !== null ? normalizePath(clipboardText) === normalizePath(pathText) : null

  const toastMentionsPath = Boolean(toast.text && toast.text.includes(pathText))

  return {
    ok: toast.type === 'success' && toastMentionsPath,
    detail: {
      toastType: toast.type,
      toastText: toast.text,
      expectedPath: pathText,
      clipboardText,
      clipboardMatches
    },
    probe: { cwdEl, expectedPath: pathText }
  }
}

export async function testWorkingDirectoryCopy(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, rootPath } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('phase0.585:start', { suite: 'WorkingDirectoryCopy', rootPath })

  // Phase A: Project Editor cwd copy
  window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId } }))
  const editorOpen = await waitFor('wdc-editor-open', () => Boolean(window.__onwardProjectEditorDebug?.isOpen?.()), 8000)
  _assert('WDC-00-project-editor-open', editorOpen, {
    isOpen: Boolean(window.__onwardProjectEditorDebug?.isOpen?.())
  })
  if (!editorOpen || cancelled()) return results

  const editorProbe = await probePanelCwdCopy(ctx, 'wdc-editor')
  _assert('WDC-01-project-editor-cwd-copy-toast', editorProbe.ok, editorProbe.detail)
  if (cancelled()) return results

  // Allow the editor toast to dismiss before switching to avoid bleed-over assertions.
  await sleep(2200)

  // Phase B: Git Diff cwd copy
  const switchedToDiff = clickSubpageButton('diff')
  _assert('WDC-02A-switch-to-diff', switchedToDiff)
  if (!switchedToDiff || cancelled()) return results
  const diffOpen = await waitFor('wdc-diff-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen?.()), 8000)
  _assert('WDC-02B-git-diff-open', diffOpen)
  if (!diffOpen || cancelled()) return results

  const diffProbe = await probePanelCwdCopy(ctx, 'wdc-diff')
  _assert('WDC-02-git-diff-cwd-copy-toast', diffProbe.ok, diffProbe.detail)
  if (cancelled()) return results

  await sleep(2200)

  // Phase C: Git History cwd copy
  const switchedToHistory = clickSubpageButton('history')
  _assert('WDC-03A-switch-to-history', switchedToHistory)
  if (!switchedToHistory || cancelled()) return results
  const historyOpen = await waitFor('wdc-history-open', () => Boolean(window.__onwardGitHistoryDebug?.isOpen?.()), 8000)
  _assert('WDC-03B-git-history-open', historyOpen)
  if (!historyOpen || cancelled()) return results

  // Git History loads commits asynchronously; wait briefly for the cwd bar to render.
  await sleep(500)
  const historyProbe = await probePanelCwdCopy(ctx, 'wdc-history')
  _assert('WDC-03-git-history-cwd-copy-toast', historyProbe.ok, historyProbe.detail)

  // Cleanup: close any open subpages so subsequent suites start from a known state.
  if (window.__onwardGitHistoryDebug?.isOpen?.()) {
    dispatchEscape()
    await sleep(400)
  }
  if (window.__onwardGitDiffDebug?.isOpen?.()) {
    dispatchEscape()
    await sleep(400)
  }

  return results
}
