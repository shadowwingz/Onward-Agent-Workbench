/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export const HTML_FILE_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])
export const HTML_PREVIEW_DEFAULT_ZOOM_FACTOR = 1
export const HTML_PREVIEW_MIN_ZOOM_FACTOR = 0.5
export const HTML_PREVIEW_MAX_ZOOM_FACTOR = 2
export const HTML_PREVIEW_ZOOM_STEP = 0.1

export interface HtmlPreviewShortcutEventLike {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export interface HtmlPreviewScrollState {
  x: number
  y: number
  scrollWidth: number
  scrollHeight: number
  clientWidth: number
  clientHeight: number
}

export function getHtmlFileExtension(path: string | null | undefined): string {
  if (!path) return ''
  const normalized = path.replace(/\\/g, '/')
  const name = normalized.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

export function isHtmlPath(path: string | null | undefined): boolean {
  return HTML_FILE_EXTENSIONS.has(getHtmlFileExtension(path))
}

export function isHtmlPreviewRefreshShortcut(event: HtmlPreviewShortcutEventLike): boolean {
  return event.key.toLowerCase() === 'r' &&
    Boolean(event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
}

export function withHtmlPreviewReloadKey(previewUrl: string | null | undefined, reloadKey: number): string | null {
  if (!previewUrl) return null
  try {
    const url = new URL(previewUrl)
    url.searchParams.set('onwardHtmlReload', String(Math.max(0, Math.floor(reloadKey))))
    return url.toString()
  } catch {
    const separator = previewUrl.includes('?') ? '&' : '?'
    return `${previewUrl}${separator}onwardHtmlReload=${encodeURIComponent(String(Math.max(0, Math.floor(reloadKey))))}`
  }
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

export function normalizeHtmlPreviewScrollState(value: unknown): HtmlPreviewScrollState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  return {
    x: readNonNegativeNumber(raw.x),
    y: readNonNegativeNumber(raw.y),
    scrollWidth: readNonNegativeNumber(raw.scrollWidth),
    scrollHeight: readNonNegativeNumber(raw.scrollHeight),
    clientWidth: readNonNegativeNumber(raw.clientWidth),
    clientHeight: readNonNegativeNumber(raw.clientHeight)
  }
}

export function normalizeHtmlPreviewZoomFactor(value: unknown): number {
  const raw = typeof value === 'number' && Number.isFinite(value)
    ? value
    : HTML_PREVIEW_DEFAULT_ZOOM_FACTOR
  const clamped = Math.max(HTML_PREVIEW_MIN_ZOOM_FACTOR, Math.min(HTML_PREVIEW_MAX_ZOOM_FACTOR, raw))
  return Math.round(clamped * 100) / 100
}

export function stepHtmlPreviewZoomFactor(value: unknown, direction: 'in' | 'out' | 'reset'): number {
  if (direction === 'reset') return HTML_PREVIEW_DEFAULT_ZOOM_FACTOR
  const current = normalizeHtmlPreviewZoomFactor(value)
  const delta = direction === 'in' ? HTML_PREVIEW_ZOOM_STEP : -HTML_PREVIEW_ZOOM_STEP
  return normalizeHtmlPreviewZoomFactor(current + delta)
}

export function formatHtmlPreviewZoomPercent(value: unknown): string {
  return `${Math.round(normalizeHtmlPreviewZoomFactor(value) * 100)}%`
}
