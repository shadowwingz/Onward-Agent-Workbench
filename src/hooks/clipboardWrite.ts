/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tiered clipboard write orchestrator. Pure (the three strategies are injected),
 * so the FALLBACK ORDER is unit-testable without DOM / Electron globals.
 *
 * Order matters: the native Electron clipboard (main-process `electron.clipboard`
 * via IPC) is NOT focus-gated, so it succeeds even when the Onward window is not
 * the OS-focused window. Chromium's Async Clipboard API (`navigator.clipboard`)
 * REJECTS with NotAllowedError "Document is not focused" in that state — which is
 * exactly why a copy that only used it failed in the unattended autotest AND for
 * a real user copying while another window is focused (WDC-01/02/03). The legacy
 * `document.execCommand('copy')` textarea trick is the last resort.
 */

export type ClipboardWriteTier = 'native' | 'async' | 'legacy' | 'none'

export interface ClipboardWriteTiers {
  /** Native Electron clipboard (focus-independent); resolves true on success. */
  native?: (text: string) => Promise<boolean>
  /** Browser Async Clipboard API (focus-gated); resolves on success, rejects otherwise. */
  async?: (text: string) => Promise<void>
  /** Legacy execCommand('copy') via an off-screen textarea; returns true on success. */
  legacy?: (text: string) => boolean
}

/**
 * Try each present tier in order until one succeeds. Returns the winning tier,
 * or 'none' if every tier was absent / threw / returned false.
 */
export async function writeTextTiered(
  text: string,
  tiers: ClipboardWriteTiers
): Promise<ClipboardWriteTier> {
  if (tiers.native) {
    try {
      if (await tiers.native(text)) return 'native'
    } catch { /* fall through to the next tier */ }
  }
  if (tiers.async) {
    try {
      await tiers.async(text)
      return 'async'
    } catch { /* fall through to the next tier */ }
  }
  if (tiers.legacy) {
    try {
      if (tiers.legacy(text)) return 'legacy'
    } catch { /* fall through */ }
  }
  return 'none'
}
