/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitWatcherErrorBanner.
 *
 * Visible, dismissable banner shown when the GitStateMirror watcher
 * supervisor is recovering, degraded, suspended, or fully failed.
 *
 * Mount once at App.tsx top level. The component owns its subscription
 * to GitStateMirror watcher health IPC; renders nothing while healthy.
 */

import { useEffect, useState, useCallback } from 'react'

import { useI18n } from '../../i18n/useI18n'
import type { GitStateMirrorWatcherHealth, GitStateMirrorWatcherStatus } from '../../types/electron'

interface WatcherBannerState {
  cwd: string
  health: GitStateMirrorWatcherHealth
  message: string | null
  shownAt: number
  hardFailure: boolean
}

export function GitWatcherErrorBanner(): JSX.Element | null {
  const { t } = useI18n()
  const [banner, setBanner] = useState<WatcherBannerState | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    const api = window.electronAPI?.git
    const disposers: Array<() => void> = []
    if (api?.onMirrorWatcherStatus) {
      disposers.push(api.onMirrorWatcherStatus((status: GitStateMirrorWatcherStatus) => {
        if (
          status.health === 'idle' ||
          status.health === 'attaching' ||
          status.health === 'healthy' ||
          status.health === 'detached'
        ) {
          setBanner((prev) => prev?.cwd === status.cwd ? null : prev)
          return
        }
        setBanner({
          cwd: status.cwd,
          health: status.health,
          message: status.message,
          shownAt: status.updatedAt,
          hardFailure: status.health === 'failed'
        })
      }))
    }
    if (api?.onMirrorWatcherError) {
      disposers.push(api.onMirrorWatcherError((cwd, message) => {
        setBanner({
          cwd,
          health: 'failed',
          message,
          shownAt: Date.now(),
          hardFailure: true
        })
      }))
    }
    return () => {
      for (const dispose of disposers) dispose?.()
    }
  }, [])

  const onDismiss = useCallback(() => {
    setBanner(null)
  }, [])

  const onRefresh = useCallback(() => {
    if (!banner) return
    setRefreshing(true)
    void Promise.resolve(window.electronAPI?.git?.forceRefresh?.(banner.cwd))
      .finally(() => {
        setRefreshing(false)
        setBanner(null)
      })
  }, [banner])

  if (!banner) return null

  const repoLabel = (() => {
    const cleaned = banner.cwd.replace(/[\\/]+$/, '')
    const parts = cleaned.split(/[\\/]/)
    return parts[parts.length - 1] || banner.cwd
  })()

  const titleKey = (banner.hardFailure
    ? 'gitState.watcherStatus.failed.title'
    : `gitState.watcherStatus.${banner.health}.title`) as Parameters<typeof t>[0]
  const bodyKey = (banner.hardFailure
    ? 'gitState.watcherStatus.failed.body'
    : `gitState.watcherStatus.${banner.health}.body`) as Parameters<typeof t>[0]
  const background = banner.hardFailure
    ? 'rgba(239, 68, 68, 0.95)'
    : 'rgba(217, 119, 6, 0.96)'
  const buttonColor = banner.hardFailure ? '#b91c1c' : '#92400e'

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
        background,
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
          {t(titleKey)}
        </div>
        <div style={{ opacity: 0.92 }}>
          {t(bodyKey, { repo: repoLabel })}
        </div>
      </div>
      {banner.hardFailure && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          style={{
            background: '#fff',
            color: buttonColor,
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
      )}
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
