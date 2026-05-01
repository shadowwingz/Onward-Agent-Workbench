/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * Lightweight DOM-only sanity for the Task layout extension. Checks that:
 *   - Sidebar exposes the new 8-grid button.
 *   - Sidebar exposes the Custom button.
 *   - Clicking the 8-grid button flips data-layout="8" on the active grid.
 *   - Clicking the Custom button mounts the preset popover.
 * Drag-to-create + downsize semantics are unit-tested in
 * `test/unittest/task-layout-utils.test.mts` because mouse-event simulation
 * across our atomic-cell mesh is fragile in headless Electron. This e2e
 * verifies the integration wiring (Sidebar → AppState → TerminalGrid CSS
 * hook), which is where regressions would actually break the UI.
 */
function findSidebarLayoutButton(matchTitleSubstrings: readonly string[]): HTMLButtonElement | null {
  // Sidebar buttons carry the i18n string in `title=`; we match on a
  // language-agnostic substring set so the suite doesn't need to know
  // which locale the app booted in.
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar .sidebar-btn'))
  for (const btn of buttons) {
    const title = (btn.getAttribute('title') ?? '').toLowerCase()
    if (matchTitleSubstrings.some(needle => title.includes(needle.toLowerCase()))) {
      return btn
    }
  }
  return null
}

function activeGridLayoutAttr(): string | null {
  // Multiple TerminalGrid instances live in the DOM (one per tab). The
  // visible one is the wrapper without the `terminal-grid-hidden` modifier.
  const grids = Array.from(document.querySelectorAll<HTMLElement>('.terminal-grid-wrapper'))
  const visible = grids.find(g => !g.classList.contains('terminal-grid-hidden'))
  if (!visible) return null
  const inner = visible.querySelector<HTMLElement>('.terminal-grid')
  return inner?.getAttribute('data-layout') ?? null
}

export async function testTaskLayout(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  // Wait for the sidebar to mount before probing buttons. The autotest
  // harness opens the project editor by default, but the sidebar is
  // rendered eagerly so this should resolve quickly.
  const sidebarReady = await waitFor('sidebar-mounted', () => {
    return document.querySelector('.sidebar') !== null
  }, 8000)
  record('TLM-00-sidebar-mounted', sidebarReady)
  if (!sidebarReady || cancelled()) return results

  // ── TLM-01: 8-grid button is reachable ──
  // Title strings: en="Eight terminals", zh-CN="八宫格". Match a
  // language-agnostic token set so the runner survives a locale swap.
  const eightBtn = findSidebarLayoutButton(['eight', '八宫格'])
  record('TLM-01-eight-grid-button-present', eightBtn !== null)

  // ── TLM-02: Custom button is reachable ──
  const customBtn = findSidebarLayoutButton(['custom layout', '自定义布局'])
  record('TLM-02-custom-button-present', customBtn !== null)

  if (!eightBtn || !customBtn) return results

  // ── TLM-03: clicking the 8-grid button flips data-layout="8" ──
  // The user might already be on layout 8 (depends on prior persisted
  // state). To keep the assertion deterministic, click "Single" (1) first,
  // then click "8" and observe.
  const singleBtn = findSidebarLayoutButton(['single', '单窗口'])
  if (singleBtn) {
    singleBtn.click()
    await sleep(80)
  }
  eightBtn.click()
  const flippedToEight = await waitFor('grid-layout-eight', () => activeGridLayoutAttr() === '8', 4000, 80)
  record('TLM-03-grid-layout-eight-after-click', flippedToEight, {
    layout: activeGridLayoutAttr()
  })

  // ── TLM-04: switching back to single shrinks the grid ──
  // We just expanded to 8; clicking Single (1) requests a downsize from 8
  // current Tasks to 1. The downsize dialog should appear (because
  // requiredCount < currentCount). This validates the dialog mounts in the
  // right code path; the user can dismiss it because we don't run
  // confirm here (drag-to-confirm is unit-tested separately).
  if (singleBtn) {
    singleBtn.click()
    const dialogShown = await waitFor(
      'downsize-dialog-visible',
      () => document.querySelector('.downsize-confirm-dialog') !== null,
      4000,
      80
    )
    record('TLM-04-downsize-dialog-shown', dialogShown)
    if (dialogShown) {
      // Dismiss so we don't leave the app in a modal state.
      const cancel = document.querySelector<HTMLButtonElement>('.downsize-confirm-secondary')
      cancel?.click()
      await sleep(100)
    }
  } else {
    record('TLM-04-downsize-dialog-shown', false, { reason: 'single-button-not-found' })
  }

  // ── TLM-05: Custom button opens the popover ──
  customBtn.click()
  const popoverShown = await waitFor(
    'custom-popover-visible',
    () => document.querySelector('.custom-layout-popover') !== null,
    4000,
    80
  )
  record('TLM-05-custom-popover-opens', popoverShown)
  if (popoverShown) {
    // Click outside to close so subsequent suites have a clean DOM.
    document.body.click()
    await sleep(100)
  }

  return results
}
