/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitWatcherErrorBanner.
 *
 * Phase 5 deliverable: visible, dismissable banner shown when the
 * GitStateMirror worker reports a parcel-watcher failure for any
 * subscribed repo. There is no silent fallback by design (per the
 * Onward state-flow architecture's "explicit failure + user-visible
 * prompt" decision) — this banner is the contract.
 *
 * Mount once at App.tsx top level. The component owns its subscription
 * to `electronAPI.git.onMirrorWatcherError`; renders nothing when no
 * error is in flight.
 */

import { useEffect, useState, useCallback } from 'react'

import { useI18n } from '../../i18n/useI18n'

interface WatcherErrorState {
  cwd: string
  message: string
  shownAt: number
}

export function GitWatcherErrorBanner(): JSX.Element | null {
  const { t } = useI18n()
  const [error, setError] = useState<WatcherErrorState | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    const api = window.electronAPI?.git
    if (!api?.onMirrorWatcherError) return
    const dispose = api.onMirrorWatcherError((cwd, message) => {
      setError({ cwd, message, shownAt: Date.now() })
    })
    return () => { dispose?.() }
  }, [])

  const onDismiss = useCallback(() => {
    setError(null)
  }, [])

  const onRefresh = useCallback(() => {
    if (!error) return
    setRefreshing(true)
    void Promise.resolve(window.electronAPI?.git?.forceRefresh?.(error.cwd))
      .finally(() => {
        setRefreshing(false)
        setError(null)
      })
  }, [error])

  if (!error) return null

  const repoLabel = (() => {
    const cleaned = error.cwd.replace(/[\\/]+$/, '')
    const parts = cleaned.split(/[\\/]/)
    return parts[parts.length - 1] || error.cwd
  })()

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        background: 'rgba(239, 68, 68, 0.95)',
        color: '#fff',
        borderRadius: 8,
        padding: '10px 14px',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)',
        fontSize: 13,
        lineHeight: 1.4,
        maxWidth: 720,
        display: 'flex',
        alignItems: 'center',
        gap: 14
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>
          {t('gitState.watcherError.title')}
        </div>
        <div style={{ opacity: 0.92 }}>
          {t('gitState.watcherError.body', { repo: repoLabel })}
        </div>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        style={{
          background: '#fff',
          color: '#b91c1c',
          border: 'none',
          borderRadius: 4,
          padding: '4px 10px',
          fontSize: 12,
          fontWeight: 600,
          cursor: refreshing ? 'default' : 'pointer',
          opacity: refreshing ? 0.75 : 1
        }}
      >
        {t('gitState.watcherError.reload')}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('gitState.watcherError.dismiss')}
        title={t('gitState.watcherError.dismiss')}
        style={{
          background: 'transparent',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.4)',
          borderRadius: 4,
          padding: '4px 8px',
          fontSize: 12,
          cursor: 'pointer'
        }}
      >
        ✕
      </button>
    </div>
  )
}
