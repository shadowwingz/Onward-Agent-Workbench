/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState } from 'react'

import type { GitDiffDebugStats } from '../../types/electron'
import { useI18n } from '../../i18n/useI18n'
import {
  aggregateClickHistory,
  computePhaseMs,
  type ClickAggregateStats,
  type PhaseMs
} from './gitDiffDebugAggregator'
import {
  GitDiffClickLatencyTracker,
  type ClickLatencyMeasurement
} from './clickLatencyTracker'
import './GitDiffDebugPanel.css'

interface GitDiffDebugPanelProps {
  tracker: GitDiffClickLatencyTracker
  cwd: string
  terminalId: string
  collapsed: boolean
  onToggleCollapsed: (next: boolean) => void
}

interface ClickEnvelope {
  measurement: ClickLatencyMeasurement | null
  history: ClickLatencyMeasurement[]
}

const PHASE_KEYS: Array<keyof PhaseMs> = [
  'ipcMs',
  'stateSetMs',
  'mountMs',
  'diffComputeMs',
  'paintMs'
]

const PHASE_COLORS: Record<keyof PhaseMs, string> = {
  ipcMs: 'var(--git-diff-debug-ipc, #6366f1)',
  stateSetMs: 'var(--git-diff-debug-state, #8b5cf6)',
  mountMs: 'var(--git-diff-debug-mount, #ec4899)',
  diffComputeMs: 'var(--git-diff-debug-diff-compute, #f59e0b)',
  paintMs: 'var(--git-diff-debug-paint, #10b981)'
}

const HISTOGRAM_WINDOW = 30
const POLL_INTERVAL_MS = 1000

const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const formatMs = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n < 10) return `${n.toFixed(1)} ms`
  return `${n.toFixed(0)} ms`
}

const elapsedSince = (ts: number, now: number): string => {
  const delta = Math.max(0, now - ts)
  if (delta < 1000) return `${delta.toFixed(0)}ms`
  if (delta < 60_000) return `${(delta / 1000).toFixed(1)}s`
  if (delta < 3_600_000) return `${(delta / 60_000).toFixed(1)}m`
  return `${(delta / 3_600_000).toFixed(1)}h`
}

interface PhaseBarSegment {
  key: keyof PhaseMs
  ms: number
  color: string
}

const buildPhaseSegments = (phases: PhaseMs): PhaseBarSegment[] => {
  return PHASE_KEYS.map((key) => ({
    key,
    ms: phases[key] ?? 0,
    color: PHASE_COLORS[key]
  })).filter((seg) => seg.ms > 0)
}

export function GitDiffDebugPanel(props: GitDiffDebugPanelProps): JSX.Element {
  const { tracker, cwd, terminalId, collapsed, onToggleCollapsed } = props
  const { t } = useI18n()

  const [envelope, setEnvelope] = useState<ClickEnvelope>({
    measurement: tracker.getLast(),
    history: tracker.getHistory()
  })
  const [stats, setStats] = useState<GitDiffDebugStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)

  // Subscribe to tracker so each completed click refreshes the panel.
  useEffect(() => {
    const update = () => {
      setEnvelope({
        measurement: tracker.getLast(),
        history: tracker.getHistory()
      })
    }
    update()
    const unsubscribe = tracker.addListener(() => update())
    return unsubscribe
  }, [tracker])

  // Poll main-process cache + scheduler stats only while the panel is
  // expanded. Collapsed mode shows just the last-click summary (in-memory
  // tracker), so there's nothing to refresh — and a collapsed panel
  // shouldn't pay the IPC tick cost. 1 Hz cadence keeps chatter
  // negligible (one in-memory map snapshot read per tick) while still
  // catching precompute bursts as they finish.
  useEffect(() => {
    if (collapsed) {
      // Drop stale stats so the next expansion reads fresh data instead
      // of flashing yesterday's snapshot for one tick.
      setStats(null)
      setStatsError(null)
      return
    }
    let cancelled = false
    const fetchStats = async () => {
      const api = window.electronAPI?.debug
      if (!api?.getGitDiffDebugStats) {
        if (!cancelled) setStatsError('debug api unavailable')
        return
      }
      try {
        const result = await api.getGitDiffDebugStats()
        if (!cancelled) {
          setStats(result)
          setStatsError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setStatsError(err instanceof Error ? err.message : String(err))
        }
      }
    }
    void fetchStats()
    const handle = window.setInterval(fetchStats, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [collapsed])

  const aggregate = useMemo<ClickAggregateStats>(() => {
    return aggregateClickHistory(envelope.history, HISTOGRAM_WINDOW)
  }, [envelope.history])

  const lastPhases = useMemo<PhaseMs | null>(() => {
    if (!envelope.measurement) return null
    return computePhaseMs(envelope.measurement)
  }, [envelope.measurement])

  const lastSegments = useMemo<PhaseBarSegment[]>(() => {
    return lastPhases ? buildPhaseSegments(lastPhases) : []
  }, [lastPhases])

  const lastTotal = envelope.measurement?.totalMs ?? null
  const lastTotalForBar = lastTotal && lastTotal > 0 ? lastTotal : 0
  const histogramData = useMemo(() => {
    return envelope.history
      .slice(-HISTOGRAM_WINDOW)
      .map((m) => ({
        measurement: m,
        phases: computePhaseMs(m),
        totalMs: m.totalMs
      }))
  }, [envelope.history])

  const histogramMaxMs = useMemo(() => {
    let peak = 0
    for (const item of histogramData) {
      if (item.totalMs !== null && item.totalMs > peak) peak = item.totalMs
    }
    return peak
  }, [histogramData])

  const handleReset = () => {
    tracker.reset()
    setEnvelope({ measurement: null, history: [] })
  }

  const now = Date.now()

  return (
    <div className={`git-diff-debug-panel${collapsed ? ' is-collapsed' : ''}`}>
      <div className="gddp-header">
        <button
          type="button"
          className="gddp-toggle"
          onClick={() => onToggleCollapsed(!collapsed)}
          aria-label={t('gitDiff.debug.toggleAria')}
          title={t(collapsed ? 'gitDiff.debug.expand' : 'gitDiff.debug.collapse' as const)}
        >
          <span className={`gddp-chevron${collapsed ? ' is-collapsed' : ''}`} aria-hidden="true">
            ▾
          </span>
          <span className="gddp-title">{t('gitDiff.debug.title')}</span>
        </button>
        <div className="gddp-summary">
          {envelope.measurement ? (
            <>
              <span className="gddp-summary-file" title={envelope.measurement.filename}>
                {envelope.measurement.filename}
              </span>
              <span className={`gddp-pill gddp-pill-${envelope.measurement.cacheState}`}>
                {t(`gitDiff.debug.cache.${envelope.measurement.cacheState}` as CacheLabelKey)}
              </span>
              <span className="gddp-summary-total">
                {t('gitDiff.debug.total')}: <strong>{formatMs(lastTotal)}</strong>
              </span>
            </>
          ) : (
            <span className="gddp-summary-empty">{t('gitDiff.debug.noClickYet')}</span>
          )}
        </div>
        {!collapsed && (
          <button
            type="button"
            className="gddp-reset"
            onClick={handleReset}
            title={t('gitDiff.debug.reset')}
          >
            {t('gitDiff.debug.reset')}
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="gddp-body">
          <section className="gddp-section gddp-last-click">
            <h4 className="gddp-section-title">{t('gitDiff.debug.lastClick')}</h4>
            {envelope.measurement ? (
              <>
                <div
                  className="gddp-phase-bar"
                  role="img"
                  aria-label={t('gitDiff.debug.lastClickAria')}
                >
                  {lastSegments.length > 0 && lastTotalForBar > 0 ? (
                    lastSegments.map((seg) => (
                      <span
                        key={seg.key}
                        className="gddp-phase-bar-seg"
                        style={{
                          flex: seg.ms,
                          backgroundColor: seg.color
                        }}
                        title={`${t(`gitDiff.debug.phase.${seg.key}` as PhaseLabelKey)}: ${formatMs(seg.ms)}`}
                      />
                    ))
                  ) : (
                    <span className="gddp-phase-bar-empty">—</span>
                  )}
                </div>
                <ul className="gddp-phase-legend">
                  {PHASE_KEYS.map((key) => (
                    <li key={key} className="gddp-phase-legend-item">
                      <span className="gddp-phase-swatch" style={{ backgroundColor: PHASE_COLORS[key] }} />
                      <span className="gddp-phase-name">
                        {t(`gitDiff.debug.phase.${key}` as PhaseLabelKey)}
                      </span>
                      <span className="gddp-phase-value">
                        {formatMs(lastPhases ? lastPhases[key] : null)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="gddp-empty">{t('gitDiff.debug.noClickYet')}</p>
            )}
          </section>

          <section className="gddp-section gddp-aggregate">
            <h4 className="gddp-section-title">
              {t('gitDiff.debug.aggregate', { count: HISTOGRAM_WINDOW })}
            </h4>
            <ul className="gddp-stat-row">
              <li>
                <span className="gddp-stat-label">{t('gitDiff.debug.count')}</span>
                <span className="gddp-stat-value">{aggregate.completed}</span>
              </li>
              <li>
                <span className="gddp-stat-label">{t('gitDiff.debug.hitRate')}</span>
                <span className="gddp-stat-value">
                  {aggregate.hitRate === null ? '—' : `${(aggregate.hitRate * 100).toFixed(0)}%`}
                </span>
                <span className="gddp-stat-suffix">
                  ({aggregate.hitCount}/{aggregate.hitCount + aggregate.missCount})
                </span>
              </li>
              <li>
                <span className="gddp-stat-label">p50</span>
                <span className="gddp-stat-value">{formatMs(aggregate.totalMs?.p50)}</span>
              </li>
              <li>
                <span className="gddp-stat-label">p95</span>
                <span className="gddp-stat-value">{formatMs(aggregate.totalMs?.p95)}</span>
              </li>
              <li>
                <span className="gddp-stat-label">{t('gitDiff.debug.max')}</span>
                <span className="gddp-stat-value">{formatMs(aggregate.totalMs?.max)}</span>
              </li>
              <li>
                <span className="gddp-stat-label">{t('gitDiff.debug.cancelled')}</span>
                <span className="gddp-stat-value">{aggregate.cancelled}</span>
              </li>
            </ul>
            <ul className="gddp-phase-mean-row">
              {PHASE_KEYS.map((key) => (
                <li key={key}>
                  <span className="gddp-phase-swatch" style={{ backgroundColor: PHASE_COLORS[key] }} />
                  <span className="gddp-phase-name">
                    {t(`gitDiff.debug.phase.${key}` as PhaseLabelKey)}
                  </span>
                  <span className="gddp-phase-value">
                    {t('gitDiff.debug.meanShort')} {formatMs(aggregate.perPhaseMean[key])}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="gddp-section gddp-cache">
            <h4 className="gddp-section-title">
              {t('gitDiff.debug.contentCacheTitle')}
            </h4>
            {statsError ? (
              <p className="gddp-empty">{statsError}</p>
            ) : stats ? (
              <>
                <p className="gddp-cache-summary">
                  {t('gitDiff.debug.cacheUsage', {
                    used: formatBytes(stats.cache.totalBytes),
                    capacity: formatBytes(stats.cache.maxProjects * stats.cache.projectByteLimit),
                    perProject: formatBytes(stats.cache.projectByteLimit),
                    projects: stats.cache.projects.length,
                    maxProjects: stats.cache.maxProjects
                  })}
                </p>
                {stats.cache.projects.length === 0 ? (
                  <p className="gddp-empty">{t('gitDiff.debug.cacheEmpty')}</p>
                ) : (
                  <ul className="gddp-cache-list">
                    {[...stats.cache.projects]
                      .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
                      .map((p, idx) => {
                        const pct = stats.cache.projectByteLimit > 0
                          ? Math.min(100, (p.bytes / stats.cache.projectByteLimit) * 100)
                          : 0
                        const isCurrent = p.project === cwd
                        return (
                          <li
                            key={p.project}
                            className={`gddp-cache-row${isCurrent ? ' is-current' : ''}`}
                            title={p.project}
                          >
                            <span className="gddp-cache-rank">#{idx + 1}</span>
                            <span className="gddp-cache-path">{p.project}</span>
                            <span className="gddp-cache-bar" aria-hidden="true">
                              <span className="gddp-cache-bar-fill" style={{ width: `${pct}%` }} />
                            </span>
                            <span className="gddp-cache-numbers">
                              {formatBytes(p.bytes)} / {p.entries} {t('gitDiff.debug.entries')}
                            </span>
                            <span className="gddp-cache-touched">
                              {elapsedSince(p.lastTouchedAt, now)}
                            </span>
                          </li>
                        )
                      })}
                  </ul>
                )}
              </>
            ) : (
              <p className="gddp-empty">{t('gitDiff.debug.loading')}</p>
            )}
          </section>

          <section className="gddp-section gddp-list-cache">
            <h4 className="gddp-section-title">
              {t('gitDiff.debug.listCacheTitle')}
            </h4>
            {stats ? (
              (() => {
                const lc = stats.listCache
                const totalLookups = lc.hits + lc.misses
                const hitPct = totalLookups > 0
                  ? `${((lc.hits / totalLookups) * 100).toFixed(0)}%`
                  : '—'
                return (
                  <ul className="gddp-stat-row">
                    <li>
                      <span className="gddp-stat-label">{t('gitDiff.debug.entries')}</span>
                      <span className="gddp-stat-value">{lc.entries}</span>
                      <span className="gddp-stat-suffix">/ {lc.maxEntries}</span>
                    </li>
                    <li>
                      <span className="gddp-stat-label">{t('gitDiff.debug.hitRate')}</span>
                      <span className="gddp-stat-value">{hitPct}</span>
                      <span className="gddp-stat-suffix">({lc.hits}/{totalLookups})</span>
                    </li>
                    <li>
                      <span className="gddp-stat-label">{t('gitDiff.debug.misses')}</span>
                      <span className="gddp-stat-value">{lc.misses}</span>
                    </li>
                    <li>
                      <span className="gddp-stat-label">{t('gitDiff.debug.forces')}</span>
                      <span className="gddp-stat-value">{lc.forces}</span>
                    </li>
                    <li>
                      <span className="gddp-stat-label">{t('gitDiff.debug.inFlight')}</span>
                      <span className="gddp-stat-value">{lc.inFlight}</span>
                    </li>
                    <li>
                      <span className="gddp-stat-label">{t('gitDiff.debug.ttl')}</span>
                      <span className="gddp-stat-value">{lc.ttlMs}ms</span>
                    </li>
                  </ul>
                )
              })()
            ) : (
              <p className="gddp-empty">{t('gitDiff.debug.loading')}</p>
            )}
          </section>

          <section className="gddp-section gddp-scheduler">
            <h4 className="gddp-section-title">
              {t('gitDiff.debug.schedulerTitle')}
            </h4>
            {stats ? (
              <ul className="gddp-stat-row">
                <li>
                  <span className="gddp-stat-label">{t('gitDiff.debug.bursts')}</span>
                  <span className="gddp-stat-value">{stats.scheduler.totalBursts}</span>
                </li>
                <li>
                  <span className="gddp-stat-label">{t('gitDiff.debug.inFlight')}</span>
                  <span className="gddp-stat-value">{stats.scheduler.inFlightProjects.length}</span>
                </li>
                <li>
                  <span className="gddp-stat-label">{t('gitDiff.debug.pending')}</span>
                  <span className="gddp-stat-value">{stats.scheduler.pendingProjects.length}</span>
                </li>
                <li>
                  <span className="gddp-stat-label">{t('gitDiff.debug.completed')}</span>
                  <span className="gddp-stat-value">{stats.scheduler.totalCompleted}</span>
                </li>
                <li>
                  <span className="gddp-stat-label">{t('gitDiff.debug.cancelled')}</span>
                  <span className="gddp-stat-value">{stats.scheduler.totalCancelled}</span>
                </li>
                <li>
                  <span className="gddp-stat-label">{t('gitDiff.debug.skipped')}</span>
                  <span className="gddp-stat-value">{stats.scheduler.totalSkipped}</span>
                </li>
              </ul>
            ) : (
              <p className="gddp-empty">{t('gitDiff.debug.loading')}</p>
            )}
          </section>

          <section className="gddp-section gddp-history">
            <h4 className="gddp-section-title">
              {t('gitDiff.debug.history', { count: HISTOGRAM_WINDOW })}
            </h4>
            {histogramData.length === 0 ? (
              <p className="gddp-empty">{t('gitDiff.debug.noClickYet')}</p>
            ) : (
              <div className="gddp-histogram" role="img" aria-label={t('gitDiff.debug.historyAria')}>
                {histogramData.map((item, idx) => {
                  const total = item.totalMs ?? 0
                  const bucketHeightPct = histogramMaxMs > 0
                    ? Math.max(2, (total / histogramMaxMs) * 100)
                    : 0
                  const segments = buildPhaseSegments(item.phases)
                  const summed = segments.reduce((a, b) => a + b.ms, 0)
                  const tooltip = `${item.measurement.filename}\n${formatMs(total)} | ${item.measurement.cacheState}`
                  return (
                    <div
                      key={`${idx}-${item.measurement.fileKey}`}
                      className={`gddp-histogram-bar${item.measurement.cancelled ? ' is-cancelled' : ''}`}
                      style={{ height: `${bucketHeightPct}%` }}
                      title={tooltip}
                    >
                      {segments.map((seg) => (
                        <span
                          key={seg.key}
                          className="gddp-histogram-seg"
                          style={{
                            flex: seg.ms,
                            backgroundColor: seg.color,
                            // Guard against zero-sum floats; if summed is 0
                            // the segments collapse anyway.
                            opacity: summed > 0 ? 1 : 0
                          }}
                        />
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      )}
      <div className="gddp-context-row">
        <span className="gddp-context-label">cwd</span>
        <span className="gddp-context-value" title={cwd}>{cwd || '—'}</span>
        <span className="gddp-context-label">tid</span>
        <span className="gddp-context-value">{terminalId || '—'}</span>
      </div>
    </div>
  )
}

type PhaseLabelKey =
  | 'gitDiff.debug.phase.ipcMs'
  | 'gitDiff.debug.phase.stateSetMs'
  | 'gitDiff.debug.phase.mountMs'
  | 'gitDiff.debug.phase.diffComputeMs'
  | 'gitDiff.debug.phase.paintMs'

type CacheLabelKey =
  | 'gitDiff.debug.cache.hit'
  | 'gitDiff.debug.cache.miss'
  | 'gitDiff.debug.cache.unknown'
