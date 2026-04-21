/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MouseEvent, ReactNode } from 'react'
import { useCallback, useMemo } from 'react'
import type { TranslationKey } from '../i18n/core'
import { usePathCopy } from './usePathCopy'

type TranslatorFn = (key: TranslationKey, params?: Record<string, string>) => string

export interface UseCwdCopyHandlerResult {
  copyMessage: ReturnType<typeof usePathCopy>['copyMessage']
  title: string | undefined
  onDoubleClick: (event: MouseEvent<HTMLElement>) => Promise<void>
  feedback: ReactNode
}

/**
 * Shared hook for the "double-click working directory to copy" pattern used by
 * Project Editor, Git Diff, and Git History subpage headers.
 *
 * Wraps `usePathCopy` with a dedicated toast lane (isolated from any filename
 * toast the caller may also host) and produces the three ready-to-attach
 * primitives that the shared SubpagePanelShell expects: tooltip title,
 * double-click handler, and inline toast node.
 */
export function useCwdCopyHandler(
  cwdPath: string | null | undefined,
  t: TranslatorFn,
  errorKey: TranslationKey
): UseCwdCopyHandlerResult {
  const { copyMessage, copyToClipboard, flashCopyFeedback } = usePathCopy(t, errorKey)

  const title = useMemo(() => {
    if (!cwdPath) return undefined
    return `${cwdPath}\n${t('common.cwdCopyHint')}`
  }, [cwdPath, t])

  const onDoubleClick = useCallback(async (event: MouseEvent<HTMLElement>) => {
    if (!cwdPath) return
    const target = event.currentTarget as HTMLElement
    const ok = await copyToClipboard(cwdPath, t('common.workingDirectory'))
    if (ok) flashCopyFeedback(target)
  }, [copyToClipboard, cwdPath, flashCopyFeedback, t])

  const feedback = useMemo<ReactNode>(() => {
    if (!copyMessage) return null
    return (
      <span className={`path-copy-toast ${copyMessage.type}`}>
        {copyMessage.text}
      </span>
    )
  }, [copyMessage])

  return { copyMessage, title, onDoubleClick, feedback }
}
