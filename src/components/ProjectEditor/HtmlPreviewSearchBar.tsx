/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useI18n } from '../../i18n/useI18n'
import './PreviewSearch/PreviewSearchBar.css'

export interface HtmlPreviewSearchResult {
  matches: number
  activeMatchOrdinal: number
  finalUpdate: boolean
}

interface HtmlPreviewSearchBarProps {
  isOpen: boolean
  focusRequestId: number
  query: string
  result: HtmlPreviewSearchResult
  onQueryChange: (query: string) => void
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}

export function HtmlPreviewSearchBar({
  isOpen,
  focusRequestId,
  query,
  result,
  onQueryChange,
  onNext,
  onPrevious,
  onClose
}: HtmlPreviewSearchBarProps) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)

  const focusInput = useCallback(() => {
    window.focus()
    const input = inputRef.current
    if (!input) return
    input.focus({ preventScroll: true })
    input.select()
  }, [])

  useEffect(() => {
    if (!isOpen) return
    focusInput()
    const raf = window.requestAnimationFrame(focusInput)
    const timeout = window.setTimeout(focusInput, 80)
    return () => {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(timeout)
    }
  }, [focusInput, focusRequestId, isOpen])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      onClose()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) {
        onPrevious()
      } else {
        onNext()
      }
    }
  }, [onClose, onNext, onPrevious])

  const preventButtonFocusSteal = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
  }, [])

  const handleClosePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }, [onClose])

  const handleCloseMouseDown = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }, [onClose])

  const handleCloseClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }, [onClose])

  const countText = useMemo(() => {
    if (!query) return ''
    if (result.finalUpdate && result.matches === 0) return t('projectEditor.previewSearch.noMatches')
    if (result.matches <= 0) return ''
    return t('projectEditor.previewSearch.count', {
      current: String(Math.max(1, result.activeMatchOrdinal)),
      total: String(result.matches)
    })
  }, [query, result.activeMatchOrdinal, result.finalUpdate, result.matches, t])

  if (!isOpen) return null

  return (
    <div className="preview-search-bar">
      <input
        ref={inputRef}
        className="preview-search-input"
        type="text"
        placeholder={t('projectEditor.previewSearch.placeholder')}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className="preview-search-count">{countText}</span>
      <button
        type="button"
        className="preview-search-nav-btn"
        aria-label={t('projectEditor.previewSearch.previous')}
        onMouseDown={preventButtonFocusSteal}
        onClick={onPrevious}
        disabled={result.matches === 0}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M7.646 4.646a.5.5 0 0 1 .708 0l4 4a.5.5 0 0 1-.708.708L8 5.707 4.354 9.354a.5.5 0 1 1-.708-.708l4-4z" />
        </svg>
      </button>
      <button
        type="button"
        className="preview-search-nav-btn"
        aria-label={t('projectEditor.previewSearch.next')}
        onMouseDown={preventButtonFocusSteal}
        onClick={onNext}
        disabled={result.matches === 0}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8.354 11.354a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 .708-.708L8 10.293l3.646-3.647a.5.5 0 0 1 .708.708l-4 4z" />
        </svg>
      </button>
      <button
        type="button"
        className="preview-search-close-btn"
        aria-label={t('projectEditor.previewSearch.closeButton')}
        onPointerDown={handleClosePointerDown}
        onMouseDown={handleCloseMouseDown}
        onClick={handleCloseClick}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
        </svg>
      </button>
    </div>
  )
}
