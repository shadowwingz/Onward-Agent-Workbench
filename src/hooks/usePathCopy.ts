/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react'
import type { TranslationKey } from '../i18n/core'
import { writeTextTiered } from './clipboardWrite'
import { perfTrace } from '../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../utils/perf-trace-names'

interface CopyMessage {
  type: 'success' | 'error'
  text: string
}

/**
 * Last-resort copy tier: off-screen textarea + execCommand('copy'). Mirrors
 * TerminalGrid's fallback so a path copy still works without the native
 * clipboard bridge or the focus-gated Async Clipboard API.
 */
function legacyExecCopy(text: string): boolean {
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus({ preventScroll: true })
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

type TranslatorFn = (key: TranslationKey, params?: Record<string, string>) => string

/**
 * Shared hook for file-path copy operations.
 *
 * Provides clipboard copy with auto-dismiss toast feedback,
 * a double-click flash + selection-clear helper, and a
 * copy-by-kind utility for context menus.
 */
export function usePathCopy(t: TranslatorFn, errorKey: TranslationKey) {
  const [copyMessage, setCopyMessage] = useState<CopyMessage | null>(null)

  useEffect(() => {
    if (!copyMessage) return
    const timer = window.setTimeout(() => setCopyMessage(null), 2000)
    return () => window.clearTimeout(timer)
  }, [copyMessage])

  const copyToClipboard = useCallback(async (text: string, label: string): Promise<boolean> => {
    // Tiered write: native Electron clipboard (focus-independent) -> browser
    // Async Clipboard API (focus-gated) -> legacy execCommand. Using only the
    // focus-gated API made this the ONE copy path in the app that failed when
    // Onward was not the OS-focused window (WDC-01/02/03 + a real user).
    const tier = await writeTextTiered(text, {
      // electronAPI/clipboard may be absent in some contexts → resolve false so
      // the orchestrator advances to the next tier; if present, returns Promise<boolean>.
      native: (value) => window.electronAPI?.clipboard?.writeText(value) ?? Promise.resolve(false),
      // navigator.clipboard is typed as always-present but can be missing / reject
      // (insecure or unfocused context) at runtime — the orchestrator's catch falls through.
      async: (value) => navigator.clipboard.writeText(value),
      legacy: legacyExecCopy
    })
    const ok = tier !== 'none'
    perfTrace(PERF_TRACE_EVENT.RENDERER_CLIPBOARD_PATH_COPY, { tier, ok, textLen: text.length })
    if (ok) {
      setCopyMessage({ type: 'success', text: t('common.copied', { label, text }) })
      return true
    }
    setCopyMessage({ type: 'error', text: t(errorKey) })
    return false
  }, [t, errorKey])

  const showCopyError = useCallback((text: string) => {
    setCopyMessage({ type: 'error', text })
  }, [])

  // Callers must pass a pre-captured element (capture `e.currentTarget` synchronously before any await,
  // since React clears SyntheticEvent.currentTarget after the handler returns).
  const flashCopyFeedback = useCallback((target: HTMLElement) => {
    window.getSelection()?.removeAllRanges()
    target.classList.add('copy-flash')
    window.setTimeout(() => target.classList.remove('copy-flash'), 300)
  }, [])

  return { copyMessage, copyToClipboard, showCopyError, flashCopyFeedback }
}
