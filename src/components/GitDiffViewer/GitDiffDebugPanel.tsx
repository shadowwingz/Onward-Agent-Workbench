/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FocusEvent as ReactFocusEvent, MouseEvent as ReactMouseEvent } from 'react'

import type { GitDiffDebugStats, GitDiffResult } from '../../types/electron'
import { useI18n } from '../../i18n/useI18n'
import { deriveCacheLayerStates, type RenderState, type MainCacheState } from './cacheLayerStates'

// Map two-layer states to existing pill CSS classes (hit = green, miss = red,
// unknown = neutral). Keeping the legacy class names avoids touching CSS.
const RENDER_PILL_CLASS: Record<RenderState, 'hit' | 'unknown'> = {
  loaded: 'hit',
  unloaded: 'unknown'
}
const MAIN_PILL_CLASS: Record<MainCacheState, 'hit' | 'miss' | 'unknown'> = {
  hit: 'hit',
  miss: 'miss',
  'not-consulted': 'unknown'
}
const RENDER_VALUE_KEY: Record<RenderState, 'gitDiff.debug.renderState.loaded' | 'gitDiff.debug.renderState.unloaded'> = {
  loaded: 'gitDiff.debug.renderState.loaded',
  unloaded: 'gitDiff.debug.renderState.unloaded'
}
const MAIN_VALUE_KEY: Record<MainCacheState, 'gitDiff.debug.mainCache.hit' | 'gitDiff.debug.mainCache.miss' | 'gitDiff.debug.mainCache.notConsulted'> = {
  hit: 'gitDiff.debug.mainCache.hit',
  miss: 'gitDiff.debug.mainCache.miss',
  'not-consulted': 'gitDiff.debug.mainCache.notConsulted'
}
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
  diffResult: GitDiffResult | null
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
  'modelBindMs',
  'mountMs',
  'diffComputeMs',
  'domCommitMs',
  'paintMs',
  'tokenizeSettleMs'
]

const PHASE_COLORS: Record<keyof PhaseMs, string> = {
  ipcMs: 'var(--git-diff-debug-ipc, #6366f1)',
  stateSetMs: 'var(--git-diff-debug-state, #8b5cf6)',
  modelBindMs: 'var(--git-diff-debug-model-bind, #06b6d4)',
  mountMs: 'var(--git-diff-debug-mount, #ec4899)',
  diffComputeMs: 'var(--git-diff-debug-diff-compute, #f59e0b)',
  domCommitMs: 'var(--git-diff-debug-dom-commit, #84cc16)',
  paintMs: 'var(--git-diff-debug-paint, #10b981)',
  tokenizeSettleMs: 'var(--git-diff-debug-tokenize-settle, #14b8a6)'
}

const HISTOGRAM_WINDOW = 30
const POLL_INTERVAL_MS = 1000
const CACHE_TOOLTIP_DELAY_MS = 90
const CACHE_TOOLTIP_HIDE_DELAY_MS = 80
const CACHE_TOOLTIP_MAX_ENTRIES = 50

const TERMS_GROUPS = [
  {
    title: 'gitDiff.debug.terms.cacheStrategy.title',
    body: 'gitDiff.debug.terms.cacheStrategy.body'
  },
  {
    title: 'gitDiff.debug.terms.cacheHit.title',
    body: 'gitDiff.debug.terms.cacheHit.body'
  },
  {
    title: 'gitDiff.debug.terms.cacheMiss.title',
    body: 'gitDiff.debug.terms.cacheMiss.body'
  },
  {
    title: 'gitDiff.debug.terms.cacheUnknown.title',
    body: 'gitDiff.debug.terms.cacheUnknown.body'
  },
  {
    title: 'gitDiff.debug.terms.aggregate.title',
    body: 'gitDiff.debug.terms.aggregate.body'
  },
  {
    title: 'gitDiff.debug.terms.contentCacheUi.title',
    body: 'gitDiff.debug.terms.contentCacheUi.body'
  },
  {
    title: 'gitDiff.debug.terms.listCache.title',
    body: 'gitDiff.debug.terms.listCache.body'
  },
  {
    title: 'gitDiff.debug.terms.scheduler.title',
    body: 'gitDiff.debug.terms.scheduler.body'
  },
  {
    title: 'gitDiff.debug.terms.history.title',
    body: 'gitDiff.debug.terms.history.body'
  }
] as const

const PHASE_TERMS = [
  {
    label: 'gitDiff.debug.phase.ipcMs',
    body: 'gitDiff.debug.terms.phase.ipcMs'
  },
  {
    label: 'gitDiff.debug.phase.stateSetMs',
    body: 'gitDiff.debug.terms.phase.stateSetMs'
  },
  {
    label: 'gitDiff.debug.phase.modelBindMs',
    body: 'gitDiff.debug.terms.phase.modelBindMs'
  },
  {
    label: 'gitDiff.debug.phase.mountMs',
    body: 'gitDiff.debug.terms.phase.mountMs'
  },
  {
    label: 'gitDiff.debug.phase.diffComputeMs',
    body: 'gitDiff.debug.terms.phase.diffComputeMs'
  },
  {
    label: 'gitDiff.debug.phase.domCommitMs',
    body: 'gitDiff.debug.terms.phase.domCommitMs'
  },
  {
    label: 'gitDiff.debug.phase.paintMs',
    body: 'gitDiff.debug.terms.phase.paintMs'
  },
  {
    label: 'gitDiff.debug.phase.tokenizeSettleMs',
    body: 'gitDiff.debug.terms.phase.tokenizeSettleMs'
  }
] as const

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

const formatAge = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

interface PhaseBarSegment {
  key: keyof PhaseMs
  ms: number
  color: string
}

type CacheProjectStats = GitDiffDebugStats['cache']['projects'][number]
type CacheEntryStats = CacheProjectStats['entryDetails'][number]
type CacheHoverAnchorEvent = ReactMouseEvent<HTMLElement> | ReactFocusEvent<HTMLElement>

interface CacheHoverCardState {
  kind: 'path' | 'entries'
  project: string
  entries: CacheEntryStats[]
  left: number
  top: number
}

const buildPhaseSegments = (phases: PhaseMs): PhaseBarSegment[] => {
  return PHASE_KEYS.map((key) => ({
    key,
    ms: phases[key] ?? 0,
    color: PHASE_COLORS[key]
  })).filter((seg) => seg.ms > 0)
}

const parseCacheEntryKey = (key: string): { title: string; meta: string } => {
  const parts = key.split('::')
  if (parts.length < 4) return { title: key, meta: '' }
  const [changeType, status, originalFilename, ...filenameParts] = parts
  const filename = filenameParts.join('::') || key
  const meta = [changeType, status, originalFilename].filter(Boolean).join(' | ')
  return { title: filename, meta }
}

const cacheMissReasonKey = (reason: string): CacheMissReasonLabelKey => {
  return `gitDiff.debug.cacheMissReason.${reason}` as CacheMissReasonLabelKey
}

export function GitDiffDebugPanel(props: GitDiffDebugPanelProps): JSX.Element {
  const { tracker, cwd, diffResult, collapsed, onToggleCollapsed } = props
  const { t } = useI18n()

  // Prefer the active measurement once it has progressed past markIpcEnd
  // (cacheState + cacheSource are then known and the pill is renderable).
  // Fall back to the last sealed measurement otherwise. This eliminates the
  // "panel shows nothing because Monaco hasn't fired yet" lag for clicks
  // where the new model content matches the placeholder (untracked empty
  // file, no-change re-renders, etc.).
  const pickDisplayMeasurement = (): ClickLatencyMeasurement | null => {
    const active = tracker.getActive()
    if (active && active.ipcEndAt !== null) return active
    return tracker.getLast()
  }
  const [envelope, setEnvelope] = useState<ClickEnvelope>({
    measurement: pickDisplayMeasurement(),
    history: tracker.getHistory()
  })
  const panelRef = useRef<HTMLDivElement | null>(null)
  const cacheHoverTimerRef = useRef<number | null>(null)
  const [stats, setStats] = useState<GitDiffDebugStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [termsOpen, setTermsOpen] = useState(false)
  const [cacheHoverCard, setCacheHoverCard] = useState<CacheHoverCardState | null>(null)

  // Subscribe to tracker. Tracker fires listeners both at markIpcEnd
  // (so the pill can render the cache outcome immediately, no waiting for
  // tokenize-settle) and at full seal (so totalMs / history fill in).
  useEffect(() => {
    const update = () => {
      setEnvelope({
        measurement: pickDisplayMeasurement(),
        history: tracker.getHistory()
      })
    }
    update()
    const unsubscribe = tracker.addListener(() => update())
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  useEffect(() => {
    return () => {
      if (cacheHoverTimerRef.current !== null) {
        window.clearTimeout(cacheHoverTimerRef.current)
        cacheHoverTimerRef.current = null
      }
    }
  }, [])

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

  const clearCacheHoverTimer = () => {
    if (cacheHoverTimerRef.current !== null) {
      window.clearTimeout(cacheHoverTimerRef.current)
      cacheHoverTimerRef.current = null
    }
  }

  const scheduleCacheHoverHide = () => {
    clearCacheHoverTimer()
    cacheHoverTimerRef.current = window.setTimeout(() => {
      cacheHoverTimerRef.current = null
      setCacheHoverCard(null)
    }, CACHE_TOOLTIP_HIDE_DELAY_MS)
  }

  const showCacheHoverCard = (
    event: CacheHoverAnchorEvent,
    project: string,
    kind: CacheHoverCardState['kind'],
    entries: CacheEntryStats[],
    delayMs: number
  ) => {
    clearCacheHoverTimer()
    const targetRect = event.currentTarget.getBoundingClientRect()
    const panelRect = panelRef.current?.getBoundingClientRect()
    if (!panelRect) return
    const estimatedWidth = kind === 'entries' ? 460 : 560
    const left = Math.max(8, Math.min(
      targetRect.left - panelRect.left,
      Math.max(8, panelRect.width - estimatedWidth - 8)
    ))
    const top = Math.max(8, targetRect.bottom - panelRect.top + 6)
    const next = { kind, project, entries, left, top }
    if (delayMs <= 0) {
      setCacheHoverCard(next)
      return
    }
    cacheHoverTimerRef.current = window.setTimeout(() => {
      cacheHoverTimerRef.current = null
      setCacheHoverCard(next)
    }, delayMs)
  }

  return (
    <div ref={panelRef} className={`git-diff-debug-panel${collapsed ? ' is-collapsed' : ''}`}>
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
              {(() => {
                const layers = deriveCacheLayerStates(
                  envelope.measurement.cacheState,
                  envelope.measurement.cacheSource
                )
                return (
                  <>
                    <span className={`gddp-pill gddp-pill-${RENDER_PILL_CLASS[layers.renderState]}`}>
                      {t('gitDiff.debug.renderState.label')}: {t(RENDER_VALUE_KEY[layers.renderState])}
                    </span>
                    <span className={`gddp-pill gddp-pill-${MAIN_PILL_CLASS[layers.mainCacheState]}`}>
                      {t('gitDiff.debug.mainCache.label')}: {t(MAIN_VALUE_KEY[layers.mainCacheState])}
                    </span>
                  </>
                )
              })()}
              <span className="gddp-summary-total">
                {t('gitDiff.debug.total')}: <strong>{formatMs(lastTotal)}</strong>
              </span>
            </>
          ) : (
            <span className="gddp-summary-empty">{t('gitDiff.debug.noClickYet')}</span>
          )}
        </div>
        {!collapsed && (
          <div className="gddp-header-actions">
            <button
              type="button"
              className={`gddp-header-button${termsOpen ? ' is-active' : ''}`}
              onClick={() => setTermsOpen((open) => !open)}
              title={t('gitDiff.debug.terms')}
              aria-expanded={termsOpen}
            >
              {t('gitDiff.debug.terms')}
            </button>
            <button
              type="button"
              className="gddp-header-button"
              onClick={handleReset}
              title={t('gitDiff.debug.reset')}
            >
              {t('gitDiff.debug.reset')}
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="gddp-body">
          {termsOpen && (
            <section className="gddp-section gddp-terms" aria-label={t('gitDiff.debug.termsTitle')}>
              <div className="gddp-terms-header">
                <h4 className="gddp-section-title">{t('gitDiff.debug.termsTitle')}</h4>
                <p>{t('gitDiff.debug.termsIntro')}</p>
              </div>
              <div className="gddp-terms-grid">
                <div className="gddp-terms-block">
                  <h5>{t('gitDiff.debug.terms.lastClickPhases')}</h5>
                  <dl className="gddp-terms-list">
                    {PHASE_TERMS.map((term) => (
                      <div key={term.label} className="gddp-term">
                        <dt>{t(term.label)}</dt>
                        <dd>{t(term.body)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <div className="gddp-terms-block">
                  <h5>{t('gitDiff.debug.terms.otherMetrics')}</h5>
                  <dl className="gddp-terms-list">
                    {TERMS_GROUPS.map((term) => (
                      <div key={term.title} className="gddp-term">
                        <dt>{t(term.title)}</dt>
                        <dd>{t(term.body)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            </section>
          )}

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
                <ul className="gddp-stat-row">
                  <li>
                    <span className="gddp-stat-label">{t('gitDiff.debug.firstPaint')}</span>
                    <span className="gddp-stat-value">{formatMs(envelope.measurement.firstPaintMs)}</span>
                  </li>
                  <li>
                    <span className="gddp-stat-label">{t('gitDiff.debug.settleReason')}</span>
                    <span className="gddp-stat-value">{envelope.measurement.settleReason ?? '—'}</span>
                  </li>
                  {envelope.measurement.cacheState === 'miss' && (
                    <li>
                      <span className="gddp-stat-label">{t('gitDiff.debug.cacheMissReason')}</span>
                      <span className="gddp-stat-value">
                        {envelope.measurement.cacheMissReason
                          ? t(cacheMissReasonKey(envelope.measurement.cacheMissReason))
                          : '—'}
                      </span>
                    </li>
                  )}
                  {envelope.measurement.coldMountMs !== null && (
                    <li>
                      <span className="gddp-stat-label">{t('gitDiff.debug.coldMount')}</span>
                      <span className="gddp-stat-value">{formatMs(envelope.measurement.coldMountMs)}</span>
                    </li>
                  )}
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
                    {stats.cache.projects
                      .map((p, idx) => {
                        const pct = stats.cache.projectByteLimit > 0
                          ? Math.min(100, (p.bytes / stats.cache.projectByteLimit) * 100)
                          : 0
                        const isCurrent = p.project === cwd
                        return (
                          <li
                            key={p.project}
                            className={`gddp-cache-row${isCurrent ? ' is-current' : ''}`}
                          >
                            <span className="gddp-cache-rank">#{idx + 1}</span>
                            <span
                              className="gddp-cache-path"
                              onMouseEnter={(event) => showCacheHoverCard(event, p.project, 'path', p.entryDetails, 0)}
                              onMouseLeave={scheduleCacheHoverHide}
                              onFocus={(event) => showCacheHoverCard(event, p.project, 'path', p.entryDetails, 0)}
                              onBlur={scheduleCacheHoverHide}
                              tabIndex={0}
                            >
                              {p.project}
                            </span>
                            <span className="gddp-cache-bar" aria-hidden="true">
                              <span className="gddp-cache-bar-fill" style={{ width: `${pct}%` }} />
                            </span>
                            <span
                              className="gddp-cache-numbers"
                              onMouseEnter={(event) => showCacheHoverCard(event, p.project, 'entries', p.entryDetails, CACHE_TOOLTIP_DELAY_MS)}
                              onMouseLeave={scheduleCacheHoverHide}
                              onFocus={(event) => showCacheHoverCard(event, p.project, 'entries', p.entryDetails, 0)}
                              onBlur={scheduleCacheHoverHide}
                              tabIndex={0}
                            >
                              {formatBytes(p.bytes)} / {p.entries} {t('gitDiff.debug.entries')}
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
            {stats && diffResult ? (
              (() => {
                const lc = stats.listCache
                const lastEventCwd = lc.lastEvent.key
                  ? lc.lastEvent.key.slice(0, lc.lastEvent.key.lastIndexOf('::'))
                  : null
                const lastEventAgeMs = lc.lastEvent.at !== null
                  ? Math.max(0, Date.now() - lc.lastEvent.at)
                  : null
                const filesCount = diffResult.files.length
                const totals = diffResult.files.reduce(
                  (acc, f) => ({
                    adds: acc.adds + (f.additions ?? 0),
                    dels: acc.dels + (f.deletions ?? 0)
                  }),
                  { adds: 0, dels: 0 }
                )
                let lastFetchedLabel: string
                if (lc.lastEvent.kind === null || lastEventAgeMs === null) {
                  lastFetchedLabel = t('gitDiff.debug.listCache.lastFetchedNone')
                } else if (cwd && lastEventCwd && lastEventCwd !== cwd) {
                  lastFetchedLabel = t('gitDiff.debug.listCache.lastFetchedOtherProject', { project: lastEventCwd })
                } else {
                  const ageStr = formatMs(lastEventAgeMs)
                  if (lc.lastEvent.kind === 'hit') {
                    lastFetchedLabel = t('gitDiff.debug.listCache.lastFetchedAgeCached', { age: ageStr })
                  } else if (lc.lastEvent.kind === 'force') {
                    lastFetchedLabel = t('gitDiff.debug.listCache.lastFetchedAgeForced', { age: ageStr })
                  } else {
                    lastFetchedLabel = t('gitDiff.debug.listCache.lastFetchedAgeFresh', { age: ageStr })
                  }
                }
                return (
                  <ul className="gddp-stat-row">
                    <li>
                      <span className="gddp-stat-label">{t('gitDiff.debug.listCache.filesChanged')}</span>
                      <span className="gddp-stat-value">{filesCount}</span>
                    </li>
                    <li>
                      <span className="gddp-stat-label">{t('gitDiff.debug.listCache.lines')}</span>
                      <span className="gddp-stat-value">+{totals.adds} / −{totals.dels}</span>
                    </li>
                    <li>
                      <span className="gddp-stat-label">{t('gitDiff.debug.listCache.lastFetched')}</span>
                      <span className="gddp-stat-value">{lastFetchedLabel}</span>
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
              (() => {
                const meta = cwd ? stats.scheduler.perProject[cwd] ?? null : null
                const now = Date.now()
                const isPrefetching = meta?.inFlightSince != null
                const isQueued = !isPrefetching && meta?.pendingSince != null
                const lastBurst = meta?.lastBurst ?? null
                const totalCancelled = stats.scheduler.totalCancelled

                let statusValue: string
                if (isPrefetching && meta?.inFlightSince != null) {
                  statusValue = t('gitDiff.debug.scheduler.statusPrefetching', {
                    age: formatAge(Math.max(0, now - meta.inFlightSince))
                  })
                } else if (isQueued && meta?.pendingSince != null) {
                  statusValue = t('gitDiff.debug.scheduler.statusQueued', {
                    age: formatAge(Math.max(0, now - meta.pendingSince))
                  })
                } else {
                  statusValue = t('gitDiff.debug.scheduler.statusIdle')
                }

                const lastBurstValue = lastBurst
                  ? t('gitDiff.debug.scheduler.lastBurstSummary', {
                      age: formatAge(Math.max(0, now - lastBurst.finishedAt)),
                      duration: formatAge(lastBurst.durationMs),
                      completed: lastBurst.completed,
                      candidates: lastBurst.candidateCount,
                      errors: lastBurst.skipped
                    })
                  : t('gitDiff.debug.scheduler.lastBurstEmpty')

                let funnelValue: string | null = null
                if (lastBurst) {
                  const filtered = Math.max(0, lastBurst.workingSetSize - lastBurst.eligibleCount)
                  const capped = Math.max(0, lastBurst.eligibleCount - lastBurst.candidateCount)
                  const base = t('gitDiff.debug.scheduler.funnelSummary', {
                    workingSet: lastBurst.workingSetSize,
                    candidates: lastBurst.candidateCount,
                    filtered
                  })
                  funnelValue = capped > 0
                    ? base + t('gitDiff.debug.scheduler.funnelCappedSuffix', { capped })
                    : base
                }

                return (
                  <ul className="gddp-stat-row">
                    <li>
                      <span className="gddp-stat-label">{t('gitDiff.debug.scheduler.statusLabel')}</span>
                      <span className="gddp-stat-value">{statusValue}</span>
                    </li>
                    <li>
                      <span className="gddp-stat-label">{t('gitDiff.debug.scheduler.lastBurstLabel')}</span>
                      <span className="gddp-stat-value">{lastBurstValue}</span>
                    </li>
                    {funnelValue && (
                      <li>
                        <span className="gddp-stat-label">{t('gitDiff.debug.scheduler.funnelLabel')}</span>
                        <span className="gddp-stat-value">{funnelValue}</span>
                      </li>
                    )}
                    {totalCancelled > 0 && (
                      <li>
                        <span className="gddp-stat-label">{t('gitDiff.debug.scheduler.cancelTotalLabel')}</span>
                        <span className="gddp-stat-value">{totalCancelled}</span>
                      </li>
                    )}
                  </ul>
                )
              })()
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
                  const missReason = item.measurement.cacheMissReason
                    ? ` | ${t(cacheMissReasonKey(item.measurement.cacheMissReason))}`
                    : ''
                  const tooltip = `${item.measurement.filename}\n${formatMs(total)} | ${item.measurement.cacheState}${missReason}`
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

          {cacheHoverCard && (
            <div
              className={`gddp-cache-hover-card is-${cacheHoverCard.kind}`}
              style={{ left: cacheHoverCard.left, top: cacheHoverCard.top }}
              role="tooltip"
              onMouseEnter={clearCacheHoverTimer}
              onMouseLeave={scheduleCacheHoverHide}
            >
              {cacheHoverCard.kind === 'path' ? (
                <>
                  <div className="gddp-cache-hover-title">{t('gitDiff.debug.cacheProjectPath')}</div>
                  <div className="gddp-cache-hover-path">{cacheHoverCard.project}</div>
                </>
              ) : (
                <>
                  <div className="gddp-cache-hover-title">
                    {t('gitDiff.debug.cacheEntryDetails', { count: cacheHoverCard.entries.length })}
                  </div>
                  <div className="gddp-cache-hover-path">{cacheHoverCard.project}</div>
                  {cacheHoverCard.entries.length === 0 ? (
                    <p className="gddp-cache-hover-empty">{t('gitDiff.debug.cacheEntryDetailsEmpty')}</p>
                  ) : (
                    <ol className="gddp-cache-entry-list">
                      {cacheHoverCard.entries.slice(0, CACHE_TOOLTIP_MAX_ENTRIES).map((entry) => {
                        const parsed = parseCacheEntryKey(entry.key)
                        return (
                          <li key={entry.key}>
                            <span className="gddp-cache-entry-main">{parsed.title}</span>
                            <span className="gddp-cache-entry-meta">
                              {parsed.meta ? `${parsed.meta} · ` : ''}{formatBytes(entry.bytes)}
                            </span>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                  {cacheHoverCard.entries.length > CACHE_TOOLTIP_MAX_ENTRIES && (
                    <div className="gddp-cache-hover-more">
                      {t('gitDiff.debug.cacheEntryDetailsMore', {
                        shown: CACHE_TOOLTIP_MAX_ENTRIES,
                        total: cacheHoverCard.entries.length
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type PhaseLabelKey =
  | 'gitDiff.debug.phase.ipcMs'
  | 'gitDiff.debug.phase.stateSetMs'
  | 'gitDiff.debug.phase.modelBindMs'
  | 'gitDiff.debug.phase.mountMs'
  | 'gitDiff.debug.phase.diffComputeMs'
  | 'gitDiff.debug.phase.domCommitMs'
  | 'gitDiff.debug.phase.paintMs'
  | 'gitDiff.debug.phase.tokenizeSettleMs'


type CacheMissReasonLabelKey =
  | 'gitDiff.debug.cacheMissReason.first-load'
  | 'gitDiff.debug.cacheMissReason.invalidated-mutation'
  | 'gitDiff.debug.cacheMissReason.invalidated-watch'
  | 'gitDiff.debug.cacheMissReason.invalidated-mirror'
  | 'gitDiff.debug.cacheMissReason.invalidated-refresh'
  | 'gitDiff.debug.cacheMissReason.renderer-force-refresh'
  | 'gitDiff.debug.cacheMissReason.project-queue-evicted'
  | 'gitDiff.debug.cacheMissReason.single-file-too-large'
  | 'gitDiff.debug.cacheMissReason.precompute-pending'
  | 'gitDiff.debug.cacheMissReason.entry-not-warmed'
  | 'gitDiff.debug.cacheMissReason.worker-error'
