/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { parseDiffFromFile, SPLIT_WITH_NEWLINES } from '@pierre/diffs'
import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from '@pierre/diffs'
import type * as monacoTypes from 'monaco-editor'
import type { GitDiffResult, GitFileStatus, GitFileContentResult, GitFileActionResult, GitRepoContext } from '../../types/electron'
import { useSettings } from '../../contexts/SettingsContext'
import { DEFAULT_GIT_DIFF_FONT_SIZE } from '../../constants/gitDiff'
import { useSubpageEscape } from '../../hooks/useSubpageEscape'
import { useI18n } from '../../i18n/useI18n'
import { useAppState } from '../../hooks/useAppState'
import type { ProjectEditorOpenEventDetail, SubpageId, SubpageNavigateEventDetail } from '../../types/subpage'
import { SubpagePanelButton, SubpagePanelShell, SubpageSwitcher, type SubpagePanelShellState } from '../SubpageSwitcher'
import {
  GitImagePreview,
  IMAGE_COMPARE_MODE_STORAGE_KEY,
  IMAGE_DISPLAY_MODE_STORAGE_KEY,
  type GitImagePreviewFileState,
  type ImageCompareMode,
  type ImageDisplayMode,
  type SvgViewMode
} from '../GitImagePreview/GitImagePreview'
import { GitPdfCompare, type GitPdfStatus } from '../GitPdfCompare/GitPdfCompare'
import { GitEpubCompare, type GitEpubStatus } from '../GitEpubCompare/GitEpubCompare'
import { usePathCopy } from '../../hooks/usePathCopy'
import { useCwdCopyHandler } from '../../hooks/useCwdCopyHandler'
import { useGitDiffFileWatch } from './useGitDiffFileWatch'
import {
  buildContentWithChangeRange,
  buildHunkActionWidgetPlan,
  type DiffHunkAction,
  type DiffHunkActionRange,
  type HunkActionWidgetInstallResult
} from './gitDiffHunkActions'
import { resolveMonacoLanguageId } from './monacoLanguageMap'
import { GitDiffClickLatencyTracker, type ClickLatencyMeasurement } from './clickLatencyTracker'
import { buildClickPhaseTraceRecords } from './clickLatencyTraceEmitter'
import { GitDiffDebugPanel } from './GitDiffDebugPanel'
import { createThemedSetiFileIconResolver, sanitizeSetiSvgOnce } from '../ProjectEditor/setiFileIconTheme'
import { perfTrace } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import '../../styles/path-copy-toast.css'
import './GitDiffViewer.css'

const DEBUG_GIT_DIFF = Boolean(window.electronAPI?.debug?.enabled)

function debugLog(...args: unknown[]) {
  if (!DEBUG_GIT_DIFF) return
  console.log('[GitDiffViewer]', ...args)
  try {
    const [message, ...data] = args
    window.electronAPI.debug.log(String(message ?? ''), data.length > 0 ? data : undefined)
  } catch {
    // ignore
  }
}

// local storage key name
const STORAGE_KEY_FILE_LIST_WIDTH = 'git-diff-file-list-width'
const STORAGE_KEY_FILE_LIST_VIEW_MODE = 'git-diff-file-list-view-mode'
const STORAGE_KEY_MODAL_SIZE = 'git-diff-modal-size'
const STORAGE_KEY_DIFF_SPLIT_RATIO = 'git-diff-split-view-ratio'
const STORAGE_KEY_DIFF_SPLIT_VIEW_MODE = 'git-diff-split-view-mode'
const STORAGE_KEY_DIFF_DEBUG_PANEL_COLLAPSED = 'git-diff-debug-panel-collapsed'

// File list width limit
const DEFAULT_FILE_LIST_WIDTH = 280
const MIN_FILE_LIST_WIDTH = 150
const MAX_FILE_LIST_WIDTH = 600

const DEFAULT_DIFF_SPLIT_RATIO = 0.5
const MIN_DIFF_SPLIT_RATIO = 0.1
const MAX_DIFF_SPLIT_RATIO = 0.9
const DIFF_SPLIT_RATIO_EPSILON = 0.002
const DIFF_INLINE_BREAKPOINT = 900

// Monaco theme aligned with @pierre/diffs' pierre-dark palette so Git Diff
// reads as the same visual family as the Git History viewer.
const PIERRE_LIKE_MONACO_THEME = 'onward-pierre-dark'
const PIERRE_LIKE_MONACO_FONT = "'SF Mono', Monaco, Consolas, 'Ubuntu Mono', 'Liberation Mono', 'Courier New', monospace"
let pierreLikeMonacoThemeRegistered = false

// SVG path constants reused by both the React icon components below and the
// imperative DOM construction inside installDiffHunkActionWidgets (where we
// build per-hunk toolbar buttons via document.createElement and need raw
// SVG markup, not React components).
const STAGE_ICON_PATHS = '<path d="M8 1.5a.75.75 0 0 1 .75.75v7.69l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06l2.22 2.22V2.25A.75.75 0 0 1 8 1.5z" /><path d="M2.75 12.5a.75.75 0 0 1 .75.75v.25h9v-.25a.75.75 0 0 1 1.5 0V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-.75a.75.75 0 0 1 .75-.75z" />'
const UNSTAGE_ICON_PATHS = '<path d="M8 14.5a.75.75 0 0 1-.75-.75V6.06l-2.22 2.22a.75.75 0 1 1-1.06-1.06l3.5-3.5a.75.75 0 0 1 1.06 0l3.5 3.5a.75.75 0 0 1-1.06 1.06l-2.22-2.22v7.69a.75.75 0 0 1-.75.75z" /><path d="M2.75 12.5a.75.75 0 0 1 .75.75v.25h9v-.25a.75.75 0 0 1 1.5 0V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-.75a.75.75 0 0 1 .75-.75z" />'
const REVERT_ICON_PATHS = '<path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" /><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2h4.086A1.5 1.5 0 0 1 7 1h2a1.5 1.5 0 0 1 1.414 1H14.5v1zM4 4v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4H4z" />'
const HUNK_ACTION_ICON_SVG: Record<'stage' | 'unstage' | 'revert', string> = {
  stage: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${STAGE_ICON_PATHS}</svg>`,
  unstage: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${UNSTAGE_ICON_PATHS}</svg>`,
  revert: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${REVERT_ICON_PATHS}</svg>`
}

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

function StageActionIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: STAGE_ICON_PATHS }}
    />
  )
}

function DiscardActionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" />
      <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2h4.086A1.5 1.5 0 0 1 7 1h2a1.5 1.5 0 0 1 1.414 1H14.5v1zM4 4v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4H4z" />
    </svg>
  )
}

function ClearActionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z" />
    </svg>
  )
}

function SaveActionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h7.19a1.5 1.5 0 0 1 1.06.44l2.81 2.81A1.5 1.5 0 0 1 15 5.31v7.19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-10zM3.5 2a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5H4v-3.5A1.5 1.5 0 0 1 5.5 8h5A1.5 1.5 0 0 1 12 9.5V13h1.5a.5.5 0 0 0 .5-.5V5.31a.5.5 0 0 0-.15-.35l-2.81-2.81A.5.5 0 0 0 10.69 2H10v2.5A1.5 1.5 0 0 1 8.5 6h-3A1.5 1.5 0 0 1 4 4.5V2h-.5zM5 2v2.5a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5V2H5zm6 11V9.5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0-.5.5V13h6z" />
    </svg>
  )
}

function RefreshActionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M13.65 5.35A5.5 5.5 0 0 0 3.4 3.15a.75.75 0 0 0 1.17.94A4 4 0 0 1 12 6.2V7h-1.75a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 .75-.75v-3.5a.75.75 0 0 0-1.5 0v1.1h-.35z" />
      <path d="M2.35 10.65A5.5 5.5 0 0 0 12.6 12.85a.75.75 0 0 0-1.17-.94A4 4 0 0 1 4 9.8V9h1.75a.75.75 0 0 0 0-1.5h-3.5a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-1.1h.35z" />
    </svg>
  )
}

function InfoActionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM2.5 8a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0z" />
      <path d="M7.25 7.25A.75.75 0 0 1 8 6.5h.25a.75.75 0 0 1 .75.75v3.25h.25a.75.75 0 0 1 0 1.5H8a.75.75 0 0 1-.75-.75V8h-.25a.75.75 0 0 1-.75-.75zM8 4.25a.875.875 0 1 0 0 1.75.875.875 0 0 0 0-1.75z" />
    </svg>
  )
}

function JumpToEditorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.75 1.5a.75.75 0 0 0 0 1.5h2.19L7.72 7.22a.75.75 0 0 0 1.06 1.06L13 4.06v2.19a.75.75 0 0 0 1.5 0v-4A.75.75 0 0 0 13.75 1.5h-4z" />
      <path d="M3.5 3A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9.75a.75.75 0 0 0-1.5 0v2.75h-8v-8h2.75a.75.75 0 0 0 0-1.5H3.5z" />
    </svg>
  )
}

function TreeViewIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h2A1.5 1.5 0 0 1 8 2.5v1A1.5 1.5 0 0 1 6.5 5h-.25v2H9V6.5A1.5 1.5 0 0 1 10.5 5h2A1.5 1.5 0 0 1 14 6.5v1A1.5 1.5 0 0 1 12.5 9h-2A1.5 1.5 0 0 1 9 7.5V8H6.25v3H9v-.5A1.5 1.5 0 0 1 10.5 9h2a1.5 1.5 0 0 1 1.5 1.5v1a1.5 1.5 0 0 1-1.5 1.5h-2A1.5 1.5 0 0 1 9 11.5V12H5.5A.5.5 0 0 1 5 11.5V5h-.5A1.5 1.5 0 0 1 3 3.5v-1z" />
    </svg>
  )
}

function FlatViewIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3 3.25A.75.75 0 0 1 3.75 2.5h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 3.25zm0 4.75a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 8zm.75 4a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5z" />
    </svg>
  )
}

function ensurePierreLikeMonacoTheme(monaco: typeof monacoTypes) {
  if (pierreLikeMonacoThemeRegistered) return
  monaco.editor.defineTheme(PIERRE_LIKE_MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#070707',
      'editor.foreground': '#fbfbfb',
      'editorLineNumber.foreground': '#84848a',
      'editorLineNumber.activeForeground': '#adadb1',
      'editorGutter.background': '#070707',
      'editor.lineHighlightBackground': '#101010',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background': '#1a1a1a',
      'editorIndentGuide.activeBackground': '#2a2a2a',
      'editorIndentGuide.background1': '#1a1a1a',
      'editorIndentGuide.activeBackground1': '#2a2a2a',
      'editor.selectionBackground': '#2a2a2a',
      'editor.inactiveSelectionBackground': '#1a1a1a',
      'editorWhitespace.foreground': '#2a2a2a',
      'diffEditor.insertedLineBackground': '#00cab11a',
      'diffEditor.insertedTextBackground': '#00cab140',
      'diffEditor.removedLineBackground': '#ff2e3f1a',
      'diffEditor.removedTextBackground': '#ff2e3f40',
      'diffEditor.diagonalFill': '#14141400',
      'diffEditor.border': '#1a1a1a',
      'diffEditor.unchangedRegionBackground': '#0a0a0a',
      'diffEditor.unchangedRegionForeground': '#79797f',
      'diffEditor.unchangedCodeBackground': '#0a0a0a',
      'diffEditorGutter.insertedLineBackground': '#00cab11a',
      'diffEditorGutter.removedLineBackground': '#ff2e3f1a',
      'diffEditorOverview.insertedForeground': '#00cab1',
      'diffEditorOverview.removedForeground': '#ff2e3f',
      'scrollbarSlider.background': '#1f1f1f80',
      'scrollbarSlider.hoverBackground': '#2f2f2fa0',
      'scrollbarSlider.activeBackground': '#3f3f3fc0'
    }
  })
  pierreLikeMonacoThemeRegistered = true
}

// Pop-up window size limit
const DEFAULT_MODAL_WIDTH = 1200
const DEFAULT_MODAL_HEIGHT = 600
const MIN_MODAL_WIDTH = 600
const MIN_MODAL_HEIGHT = 400
const MAX_MODAL_WIDTH_PERCENT = 95  // Percentage relative to viewport
const MAX_MODAL_HEIGHT_PERCENT = 95

interface GitDiffViewerProps {
  isOpen: boolean
  onClose: () => void
  terminalId: string
  cwd: string | null
  cwdPending?: boolean
  openRequestedAt?: number | null
  cwdReadyAt?: number | null
  displayMode?: 'modal' | 'panel'
  panelShellMode?: 'internal' | 'external'
  onPanelShellStateChange?: (state: SubpagePanelShellState | null) => void
  taskTitle?: string
  navigationTarget?: GitDiffNavigationTarget | null
}

type GitDiffTimingSnapshot = {
  openRequestedAt: number | null
  shellShownAt: number | null
  cwdReadyAt: number | null
  diffLoadedAt: number | null
}

type DiffSplitLayout = {
  ratio: number
  originalWidth: number
  modifiedWidth: number
  originalLeft: number
  modifiedLeft: number
  gap: number
}

type DiffLayoutMode = 'side-by-side' | 'inline'

type DiffHunkActionWidgetHandle = {
  id: string
  anchorLine: number
  range: DiffHunkActionRange
  node: HTMLDivElement
  buttons: HTMLButtonElement[]
}
type GitDiffFileListViewMode = 'tree' | 'flat'
type GitDiffSplitViewMode = 'auto' | 'split' | 'inline'
type GitDiffNavigationTarget = {
  filePath: string
  repoRoot?: string | null
  nonce: number
}

type DiffSplitState = {
  mode: DiffLayoutMode
  ratio: number | null
  originalWidth: number
  modifiedWidth: number
}

type FileContentLoadReason = 'select' | 'prefetch' | 'refresh' | 'auto-refresh' | 'debug'

type DiffNavigationSelectionTarget = {
  filePath: string
  repoRoot: string | null
}

type DiffFileTreeNode = {
  key: string
  name: string
  path: string
  type: 'dir' | 'file'
  count: number
  file?: GitFileStatus
  children?: DiffFileTreeNode[]
}

// Retained as a typed shape only so the `getPrefetchState` debug helper can
// keep returning something for the legacy autotest selector. The renderer no
// longer prefetches; the snapshot is always the "idle" sentinel.
type BodyPrefetchSnapshot = {
  scheduled: number
  completed: number
  inFlight: boolean
  candidates: string[]
  lastReason: 'idle' | 'scheduled' | 'completed' | 'cancelled' | 'skipped'
  lastDurationMs: number | null
}

const PREFETCH_RETIRED_SNAPSHOT: BodyPrefetchSnapshot = {
  scheduled: 0,
  completed: 0,
  inFlight: false,
  candidates: [],
  lastReason: 'idle',
  lastDurationMs: null
}

// Status color map
const statusColors: Record<GitFileStatus['status'], string> = {
  'M': '#e2c08d', // Modified - Orange
  'A': '#89d185', // Added - green
  'D': '#f14c4c', // Deleted - red
  'R': '#569cd6', // Renamed - blue
  'C': '#c586c0', // Copied - Purple
  '?': '#858585', // Untracked - Gray
  '!': '#f14c4c'  // Conflict - red
}

interface FileContentState {
  loading: boolean
  originalContent: string
  modifiedContent: string
  draftContent?: string
  isBinary: boolean
  isImage?: boolean
  isSvg?: boolean
  isPdf?: boolean
  isEpub?: boolean
  originalImageUrl?: string
  modifiedImageUrl?: string
  originalImageSize?: number
  modifiedImageSize?: number
  originalPreviewData?: string
  modifiedPreviewData?: string
  originalPreviewSize?: number
  modifiedPreviewSize?: number
  error?: string
}

function retainDirtyDrafts(contents: Record<string, FileContentState>): Record<string, FileContentState> {
  const retained: Record<string, FileContentState> = {}
  for (const [key, state] of Object.entries(contents)) {
    if (state.draftContent !== undefined && state.draftContent !== state.modifiedContent) {
      retained[key] = state
    }
  }
  return retained
}

function normalizeInvalidationPath(value: string): string {
  let normalized = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (normalized.startsWith('/private/')) normalized = normalized.slice('/private'.length)
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

function normalizeDiffDisplayPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '')
}

function normalizeComparableGitPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return window.electronAPI.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function joinGitPath(root: string | null | undefined, relativePath: string): string {
  const normalizedRoot = (root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedRelative = normalizeDiffDisplayPath(relativePath)
  return normalizedRoot ? `${normalizedRoot}/${normalizedRelative}` : normalizedRelative
}

function findDiffFileByNavigationTarget(
  result: GitDiffResult | null,
  target: DiffNavigationSelectionTarget | null
): GitFileStatus | null {
  if (!result?.success || !target?.filePath) return null
  const targetAbsolute = normalizeComparableGitPath(joinGitPath(target.repoRoot || result.cwd, target.filePath))
  const targetRelative = normalizeComparableGitPath(normalizeDiffDisplayPath(target.filePath))
  for (const file of result.files) {
    const fileRelative = normalizeComparableGitPath(normalizeDiffDisplayPath(file.filename))
    const fileAbsolute = normalizeComparableGitPath(joinGitPath(file.repoRoot || result.cwd, file.filename))
    if (fileAbsolute === targetAbsolute || (!target.repoRoot && fileRelative === targetRelative)) {
      return file
    }
  }
  return null
}

function buildDiffFileTree(files: GitFileStatus[], treeScopeKey: string): DiffFileTreeNode[] {
  const root: DiffFileTreeNode = {
    key: `${treeScopeKey}::root`,
    name: '',
    path: '',
    type: 'dir',
    count: 0,
    children: []
  }

  const sortedFiles = [...files].sort((a, b) => normalizeDiffDisplayPath(a.filename).localeCompare(normalizeDiffDisplayPath(b.filename)))
  for (const file of sortedFiles) {
    const parts = normalizeDiffDisplayPath(file.filename).split('/').filter(Boolean)
    if (parts.length === 0) continue
    let cursor = root
    let currentPath = ''
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]
      currentPath = currentPath ? `${currentPath}/${name}` : name
      const isLeaf = index === parts.length - 1
      if (isLeaf) {
        cursor.children!.push({
          key: `${treeScopeKey}::file::${file.changeType}::${file.status}::${file.originalFilename ?? ''}::${file.filename}`,
          name,
          path: currentPath,
          type: 'file',
          count: 1,
          file
        })
        continue
      }
      let dir = cursor.children!.find((child) => child.type === 'dir' && child.name === name)
      if (!dir) {
        dir = {
          key: `${treeScopeKey}::dir::${currentPath}`,
          name,
          path: currentPath,
          type: 'dir',
          count: 0,
          children: []
        }
        cursor.children!.push(dir)
      }
      cursor = dir
    }
  }

  const assignCounts = (node: DiffFileTreeNode): number => {
    if (node.type === 'file') {
      node.count = 1
      return 1
    }
    node.count = (node.children ?? []).reduce((sum, child) => sum + assignCounts(child), 0)
    return node.count
  }
  const sortNodes = (nodes: DiffFileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.children) sortNodes(node.children)
    }
  }
  assignCounts(root)
  sortNodes(root.children!)
  return root.children!
}

type DiffViewAnchor = {
  line: number | null        // Modify the first visible line number in the editor
  scrollTop: number          // Editor scroll position
}

// Render-then-reveal state machine for eliminating diff scroll flash.
// Mirrors the PreviewRestorePhase pattern used by Markdown preview.
type DiffRevealPhase = 'idle' | 'waiting-diff' | 'restoring-scroll'

type DiffViewMemoryEntry = {
  fileKey: string
  filePath: string
  originalFilename?: string
  anchor: DiffViewAnchor | null
  scrollTop: number
  signature: string | null
  updatedAt: number
}

type DiffViewMemory = {
  selectedFileKey: string | null
  entries: Record<string, DiffViewMemoryEntry>
}

type RestoredAnchor = {
  line: number | null
  scrollTop: number
}

type CompareStatus = 'added' | 'deleted' | 'modified' | null
type ChapterKind = 'added' | 'deleted' | 'modified' | 'unchanged'

function resolveCompareStatus(container: Element | null): CompareStatus {
  if (!container) return null
  if (container.querySelector('.git-pdf-compare-status-added, .git-epub-compare-status-added')) return 'added'
  if (container.querySelector('.git-pdf-compare-status-deleted, .git-epub-compare-status-deleted')) return 'deleted'
  return 'modified'
}

// Shared DOM inspection helpers used by both GitDiffViewer and GitHistoryViewer
// debug APIs. Querying the DOM keeps these decoupled from React state and lets
// autotests verify what the user actually sees.
export function inspectPdfCompareDom() {
  const root = document.querySelector('.git-pdf-compare')
  if (!root) return { visible: false, status: null, originalSrc: null, modifiedSrc: null, originalHasEmpty: false, modifiedHasEmpty: false }
  const panes = Array.from(root.querySelectorAll('.git-pdf-compare-pane')) as HTMLElement[]
  const [leftPane, rightPane] = [panes[0] ?? null, panes[1] ?? null]
  const readSrc = (pane: HTMLElement | null) =>
    (pane?.querySelector('iframe.git-pdf-compare-frame') as HTMLIFrameElement | null)?.src ?? null
  return {
    visible: true,
    status: resolveCompareStatus(root),
    originalSrc: readSrc(leftPane),
    modifiedSrc: readSrc(rightPane),
    originalHasEmpty: Boolean(leftPane?.querySelector('.git-pdf-compare-empty')),
    modifiedHasEmpty: Boolean(rightPane?.querySelector('.git-pdf-compare-empty'))
  }
}

export function inspectEpubCompareDom() {
  const root = document.querySelector('.git-epub-compare')
  if (!root) {
    return { visible: false, status: null, chapterCount: 0, selectedHref: null, chapterBadges: [], diffCounts: null }
  }
  const chapterButtons = Array.from(root.querySelectorAll('.git-epub-compare-chapter-list > li .git-epub-compare-chapter-item')) as HTMLElement[]
  const chapterBadges = chapterButtons.map(btn => {
    const label = btn.querySelector('.git-epub-compare-chapter-label')?.textContent?.trim() ?? ''
    const cls = btn.className
    let kind: ChapterKind = 'unchanged'
    if (cls.includes('git-epub-compare-chapter-added')) kind = 'added'
    else if (cls.includes('git-epub-compare-chapter-deleted')) kind = 'deleted'
    else if (cls.includes('git-epub-compare-chapter-modified')) kind = 'modified'
    const href = btn.dataset?.href ?? ''
    return { href, label, kind }
  })
  const active = chapterButtons.find(btn => btn.classList.contains('active')) ?? null
  const selectedHref = active?.dataset?.href ?? null
  // Count diff lines in the currently visible panes. These come from the
  // annotateLines helper: .git-epub-compare-line-add / -del / -same.
  const countClass = (cls: string) => root.querySelectorAll(`.${cls}`).length
  const diffCounts = chapterButtons.length > 0
    ? { add: countClass('git-epub-compare-line-add'), del: countClass('git-epub-compare-line-del'), same: countClass('git-epub-compare-line-same') }
    : null
  return {
    visible: true,
    status: resolveCompareStatus(root),
    chapterCount: chapterButtons.length,
    selectedHref,
    chapterBadges,
    diffCounts
  }
}

type GitDiffDebugApi = {
  isOpen: () => boolean
  getFileList: () => GitFileStatus[]
  getVisibleFileList: () => GitFileStatus[]
  getFileListViewMode: () => GitDiffFileListViewMode
  setFileListViewMode: (mode: GitDiffFileListViewMode) => boolean
  getVisibleTreeRows: () => Array<{ type: 'dir' | 'file'; path: string; depth: number; name: string }>
  getRepoList: () => GitRepoContext[]
  getVisibleRepoItems: () => RepoFilterTreeItem[]
  setRepoExpanded: (repoRoot: string, expanded: boolean) => boolean
  setRepoFilter: (repoRoot: string | null) => boolean
  getSelectedFile: () => {
    filename: string
    originalFilename?: string
    status: GitFileStatus['status']
    changeType: GitFileStatus['changeType']
  } | null
  selectFileByPath: (path: string) => boolean
  selectFileByIndex: (index: number) => boolean
  isSelectedReady: () => boolean
  getSelectedFileContent: () => {
    originalContent: string | null
    modifiedContent: string | null
    draftContent: string | null
    isBinary: boolean
    loading: boolean
    error: string | null
  } | null
  getCachedFileContentByPath: (path: string, changeType?: GitFileStatus['changeType']) => {
    filename: string
    changeType: GitFileStatus['changeType']
    originalContent: string | null
    modifiedContent: string | null
    draftContent: string | null
    isBinary: boolean
    loading: boolean
    error: string | null
  } | null
  getPrefetchState: () => BodyPrefetchSnapshot
  getLastClickLatency: () => ClickLatencyMeasurement | null
  getLastClickLatencyForFile: (fileKey: string) => ClickLatencyMeasurement | null
  getClickLatencyHistory: () => ClickLatencyMeasurement[]
  resetClickLatencyHistory: () => void
  setSelectedDraftContent: (content: string) => boolean
  getIsDraftDirty: () => boolean
  getRestoreNotice: () => { type: 'changed'; message: string; fileName?: string } | null
  getScrollTop: () => number
  getFirstVisibleLine: () => number
  scrollToFraction: (fraction: number) => boolean
  scrollToLine: (line: number) => boolean
  getDiffFontSize: () => number
  getCwd: () => string | null
  getRepoRoot: () => string | null
  isSubmodulesLoading: () => boolean
  getTiming: () => {
    openRequestedAt: number | null
    shellShownAt: number | null
    cwdReadyAt: number | null
    diffLoadedAt: number | null
    openToShellMs: number | null
    openToCwdReadyMs: number | null
    openToDiffLoadedMs: number | null
    cwdReadyToDiffLoadedMs: number | null
  }
  getLoadState: () => {
    inFlight: boolean
    queued: { reset: boolean; silent: boolean; force: boolean } | null
    hasDiffResult: boolean
    fileCount: number | null
    submodulesLoading: boolean
    hasLastDiff: boolean
    lastDiffAgeMs: number | null
  }
  getSplitViewState: () => DiffSplitState | null
  getDiffNavigationState: () => { changeCount: number; currentIndex: number }
  getResponsiveLayoutState: () => {
    mode: DiffLayoutMode | null
    containerWidth: number | null
    inlineBreakpoint: number
    useInlineViewWhenSpaceIsLimited: boolean
  }
  setSplitViewRatio: (ratio: number) => boolean
  setFileListWidth: (width: number) => boolean
  dragSplitViewRatio: (ratio: number) => Promise<boolean>
  navigateDiffChange: (direction: 'previous' | 'next') => boolean
  refreshChanges: () => Promise<boolean>
  getTermsPopoverOpen: () => boolean
  toggleTermsPopover: () => boolean
  getHunkActionWidgetCount: () => number
  getHunkActionDebugState: () => {
    hasEditor: boolean
    hasMonaco: boolean
    selectedFile: { filename: string; changeType: GitFileStatus['changeType']; status: GitFileStatus['status'] } | null
    selectedFileKey: string | null
    hasState: boolean
    loading: boolean | null
    error: string | null
    isBinary: boolean | null
    isDraftDirty: boolean
    lineChanges: number
    widgetDomCount: number
    visibleWidgetDomCount: number
    widgetDisposableCount: number
  }
  revealFirstHunkActionForTest: () => boolean
  hideHunkActionsForTest: () => void
  triggerFirstHunkAction: (action: DiffHunkAction) => Promise<boolean>
  setSelectedLineRangeForTest: (start: number, end: number, side?: SelectionSide) => boolean
  triggerLineAction: (action: 'keep' | 'deny') => Promise<boolean>
  getImagePreviewState: () => {
    isImage: boolean
    isSvg: boolean
    isBinary: boolean
    hasOriginalUrl: boolean
    hasModifiedUrl: boolean
    compareMode: ImageCompareMode
    displayMode: ImageDisplayMode
    loading: boolean
  } | null
  getFileActionState: () => {
    fileActionsVisible: boolean
    lineActionsVisible: boolean
    keepDisabled: boolean
    denyDisabled: boolean
    pending: boolean
    toolbarVisible: boolean
    actionPanelVisible: boolean
    visibleLabels: string[]
  } | null
  triggerFileAction: (action: 'keep' | 'deny') => Promise<boolean>
  getPdfCompareState: () => ReturnType<typeof inspectPdfCompareDom>
  getEpubCompareState: () => ReturnType<typeof inspectEpubCompareDom>
}

function clampDiffSplitRatio(value: number): number {
  return Math.max(MIN_DIFF_SPLIT_RATIO, Math.min(MAX_DIFF_SPLIT_RATIO, value))
}

function readStoredDiffSplitRatio(): number {
  const saved = localStorage.getItem(STORAGE_KEY_DIFF_SPLIT_RATIO)
  if (!saved) return DEFAULT_DIFF_SPLIT_RATIO
  const parsed = Number(saved)
  if (!Number.isFinite(parsed)) return DEFAULT_DIFF_SPLIT_RATIO
  return clampDiffSplitRatio(parsed)
}

function isGitDiffFileListViewMode(value: unknown): value is GitDiffFileListViewMode {
  return value === 'tree' || value === 'flat'
}

function isGitDiffSplitViewMode(value: unknown): value is GitDiffSplitViewMode {
  return value === 'auto' || value === 'split' || value === 'inline'
}

function readStoredSplitViewMode(): GitDiffSplitViewMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_DIFF_SPLIT_VIEW_MODE)
    return isGitDiffSplitViewMode(saved) ? saved : 'auto'
  } catch {
    return 'auto'
  }
}

type LineSelectionInfo =
  | {
    valid: false
    side: SelectionSide
    count: number
    message: string
  }
  | {
    valid: true
    side: SelectionSide
    start: number
    end: number
    count: number
  }

function resolveLineSelectionInfo(
  range: SelectedLineRange | null,
  crossSideMessage: string
): LineSelectionInfo | null {
  if (!range) return null
  const side = (range.side ?? 'additions') as SelectionSide
  const endSide = (range.endSide ?? side) as SelectionSide
  const count = Math.abs(range.end - range.start) + 1
  if (side !== endSide) {
    return {
      valid: false,
      side,
      count,
      message: crossSideMessage
    }
  }
  const start = Math.min(range.start, range.end)
  const end = Math.max(range.start, range.end)
  return {
    valid: true,
    side,
    start,
    end,
    count
  }
}

function buildFileKey(repoRoot: string, file: GitFileStatus): string {
  const original = file.originalFilename ?? ''
  return `${repoRoot}::${file.changeType}::${file.status}::${original}::${file.filename}`
}

// Rough line-level diff stats via multiset symmetric difference. Used to keep
// the sidebar +/- counters in sync after a local save without re-fetching the
// whole repo diff. Not intended to match git's diff algorithm exactly —
// accuracy is secondary to avoiding a full refresh.
function quickLineDiffStats(original: string, modified: string): { additions: number; deletions: number } {
  if (original === modified) return { additions: 0, deletions: 0 }
  // An empty file has zero lines, not one empty line — otherwise the multiset
  // treats the single empty-string entry as a phantom add/delete pair.
  const splitLines = (text: string): string[] => (text === '' ? [] : text.split('\n'))
  const originalLines = splitLines(original)
  const modifiedLines = splitLines(modified)
  const counts = new Map<string, number>()
  for (const line of originalLines) counts.set(line, (counts.get(line) ?? 0) + 1)
  let additions = 0
  for (const line of modifiedLines) {
    const c = counts.get(line) ?? 0
    if (c > 0) counts.set(line, c - 1)
    else additions += 1
  }
  let deletions = 0
  for (const c of counts.values()) deletions += c
  return { additions, deletions }
}

function sortRepoContexts(a: GitRepoContext, b: GitRepoContext): number {
  if (a.isSubmodule !== b.isSubmodule) {
    return a.isSubmodule ? 1 : -1
  }
  if (a.depth !== b.depth) {
    return a.depth - b.depth
  }
  return a.label.localeCompare(b.label)
}

interface RepoFilterTreeItem extends GitRepoContext {
  treeDepth: number
  hasChildren: boolean
  expanded: boolean
  isCurrent: boolean
  displayLabel: string
}

function normalizeRepoRoot(root: string | null | undefined): string {
  return (root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function getRepoTreeDepth(repo: GitRepoContext): number {
  return repo.isSubmodule ? repo.depth + 1 : 0
}

function getRepoLeafLabel(label: string): string {
  const normalized = label.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).pop() || label
}

function buildRepoFilterTreeItems(
  repos: GitRepoContext[] | undefined,
  expandedRoots: Set<string>,
  currentRoot: string | null,
  currentLabel: string,
  includeRepo: (repo: GitRepoContext) => boolean
): RepoFilterTreeItem[] {
  if (!repos || repos.length === 0) return []
  const normalizedCurrent = normalizeRepoRoot(currentRoot)
  const childrenByParent = new Map<string, GitRepoContext[]>()
  const rootRepos: GitRepoContext[] = []
  const includedRoots = new Set<string>()

  for (const repo of repos) {
    const parentRoot = normalizeRepoRoot(repo.parentRoot)
    if (repo.isSubmodule && parentRoot) {
      const existing = childrenByParent.get(parentRoot) ?? []
      existing.push(repo)
      childrenByParent.set(parentRoot, existing)
    } else {
      rootRepos.push(repo)
    }
  }

  const markIncludedWithAncestors = (repo: GitRepoContext) => {
    if (!includeRepo(repo)) return
    includedRoots.add(normalizeRepoRoot(repo.root))
    let parentRoot = normalizeRepoRoot(repo.parentRoot)
    while (parentRoot) {
      includedRoots.add(parentRoot)
      const parent = repos.find((candidate) => normalizeRepoRoot(candidate.root) === parentRoot)
      parentRoot = normalizeRepoRoot(parent?.parentRoot)
    }
  }
  repos.forEach(markIncludedWithAncestors)

  const output: RepoFilterTreeItem[] = []
  const visit = (repo: GitRepoContext) => {
    const root = normalizeRepoRoot(repo.root)
    if (!includedRoots.has(root)) return
    const children = [...(childrenByParent.get(root) ?? [])].sort(sortRepoContexts)
    const visibleChildren = children.filter((child) => includedRoots.has(normalizeRepoRoot(child.root)))
    const hasChildren = visibleChildren.length > 0
    const expanded = expandedRoots.has(root)
    const displayLabel = repo.isSubmodule ? getRepoLeafLabel(repo.label) : currentLabel
    output.push({
      ...repo,
      treeDepth: getRepoTreeDepth(repo),
      hasChildren,
      expanded,
      isCurrent: root === normalizedCurrent,
      displayLabel
    })
    if (expanded) {
      visibleChildren.forEach(visit)
    }
  }

  rootRepos.sort(sortRepoContexts).forEach(visit)
  return output
}

function getDiffPaneElement(
  editor: monacoTypes.editor.IStandaloneDiffEditor,
  side: 'original' | 'modified'
): HTMLElement | null {
  const privateElements = (editor as monacoTypes.editor.IStandaloneDiffEditor & {
    elements?: Partial<Record<'root' | 'original' | 'modified', HTMLElement>>
  }).elements
  const privatePane = privateElements?.[side]
  if (privatePane instanceof HTMLElement) {
    return privatePane
  }
  const container = editor.getContainerDomNode()
  const diffRoot = container.classList.contains('monaco-diff-editor')
    ? container
    : container.querySelector<HTMLElement>('.monaco-diff-editor')
  if (!diffRoot) return null
  for (const child of Array.from(diffRoot.children)) {
    if (!(child instanceof HTMLElement)) continue
    if (!child.classList.contains('editor')) continue
    if (!child.classList.contains(side)) continue
    return child
  }
  return null
}

function getDiffLayoutMode(
  editor: monacoTypes.editor.IStandaloneDiffEditor
): DiffLayoutMode {
  const containerWidth = editor.getContainerDomNode().getBoundingClientRect().width
  if (Number.isFinite(containerWidth) && containerWidth > 0 && containerWidth <= DIFF_INLINE_BREAKPOINT) {
    return 'inline'
  }

  const originalPane = getDiffPaneElement(editor, 'original')
  const modifiedPane = getDiffPaneElement(editor, 'modified')
  if (!originalPane || !modifiedPane) return 'side-by-side'
  const originalRect = originalPane.getBoundingClientRect()
  const modifiedRect = modifiedPane.getBoundingClientRect()
  if (originalRect.width <= 0 || modifiedRect.width <= 0) return 'inline'
  const sameRow = Math.abs(originalRect.top - modifiedRect.top) < 8
  const separatedColumns = modifiedRect.left > originalRect.left + Math.min(originalRect.width, modifiedRect.width) * 0.5
  return sameRow && separatedColumns ? 'side-by-side' : 'inline'
}

const SIGNATURE_SAMPLE_SIZE = 256
const SCROLL_RESTORE_TOLERANCE = 64

function hashString(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}

function buildTextSignature(text: string): string {
  if (!text) return '0:0:0'
  const head = text.slice(0, SIGNATURE_SAMPLE_SIZE)
  const tail = text.slice(-SIGNATURE_SAMPLE_SIZE)
  return `${text.length}:${hashString(head)}:${hashString(tail)}`
}

function buildDiffSignature(original: string, modified: string): string {
  return `${buildTextSignature(original)}|${buildTextSignature(modified)}`
}

function buildContentWithSelection(
  diff: FileDiffMetadata,
  side: SelectionSide,
  selectedLines: Set<number>,
  applySelected: boolean,
  oldContent: string,
  newContent: string
): string {
  const oldLines = diff.oldLines ?? oldContent.split(SPLIT_WITH_NEWLINES)
  const newLines = diff.newLines ?? newContent.split(SPLIT_WITH_NEWLINES)
  const output: string[] = []
  let oldIndex = 1
  let newIndex = 1

  for (const hunk of diff.hunks) {
    while (oldIndex < hunk.deletionStart && newIndex < hunk.additionStart) {
      output.push(oldLines[oldIndex - 1] ?? '')
      oldIndex += 1
      newIndex += 1
    }

    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let i = 0; i < content.lines.length; i += 1) {
          output.push(oldLines[oldIndex - 1] ?? '')
          oldIndex += 1
          newIndex += 1
        }
      } else {
        for (let i = 0; i < content.deletions.length; i += 1) {
          const lineNumber = oldIndex
          const isSelected = side === 'deletions' && selectedLines.has(lineNumber)
          const shouldApply = applySelected ? isSelected : !isSelected
          if (!shouldApply) {
            output.push(oldLines[oldIndex - 1] ?? '')
          }
          oldIndex += 1
        }
        for (let i = 0; i < content.additions.length; i += 1) {
          const lineNumber = newIndex
          const isSelected = side === 'additions' && selectedLines.has(lineNumber)
          const shouldApply = applySelected ? isSelected : !isSelected
          if (shouldApply) {
            output.push(newLines[newIndex - 1] ?? '')
          }
          newIndex += 1
        }
      }
    }
  }

  while (oldIndex <= oldLines.length && newIndex <= newLines.length) {
    output.push(oldLines[oldIndex - 1] ?? '')
    oldIndex += 1
    newIndex += 1
  }

  return output.join('')
}

export function GitDiffViewer({
  isOpen,
  onClose,
  terminalId,
  cwd,
  cwdPending = false,
  openRequestedAt = null,
  cwdReadyAt = null,
  displayMode = 'modal',
  panelShellMode = 'internal',
  onPanelShellStateChange,
  taskTitle,
  navigationTarget = null
}: GitDiffViewerProps) {
  const isPanel = displayMode === 'panel'
  const { getTerminalStyle, settings } = useSettings()
  const { t } = useI18n()
  const { getUIPreferences, updateUIPreferences } = useAppState()
  const perfCountersRef = useRef({
    renders: 0,
    loadDiff: 0,
    diffViewBuild: 0
  })
  const perfIntervalRef = useRef<number | null>(null)
  const timingRef = useRef<GitDiffTimingSnapshot>({
    openRequestedAt: null,
    shellShownAt: null,
    cwdReadyAt: null,
    diffLoadedAt: null
  })
  const diffMemoryRef = useRef<Record<string, DiffViewMemory>>({})
  const diffRestoreCycleRef = useRef(0)
  const diffRestoreAppliedRef = useRef<{ cycle: number; fileKey: string | null }>({ cycle: 0, fileKey: null })
  const restoredAnchorRef = useRef<Record<string, RestoredAnchor>>({})
  const diffScrollCaptureTimerRef = useRef<number | null>(null)
  const suppressScrollCaptureRef = useRef(false)
  const [diffRestoreNotice, setDiffRestoreNotice] = useState<{
    type: 'changed'
    message: string
    fileName?: string
  } | null>(null)
  if (DEBUG_GIT_DIFF) {
    perfCountersRef.current.renders += 1
  }
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null)
  const [selectedFile, setSelectedFile] = useState<GitFileStatus | null>(null)
  const [fileContents, setFileContents] = useState<Record<string, FileContentState>>({})
  const diffResultRef = useRef<GitDiffResult | null>(null)
  const fileContentsRef = useRef<Record<string, FileContentState>>({})
  const pendingNavigationSelectRef = useRef<DiffNavigationSelectionTarget | null>(null)
  const [pendingNavigationSelectNonce, setPendingNavigationSelectNonce] = useState(0)
  // Ref-bridge so the watcher-driven invalidation listener (registered above
  // ensureFileContent in the file) can call into it without forming a hooks
  // dependency cycle. Updated on every render where ensureFileContent's
  // identity changes.
  const ensureFileContentRef = useRef<((file: GitFileStatus, force?: boolean, reason?: FileContentLoadReason) => Promise<void>) | null>(null)
  // Captures the most recent NON-NULL cwd so the always-on invalidation
  // listener can still match repo paths during the closed window — the
  // parent (TerminalGrid) sets cwd to null on close, which would otherwise
  // make the listener silently drop events fired between close and reopen.
  const lastKnownCwdRef = useRef<string | null>(null)
  const loadDiffRef = useRef<((options?: { reset?: boolean; silent?: boolean; force?: boolean }) => Promise<void>) | null>(null)
  const inFlightRef = useRef<Partial<Record<string, Promise<void>>>>({})
  // Click → render latency tracker. One per component instance so two
  // GitDiffViewer panels (different terminals) keep independent histories.
  const clickLatencyTrackerRef = useRef<GitDiffClickLatencyTracker>(new GitDiffClickLatencyTracker())
  // Collapse state for the in-app debug panel. Persisted globally because
  // operators want the same setting across projects / terminals.
  const [debugPanelCollapsed, setDebugPanelCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem(STORAGE_KEY_DIFF_DEBUG_PANEL_COLLAPSED) === '1'
    } catch {
      return false
    }
  })
  const handleDebugPanelToggle = useCallback((next: boolean) => {
    setDebugPanelCollapsed(next)
    try {
      window.localStorage.setItem(STORAGE_KEY_DIFF_DEBUG_PANEL_COLLAPSED, next ? '1' : '0')
    } catch {
      /* localStorage may be unavailable in restricted contexts */
    }
  }, [])
  // Lightweight prefetch state for the autotest debug surface.
  const rendererPrefetchSnapshotRef = useRef<BodyPrefetchSnapshot>({
    scheduled: 0,
    completed: 0,
    inFlight: false,
    candidates: [],
    lastReason: 'idle',
    lastDurationMs: null
  })
  const loadTokenRef = useRef(0)
  const loadInFlightRef = useRef(false)
  const loadQueuedRef = useRef<{ reset?: boolean; silent?: boolean; force?: boolean } | null>(null)
  const loadIdleWaitersRef = useRef<Array<() => void>>([])
  const lastDiffRef = useRef<{ cwd: string; originalCwd: string; at: number; result: GitDiffResult } | null>(null)
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [lineMessage, setLineMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [actionState, setActionState] = useState<{ type: 'keep' | 'deny'; fileKey: string } | null>(null)
  const [selectedLineRange, setSelectedLineRangeState] = useState<SelectedLineRange | null>(null)
  const selectedLineRangeRef = useRef<SelectedLineRange | null>(null)
  const lineSelectionInfoRef = useRef<LineSelectionInfo | null>(null)
  const [lineActionState, setLineActionState] = useState<{ type: 'keep' | 'deny'; fileKey: string } | null>(null)
  const [editMessage, setEditMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const editMessageTimerRef = useRef<number>(0)
  const [isSavingEdit, setIsSavingEdit] = useState(false)
  const [isRefreshingChanges, setIsRefreshingChanges] = useState(false)
  const [termsPopoverOpen, setTermsPopoverOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetFile: GitFileStatus } | null>(null)
  const [fileListViewMode, setFileListViewModeState] = useState<GitDiffFileListViewMode>(() => {
    const prefs = getUIPreferences()
    if (isGitDiffFileListViewMode(prefs.gitDiffFileListViewMode)) return prefs.gitDiffFileListViewMode
    const saved = localStorage.getItem(STORAGE_KEY_FILE_LIST_VIEW_MODE)
    return isGitDiffFileListViewMode(saved) ? saved : 'tree'
  })
  const [splitViewMode, setSplitViewModeState] = useState<GitDiffSplitViewMode>(() => readStoredSplitViewMode())
  const [collapsedDiffTreeDirs, setCollapsedDiffTreeDirs] = useState<Set<string>>(() => new Set())
  const [imageDisplayMode, setImageDisplayMode] = useState<ImageDisplayMode>(() => {
    const prefs = getUIPreferences()
    const p = prefs.gitDiffImageDisplayMode
    if (p === 'original' || p === 'fit') return p
    const saved = localStorage.getItem(IMAGE_DISPLAY_MODE_STORAGE_KEY)
    return saved === 'original' || saved === 'fit' ? saved : 'fit'
  })
  const [imageCompareMode, setImageCompareMode] = useState<ImageCompareMode>(() => {
    const prefs = getUIPreferences()
    const p = prefs.gitDiffImageCompareMode
    if (p === '2up' || p === 'swipe' || p === 'onion') return p
    const saved = localStorage.getItem(IMAGE_COMPARE_MODE_STORAGE_KEY)
    return saved === '2up' || saved === 'swipe' || saved === 'onion' ? saved : '2up'
  })
  const diffSplitRatioRef = useRef<number>((() => {
    const prefs = getUIPreferences()
    if (prefs.gitDiffSplitViewRatio !== undefined) return prefs.gitDiffSplitViewRatio
    return readStoredDiffSplitRatio()
  })())
  const [diffEditorResetNonce] = useState(0)
  const [svgViewMode, setSvgViewMode] = useState<SvgViewMode>('visual')
  const [pdfViewerUrl, setPdfViewerUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const url = await window.electronAPI.appInfo?.getPdfViewerUrl?.()
        if (!cancelled && typeof url === 'string') setPdfViewerUrl(url)
      } catch {
        /* ignore — PDF diff will show a fallback message if URL unavailable */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  const diffEditorRef = useRef<monacoTypes.editor.IStandaloneDiffEditor | null>(null)
  const monacoRef = useRef<typeof monacoTypes | null>(null)
  const diffEditorBindingDisposablesRef = useRef<Array<{ dispose: () => void }>>([])
  const diffHunkActionDisposablesRef = useRef<Array<{ dispose: () => void }>>([])
  const diffHunkActionWidgetHandlesRef = useRef<DiffHunkActionWidgetHandle[]>([])
  const visibleHunkActionWidgetIdRef = useRef<string | null>(null)
  const diffSplitMeasureFrameRef = useRef<number | null>(null)
  const diffNavigationIndexRef = useRef(-1)
  const hunkActionInFlightRef = useRef(false)
  const runDiffHunkActionRef = useRef<((action: DiffHunkAction, range: DiffHunkActionRange) => Promise<boolean>) | null>(null)
  const installDiffHunkActionWidgetsRef = useRef<null | ((
    editor: monacoTypes.editor.IStandaloneDiffEditor,
    monaco: typeof monacoTypes
  ) => HunkActionWidgetInstallResult)>(null)
  const isDraftDirtyRef = useRef(false)
  const autoRefreshInFlightRef = useRef(false)
  const autoRefreshQueuedRef = useRef(false)
  const selfSaveSuppressUntilRef = useRef(0)
  const originalDecorationsRef = useRef<monacoTypes.editor.IEditorDecorationsCollection | null>(null)
  const modifiedDecorationsRef = useRef<monacoTypes.editor.IEditorDecorationsCollection | null>(null)
  const selectedFileRef = useRef<GitFileStatus | null>(null)
  const lastSelectedFileRef = useRef<GitFileStatus | null>(null)
  const visibleFileListRef = useRef<GitFileStatus[]>([])
  const visibleRepoItemsRef = useRef<RepoFilterTreeItem[]>([])
  const lastOpenScopeRef = useRef<string | null | undefined>(undefined)
  const resetDiffOnNextLoadRef = useRef(true)
  const [diffRevealPhase, setDiffRevealPhase] = useState<DiffRevealPhase>('idle')
  const diffRevealPhaseRef = useRef<DiffRevealPhase>('idle')
  const diffRevealTimeoutRef = useRef<number | null>(null)
  const [repoFilter, setRepoFilter] = useState<string | null>(null)
  const repoFilterRef = useRef<string | null>(null)
  const [expandedRepoRoots, setExpandedRepoRoots] = useState<Set<string>>(() => new Set())
  const activeCwd = useMemo(() => diffResult?.cwd || cwd, [diffResult?.cwd, cwd])
  const getFileKey = useCallback((file: GitFileStatus, repoRoot = activeCwd || '') => {
    return buildFileKey(file.repoRoot || repoRoot, file)
  }, [activeCwd])

  // Whenever a click measurement seals, emit one perf-trace span per phase
  // (plus a total span) so a Perfetto capture carries the same JadeTree
  // chain that the in-app debug panel surfaces. `addListener` returns the
  // unsubscribe handle; we re-subscribe whenever cwd / terminalId change so
  // the trace context tag matches the current selection.
  useEffect(() => {
    const tracker = clickLatencyTrackerRef.current
    return tracker.addListener((measurement) => {
      const records = buildClickPhaseTraceRecords(measurement, {
        cwd: activeCwd ?? '',
        terminalId
      })
      for (const record of records) {
        perfTrace(record.event, record.payload)
      }
    })
  }, [activeCwd, terminalId])

  const selectedFileKey = selectedFile ? getFileKey(selectedFile) : null
  const selectedFileState = selectedFileKey ? fileContents[selectedFileKey] : null
  const statusText = useMemo(() => ({
    M: t('gitDiff.status.modified'),
    A: t('gitDiff.status.added'),
    D: t('gitDiff.status.deleted'),
    R: t('gitDiff.status.renamed'),
    C: t('gitDiff.status.copied'),
    '?': t('gitDiff.status.untracked'),
    '!': t('gitDiff.status.conflict')
  }), [t])
  const changeTypeText = useMemo(() => ({
    unstaged: t('gitDiff.changeType.unstaged'),
    staged: t('gitDiff.changeType.staged'),
    untracked: t('gitDiff.changeType.untracked'),
    conflict: t('gitDiff.changeType.conflict')
  }), [t])
  const resolveSetiFileIcon = useMemo(
    () => createThemedSetiFileIconResolver(settings?.theme),
    [settings?.theme]
  )
  // Keep diffRevealPhase ref in sync with state
  useEffect(() => { diffRevealPhaseRef.current = diffRevealPhase }, [diffRevealPhase])
  const cancelDiffRevealTimeout = useCallback(() => {
    if (diffRevealTimeoutRef.current !== null) {
      window.clearTimeout(diffRevealTimeoutRef.current)
      diffRevealTimeoutRef.current = null
    }
  }, [])
  const enterDiffWaiting = useCallback(() => {
    cancelDiffRevealTimeout()
    setDiffRevealPhase('waiting-diff')
    diffRevealPhaseRef.current = 'waiting-diff'
    // Safety timeout: if onDidUpdateDiff never fires (large file, Monaco stall),
    // trigger restoring-scroll so the useLayoutEffect still runs scroll restoration
    // before revealing. 2000ms accommodates large diffs on slower machines.
    diffRevealTimeoutRef.current = window.setTimeout(() => {
      if (diffRevealPhaseRef.current === 'waiting-diff') {
        setDiffRevealPhase('restoring-scroll')
        diffRevealPhaseRef.current = 'restoring-scroll'
      }
    }, 2000)
  }, [cancelDiffRevealTimeout])

  const isDraftDirty = selectedFileState?.draftContent !== undefined &&
    selectedFileState.draftContent !== selectedFileState.modifiedContent
  const hasAnyUnsavedDraft = useMemo(() => {
    return Object.values(fileContents).some((state) =>
      state?.draftContent !== undefined && state.draftContent !== state.modifiedContent
    )
  }, [fileContents])
  const effectiveModifiedContent = selectedFileState?.draftContent ?? selectedFileState?.modifiedContent ?? ''
  const editDisabledReason = useMemo(() => {
    if (!selectedFile) return t('gitDiff.editDisabled.noFile')
    if (!selectedFileState) return t('gitDiff.editDisabled.fileNotLoaded')
    if (selectedFileState.loading) return t('gitDiff.editDisabled.fileLoading')
    if (selectedFileState.error) return t('gitDiff.editDisabled.readFailed')
    if (selectedFileState.isBinary) return t('gitDiff.editDisabled.binary')
    if (selectedFile.isSubmoduleEntry) return t('gitDiff.editDisabled.submodule')
    if (selectedFile.status === 'D') return t('gitDiff.editDisabled.deleted')
    if (selectedFile.changeType === 'staged') return t('gitDiff.editDisabled.staged')
    return ''
  }, [selectedFile, selectedFileState, t])
  const canEditFile = editDisabledReason.length === 0
  const canSaveDraft = canEditFile && isDraftDirty && !isSavingEdit
  const hasMultipleRepos = Boolean(diffResult?.repos && diffResult.repos.length > 1)
  useEffect(() => {
    const repos = diffResult?.repos ?? []
    if (repos.length === 0) return
    setExpandedRepoRoots((prev) => {
      const next = new Set(prev)
      for (const repo of repos) {
        next.add(normalizeRepoRoot(repo.root))
        if (repo.parentRoot) {
          next.add(normalizeRepoRoot(repo.parentRoot))
        }
      }
      return next
    })
  }, [diffResult?.repos])
  const visibleFileList = useMemo(() => {
    const files = diffResult?.files ?? []
    return repoFilter ? files.filter((file) => file.repoRoot === repoFilter) : files
  }, [diffResult?.files, repoFilter])
  const visibleRepoItems = useMemo(() => buildRepoFilterTreeItems(
    diffResult?.repos,
    expandedRepoRoots,
    diffResult?.cwd || cwd || null,
    t('gitDiff.repo.current'),
    (repo) => repo.changeCount > 0 || Boolean(repo.loading) || !repo.isSubmodule
  ), [cwd, diffResult?.cwd, diffResult?.repos, expandedRepoRoots, t])
  useEffect(() => {
    diffResultRef.current = diffResult
  }, [diffResult])
  useEffect(() => {
    visibleFileListRef.current = visibleFileList
  }, [visibleFileList])
  useEffect(() => {
    visibleRepoItemsRef.current = visibleRepoItems
  }, [visibleRepoItems])
  const setRepoExpanded = useCallback((repoRoot: string, expanded: boolean) => {
    const key = normalizeRepoRoot(repoRoot)
    if (!key) return false
    setExpandedRepoRoots((prev) => {
      const next = new Set(prev)
      if (expanded) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })
    return true
  }, [])
  const toggleRepoExpanded = useCallback((repoRoot: string) => {
    const key = normalizeRepoRoot(repoRoot)
    if (!key) return
    setExpandedRepoRoots((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])
  const updateRepoFilter = useCallback((repoRoot: string | null) => {
    repoFilterRef.current = repoRoot
    setRepoFilter(repoRoot)
    return true
  }, [])
  const confirmCloseWithDraft = useCallback(() => {
    if (!hasAnyUnsavedDraft) return true
    return window.confirm(t('gitDiff.confirm.closeWithDraft'))
  }, [hasAnyUnsavedDraft, t])
  const toggleImageDisplayMode = useCallback((mode: ImageDisplayMode) => {
    setImageDisplayMode(mode)
    localStorage.setItem(IMAGE_DISPLAY_MODE_STORAGE_KEY, mode)
    updateUIPreferences({ gitDiffImageDisplayMode: mode })
  }, [updateUIPreferences])
  const toggleImageCompareMode = useCallback((mode: ImageCompareMode) => {
    setImageCompareMode(mode)
    localStorage.setItem(IMAGE_COMPARE_MODE_STORAGE_KEY, mode)
    updateUIPreferences({ gitDiffImageCompareMode: mode })
  }, [updateUIPreferences])
  const setFileListViewMode = useCallback((mode: GitDiffFileListViewMode) => {
    setFileListViewModeState(mode)
    localStorage.setItem(STORAGE_KEY_FILE_LIST_VIEW_MODE, mode)
    updateUIPreferences({ gitDiffFileListViewMode: mode })
    perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_FILE_LIST_MODE_CHANGE, {
      terminalId,
      cwd: activeCwd,
      mode
    })
  }, [activeCwd, terminalId, updateUIPreferences])

  const setSplitViewMode = useCallback((mode: GitDiffSplitViewMode) => {
    setSplitViewModeState(mode)
    try {
      localStorage.setItem(STORAGE_KEY_DIFF_SPLIT_VIEW_MODE, mode)
    } catch {
      /* localStorage may be unavailable in private contexts; persist best-effort */
    }
    perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_SPLIT_MODE_TOGGLE, {
      terminalId,
      cwd: activeCwd,
      mode
    })
  }, [activeCwd, terminalId])

  const persistDiffSplitRatio = useCallback((nextRatio: number) => {
    const normalized = clampDiffSplitRatio(nextRatio)
    const prev = diffSplitRatioRef.current
    if (Math.abs(prev - normalized) <= DIFF_SPLIT_RATIO_EPSILON) return prev
    diffSplitRatioRef.current = normalized
    localStorage.setItem(STORAGE_KEY_DIFF_SPLIT_RATIO, String(normalized))
    updateUIPreferences({ gitDiffSplitViewRatio: normalized })
    return normalized
  }, [updateUIPreferences])

  // --- Path copy (shared hook) ---
  const { copyMessage, copyToClipboard, flashCopyFeedback } = usePathCopy(t, 'gitDiff.copyFailed')

  const handleFilenameDblClick = useCallback(async (e: React.MouseEvent) => {
    if (!selectedFile) return
    const target = e.currentTarget as HTMLElement
    const rootCwd = selectedFile.repoRoot || activeCwd || ''
    const isAbsolute = e.altKey
    const relativePath = selectedFile.filename
    const pathToCopy = isAbsolute ? `${rootCwd}/${relativePath}` : relativePath
    const label = isAbsolute ? t('common.absolutePath') : t('common.relativePath')
    const ok = await copyToClipboard(pathToCopy, label)
    if (ok) flashCopyFeedback(target)
  }, [selectedFile, activeCwd, copyToClipboard, flashCopyFeedback, t])

  const handleFileContextMenu = useCallback((e: React.MouseEvent, file: GitFileStatus) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, targetFile: file })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const copyContextMenuPath = useCallback(async (file: GitFileStatus, kind: 'name' | 'relative' | 'absolute') => {
    const rootCwd = file.repoRoot || activeCwd || ''
    if (kind === 'name') {
      const name = file.filename.split('/').pop() || file.filename
      await copyToClipboard(name, t('common.name'))
    } else if (kind === 'relative') {
      await copyToClipboard(file.filename, t('common.relativePath'))
    } else {
      await copyToClipboard(`${rootCwd}/${file.filename}`, t('common.absolutePath'))
    }
    closeContextMenu()
  }, [activeCwd, copyToClipboard, closeContextMenu, t])

  useEffect(() => {
    if (!contextMenu) return
    const handleMouseDown = () => setContextMenu(null)
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [contextMenu])

  useEffect(() => {
    if (!termsPopoverOpen) return
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.git-diff-terms-help')) return
      setTermsPopoverOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [termsPopoverOpen])

  // File list width (read from uiPreferences, fallback to localStorage)
  const [fileListWidth, setFileListWidth] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.gitDiffFileListWidth !== undefined) return prefs.gitDiffFileListWidth
    const saved = localStorage.getItem(STORAGE_KEY_FILE_LIST_WIDTH)
    return saved ? parseInt(saved, 10) : DEFAULT_FILE_LIST_WIDTH
  })
  const fileListWidthRef = useRef(fileListWidth)
  const isDraggingRef = useRef(false)

  // Pop-up window size (read from uiPreferences, fallback to localStorage)
  const [modalSize, setModalSize] = useState(() => {
    if (isPanel) {
      return { width: DEFAULT_MODAL_WIDTH, height: DEFAULT_MODAL_HEIGHT }
    }
    const prefs = getUIPreferences()
    if (prefs.gitDiffModalSize) {
      return { width: prefs.gitDiffModalSize.width || DEFAULT_MODAL_WIDTH, height: prefs.gitDiffModalSize.height || DEFAULT_MODAL_HEIGHT }
    }
    const saved = localStorage.getItem(STORAGE_KEY_MODAL_SIZE)
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        return {
          width: parsed.width || DEFAULT_MODAL_WIDTH,
          height: parsed.height || DEFAULT_MODAL_HEIGHT
        }
      } catch {
        return { width: DEFAULT_MODAL_WIDTH, height: DEFAULT_MODAL_HEIGHT }
      }
    }
    return { width: DEFAULT_MODAL_WIDTH, height: DEFAULT_MODAL_HEIGHT }
  })
  const modalSizeRef = useRef(modalSize)
  const isResizingModalRef = useRef(false)
  const resizeDirectionRef = useRef<string>('')

  const getMemoryKey = useCallback((repoRootOverride?: string | null) => {
    const repo = repoRootOverride || activeCwd || cwd || ''
    const terminal = terminalId || ''
    if (!repo || !terminal) return ''
    return `${terminal}::${repo}`
  }, [activeCwd, cwd, terminalId])

  const getMemoryStore = useCallback(() => {
    const key = getMemoryKey()
    if (!key) return null
    if (!diffMemoryRef.current[key]) {
      diffMemoryRef.current[key] = {
        selectedFileKey: null,
        entries: {}
      }
    }
    return diffMemoryRef.current[key]
  }, [getMemoryKey])

  const findMemoryEntry = useCallback((
    memory: DiffViewMemory,
    file: GitFileStatus,
    fileKey: string
  ): DiffViewMemoryEntry | null => {
    const direct = memory.entries[fileKey]
    if (direct) return direct
    const match = Object.values(memory.entries).find((entry) =>
      entry.filePath === file.filename &&
      (entry.originalFilename ?? '') === (file.originalFilename ?? '')
    )
    return match ?? null
  }, [])

  const captureDiffView = useCallback((fileKeyOverride?: string | null) => {
    const memory = getMemoryStore()
    if (!memory) return
    const editor = diffEditorRef.current
    if (!editor) return
    const fileKey = fileKeyOverride ?? selectedFileKey
    if (!fileKey || !selectedFile) return
    const modifiedEditor = editor.getModifiedEditor()
    const visibleRanges = modifiedEditor.getVisibleRanges()
    const firstVisibleLine = visibleRanges.length > 0 ? visibleRanges[0].startLineNumber : null
    const scrollTop = modifiedEditor.getScrollTop()
    const anchor: DiffViewAnchor = {
      line: firstVisibleLine,
      scrollTop
    }
    const signature = selectedFileState && !selectedFileState.isBinary
      ? buildDiffSignature(
        selectedFileState.originalContent ?? '',
        selectedFileState.draftContent ?? selectedFileState.modifiedContent ?? ''
      )
      : null
    memory.entries[fileKey] = {
      fileKey,
      filePath: selectedFile.filename,
      originalFilename: selectedFile.originalFilename,
      anchor,
      scrollTop,
      signature,
      updatedAt: Date.now()
    }
    memory.selectedFileKey = fileKey
  }, [
    getMemoryStore,
    selectedFile,
    selectedFileKey,
    selectedFileState
  ])

  const scrollToFirstChange = useCallback(() => {
    const editor = diffEditorRef.current
    if (!editor) return
    const changes = editor.getLineChanges()
    if (!changes || changes.length === 0) return
    const firstChange = changes[0]
    const targetLine = firstChange.modifiedStartLineNumber || firstChange.originalStartLineNumber || 1
    editor.getModifiedEditor().revealLineNearTop(targetLine)
  }, [])

  const scrollToTop = useCallback(() => {
    const editor = diffEditorRef.current
    if (!editor) return
    editor.getModifiedEditor().setScrollTop(0)
  }, [])

  const setSelectedLineRangeValue = useCallback((range: SelectedLineRange | null) => {
    selectedLineRangeRef.current = range
    lineSelectionInfoRef.current = resolveLineSelectionInfo(range, t('gitDiff.line.invalid.crossSide'))
    setSelectedLineRangeState(range)
  }, [t])

  const navigateDiffChange = useCallback((direction: 'previous' | 'next') => {
    const editor = diffEditorRef.current
    if (!editor) return false
    const changes = editor.getLineChanges() ?? []
    if (changes.length === 0) return false
    const modifiedEditor = editor.getModifiedEditor()
    const visibleRanges = modifiedEditor.getVisibleRanges()
    const referenceLine = visibleRanges[0]?.startLineNumber ?? modifiedEditor.getPosition()?.lineNumber ?? 1
    let currentIndex = diffNavigationIndexRef.current
    if (currentIndex < 0 || currentIndex >= changes.length) {
      currentIndex = changes.findIndex((change) => {
        const line = change.modifiedStartLineNumber || change.modifiedEndLineNumber || change.originalStartLineNumber || 1
        return line >= referenceLine
      })
      if (currentIndex < 0) currentIndex = direction === 'next' ? -1 : 0
    }
    const delta = direction === 'next' ? 1 : -1
    const nextIndex = (currentIndex + delta + changes.length) % changes.length
    const target = changes[nextIndex]
    const lineCount = modifiedEditor.getModel()?.getLineCount() ?? 1
    const rawLine = target.modifiedStartLineNumber || target.modifiedEndLineNumber || target.originalStartLineNumber || 1
    const line = Math.max(1, Math.min(rawLine, lineCount))
    diffNavigationIndexRef.current = nextIndex
    modifiedEditor.setPosition({ lineNumber: line, column: 1 })
    modifiedEditor.revealLineInCenterIfOutsideViewport(line)
    perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_HUNK_NAVIGATE, {
      cwd: activeCwd,
      terminalId,
      direction,
      index: nextIndex,
      changeCount: changes.length,
      line
    })
    const monaco = monacoRef.current
    if (monaco) {
      installDiffHunkActionWidgetsRef.current?.(editor, monaco)
    }
    return true
  }, [activeCwd, terminalId])

  const disposeDiffHunkActionWidgets = useCallback(() => {
    const count = diffHunkActionDisposablesRef.current.length
    visibleHunkActionWidgetIdRef.current = null
    for (const disposable of diffHunkActionDisposablesRef.current) {
      try {
        disposable.dispose()
      } catch (error) {
        debugLog('editor:dispose-hunk-action:error', { error: String(error) })
      }
    }
    diffHunkActionDisposablesRef.current = []
    diffHunkActionWidgetHandlesRef.current = []
    if (count > 0) {
      debugLog('editor:hunk-actions:disposed', { count })
    }
  }, [])

  const installDiffHunkActionWidgets = useCallback((
    editor: monacoTypes.editor.IStandaloneDiffEditor,
    monaco: typeof monacoTypes
  ): HunkActionWidgetInstallResult => {
    disposeDiffHunkActionWidgets()

    const file = selectedFileRef.current ?? selectedFile
    if (!file || file.isSubmoduleEntry || file.changeType === 'untracked' || file.status === 'D') return 'skipped'
    const key = getFileKey(file)
    const state = fileContentsRef.current[key] ?? (
      selectedFile && getFileKey(selectedFile) === key ? selectedFileState : null
    )

    const changes = editor.getLineChanges() ?? []
    const modifiedEditor = editor.getModifiedEditor()
    const lineCount = modifiedEditor.getModel()?.getLineCount() ?? 1
    const isStagedFile = file.changeType === 'staged'
    const plan = buildHunkActionWidgetPlan({
      file,
      state,
      isDraftDirty: isDraftDirtyRef.current,
      changes,
      lineCount
    })
    if (plan.eligibility.result !== 'installed') return plan.eligibility.result

    plan.widgets.forEach(({ anchorLine, range, showRevert }) => {
      const widgetId = `onward.gitDiff.hunkAction.${range.id}`
      const node = document.createElement('div')
      // is-visible class is applied unconditionally — these toolbars are
      // always-on per-hunk controls, no longer hover-revealed.
      node.className = 'git-diff-hunk-actions is-visible'
      node.dataset.hunkIndex = String(range.index)
      node.setAttribute('aria-hidden', 'false')

      const buildIconButton = (
        variant: 'stage' | 'unstage' | 'revert',
        label: string,
        title: string,
        onClick: () => void
      ) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = `git-diff-hunk-action-button ${variant === 'revert' ? 'danger' : 'success'}`
        button.title = title
        button.tabIndex = 0
        button.innerHTML = `${HUNK_ACTION_ICON_SVG[variant]}<span class="git-diff-hunk-action-label">${escapeHtmlText(label)}</span>`
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          onClick()
        })
        return button
      }

      const buttons: HTMLButtonElement[] = []
      if (isStagedFile) {
        buttons.push(buildIconButton(
          'unstage',
          t('gitDiff.hunk.unstage'),
          t('gitDiff.hunk.unstageTitle'),
          () => { void runDiffHunkActionRef.current?.('unstage', range) }
        ))
      } else {
        buttons.push(buildIconButton(
          'stage',
          t('gitDiff.hunk.stage'),
          t('gitDiff.hunk.stageTitle'),
          () => { void runDiffHunkActionRef.current?.('stage', range) }
        ))
        if (showRevert) {
          buttons.push(buildIconButton(
            'revert',
            t('gitDiff.hunk.revert'),
            t('gitDiff.hunk.revertTitle'),
            () => { void runDiffHunkActionRef.current?.('revert', range) }
          ))
        }
      }
      buttons.forEach((b) => node.appendChild(b))

      const preventEditorFocus = (event: Event) => {
        event.preventDefault()
        event.stopPropagation()
      }
      node.addEventListener('mousedown', preventEditorFocus)

      const widget: monacoTypes.editor.IContentWidget = {
        allowEditorOverflow: false,
        suppressMouseDown: true,
        getId: () => widgetId,
        getDomNode: () => node,
        getPosition: () => ({
          // Float ABOVE the hunk's first line so the toolbar never covers
          // code. Falls back to BELOW when the hunk sits at the very first
          // visible line and there is no room above.
          position: { lineNumber: anchorLine, column: 1 },
          preference: [
            monaco.editor.ContentWidgetPositionPreference.ABOVE,
            monaco.editor.ContentWidgetPositionPreference.BELOW
          ]
        })
      }

      modifiedEditor.addContentWidget(widget)
      diffHunkActionWidgetHandlesRef.current.push({
        id: widgetId,
        anchorLine,
        range,
        node,
        buttons
      })
      diffHunkActionDisposablesRef.current.push({
        dispose: () => {
          modifiedEditor.removeContentWidget(widget)
          node.remove()
        }
      })
    })
    return diffHunkActionDisposablesRef.current.length > 0 ? 'installed' : 'skipped'
  }, [disposeDiffHunkActionWidgets, getFileKey, selectedFile, selectedFileState, t])

  useEffect(() => {
    installDiffHunkActionWidgetsRef.current = installDiffHunkActionWidgets
  }, [installDiffHunkActionWidgets])

  // Hover detection deleted intentionally: per-hunk Stage / Revert toolbars
  // are now installed always-visible by installDiffHunkActionWidgets, so
  // there is no need for a renderer-side mousemove pipeline reaching into
  // Monaco's diff DOM. The toolbars are rebuilt whenever the diff updates
  // (see editor.onDidUpdateDiff in handleEditorDidMount) which is the only
  // signal the renderer actually needs.

  const disposeDiffEditorBindings = useCallback(() => {
    if (diffSplitMeasureFrameRef.current !== null) {
      window.cancelAnimationFrame(diffSplitMeasureFrameRef.current)
      diffSplitMeasureFrameRef.current = null
    }
    if (diffScrollCaptureTimerRef.current !== null) {
      window.clearTimeout(diffScrollCaptureTimerRef.current)
      diffScrollCaptureTimerRef.current = null
    }
    disposeDiffHunkActionWidgets()
    for (const disposable of diffEditorBindingDisposablesRef.current) {
      try {
        disposable.dispose()
      } catch (error) {
        debugLog('editor:dispose-binding:error', { error: String(error) })
      }
    }
    diffEditorBindingDisposablesRef.current = []
  }, [disposeDiffHunkActionWidgets])

  const measureDiffSplitState = useCallback((
    editorOverride?: monacoTypes.editor.IStandaloneDiffEditor | null
  ): DiffSplitState | null => {
    const editor = editorOverride ?? diffEditorRef.current
    if (!editor) return null
    const mode = getDiffLayoutMode(editor)
    const originalLayoutWidth = editor.getOriginalEditor().getLayoutInfo().width
    const modifiedLayoutWidth = editor.getModifiedEditor().getLayoutInfo().width
    const layoutWidth = originalLayoutWidth + modifiedLayoutWidth
    if (mode !== 'side-by-side') {
      return {
        mode,
        ratio: null,
        originalWidth: Math.max(0, Math.round(originalLayoutWidth)),
        modifiedWidth: Math.max(0, Math.round(modifiedLayoutWidth))
      }
    }
    if (layoutWidth > 0) {
      return {
        mode,
        ratio: clampDiffSplitRatio(originalLayoutWidth / layoutWidth),
        originalWidth: Math.max(0, Math.round(originalLayoutWidth)),
        modifiedWidth: Math.max(0, Math.round(modifiedLayoutWidth))
      }
    }
    const layout = (() => {
      const privateElements = (editor as monacoTypes.editor.IStandaloneDiffEditor & {
        elements?: Partial<Record<'root' | 'original' | 'modified', HTMLElement>>
      }).elements
      const container = editor.getContainerDomNode()
      const diffRoot = privateElements?.root ?? (
        container.classList.contains('monaco-diff-editor')
          ? container
          : container.querySelector<HTMLElement>('.monaco-diff-editor')
      )
      const originalPane = getDiffPaneElement(editor, 'original')
      const modifiedPane = getDiffPaneElement(editor, 'modified')
      if (!diffRoot || !originalPane || !modifiedPane) return null
      const rootRect = diffRoot.getBoundingClientRect()
      const originalRect = originalPane.getBoundingClientRect()
      const modifiedRect = modifiedPane.getBoundingClientRect()
      const originalWidth = originalRect.width
      const modifiedWidth = modifiedRect.width
      const gap = Math.max(0, modifiedRect.left - originalRect.right)
      const splitLeft = originalWidth + gap
      const contentWidth = splitLeft + modifiedWidth
      if (contentWidth <= 0) return null
      return {
        ratio: clampDiffSplitRatio(splitLeft / contentWidth),
        originalWidth,
        modifiedWidth,
        originalLeft: Math.max(0, originalRect.left - rootRect.left),
        modifiedLeft: Math.max(0, modifiedRect.left - rootRect.left),
        gap
      } satisfies DiffSplitLayout
    })()
    if (!layout) return null
    return {
      mode,
      ratio: layout.ratio,
      originalWidth: Math.max(0, Math.round(layout.originalWidth)),
      modifiedWidth: Math.max(0, Math.round(layout.modifiedWidth))
    }
  }, [])

  const scheduleDiffSplitMeasurement = useCallback((
    editorOverride?: monacoTypes.editor.IStandaloneDiffEditor | null
  ) => {
    if (diffSplitMeasureFrameRef.current !== null) {
      window.cancelAnimationFrame(diffSplitMeasureFrameRef.current)
    }
    diffSplitMeasureFrameRef.current = window.requestAnimationFrame(() => {
      diffSplitMeasureFrameRef.current = null
      const measurement = measureDiffSplitState(editorOverride)
      if (!measurement || measurement.ratio === null) return
      persistDiffSplitRatio(measurement.ratio)
    })
  }, [measureDiffSplitState, persistDiffSplitRatio])

  const persistCurrentDiffSplitRatio = useCallback((
    editorOverride?: monacoTypes.editor.IStandaloneDiffEditor | null
  ) => {
    const measurement = measureDiffSplitState(editorOverride)
    if (!measurement || measurement.ratio === null) return null
    return persistDiffSplitRatio(measurement.ratio)
  }, [measureDiffSplitState, persistDiffSplitRatio])

  const dragDiffSplitRatio = useCallback(async (nextRatio: number) => {
    const editor = diffEditorRef.current
    if (!editor) return false
    if (getDiffLayoutMode(editor) !== 'side-by-side') return false
    const container = editor.getContainerDomNode()
    const diffRoot = container.classList.contains('monaco-diff-editor')
      ? container
      : container.querySelector<HTMLElement>('.monaco-diff-editor')
    const sash = diffRoot?.querySelector<HTMLElement>('.monaco-sash.vertical') ??
      diffRoot?.querySelector<HTMLElement>('.monaco-sash') ??
      null
    const originalPane = getDiffPaneElement(editor, 'original')
    const modifiedPane = getDiffPaneElement(editor, 'modified')
    if (!diffRoot || !sash || !originalPane || !modifiedPane) return false

    const originalRect = originalPane.getBoundingClientRect()
    const modifiedRect = modifiedPane.getBoundingClientRect()
    const sashRect = sash.getBoundingClientRect()
    const contentLeft = originalRect.left
    const contentWidth = modifiedRect.right - originalRect.left
    if (contentWidth <= 0) return false

    const targetRatio = clampDiffSplitRatio(nextRatio)
    const startX = sashRect.left + (sashRect.width / 2)
    const targetX = contentLeft + (contentWidth * targetRatio)
    const clientY = sashRect.top + (sashRect.height / 2)
    const waitForFrame = () => new Promise<void>((resolve) => {
      window.setTimeout(resolve, 16)
    })
    const dispatchMouseEvent = (
      target: EventTarget,
      type: 'mousedown' | 'mousemove' | 'mouseup',
      clientX: number
    ) => {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1
      }))
    }
    const dispatchPointerEvent = (
      target: EventTarget,
      type: 'pointerdown' | 'pointermove' | 'pointerup',
      clientX: number
    ) => {
      if (typeof window.PointerEvent !== 'function') return
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      }))
    }

    const steps = 8
    dispatchPointerEvent(sash, 'pointerdown', startX)
    dispatchMouseEvent(sash, 'mousedown', startX)
    await waitForFrame()

    for (let step = 1; step <= steps; step += 1) {
      const nextX = startX + (((targetX - startX) * step) / steps)
      dispatchPointerEvent(document, 'pointermove', nextX)
      dispatchMouseEvent(document, 'mousemove', nextX)
      await waitForFrame()
    }

    dispatchPointerEvent(document, 'pointerup', targetX)
    dispatchMouseEvent(document, 'mouseup', targetX)
    dispatchPointerEvent(window, 'pointerup', targetX)
    dispatchMouseEvent(window, 'mouseup', targetX)
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 150)
    })

    const measurement = measureDiffSplitState(editor)
    return Boolean(measurement && measurement.ratio !== null && Math.abs(measurement.ratio - targetRatio) <= 0.08)
  }, [measureDiffSplitState])

  const detachDiffEditor = useCallback(() => {
    if (isPanel) {
      disposeDiffEditorBindings()
      return
    }
    disposeDiffEditorBindings()
    const editor = diffEditorRef.current
    const modelUrisToDispose = new Set<string>()
    if (editor) {
      const model = editor.getModel()
      if (model?.original) modelUrisToDispose.add(model.original.uri.toString())
      if (model?.modified) modelUrisToDispose.add(model.modified.uri.toString())
    }
    const monaco = monacoRef.current
    if (monaco && modelUrisToDispose.size > 0) {
      // @monaco-editor/react owns the DiffEditor disposal. Disposing it here as
      // well can race Monaco's delayed menu/context-key emitters during close.
      window.setTimeout(() => {
        for (const model of monaco.editor.getModels()) {
          if (!model.uri.toString().startsWith('inmemory://model/onward-git-diff/')) continue
          if (!modelUrisToDispose.has(model.uri.toString())) continue
          try {
            model.dispose()
          } catch (error) {
            debugLog('editor:model-dispose:error', { error: String(error), uri: model.uri.toString() })
          }
        }
      }, 100)
    }
    originalDecorationsRef.current?.clear()
    modifiedDecorationsRef.current?.clear()
    originalDecorationsRef.current = null
    modifiedDecorationsRef.current = null
    diffEditorRef.current = null
    monacoRef.current = null
  }, [disposeDiffEditorBindings, isPanel])

  const clearActiveDiffSelection = useCallback((options?: { detachEditor?: boolean }) => {
    setSelectedFile(null)
    selectedFileRef.current = null
    lastSelectedFileRef.current = null
    setActionMessage(null)
    setLineMessage(null)
    setSelectedLineRangeValue(null)
    setLineActionState(null)
    setEditMessage(null)
    setIsSavingEdit(false)
    setDiffRestoreNotice(null)
    originalDecorationsRef.current?.clear()
    modifiedDecorationsRef.current?.clear()
    if (options?.detachEditor) {
      detachDiffEditor()
    }
  }, [detachDiffEditor, setSelectedLineRangeValue])

  // Load Git Diff data
  const resetViewerState = useCallback(() => {
    setDiffResult(null)
    diffResultRef.current = null
    clearActiveDiffSelection()
    setFileContents({})
    fileContentsRef.current = {}
    repoFilterRef.current = null
    setRepoFilter(null)
    setExpandedRepoRoots(new Set())
    setCollapsedDiffTreeDirs(new Set())
    setActionMessage(null)
    setLineMessage(null)
    detachDiffEditor()
  }, [clearActiveDiffSelection, detachDiffEditor])

  const applyLoadedDiffResult = useCallback((
    result: GitDiffResult,
    sourceCwd: string,
    previousSelection: GitFileStatus | null
  ) => {
    setDiffResult(result)
    lastDiffRef.current = {
      cwd: result.cwd || sourceCwd,
      originalCwd: sourceCwd,
      at: Date.now(),
      result
    }

    const repoRoot = result.cwd || sourceCwd
    const nextKeys = new Set(result.files.map((file) => buildFileKey(file.repoRoot || repoRoot, file)))
    const memoryKey = getMemoryKey(repoRoot)
    const memoryStore = memoryKey
      ? (diffMemoryRef.current[memoryKey] || {
        selectedFileKey: null,
        entries: {}
      })
      : {
        selectedFileKey: null,
        entries: {}
      }
    if (memoryKey) {
      diffMemoryRef.current[memoryKey] = memoryStore
    }

    setFileContents((prev) => {
      const next: Record<string, FileContentState> = {}
      for (const key of nextKeys) {
        if (prev[key]) {
          next[key] = prev[key]
        }
      }
      return next
    })

    const activeSelection = selectedFileRef.current || previousSelection
    if (result.success && result.files.length > 0 && activeSelection) {
      const previous = activeSelection
      const matched = result.files.find((file) => file.filename === previous.filename && file.changeType === previous.changeType)
      const fallback = (!matched && previous)
        ? result.files.find((file) => file.filename === previous.filename &&
          (file.originalFilename ?? '') === (previous.originalFilename ?? ''))
        : null
      // Guard: skip setSelectedFile when the same file is already selected
      // (e.g., submodule stage-2 load arriving with unchanged file selection).
      // This prevents unnecessary Monaco editor remount and visual flash.
      const nextFile = matched || fallback || null
      if (!nextFile) {
        selectedFileRef.current = null
        lastSelectedFileRef.current = null
        setSelectedFile(null)
      } else {
        const currentKey = selectedFileRef.current ? getFileKey(selectedFileRef.current) : null
        const nextKey = buildFileKey(nextFile.repoRoot || repoRoot, nextFile)
        if (nextKey !== currentKey) {
          setSelectedFile(nextFile)
        } else {
          selectedFileRef.current = nextFile
          // The selected-file effect only fires on a reference change; when
          // the per-file content cache was wiped externally (watcher-driven
          // invalidation while the panel was closed), the effect will not
          // re-fetch on its own and Monaco renders blank or the prior body.
          // Trigger a fetch directly when the cache slot is empty.
          if (!fileContentsRef.current[nextKey]) {
            void ensureFileContentRef.current?.(nextFile)
          }
        }
      }
    } else {
      selectedFileRef.current = null
      lastSelectedFileRef.current = null
      setSelectedFile(null)
    }
    const currentRepoFilter = repoFilterRef.current
    if (result.files.length > 0 && currentRepoFilter && !result.files.some((file) => file.repoRoot === currentRepoFilter)) {
      repoFilterRef.current = null
      setRepoFilter(null)
    }
  }, [getFileKey, getMemoryKey])

  const resolveLoadIdleWaiters = useCallback(() => {
    const waiters = loadIdleWaitersRef.current.splice(0)
    for (const resolve of waiters) {
      resolve()
    }
  }, [])

  const waitForLoadIdle = useCallback(() => {
    if (!loadInFlightRef.current && !loadQueuedRef.current) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      loadIdleWaitersRef.current.push(resolve)
    })
  }, [])

  const markDiffLoadedForTiming = useCallback((reason: string, detail?: Record<string, unknown>) => {
    if (timingRef.current.diffLoadedAt !== null) return false
    const loadedAt = performance.now()
    const nextTiming = {
      ...timingRef.current,
      diffLoadedAt: loadedAt
    }
    timingRef.current = nextTiming
    debugLog('diff:timing:loaded', {
      reason,
      openRequestedAt: nextTiming.openRequestedAt,
      cwdReadyAt: nextTiming.cwdReadyAt,
      openToDiffLoadedMs: nextTiming.openRequestedAt !== null
        ? Math.round(loadedAt - nextTiming.openRequestedAt)
        : null,
      cwdReadyToDiffLoadedMs: nextTiming.cwdReadyAt !== null
        ? Math.round(loadedAt - nextTiming.cwdReadyAt)
        : null,
      ...detail
    })
    return true
  }, [])

  const loadDiff = useCallback(async (options?: { reset?: boolean; silent?: boolean; force?: boolean }) => {
    if (DEBUG_GIT_DIFF) {
      perfCountersRef.current.loadDiff += 1
    }
    const previousSelection = selectedFileRef.current
    if (!cwd) {
      if (cwdPending) {
        setDiffResult(null)
        return
      }
      setDiffResult({
        success: false,
        cwd: '',
        isGitRepo: false,
        gitInstalled: true,
        files: [],
        error: t('gitDiff.error.noWorkingDirectory')
      })
      return
    }

    if (!options?.reset && !options?.force) {
      const cached = lastDiffRef.current
      if (cached && (cached.originalCwd === cwd || cached.cwd === cwd)) {
        const age = Date.now() - cached.at
        if (age < 800 && !cached.result.submodulesLoading) {
          debugLog('diff:load:cache', { cwd, age })
          setDiffResult(cached.result)
          // Treat a cache hit as "diff loaded" for timing purposes so the
          // subpage entry's openToDiffLoadedMs reflects the real (near-zero)
          // latency users perceive when reopening Diff onto a warm cache.
          // Without this the cwdReadyToDiffLoadedMs sample stays null on
          // every cache-hit re-entry.
          markDiffLoadedForTiming('renderer-cache-hit', {
            cwd,
            age,
            fileCount: cached.result.files?.length ?? 0
          })
          return
        }
      }
    }

    if (loadInFlightRef.current) {
      const previous = loadQueuedRef.current
      const nextSilent = options?.silent ?? false
      loadQueuedRef.current = {
        reset: Boolean(previous?.reset || options?.reset),
        force: Boolean(previous?.force || options?.force),
        silent: previous ? Boolean(previous.silent ?? true) && nextSilent : nextSilent
      }
      const waitStartedAt = performance.now()
      debugLog('diff:load:skip', {
        cwd,
        reason: 'in-flight',
        queued: loadQueuedRef.current,
        hasDiffResult: Boolean(diffResultRef.current),
        fileCount: diffResultRef.current?.files?.length ?? null
      })
      await waitForLoadIdle()
      const latestResult = diffResultRef.current
      const cwdMatchesLatest = Boolean(
        latestResult &&
        (latestResult.cwd === cwd || latestResult.cwd === '' || cwd === null)
      )
      const timingMarked = cwdMatchesLatest
        ? markDiffLoadedForTiming('in-flight-idle', {
            cwd,
            waitMs: Math.round(performance.now() - waitStartedAt),
            fileCount: latestResult?.files?.length ?? null,
            submodulesLoading: Boolean(latestResult?.submodulesLoading)
          })
        : false
      debugLog('diff:load:skip:idle', {
        cwd,
        waitMs: Math.round(performance.now() - waitStartedAt),
        cwdMatchesLatest,
        timingMarked,
        hasDiffResult: Boolean(latestResult),
        fileCount: latestResult?.files?.length ?? null
      })
      return
    }
    loadInFlightRef.current = true

    if (options?.reset) {
      resetViewerState()
    }

    const currentToken = ++loadTokenRef.current
    const start = performance.now()
    debugLog('diff:load:start', {
      cwd,
      token: currentToken,
      reset: Boolean(options?.reset),
      silent: Boolean(options?.silent),
      force: Boolean(options?.force)
    })
    try {
      const stagedLoad = Boolean(options?.reset)
      const initialScope = stagedLoad ? 'root-only' : 'full'
      const initialResult = await window.electronAPI.git.getDiff(cwd, { scope: initialScope, force: Boolean(options?.force) })
      if (loadTokenRef.current !== currentToken) return

      // When submodules are still loading, defer UI update to avoid an
      // intermediate flash (placeholder → root-only list → full list).
      // Instead, show placeholder until the full result arrives.
      const deferForSubmodules = stagedLoad && initialResult.success && initialResult.submodulesLoading
      if (!deferForSubmodules) {
        applyLoadedDiffResult(initialResult, cwd, previousSelection)
      } else {
        // Expose the nested repository outline while suppressing the partial
        // root-only file list until the full recursive diff is ready.
        setDiffResult({ ...initialResult, files: [] })
      }
      debugLog('diff:load:done', {
        cwd: initialResult.cwd || cwd,
        token: currentToken,
        stage: initialScope,
        success: initialResult.success,
        fileCount: initialResult.files?.length ?? 0,
        duration: Math.round(performance.now() - start),
        submodulesLoading: Boolean(initialResult.submodulesLoading),
        deferred: deferForSubmodules
      })

      if (!deferForSubmodules) {
        markDiffLoadedForTiming('initial-load', {
          cwd: initialResult.cwd || cwd,
          stage: initialScope,
          fileCount: initialResult.files?.length ?? 0,
          durationMs: Math.round(performance.now() - start)
        })
      }

      if (deferForSubmodules) {
        const fullResult = await window.electronAPI.git.getDiff(cwd, { scope: 'full', force: Boolean(options?.force) })
        if (loadTokenRef.current !== currentToken) return
        applyLoadedDiffResult(
          fullResult,
          cwd,
          previousSelection
        )
        markDiffLoadedForTiming('full-submodule-load', {
          cwd: fullResult.cwd || cwd,
          stage: 'full',
          fileCount: fullResult.files?.length ?? 0,
          durationMs: Math.round(performance.now() - start)
        })
        debugLog('diff:load:done', {
          cwd: fullResult.cwd || cwd,
          token: currentToken,
          stage: 'full',
          success: fullResult.success,
          fileCount: fullResult.files?.length ?? 0,
          duration: Math.round(performance.now() - start),
          submodulesLoading: Boolean(fullResult.submodulesLoading)
        })
      }
    } catch (error) {
      if (loadTokenRef.current !== currentToken) return
      setDiffResult({
        success: false,
        cwd: cwd || '',
        isGitRepo: false,
        gitInstalled: true,
        files: [],
        error: t('gitDiff.error.loadFailed', { error: String(error) })
      })
      debugLog('diff:load:error', { cwd, token: currentToken, error: String(error) })
    } finally {
      loadInFlightRef.current = false
      if (loadQueuedRef.current) {
        const queued = loadQueuedRef.current
        loadQueuedRef.current = null
        await loadDiff(queued)
      } else {
        resolveLoadIdleWaiters()
      }
    }
  }, [applyLoadedDiffResult, cwd, cwdPending, markDiffLoadedForTiming, resetViewerState, resolveLoadIdleWaiters, t, waitForLoadIdle])

  const refreshChanges = useCallback(async () => {
    if (!cwd || isRefreshingChanges) return false
    const startedAt = performance.now()
    setIsRefreshingChanges(true)
    setActionMessage(null)
    setLineMessage(null)
    try {
      lastDiffRef.current = null
      const retainedDrafts = retainDirtyDrafts(fileContentsRef.current)
      setFileContents(retainedDrafts)
      fileContentsRef.current = retainedDrafts
      await loadDiff({ silent: true, force: true })
      const file = selectedFileRef.current
      if (file && !isDraftDirtyRef.current) {
        await ensureFileContentRef.current?.(file, true, 'refresh')
      }
      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_MANUAL_REFRESH, {
        cwd,
        terminalId,
        result: 'success',
        durationMs: +(performance.now() - startedAt).toFixed(1)
      })
      return true
    } catch (error) {
      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_MANUAL_REFRESH, {
        cwd,
        terminalId,
        result: 'exception',
        error: String(error),
        durationMs: +(performance.now() - startedAt).toFixed(1)
      })
      return false
    } finally {
      setIsRefreshingChanges(false)
    }
  }, [cwd, isRefreshingChanges, loadDiff, terminalId])

  const loadDiffFromRoot = useCallback(async (rootPath: string) => {
    if (!rootPath) return
    repoFilterRef.current = null
    setRepoFilter(null)
    resetViewerState()
    const result = await window.electronAPI.git.getDiff(rootPath)
    setDiffResult(result)
    lastDiffRef.current = {
      cwd: result.cwd || rootPath,
      originalCwd: rootPath,
      at: Date.now(),
      result
    }
    clearActiveDiffSelection()
  }, [clearActiveDiffSelection, resetViewerState])

  // Clear stale state before paint only when the backing cwd changes.
  useLayoutEffect(() => {
    if (isOpen) {
      const nextScope = cwd ?? null
      const shouldReset = lastOpenScopeRef.current !== nextScope
      const openingFromClosed = !wasOpenRef.current
      lastOpenScopeRef.current = nextScope
      resetDiffOnNextLoadRef.current = shouldReset
      timingRef.current = {
        openRequestedAt,
        shellShownAt: performance.now(),
        cwdReadyAt,
        diffLoadedAt: null
      }
      if (shouldReset) {
        resetViewerState()
      } else if (openingFromClosed) {
        clearActiveDiffSelection({ detachEditor: true })
      }
    }
  }, [clearActiveDiffSelection, cwdReadyAt, isOpen, openRequestedAt, resetViewerState])

  useEffect(() => {
    if (!isOpen) return
    timingRef.current = {
      ...timingRef.current,
      openRequestedAt,
      cwdReadyAt
    }
  }, [cwdReadyAt, isOpen, openRequestedAt])

  // Load data when opening (async, after paint). Force-bypass the worker
  // request cache only on a cwd change (`reset=true`), which signals a
  // fresh open whose underlying repo may have mutated outside our
  // watcher's lifetime. For same-cwd re-entries we trust the watcher →
  // invalidation chain (registered below), which clears the worker AND
  // renderer caches whenever a real file mutation lands. A non-forced
  // re-entry hits the worker request cache (~ms) and the renderer's
  // per-file content cache (also ~ms), so the panel paints instantly.
  useEffect(() => {
    if (isOpen) {
      const reset = resetDiffOnNextLoadRef.current
      resetDiffOnNextLoadRef.current = false
      loadDiff({ reset, force: reset })
    }
  }, [isOpen, loadDiff])

  // Track the latest non-null cwd so the always-on listener below can
  // continue matching repo paths after the panel closes (parent zeroes
  // cwd on close, which is why earlier versions of this listener missed
  // mid-close invalidations).
  useEffect(() => {
    if (cwd) lastKnownCwdRef.current = cwd
  }, [cwd])

  useEffect(() => {
    loadDiffRef.current = loadDiff
  }, [loadDiff])

  // Backend FS-watcher invalidations: drop the renderer's per-file
  // content cache (`fileContents`) so a future re-entry — or an
  // already-open panel — refetches the selected file's body. Subscribe
  // ONCE on mount and gate via refs (lastKnownCwdRef, isOpenRef,
  // loadDiffRef, ensureFileContentRef): the prior `isOpen`-gated and
  // `cwd`-gated variants both unsubscribed during the close window and
  // therefore left fileContents stale after `close → external edit →
  // reopen`. The invalidator already debounces to 180 ms so this
  // listener cannot fire faster than that. Also drops `lastDiffRef` so
  // the in-component 800 ms diff-list cache cannot serve a pre-mutation
  // file list either.
  useEffect(() => {
    const dispose = window.electronAPI.git.onDiffCacheInvalidated((invalidatedCwd) => {
      const targetCwd = lastKnownCwdRef.current
      if (!targetCwd) return
      // Match by prefix so a submodule mutation under the current cwd
      // also counts. The invalidator normalises cwds via path.resolve,
      // so a strict prefix check (with separator boundary) is correct
      // on all platforms.
      const normalizedSelf = normalizeInvalidationPath(targetCwd)
      const normalizedHit = normalizeInvalidationPath(invalidatedCwd)
      const matches =
        normalizedHit === normalizedSelf ||
        normalizedHit.startsWith(`${normalizedSelf}/`) ||
        normalizedHit.startsWith(`${normalizedSelf}\\`) ||
        normalizedSelf.startsWith(`${normalizedHit}/`) ||
        normalizedSelf.startsWith(`${normalizedHit}\\`)
      if (!matches) return
      // Drop both renderer-side caches:
      //   - `fileContents` (per-file diff body, owned by Monaco)
      //   - `lastDiffRef` (the in-component 800 ms diff-list cache,
      //     which would otherwise short-circuit `loadDiff` and skip
      //     `applyLoadedDiffResult` entirely on the next entry)
      const retainedDrafts = retainDirtyDrafts(fileContentsRef.current)
      setFileContents(retainedDrafts)
      fileContentsRef.current = retainedDrafts
      lastDiffRef.current = null
      if (!isOpenRef.current) return
      void loadDiffRef.current?.({ silent: true, force: true })
      const sel = selectedFileRef.current
      if (sel) void ensureFileContentRef.current?.(sel, true, 'auto-refresh')
    })
    return () => {
      dispose()
    }
  }, [])

  useEffect(() => {
    selectedFileRef.current = selectedFile
    if (selectedFile) {
      lastSelectedFileRef.current = selectedFile
    }
  }, [selectedFile])

  useEffect(() => {
    fileContentsRef.current = fileContents
  }, [fileContents])

  const wasOpenRef = useRef(false)
  const isOpenRef = useRef(isOpen)
  useEffect(() => {
    isOpenRef.current = isOpen
  }, [isOpen])

  useEffect(() => {
    if (isOpen) {
      diffRestoreCycleRef.current += 1
      diffRestoreAppliedRef.current = { cycle: diffRestoreCycleRef.current, fileKey: null }
      wasOpenRef.current = true
      return
    }
    if (wasOpenRef.current) {
      captureDiffView()
      wasOpenRef.current = false
    }
  }, [captureDiffView, getMemoryKey, getMemoryStore, isOpen])

  // Scroll capture is now registered via onDidScrollChange in handleEditorDidMount
  // Position restoration is done directly in handleEditorDidMount by checking memory storage (to avoid effect timing competition)

  useEffect(() => {
    if (!diffRestoreNotice || !selectedFile) return
    if (diffRestoreNotice.type !== 'changed') return
    const headerTitle = selectedFile.originalFilename && (selectedFile.status === 'R' || selectedFile.status === 'C')
      ? `${selectedFile.originalFilename} → ${selectedFile.filename}`
      : selectedFile.filename
    if (diffRestoreNotice.fileName && diffRestoreNotice.fileName !== headerTitle) {
      setDiffRestoreNotice(null)
    }
  }, [diffRestoreNotice, selectedFile])

  // Drag and drop to adjust file list width
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    const startX = e.clientX
    const startWidth = fileListWidth

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = e.clientX - startX
      const newWidth = Math.max(MIN_FILE_LIST_WIDTH, Math.min(MAX_FILE_LIST_WIDTH, startWidth + delta))
      fileListWidthRef.current = newWidth
      setFileListWidth(newWidth)
    }

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false
        const latestWidth = fileListWidthRef.current
        localStorage.setItem(STORAGE_KEY_FILE_LIST_WIDTH, String(latestWidth))
        updateUIPreferences({ gitDiffFileListWidth: latestWidth })
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('git-diff-resizing')
    }

    document.body.classList.add('git-diff-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [fileListWidth, updateUIPreferences])

  // Save width to localStorage (when width changes)
  useEffect(() => {
    fileListWidthRef.current = fileListWidth
    if (!isDraggingRef.current) {
      localStorage.setItem(STORAGE_KEY_FILE_LIST_WIDTH, String(fileListWidth))
    }
  }, [fileListWidth])

  // Drag and drop to adjust pop-up window size
  const handleModalResizeMouseDown = useCallback((e: React.MouseEvent, direction: string) => {
    if (isPanel) return
    e.preventDefault()
    e.stopPropagation()
    isResizingModalRef.current = true
    resizeDirectionRef.current = direction

    const startX = e.clientX
    const startY = e.clientY
    const startWidth = modalSize.width
    const startHeight = modalSize.height

    const maxWidth = window.innerWidth * MAX_MODAL_WIDTH_PERCENT / 100
    const maxHeight = window.innerHeight * MAX_MODAL_HEIGHT_PERCENT / 100

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingModalRef.current) return

      let newWidth = startWidth
      let newHeight = startHeight

      const dir = resizeDirectionRef.current

      // Handle horizontal orientation
      if (dir.includes('e')) {
        newWidth = Math.max(MIN_MODAL_WIDTH, Math.min(maxWidth, startWidth + (e.clientX - startX) * 2))
      } else if (dir.includes('w')) {
        newWidth = Math.max(MIN_MODAL_WIDTH, Math.min(maxWidth, startWidth - (e.clientX - startX) * 2))
      }

      // Handle vertical orientation
      if (dir.includes('s')) {
        newHeight = Math.max(MIN_MODAL_HEIGHT, Math.min(maxHeight, startHeight + (e.clientY - startY) * 2))
      } else if (dir.includes('n')) {
        newHeight = Math.max(MIN_MODAL_HEIGHT, Math.min(maxHeight, startHeight - (e.clientY - startY) * 2))
      }

      setModalSize({ width: newWidth, height: newHeight })
    }

    const handleMouseUp = () => {
      if (isResizingModalRef.current) {
        isResizingModalRef.current = false
        resizeDirectionRef.current = ''
        // Save to localStorage
        localStorage.setItem(STORAGE_KEY_MODAL_SIZE, JSON.stringify(modalSizeRef.current))
        updateUIPreferences({ gitDiffModalSize: modalSizeRef.current })
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('git-diff-modal-resizing')
    }

    document.body.classList.add('git-diff-modal-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [isPanel, modalSize])

  // Save popup window size to localStorage
  useEffect(() => {
    if (isPanel) return
    if (!isResizingModalRef.current) {
      localStorage.setItem(STORAGE_KEY_MODAL_SIZE, JSON.stringify(modalSize))
      updateUIPreferences({ gitDiffModalSize: modalSize })
    }
  }, [isPanel, modalSize, updateUIPreferences])

  useEffect(() => {
    modalSizeRef.current = modalSize
  }, [modalSize])

  const ensureFileContent = useCallback(async (
    file: GitFileStatus,
    force = false,
    reason: FileContentLoadReason = 'select'
  ) => {
    if (!activeCwd) return
    const fileKey = getFileKey(file)
    const cached = fileContentsRef.current[fileKey]
    if (cached && !cached.loading && !force) {
      // Cached early-return: the file's content is already in state, so
      // there is no placeholder→real transition. Mark stateSet anyway so
      // the click-latency tracker's `markDiffComputedIfReal` gate accepts
      // the next onDidUpdateDiff (Monaco swaps the DiffEditor's modified
      // model when selectedFile changes, even when content was cached).
      clickLatencyTrackerRef.current.markStateSet(fileKey)
      return
    }
    if (inFlightRef.current[fileKey]) {
      return
    }

    const loadStartedAt = performance.now()
    setFileContents((prev) => ({
      ...prev,
      [fileKey]: {
        ...(prev[fileKey] || {
          originalContent: '',
          modifiedContent: '',
          isBinary: false
        }),
        loading: true,
        error: undefined
      }
    }))

    const task = (async () => {
      try {
        clickLatencyTrackerRef.current.markIpcStart(fileKey)
        const ipcStartedAt = performance.now()
        const result: GitFileContentResult = await window.electronAPI.git.getFileContent(activeCwd, {
          filename: file.filename,
          status: file.status,
          originalFilename: file.originalFilename,
          changeType: file.changeType,
          isSubmoduleEntry: file.isSubmoduleEntry
        }, file.repoRoot)
        const ipcDurationMs = performance.now() - ipcStartedAt
        // < 8 ms round-trip is dominated by IPC overhead, with no time left
        // for a worker disk read — that's our cache-hit signal. Above the
        // threshold we tag as miss so the autotest can attribute slow loads
        // to the cache layer vs Monaco rendering.
        const cacheState: 'hit' | 'miss' = ipcDurationMs < 8 ? 'hit' : 'miss'
        clickLatencyTrackerRef.current.markIpcEnd(fileKey, cacheState)

        if (!result.success) {
          perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_FILE_LOAD, {
            cwd: activeCwd,
            terminalId,
            fileKey,
            filename: file.filename,
            changeType: file.changeType,
            reason,
            result: 'error',
            durationMs: +(performance.now() - loadStartedAt).toFixed(1)
          })
          setFileContents((prev) => ({
            ...prev,
            [fileKey]: {
              ...(prev[fileKey] || {
                originalContent: '',
                modifiedContent: '',
                isBinary: false
              }),
              loading: false,
              error: result.error || t('gitDiff.error.readFile'),
              originalContent: '',
              modifiedContent: '',
              draftContent: prev[fileKey]?.draftContent,
              isBinary: false,
              isImage: false,
              isSvg: false,
              originalImageUrl: undefined,
              modifiedImageUrl: undefined,
              originalImageSize: undefined,
              modifiedImageSize: undefined
            }
          }))
          return
        }

        setFileContents((prev) => {
          const previous = prev[fileKey]
          const draft = previous?.draftContent
          const nextDraft = draft !== undefined && draft !== result.modifiedContent ? draft : undefined
          return {
            ...prev,
            [fileKey]: {
              loading: false,
              error: undefined,
              originalContent: result.originalContent,
              modifiedContent: result.modifiedContent,
              draftContent: nextDraft,
              isBinary: result.isBinary,
              isImage: result.isImage,
              isSvg: result.isSvg,
              isPdf: result.isPdf,
              isEpub: result.isEpub,
              originalImageUrl: result.originalImageUrl,
              modifiedImageUrl: result.modifiedImageUrl,
              originalImageSize: result.originalImageSize,
              modifiedImageSize: result.modifiedImageSize,
              originalPreviewData: result.originalPreviewData,
              modifiedPreviewData: result.modifiedPreviewData,
              originalPreviewSize: result.originalPreviewSize,
              modifiedPreviewSize: result.modifiedPreviewSize
            }
          }
        })
        clickLatencyTrackerRef.current.markStateSet(fileKey)
        perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_FILE_LOAD, {
          cwd: activeCwd,
          terminalId,
          fileKey,
          filename: file.filename,
          changeType: file.changeType,
          reason,
          result: 'success',
          originalLen: result.originalContent.length,
          modifiedLen: result.modifiedContent.length,
          force,
          durationMs: +(performance.now() - loadStartedAt).toFixed(1)
        })
        perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_BODY_RENDERED, {
          cwd: activeCwd,
          terminalId,
          fileKey,
          filename: file.filename,
          originalLen: result.originalContent.length,
          modifiedLen: result.modifiedContent.length,
          reason,
          force
        })
      } catch (error) {
        perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_FILE_LOAD, {
          cwd: activeCwd,
          terminalId,
          fileKey,
          filename: file.filename,
          changeType: file.changeType,
          reason,
          result: 'exception',
          durationMs: +(performance.now() - loadStartedAt).toFixed(1)
        })
        setFileContents((prev) => ({
          ...prev,
          [fileKey]: {
            ...(prev[fileKey] || {
              originalContent: '',
              modifiedContent: '',
              isBinary: false
            }),
            loading: false,
            error: t('gitDiff.error.readFailed', { error: String(error) }),
            originalContent: '',
            modifiedContent: '',
            draftContent: prev[fileKey]?.draftContent,
            isBinary: false,
            isImage: false,
            isSvg: false,
            originalImageUrl: undefined,
            modifiedImageUrl: undefined,
            originalImageSize: undefined,
            modifiedImageSize: undefined
          }
        }))
      }
    })()

    inFlightRef.current[fileKey] = task
    try {
      await task
    } finally {
      delete inFlightRef.current[fileKey]
    }
  }, [activeCwd, getFileKey, t, terminalId])

  // Bridge ensureFileContent into the watcher-invalidation listener
  // (registered above, before this callback is defined). The listener
  // keeps a stable identity by referencing the callback through this
  // ref, so the always-on subscription does not re-attach on every
  // ensureFileContent re-creation.
  useEffect(() => {
    ensureFileContentRef.current = ensureFileContent
  }, [ensureFileContent])

  useEffect(() => {
    if (selectedFile) {
      ensureFileContent(selectedFile)
      setActionMessage(null)
    }
    setSelectedLineRangeValue(null)
    originalDecorationsRef.current?.clear()
    modifiedDecorationsRef.current?.clear()
  }, [selectedFile, ensureFileContent, setSelectedLineRangeValue])

  // Lightweight renderer-side prefetch loop. The HEAVY prefetch lives in
  // the main-process precompute scheduler now; this loop just primes the
  // renderer's `fileContentsRef` so the autotest's "first-selection-uses-
  // prefetched-body-cache" assertion (which inspects renderer state)
  // still has data to look at. Each call almost always lands on the
  // main-side cache and returns in single-digit ms, so the cost is
  // negligible. Caps at 8 files per burst.
  useEffect(() => {
    if (!isOpen || !activeCwd || !diffResult?.success || diffResult.submodulesLoading) {
      return
    }
    let cancelled = false
    const candidates = visibleFileList
      .filter((file) => !file.isSubmoduleEntry)
      .filter((file) => file.status !== 'D' && file.status !== '!')
      .filter((file) => {
        const key = getFileKey(file)
        return !fileContentsRef.current[key] && !inFlightRef.current[key]
      })
      .slice(0, 4)
    if (candidates.length === 0) return
    rendererPrefetchSnapshotRef.current = {
      scheduled: candidates.length,
      completed: 0,
      inFlight: true,
      candidates: candidates.map((file) => file.filename),
      lastReason: 'scheduled',
      lastDurationMs: null
    }
    const handle = window.setTimeout(() => {
      void (async () => {
        const startedAt = performance.now()
        perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_BODY_PREFETCH, {
          cwd: activeCwd,
          terminalId,
          phase: 'start',
          candidateCount: candidates.length,
          candidates: candidates.map((file) => file.filename)
        })
        let completed = 0
        for (const file of candidates) {
          if (cancelled) return
          const key = getFileKey(file)
          if (!fileContentsRef.current[key]) {
            await ensureFileContent(file, false, 'prefetch')
          }
          completed += 1
          rendererPrefetchSnapshotRef.current = {
            ...rendererPrefetchSnapshotRef.current,
            completed
          }
        }
        const durationMs = +(performance.now() - startedAt).toFixed(1)
        rendererPrefetchSnapshotRef.current = {
          scheduled: candidates.length,
          completed,
          inFlight: false,
          candidates: candidates.map((file) => file.filename),
          lastReason: 'completed',
          lastDurationMs: durationMs
        }
        perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_BODY_PREFETCH, {
          cwd: activeCwd,
          terminalId,
          phase: 'done',
          candidateCount: candidates.length,
          completed,
          durationMs
        })
      })()
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [activeCwd, diffResult?.success, diffResult?.submodulesLoading, ensureFileContent, getFileKey, isOpen, visibleFileList])

  useEffect(() => { isDraftDirtyRef.current = isDraftDirty }, [isDraftDirty])

  // --- Auto-refresh when the working-tree file changes externally ---
  const handleAutoRefresh = useCallback(async (changeType: 'changed' | 'deleted') => {
    if (!activeCwd) return

    // File deleted externally — refresh the diff list so the sidebar
    // reflects the removal. No content reload needed.
    if (changeType === 'deleted') {
      debugLog('auto-refresh:file-deleted')
      void loadDiff({ silent: true, force: true })
      return
    }

    // changeType === 'changed'
    if (!selectedFile) return

    // Don't overwrite unsaved user edits.
    if (isDraftDirtyRef.current) {
      debugLog('auto-refresh:skip:draft-dirty')
      return
    }

    // Skip watcher-driven refresh for a short window after a local save —
    // the save path already updates state in place, and letting the watcher
    // through would cause the exact full-refresh flicker we're avoiding.
    if (Date.now() < selfSaveSuppressUntilRef.current) {
      debugLog('auto-refresh:skip:self-save')
      return
    }

    if (autoRefreshInFlightRef.current) {
      autoRefreshQueuedRef.current = true
      return
    }

    autoRefreshInFlightRef.current = true
    suppressScrollCaptureRef.current = true
    debugLog('auto-refresh:start', selectedFile.filename)

    try {
      // Capture current scroll position before reload.
      const editor = diffEditorRef.current
      const scrollTop = editor?.getModifiedEditor().getScrollTop() ?? 0

      // Force-reload original + modified content from git.
      await ensureFileContent(selectedFile, true, 'auto-refresh')

      // Update the signature in the memory store so the reveal phase
      // does not show "content changed completely".
      const memory = getMemoryStore()
      const fileKey = selectedFileKey
      if (memory && fileKey) {
        const entry = memory.entries[fileKey]
        const fileState = fileContentsRef.current[fileKey]
        if (entry && fileState && !fileState.isBinary) {
          entry.signature = buildDiffSignature(
            fileState.originalContent ?? '',
            fileState.draftContent ?? fileState.modifiedContent ?? ''
          )
          entry.scrollTop = scrollTop
        }
      }

      // Restore scroll position after Monaco processes the new content.
      requestAnimationFrame(() => {
        const currentEditor = diffEditorRef.current?.getModifiedEditor()
        if (currentEditor && scrollTop > 0) {
          currentEditor.setScrollTop(scrollTop)
        }
        suppressScrollCaptureRef.current = false
      })

      // Also refresh the diff file list so sidebar stats (+/- counts)
      // stay up-to-date with the actual content.
      void loadDiff({ silent: true, force: true })

      debugLog('auto-refresh:done', selectedFile.filename)
    } finally {
      autoRefreshInFlightRef.current = false
      if (autoRefreshQueuedRef.current) {
        autoRefreshQueuedRef.current = false
        setTimeout(() => void handleAutoRefresh('changed'), 0)
      }
    }
  }, [selectedFile, selectedFileKey, activeCwd, ensureFileContent, getMemoryStore, loadDiff])

  useGitDiffFileWatch({
    isOpen,
    selectedFile,
    repoRoot: selectedFile?.repoRoot || activeCwd || null,
    onFileChanged: handleAutoRefresh
  })

  const handleFileSelect = useCallback((file: GitFileStatus) => {
    const nextKey = getFileKey(file)
    // Begin a click→render measurement. Even if the user re-clicks the
    // already-selected file (a no-op below) the tracker resets the chain so
    // autotest harnesses can ask "did this click feel fast?" deterministically.
    clickLatencyTrackerRef.current.start(nextKey, file.filename)
    const memory = getMemoryStore()
    if (selectedFileKey && nextKey !== selectedFileKey) {
      captureDiffView(selectedFileKey)
      setDiffRestoreNotice(null)
    }
    if (selectedFileKey && nextKey !== selectedFileKey && isDraftDirty) {
      const confirmed = window.confirm(t('gitDiff.confirm.switchFileWithDraft'))
      if (!confirmed) return
    }
    if (selectedFileKey && nextKey !== selectedFileKey) {
      const editor = diffEditorRef.current
      if (editor) {
        suppressScrollCaptureRef.current = true
        originalDecorationsRef.current?.clear()
        modifiedDecorationsRef.current?.clear()
        window.setTimeout(() => {
          suppressScrollCaptureRef.current = false
        }, 0)
      }
      // Begin render-then-reveal cycle for the new file
      enterDiffWaiting()
    }
    if (memory) {
      const previousEntry = memory.entries[nextKey]
      memory.entries[nextKey] = {
        fileKey: nextKey,
        filePath: file.filename,
        originalFilename: file.originalFilename,
        anchor: previousEntry?.anchor ?? null,
        scrollTop: previousEntry?.scrollTop ?? 0,
        signature: previousEntry?.signature ?? null,
        updatedAt: Date.now()
      }
      memory.selectedFileKey = nextKey
    }
    if (!fileContentsRef.current[nextKey]) {
      const placeholder: FileContentState = {
        loading: true,
        originalContent: '',
        modifiedContent: '',
        isBinary: false
      }
      fileContentsRef.current = {
        ...fileContentsRef.current,
        [nextKey]: placeholder
      }
      setFileContents((prev) => prev[nextKey] ? prev : {
        ...prev,
        [nextKey]: placeholder
      })
    }
    selectedFileRef.current = file
    lastSelectedFileRef.current = file
    setSelectedFile(file)
  }, [captureDiffView, enterDiffWaiting, getFileKey, getMemoryStore, isDraftDirty, selectedFileKey, t])

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const customEvent = event as CustomEvent<SubpageNavigateEventDetail>
      const detail = customEvent.detail
      if (detail?.target !== 'diff') return
      if (!detail.terminalId || detail.terminalId !== terminalId) return
      if (!detail.filePath) return
      pendingNavigationSelectRef.current = {
        filePath: detail.filePath,
        repoRoot: detail.repoRoot ?? null
      }
      setPendingNavigationSelectNonce((nonce) => nonce + 1)
    }

    window.addEventListener('subpage:navigate', handleNavigate as EventListener)
    return () => {
      window.removeEventListener('subpage:navigate', handleNavigate as EventListener)
    }
  }, [terminalId])

  useEffect(() => {
    const target = pendingNavigationSelectRef.current
    if (!target || !diffResult?.success) return
    const match = findDiffFileByNavigationTarget(diffResult, target)
    if (!match) return
    pendingNavigationSelectRef.current = null
    handleFileSelect(match)
  }, [diffResult, handleFileSelect, pendingNavigationSelectNonce])

  useEffect(() => {
    if (!isOpen || !navigationTarget?.filePath) return
    pendingNavigationSelectRef.current = {
      filePath: navigationTarget.filePath,
      repoRoot: navigationTarget.repoRoot ?? null
    }
    setPendingNavigationSelectNonce((nonce) => nonce + 1)
  }, [isOpen, navigationTarget?.filePath, navigationTarget?.nonce, navigationTarget?.repoRoot])

  const clearLineSelection = useCallback(() => {
    setSelectedLineRangeValue(null)
    originalDecorationsRef.current?.clear()
    modifiedDecorationsRef.current?.clear()
  }, [setSelectedLineRangeValue])

  const discardDraft = useCallback(() => {
    if (!selectedFileKey) return
    setFileContents((prev) => {
      const current = prev[selectedFileKey]
      if (!current) return prev
      return {
        ...prev,
        [selectedFileKey]: {
          ...current,
          draftContent: undefined
        }
      }
    })
    setEditMessage(null)
  }, [selectedFileKey])

  const handleDraftChange = useCallback((value?: string) => {
    if (!selectedFileKey) return
    setFileContents((prev) => {
      const current = prev[selectedFileKey]
      if (!current) return prev
      const nextValue = value ?? ''
      const nextDraft = nextValue === current.modifiedContent ? undefined : nextValue
      if (current.draftContent === nextDraft) return prev
      return {
        ...prev,
        [selectedFileKey]: {
          ...current,
          draftContent: nextDraft
        }
      }
    })
    setEditMessage(null)
  }, [selectedFileKey])

  const scheduleDiffRestore = useCallback((editor: monacoTypes.editor.IStandaloneDiffEditor) => {
    suppressScrollCaptureRef.current = true
    window.setTimeout(() => {
      const currentCycle = diffRestoreCycleRef.current
      const file = selectedFileRef.current
      const fileKey = file ? getFileKey(file) : null
      if (!file || !fileKey) {
        suppressScrollCaptureRef.current = false
        return
      }
      if (
        diffRestoreAppliedRef.current.cycle === currentCycle &&
        diffRestoreAppliedRef.current.fileKey === fileKey
      ) {
        suppressScrollCaptureRef.current = false
        return
      }
      const memory = getMemoryStore()
      if (!memory) {
        suppressScrollCaptureRef.current = false
        return
      }
      const entry = findMemoryEntry(memory, file, fileKey)
      if (!entry) {
        debugLog('restore:no-entry', { fileKey })
        suppressScrollCaptureRef.current = false
        return
      }
      const headerTitle = file.originalFilename && (file.status === 'R' || file.status === 'C')
        ? `${file.originalFilename} → ${file.filename}`
        : file.filename
      if (file.status === 'D') {
        diffRestoreAppliedRef.current = { cycle: currentCycle, fileKey }
        suppressScrollCaptureRef.current = false
        return
      }
      const currentFileState = fileContentsRef.current[fileKey]
      if (entry.signature && currentFileState && !currentFileState.isBinary) {
        const currentSignature = buildDiffSignature(
          currentFileState.originalContent ?? '',
          currentFileState.draftContent ?? currentFileState.modifiedContent ?? ''
        )
        if (currentSignature !== entry.signature) {
          diffRestoreAppliedRef.current = { cycle: currentCycle, fileKey }
          // Banner suppressed by user preference — silently abandon scroll
          // restoration when the signature mismatches and let the user
          // land wherever Monaco places them naturally.
          suppressScrollCaptureRef.current = false
          return
        }
      }

      const modifiedEditor = editor.getModifiedEditor()
      const lineCount = modifiedEditor.getModel()?.getLineCount() ?? 0
      let targetLine = entry.anchor?.line ?? null
      if (targetLine !== null) {
        if (lineCount <= 0) {
          window.setTimeout(() => {
            scheduleDiffRestore(editor)
          }, 40)
          return
        }
        targetLine = Math.max(1, Math.min(targetLine, lineCount))
      }

      restoredAnchorRef.current[fileKey] = {
        line: targetLine,
        scrollTop: entry.scrollTop
      }

      if (targetLine) {
        debugLog('restore:line', { fileKey, line: targetLine })
      }

      if (entry.scrollTop > 0) {
        const applyScrollTop = (attempt: number) => {
          const currentEditor = diffEditorRef.current?.getModifiedEditor()
          if (!currentEditor) return
          currentEditor.setScrollTop(entry.scrollTop)
          if (attempt < 2 && Math.abs(currentEditor.getScrollTop() - entry.scrollTop) > 1) {
            window.requestAnimationFrame(() => applyScrollTop(attempt + 1))
            return
          }
          debugLog('restore:scrollTop-adjust', {
            fileKey,
            scrollTop: entry.scrollTop,
            actualScrollTop: currentEditor.getScrollTop(),
            attempts: attempt + 1
          })
        }
        window.requestAnimationFrame(() => applyScrollTop(0))
        window.setTimeout(() => applyScrollTop(0), 120)
      } else if (targetLine) {
        modifiedEditor.revealLineNearTop(targetLine)
      } else if (entry.scrollTop > 0) {
        modifiedEditor.setScrollTop(entry.scrollTop)
        debugLog('restore:scrollTop', { fileKey, scrollTop: entry.scrollTop })
      }
      diffRestoreAppliedRef.current = { cycle: currentCycle, fileKey }
      setDiffRestoreNotice(null)
      window.setTimeout(() => {
        suppressScrollCaptureRef.current = false
      }, 200)
    }, 80)
  }, [findMemoryEntry, getFileKey, getMemoryStore, t])

  const handleEditorDidMount = useCallback(
    (editor: monacoTypes.editor.IStandaloneDiffEditor, monaco: typeof monacoTypes) => {
      disposeDiffEditorBindings()
      diffEditorRef.current = editor
      monacoRef.current = monaco

      // Apply persisted split ratio at mount as a guard for Monaco versions
      // that initialize layout before consuming the initial options object.
      editor.updateOptions({ splitViewDefaultRatio: diffSplitRatioRef.current })

      // Begin render-then-reveal cycle: editor just mounted, hide until diff is computed
      enterDiffWaiting()

      // The editor instance is now reachable for the currently selected
      // file, if any. Tracker stays a no-op when no measurement is active.
      const currentFileKey = selectedFileRef.current ? getFileKey(selectedFileRef.current) : null
      if (currentFileKey) clickLatencyTrackerRef.current.markEditorReady(currentFileKey)

      // Backup "rendered" signal for the click-latency tracker: Monaco's
      // onDidUpdateDiff is the primary marker for "diff computed and
      // committed to DOM", but it can be silent when both panes' content
      // is unchanged from the previous file (e.g. untracked files that
      // all share original=''). Listening to the modified editor's
      // onDidChangeModelContent fills the gap — once new modified
      // content lands, the user sees it on the next paint, regardless
      // of Monaco's higher-level diff scheduler.
      const modifiedEditorForTracker = editor.getModifiedEditor()
      // Helper: skip the placeholder pass. Uncached clicks transition the
      // selected file's state through `loading: true` (empty original /
      // modified) before the worker returns the real bodies. Monaco fires
      // `onDidUpdateDiff` for that empty pass and would otherwise be the
      // first — and thus winning — call to `markDiffComputed`. We can NOT
      // gate on `fileContentsRef.current[fileKey].loading` because that
      // ref is synced through a useEffect that runs *after* the commit
      // phase that triggered onDidUpdateDiff in the first place — at the
      // moment the diff-update fires, the ref still reflects the
      // placeholder. Instead, gate on the tracker's own `stateSetAt`:
      // markStateSet fires synchronously in `ensureFileContent` (success
      // path) and in the cached early-return below, so by the time the
      // real onDidUpdateDiff lands, stateSetAt is set, the gate passes,
      // and the placeholder pass (which preceded both) has been ignored.
      const markDiffComputedIfReal = (liveFileKey: string | null) => {
        if (!liveFileKey) return
        const active = clickLatencyTrackerRef.current.getActive()
        if (!active || active.fileKey !== liveFileKey) return
        if (active.stateSetAt === null) return
        clickLatencyTrackerRef.current.markDiffComputed(liveFileKey)
      }
      diffEditorBindingDisposablesRef.current.push(modifiedEditorForTracker.onDidChangeModelContent(() => {
        const liveFileKey = selectedFileRef.current ? getFileKey(selectedFileRef.current) : null
        markDiffComputedIfReal(liveFileKey)
      }))

      // Transition from waiting-diff to restoring-scroll when Monaco finishes computing changes
      diffEditorBindingDisposablesRef.current.push(editor.onDidUpdateDiff(() => {
        if (diffRevealPhaseRef.current === 'waiting-diff') {
          setDiffRevealPhase('restoring-scroll')
          diffRevealPhaseRef.current = 'restoring-scroll'
        }
        diffNavigationIndexRef.current = -1
        installDiffHunkActionWidgets(editor, monaco)
        const liveFileKey = selectedFileRef.current ? getFileKey(selectedFileRef.current) : null
        markDiffComputedIfReal(liveFileKey)
      }))

      // Reset decoration refs (the old editor was destroyed, the old collection is no longer valid)
      originalDecorationsRef.current = null
      modifiedDecorationsRef.current = null

      const originalEditor = editor.getOriginalEditor()
      const modifiedEditor = editor.getModifiedEditor()

      // Monitor content changes in the editor on the right (direct editing, automatic draft maintenance)
      diffEditorBindingDisposablesRef.current.push(modifiedEditor.onDidChangeModelContent(() => {
        const value = modifiedEditor.getValue()
        handleDraftChange(value)
      }))

      // Auxiliary: Convert editor selection to row selection range
      const handleCursorSelection = (
        side: SelectionSide,
        selection: monacoTypes.Selection
      ) => {
        // Skip row selection when there are unsaved drafts to avoid confusion between editing text and row-level operation status
        if (isDraftDirtyRef.current) return

        const targetEditor = side === 'deletions' ? originalEditor : modifiedEditor
        const lineCount = targetEditor.getModel()?.getLineCount() ?? 0
        if (lineCount <= 0) {
          setSelectedLineRangeValue(null)
          originalDecorationsRef.current?.clear()
          modifiedDecorationsRef.current?.clear()
          return
        }

        const startLine = selection.startLineNumber
        const endLine = selection.endLineNumber === selection.startLineNumber
          ? selection.endLineNumber
          : (selection.endColumn === 1 ? selection.endLineNumber - 1 : selection.endLineNumber)

        if (startLine === endLine && selection.startColumn === selection.endColumn) {
          // No selection (cursor click), clear row selection
          setSelectedLineRangeValue(null)
          originalDecorationsRef.current?.clear()
          modifiedDecorationsRef.current?.clear()
          return
        }

        const start = Math.max(1, Math.min(Math.min(startLine, endLine), lineCount))
        const end = Math.max(start, Math.min(Math.max(startLine, endLine), lineCount))

        setSelectedLineRangeValue({
          start,
          end,
          side,
          endSide: side
        })

        // Apply decorative highlighting
        const decorations: monacoTypes.editor.IModelDeltaDecoration[] = []
        for (let i = start; i <= end; i++) {
          decorations.push({
            range: new monaco.Range(i, 1, i, 1),
            options: {
              isWholeLine: true,
              className: 'git-diff-selected-line'
            }
          })
        }

        if (side === 'deletions') {
          modifiedDecorationsRef.current?.clear()
          if (!originalDecorationsRef.current) {
            originalDecorationsRef.current = originalEditor.createDecorationsCollection(decorations)
          } else {
            originalDecorationsRef.current.set(decorations)
          }
        } else {
          originalDecorationsRef.current?.clear()
          if (!modifiedDecorationsRef.current) {
            modifiedDecorationsRef.current = modifiedEditor.createDecorationsCollection(decorations)
          } else {
            modifiedDecorationsRef.current.set(decorations)
          }
        }
      }

      // Register selection changes for the original editor (left = deletions)
      diffEditorBindingDisposablesRef.current.push(originalEditor.onDidChangeCursorSelection((e) => {
        if (e.reason === monaco.editor.CursorChangeReason.RecoverFromMarkers) return
        handleCursorSelection('deletions', e.selection)
      }))

      // Register selection changes in the modification editor (right = additions)
      diffEditorBindingDisposablesRef.current.push(modifiedEditor.onDidChangeCursorSelection((e) => {
        if (e.reason === monaco.editor.CursorChangeReason.RecoverFromMarkers) return
        handleCursorSelection('additions', e.selection)
      }))

      // Scroll capture (replacing DOM scroll monitoring)
      diffEditorBindingDisposablesRef.current.push(modifiedEditor.onDidScrollChange(() => {
        if (suppressScrollCaptureRef.current) return
        if (diffScrollCaptureTimerRef.current) {
          window.clearTimeout(diffScrollCaptureTimerRef.current)
        }
        diffScrollCaptureTimerRef.current = window.setTimeout(() => {
          diffScrollCaptureTimerRef.current = null
          if (!isDraftDirtyRef.current) {
            // Read the latest editor status directly through ref to avoid closure expiration
            const currentEditor = diffEditorRef.current
            if (!currentEditor) return
            const currentMemory = getMemoryStore()
            if (!currentMemory) return
            const currentFile = selectedFileRef.current
            const currentFileKey = currentFile ? getFileKey(currentFile) : null
            if (!currentFileKey || !currentFile) return
            const currentFileState = fileContentsRef.current[currentFileKey]
            const me = currentEditor.getModifiedEditor()
            const ranges = me.getVisibleRanges()
            const firstLine = ranges.length > 0 ? ranges[0].startLineNumber : null
            const st = me.getScrollTop()
            const sig = currentFileState && !currentFileState.isBinary
              ? buildDiffSignature(
                currentFileState.originalContent ?? '',
                currentFileState.draftContent ?? currentFileState.modifiedContent ?? ''
              )
              : null
            currentMemory.entries[currentFileKey] = {
              fileKey: currentFileKey,
              filePath: currentFile.filename,
              originalFilename: currentFile.originalFilename,
              anchor: { line: firstLine, scrollTop: st },
              scrollTop: st,
              signature: sig,
              updatedAt: Date.now()
            }
            currentMemory.selectedFileKey = currentFileKey
            debugLog('capture:scroll', { fileKey: currentFileKey, line: firstLine, scrollTop: st })
          }
        }, 120)
      }))

      const handlePointerRelease = () => {
        scheduleDiffSplitMeasurement(editor)
      }
      window.addEventListener('mouseup', handlePointerRelease)
      window.addEventListener('pointerup', handlePointerRelease)
      diffEditorBindingDisposablesRef.current.push({
        dispose: () => {
          window.removeEventListener('mouseup', handlePointerRelease)
          window.removeEventListener('pointerup', handlePointerRelease)
        }
      })

      // Monaco's vertical sash sometimes captures pointer events without
      // letting them bubble to window — depending on platform / Monaco
      // version. Layout-change events are emitted directly from each
      // inner editor whenever the sash moves, so subscribing here is the
      // most reliable trigger for split-view-ratio persistence. Original
      // and modified pane widths change together; one listener is enough.
      diffEditorBindingDisposablesRef.current.push(
        modifiedEditor.onDidLayoutChange(() => {
          scheduleDiffSplitMeasurement(editor)
        })
      )

      // Scroll restoration is now handled by the DiffRevealPhase useLayoutEffect
      // when onDidUpdateDiff fires → restoring-scroll → synchronous scroll + reveal.
    },
    [disposeDiffEditorBindings, enterDiffWaiting, handleDraftChange, installDiffHunkActionWidgets, scheduleDiffSplitMeasurement, setSelectedLineRangeValue]
  )

  // When the selected file changes (not draft edits), enter waiting-diff so the
  // onDidUpdateDiff → restoring-scroll → reveal cycle can proceed.
  // Intentionally depends only on selectedFileKey (not selectedFileState) to avoid
  // re-entering the reveal cycle on every draft keystroke.
  useEffect(() => {
    if (!isOpen || !selectedFileKey) return
    const editor = diffEditorRef.current
    if (!editor) return
    if (diffRevealPhaseRef.current === 'idle') {
      enterDiffWaiting()
    }
  }, [isOpen, enterDiffWaiting, selectedFileKey])

  useEffect(() => {
    const editor = diffEditorRef.current
    const monaco = monacoRef.current
    if (!isOpen || !editor || !monaco) {
      disposeDiffHunkActionWidgets()
      return
    }
    installDiffHunkActionWidgets(editor, monaco)
  }, [disposeDiffHunkActionWidgets, isOpen, installDiffHunkActionWidgets, isDraftDirty, selectedFileKey, selectedFileState])

  // Render-then-reveal: restore scroll position synchronously before paint,
  // then transition to idle so CSS fade-in reveals the content.
  useLayoutEffect(() => {
    if (diffRevealPhase !== 'restoring-scroll') return

    const editor = diffEditorRef.current
    if (!editor) {
      setDiffRevealPhase('idle')
      diffRevealPhaseRef.current = 'idle'
      return
    }

    suppressScrollCaptureRef.current = true

    const file = selectedFileRef.current
    const fileKey = file ? getFileKey(file) : null
    const memory = getMemoryStore()
    let scrollApplied = false

    if (file && fileKey && memory) {
      const entry = findMemoryEntry(memory, file, fileKey)
      if (entry) {
        const headerTitle = file.originalFilename && (file.status === 'R' || file.status === 'C')
          ? `${file.originalFilename} → ${file.filename}`
          : file.filename

        if (file.status === 'D') {
          diffRestoreAppliedRef.current = { cycle: diffRestoreCycleRef.current, fileKey }
        } else {
          // Check signature to detect content changes
          const currentFileState = fileContentsRef.current[fileKey]
          if (entry.signature && currentFileState && !currentFileState.isBinary) {
            const currentSignature = buildDiffSignature(
              currentFileState.originalContent ?? '',
              currentFileState.draftContent ?? currentFileState.modifiedContent ?? ''
            )
            if (currentSignature !== entry.signature) {
              diffRestoreAppliedRef.current = { cycle: diffRestoreCycleRef.current, fileKey }
              // Banner suppressed — see the matching site at the
              // selectedFile-mount path. Restoration is still aborted; the
              // user just doesn't see a "content changed" prompt.
              // Content changed — abort scroll restoration, let user land at first change
              cancelDiffRevealTimeout()
              setDiffRevealPhase('idle')
              diffRevealPhaseRef.current = 'idle'
              window.setTimeout(() => { suppressScrollCaptureRef.current = false }, 200)
              return
            }
          }

          // Apply saved scroll position
          if (entry.scrollTop > 0) {
            const modifiedEditor = editor.getModifiedEditor()
            modifiedEditor.setScrollTop(entry.scrollTop)
            restoredAnchorRef.current[fileKey] = {
              line: entry.anchor?.line ?? null,
              scrollTop: entry.scrollTop
            }
            scrollApplied = true
          } else if (entry.anchor?.line) {
            const modifiedEditor = editor.getModifiedEditor()
            const lineCount = modifiedEditor.getModel()?.getLineCount() ?? 0
            const targetLine = Math.max(1, Math.min(entry.anchor.line, lineCount || 1))
            modifiedEditor.revealLineNearTop(targetLine)
            restoredAnchorRef.current[fileKey] = {
              line: targetLine,
              scrollTop: 0
            }
            scrollApplied = true
          }

          diffRestoreAppliedRef.current = { cycle: diffRestoreCycleRef.current, fileKey }
          setDiffRestoreNotice(null)
        }
      }
    }

    if (!scrollApplied) {
      // No saved position: jump to first change
      const changes = editor.getLineChanges()
      if (changes && changes.length > 0) {
        const firstChange = changes[0]
        const targetLine = firstChange.modifiedStartLineNumber || firstChange.originalStartLineNumber || 1
        editor.getModifiedEditor().revealLineNearTop(targetLine)
      }
    }

    // Transition to idle — CSS fade-in reveals content
    cancelDiffRevealTimeout()
    setDiffRevealPhase('idle')
    diffRevealPhaseRef.current = 'idle'

    // Release scroll capture suppression after a brief delay
    window.setTimeout(() => {
      suppressScrollCaptureRef.current = false
    }, 200)
  }, [diffRevealPhase, cancelDiffRevealTimeout, findMemoryEntry, getFileKey, getMemoryStore, t])

  useEffect(() => {
    return () => {
      disposeDiffEditorBindings()
      cancelDiffRevealTimeout()
    }
  }, [disposeDiffEditorBindings, cancelDiffRevealTimeout])

  const showEditMessage = useCallback((msg: { type: 'success' | 'error'; text: string }) => {
    setEditMessage(msg)
    if (editMessageTimerRef.current) {
      window.clearTimeout(editMessageTimerRef.current)
    }
    editMessageTimerRef.current = window.setTimeout(() => {
      setEditMessage(null)
    }, 2000)
  }, [])

  const handleSaveDraft = useCallback(async () => {
    if (!selectedFile || !selectedFileKey || !selectedFileState || !activeCwd) return
    if (!canEditFile) return
    const draft = selectedFileState.draftContent
    if (draft === undefined || draft === selectedFileState.modifiedContent) return
    setIsSavingEdit(true)
    setEditMessage(null)
    try {
      const result = await window.electronAPI.git.saveFileContent(activeCwd, selectedFile.filename, draft)
      if (!result.success) {
        showEditMessage({ type: 'error', text: result.error || t('gitDiff.error.saveFailed') })
        return
      }
      // Suppress the upcoming file-watch 'changed' event triggered by our own
      // save. The main-process watcher already calls suppressNext on this path,
      // but timing is platform-dependent — this client-side window is a belt
      // and braces against races.
      selfSaveSuppressUntilRef.current = Date.now() + 800
      const originalContent = selectedFileState.originalContent ?? ''
      setFileContents((prev) => {
        const current = prev[selectedFileKey]
        if (!current) return prev
        return {
          ...prev,
          [selectedFileKey]: {
            ...current,
            modifiedContent: draft,
            draftContent: undefined
          }
        }
      })
      // Patch sidebar +/- stats locally — avoid the full loadDiff({force:true})
      // round-trip which otherwise re-builds diffResult, re-keys fileContents,
      // and causes the whole UI to flicker on save. VS Code-style minimal update.
      const { additions, deletions } = quickLineDiffStats(originalContent, draft)
      if (additions === 0 && deletions === 0) {
        // Save brought the file back to its original content — git no longer
        // considers it a change, so the entry should leave the sidebar. Let
        // the authoritative diff refresh remove it; our suppress window
        // continues to short-circuit the concurrent file-watcher path.
        await loadDiff({ silent: true, force: true })
      } else {
        setDiffResult((prev) => {
          if (!prev) return prev
          let mutated = false
          const files = prev.files.map((f) => {
            const key = buildFileKey(f.repoRoot || prev.cwd || '', f)
            if (key !== selectedFileKey) return f
            if (f.additions === additions && f.deletions === deletions) return f
            mutated = true
            return { ...f, additions, deletions }
          })
          return mutated ? { ...prev, files } : prev
        })
      }
      showEditMessage({ type: 'success', text: t('gitDiff.saved') })
    } catch (error) {
      showEditMessage({ type: 'error', text: t('gitDiff.error.saveFailedWithReason', { error: String(error) }) })
    } finally {
      setIsSavingEdit(false)
    }
  }, [
    selectedFile,
    selectedFileKey,
    selectedFileState,
    activeCwd,
    canEditFile,
    loadDiff,
    showEditMessage,
    t
  ])


  const handleKeep = useCallback(async () => {
    if (!selectedFile || !activeCwd) return
    const fileKey = getFileKey(selectedFile)
    setActionState({ type: 'keep', fileKey })
    setActionMessage(null)
    try {
      const result: GitFileActionResult = await window.electronAPI.git.stageFile(activeCwd, selectedFile.filename, selectedFile.repoRoot)
      if (!result.success) {
        setActionMessage({ type: 'error', text: result.error || t('gitDiff.error.stageFailed') })
      } else {
        const message = selectedFile.changeType === 'staged' ? t('gitDiff.action.keepStaged') : t('gitDiff.action.staged')
        setActionMessage({ type: 'success', text: message })
        await loadDiff({ force: true })
      }
    } catch (error) {
      setActionMessage({ type: 'error', text: t('gitDiff.error.stageFailedWithReason', { error: String(error) }) })
    } finally {
      setActionState((prev) => (prev?.fileKey === fileKey ? null : prev))
    }
  }, [selectedFile, activeCwd, getFileKey, loadDiff, t])

  const handleDeny = useCallback(async () => {
    if (!selectedFile || !activeCwd) return
    if (selectedFile.changeType === 'untracked') {
      const confirmed = window.confirm(t('gitDiff.confirm.deleteUntracked', { fileName: selectedFile.filename }))
      if (!confirmed) return
    }
    const fileKey = getFileKey(selectedFile)
    setActionState({ type: 'deny', fileKey })
    setActionMessage(null)
    try {
      const result: GitFileActionResult = await window.electronAPI.git.discardFile(activeCwd, {
        filename: selectedFile.filename,
        changeType: selectedFile.changeType,
        status: selectedFile.status,
        isSubmoduleEntry: selectedFile.isSubmoduleEntry
      }, selectedFile.repoRoot)
      if (!result.success) {
        setActionMessage({ type: 'error', text: result.error || t('gitDiff.error.discardFailed') })
      } else {
        const message = selectedFile.changeType === 'staged' ? t('gitDiff.action.unstaged') : t('gitDiff.action.discarded')
        setActionMessage({ type: 'success', text: message })
        await loadDiff({ force: true })
      }
    } catch (error) {
      setActionMessage({ type: 'error', text: t('gitDiff.error.discardFailedWithReason', { error: String(error) }) })
    } finally {
      setActionState((prev) => (prev?.fileKey === fileKey ? null : prev))
    }
  }, [selectedFile, activeCwd, getFileKey, loadDiff, t])

  useEffect(() => {
    if (editMessageTimerRef.current) {
      window.clearTimeout(editMessageTimerRef.current)
      editMessageTimerRef.current = 0
    }
    setEditMessage(null)
    setLineMessage(null)
  }, [selectedFileKey])

  useEffect(() => {
    if (isDraftDirty) {
      setSelectedLineRangeValue(null)
      originalDecorationsRef.current?.clear()
      modifiedDecorationsRef.current?.clear()
    }
  }, [isDraftDirty, setSelectedLineRangeValue])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (canSaveDraft) {
          e.preventDefault()
          handleSaveDraft()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [isOpen, canSaveDraft, handleSaveDraft])

  const requestClose = useCallback(() => {
    if (!isOpen) return
    if (!confirmCloseWithDraft()) return
    persistCurrentDiffSplitRatio()
    captureDiffView()
    detachDiffEditor()
    clearActiveDiffSelection()
    onClose()
  }, [captureDiffView, clearActiveDiffSelection, confirmCloseWithDraft, detachDiffEditor, isOpen, onClose, persistCurrentDiffSplitRatio])

  useEffect(() => {
    const handleCloseEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ terminalId?: string }>
      if (!customEvent.detail?.terminalId) return
      if (customEvent.detail.terminalId !== terminalId) return
      requestClose()
    }

    window.addEventListener('git-diff:close', handleCloseEvent as EventListener)
    return () => {
      window.removeEventListener('git-diff:close', handleCloseEvent as EventListener)
    }
  }, [requestClose, terminalId])

  const handleOpenHistory = useCallback(() => {
    if (!terminalId) return
    if (!confirmCloseWithDraft()) return
    persistCurrentDiffSplitRatio()
    captureDiffView()
    detachDiffEditor()
    setDiffRestoreNotice(null)
    const detail: SubpageNavigateEventDetail = { terminalId, target: 'history' }
    window.dispatchEvent(new CustomEvent('subpage:navigate', { detail }))
  }, [captureDiffView, confirmCloseWithDraft, detachDiffEditor, persistCurrentDiffSplitRatio, terminalId])

  const jumpToEditorDisabledReason = useMemo(() => {
    if (!selectedFile) return t('gitDiff.jumpToEditorDisabled.noFile')
    if (selectedFile.isSubmoduleEntry) return t('gitDiff.jumpToEditorDisabled.submodule')
    if (selectedFile.status === 'D') return t('gitDiff.jumpToEditorDisabled.deleted')
    return null
  }, [selectedFile, t])

  const handleOpenEditor = useCallback(() => {
    if (!terminalId) return
    if (jumpToEditorDisabledReason) return
    if (!confirmCloseWithDraft()) return
    const activeFile = selectedFileRef.current ?? selectedFile
    const detail: ProjectEditorOpenEventDetail = {
      terminalId,
      filePath: activeFile?.filename ?? null,
      repoRoot: activeFile?.repoRoot || diffResult?.cwd || activeCwd || null,
      source: 'diff',
      returnTarget: 'diff',
      diffFilePath: activeFile?.filename ?? null,
      diffRepoRoot: activeFile?.repoRoot || diffResult?.cwd || activeCwd || null
    }
    persistCurrentDiffSplitRatio()
    captureDiffView()
    detachDiffEditor()
    setDiffRestoreNotice(null)
    perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_JUMP_TO_EDITOR, {
      terminalId,
      cwd: activeCwd,
      filename: detail.filePath,
      repoRoot: detail.repoRoot
    })
    window.dispatchEvent(new CustomEvent<SubpageNavigateEventDetail>('subpage:navigate', {
      detail: {
        terminalId: detail.terminalId,
        target: 'editor',
        filePath: detail.filePath,
        repoRoot: detail.repoRoot,
        source: detail.source,
        returnTarget: detail.returnTarget,
        diffFilePath: detail.diffFilePath,
        diffRepoRoot: detail.diffRepoRoot
      }
    }))
  }, [
    activeCwd,
    captureDiffView,
    confirmCloseWithDraft,
    detachDiffEditor,
    diffResult?.cwd,
    jumpToEditorDisabledReason,
    persistCurrentDiffSplitRatio,
    selectedFile,
    terminalId
  ])

  const handleSelectSubpage = useCallback((target: SubpageId) => {
    if (target === 'editor') {
      // SubpageSwitcher is a view switch — let Editor restore its own state
      // rather than overriding it with the Diff's selected file.
      if (!terminalId) return
      if (!confirmCloseWithDraft()) return
      persistCurrentDiffSplitRatio()
      captureDiffView()
      detachDiffEditor()
      setDiffRestoreNotice(null)
      window.dispatchEvent(new CustomEvent<SubpageNavigateEventDetail>('subpage:navigate', {
        detail: { terminalId, target: 'editor' }
      }))
      return
    }
    if (target === 'history') {
      handleOpenHistory()
    }
  }, [captureDiffView, confirmCloseWithDraft, detachDiffEditor, handleOpenHistory, persistCurrentDiffSplitRatio, terminalId])

  useSubpageEscape({ isOpen, onEscape: requestClose })
  const lineSelectionInfo = useMemo<LineSelectionInfo | null>(
    () => resolveLineSelectionInfo(selectedLineRange, t('gitDiff.line.invalid.crossSide')),
    [selectedLineRange, t]
  )
  useEffect(() => {
    selectedLineRangeRef.current = selectedLineRange
    lineSelectionInfoRef.current = lineSelectionInfo
  }, [lineSelectionInfo, selectedLineRange])
  const lineActionStatus = useMemo(() => {
    if (!selectedLineRange) {
      return {
        hasSelection: false,
        valid: false,
        label: t('gitDiff.line.noneSelected')
      }
    }
    if (!lineSelectionInfo) {
      return {
        hasSelection: false,
        valid: false,
        label: t('gitDiff.line.noneSelected')
      }
    }
    if (!lineSelectionInfo.valid) {
      return {
        hasSelection: true,
        valid: false,
        label: lineSelectionInfo.message
      }
    }
    return {
      hasSelection: true,
      valid: true,
      label: t('gitDiff.line.selectedCount', { count: lineSelectionInfo.count })
    }
  }, [selectedLineRange, lineSelectionInfo, t])
  const runLineAction = useCallback(async (action: 'keep' | 'deny'): Promise<boolean> => {
    const currentLineSelectionInfo = lineSelectionInfoRef.current ?? lineSelectionInfo
    if (!selectedFile || !activeCwd || !selectedFileState) return false
    if (!currentLineSelectionInfo) return false
    if (!currentLineSelectionInfo.valid) {
      setLineMessage({ type: 'error', text: currentLineSelectionInfo.message })
      return false
    }
    if (selectedFile.changeType === 'untracked') {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.untracked') })
      return false
    }
    if (selectedFile.status === 'D') {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.deleted') })
      return false
    }
    if (selectedFileState.isBinary) {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.binary') })
      return false
    }

    if (selectedFile.changeType === 'staged' && action === 'keep') {
      setLineMessage({ type: 'success', text: t('gitDiff.line.action.keepStagedSelection') })
      clearLineSelection()
      return true
    }

    const fileKey = getFileKey(selectedFile)
    setLineActionState({ type: action, fileKey })
    setLineMessage(null)
    try {
      const baseContent = selectedFileState.originalContent
      const newContent = selectedFileState.modifiedContent
      let diff: FileDiffMetadata
      try {
        diff = parseDiffFromFile(
          { name: selectedFile.originalFilename || selectedFile.filename, contents: baseContent },
          { name: selectedFile.filename, contents: newContent }
        )
      } catch (error) {
        setLineMessage({ type: 'error', text: t('gitDiff.line.error.parseFailed', { error: String(error) }) })
        return false
      }

      const selectedLines = new Set<number>()
      for (let i = currentLineSelectionInfo.start; i <= currentLineSelectionInfo.end; i += 1) {
        selectedLines.add(i)
      }

      const applySelected = action === 'keep'
      const nextContent = buildContentWithSelection(
        diff,
        currentLineSelectionInfo.side,
        selectedLines,
        applySelected,
        baseContent,
        newContent
      )

      if (selectedFile.changeType === 'unstaged' && action === 'deny') {
        const saveResult = await window.electronAPI.git.saveFileContent(activeCwd, selectedFile.filename, nextContent)
        if (!saveResult.success) {
          setLineMessage({ type: 'error', text: saveResult.error || t('gitDiff.line.error.discardSelectionFailed') })
          return false
        }
        setLineMessage({ type: 'success', text: t('gitDiff.line.action.discardedSelection') })
        clearLineSelection()
        await loadDiff({ reset: true, force: true })
        return true
      }

      const updateResult = await window.electronAPI.git.updateIndexContent(activeCwd, selectedFile.filename, nextContent)
      if (!updateResult.success) {
        setLineMessage({ type: 'error', text: updateResult.error || t('gitDiff.line.error.updateIndexFailed') })
        return false
      }

      const message = selectedFile.changeType === 'staged'
        ? t('gitDiff.line.action.unstagedSelection')
        : t('gitDiff.line.action.stagedSelection')
      setLineMessage({ type: 'success', text: message })
      clearLineSelection()
      await loadDiff({ reset: true, force: true })
      return true
    } catch (error) {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.actionFailed', { error: String(error) }) })
      return false
    } finally {
      setLineActionState((prev) => (prev?.fileKey === fileKey ? null : prev))
    }
  }, [
    selectedFile,
    activeCwd,
    selectedFileState,
    lineSelectionInfo,
    getFileKey,
    loadDiff,
    clearLineSelection,
    t
  ])

  const runDiffHunkAction = useCallback(async (action: DiffHunkAction, range: DiffHunkActionRange): Promise<boolean> => {
    if (hunkActionInFlightRef.current) return false
    if (!selectedFile || !activeCwd || !selectedFileState) return false
    if (selectedFile.changeType === 'untracked' || selectedFile.status === 'D' || selectedFileState.isBinary) return false
    if (isDraftDirtyRef.current) return false
    const startedAt = performance.now()
    const fileKey = getFileKey(selectedFile)
    hunkActionInFlightRef.current = true
    setLineMessage(null)
    try {
      const baseContent = selectedFileState.originalContent
      const newContent = selectedFileState.modifiedContent
      let diff: FileDiffMetadata
      try {
        diff = parseDiffFromFile(
          { name: selectedFile.originalFilename || selectedFile.filename, contents: baseContent },
          { name: selectedFile.filename, contents: newContent }
        )
      } catch (error) {
        setLineMessage({ type: 'error', text: t('gitDiff.line.error.parseFailed', { error: String(error) }) })
        return false
      }

      if (selectedFile.changeType === 'unstaged' && action === 'revert') {
        const nextContent = buildContentWithChangeRange(diff, range, false, baseContent, newContent)
        const saveResult = await window.electronAPI.git.saveFileContent(activeCwd, selectedFile.filename, nextContent)
        if (!saveResult.success) {
          setLineMessage({ type: 'error', text: saveResult.error || t('gitDiff.line.error.discardSelectionFailed') })
          return false
        }
        setLineMessage({ type: 'success', text: t('gitDiff.hunk.action.reverted') })
      } else {
        const applySelected = selectedFile.changeType === 'staged' || action === 'unstage' ? false : true
        const nextContent = buildContentWithChangeRange(diff, range, applySelected, baseContent, newContent)
        const updateResult = await window.electronAPI.git.updateIndexContent(activeCwd, selectedFile.filename, nextContent)
        if (!updateResult.success) {
          setLineMessage({ type: 'error', text: updateResult.error || t('gitDiff.line.error.updateIndexFailed') })
          return false
        }
        setLineMessage({
          type: 'success',
          text: applySelected ? t('gitDiff.hunk.action.staged') : t('gitDiff.hunk.action.unstaged')
        })
      }

      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_HUNK_ACTION, {
        cwd: activeCwd,
        terminalId,
        fileKey,
        filename: selectedFile.filename,
        changeType: selectedFile.changeType,
        action,
        hunkIndex: range.index,
        result: 'success',
        durationMs: +(performance.now() - startedAt).toFixed(1)
      })
      await loadDiff({ reset: true, force: true })
      return true
    } catch (error) {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.actionFailed', { error: String(error) }) })
      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_HUNK_ACTION, {
        cwd: activeCwd,
        terminalId,
        fileKey,
        filename: selectedFile.filename,
        changeType: selectedFile.changeType,
        action,
        hunkIndex: range.index,
        result: 'exception',
        error: String(error),
        durationMs: +(performance.now() - startedAt).toFixed(1)
      })
      return false
    } finally {
      hunkActionInFlightRef.current = false
    }
  }, [activeCwd, getFileKey, loadDiff, selectedFile, selectedFileState, t, terminalId])

  useEffect(() => {
    runDiffHunkActionRef.current = runDiffHunkAction
  }, [runDiffHunkAction])

  const handleLineKeep = useCallback(() => {
    runLineAction('keep')
  }, [runLineAction])

  const handleLineDeny = useCallback(() => {
    runLineAction('deny')
  }, [runLineAction])
  const isActionPending = !!selectedFileKey && actionState?.fileKey === selectedFileKey
  const isKeepPending = isActionPending && actionState?.type === 'keep'
  const isDenyPending = isActionPending && actionState?.type === 'deny'
  const isLineActionPending = !!selectedFileKey && lineActionState?.fileKey === selectedFileKey
  const isLineKeepPending = isLineActionPending && lineActionState?.type === 'keep'
  const isLineDenyPending = isLineActionPending && lineActionState?.type === 'deny'
  const isImageVisualPreview = Boolean(selectedFileState?.isImage && (selectedFileState.isBinary || (selectedFileState.isSvg && svgViewMode === 'visual')))
  const canUseLineActions = !!selectedFile &&
    !!selectedFileState &&
    !selectedFileState.loading &&
    !selectedFileState.error &&
    !selectedFileState.isBinary &&
    (!selectedFile.repoRoot || selectedFile.repoRoot === diffResult?.cwd) &&
    !isDraftDirty &&
    selectedFile.changeType !== 'untracked' &&
    selectedFile.status !== 'D'
  const canShowLineActionPanel = Boolean(selectedFile && !isImageVisualPreview && !selectedFile.isSubmoduleEntry)
  const canShowFileActionPanel = Boolean(selectedFile)
  const canShowEditActionPanel = Boolean(!isImageVisualPreview && (isDraftDirty || editMessage))
  // Toggle visible only when the Monaco diff editor itself renders. Hides
  // for image / pdf / epub / submodule / binary / errored entries where
  // there is no Monaco viewport to switch.
  const canShowSplitModeToggle = Boolean(
    selectedFile
    && !selectedFile.isSubmoduleEntry
    && selectedFileState
    && !selectedFileState.error
    && !selectedFileState.isBinary
    && !selectedFileState.isSvg
    && !selectedFileState.isImage
    && !selectedFileState.isPdf
    && !selectedFileState.isEpub
  )
  const lineKeepLabel = selectedFile?.changeType === 'staged'
    ? t('gitDiff.line.keepStagedShort')
    : t('gitDiff.line.stageSelection')
  const lineDenyLabel = selectedFile?.changeType === 'staged'
    ? t('gitDiff.line.unstageSelection')
    : t('gitDiff.line.revertSelection')
  const fileKeepLabel = selectedFile?.changeType === 'staged'
    ? t('gitDiff.fileActions.keepStagedShort')
    : t('gitDiff.fileActions.stage')
  const fileDenyLabel = selectedFile?.changeType === 'staged'
    ? t('gitDiff.fileActions.unstage')
    : selectedFile?.changeType === 'untracked'
      ? t('gitDiff.fileActions.delete')
      : t('gitDiff.fileActions.discard')
  const diffFontSize = getTerminalStyle(terminalId)?.gitDiffFontSize ?? DEFAULT_GIT_DIFF_FONT_SIZE
  const diffEditorOptions = useMemo(() => ({
    splitViewDefaultRatio: diffSplitRatioRef.current,
    // Three-state view: 'split' forces side-by-side regardless of width;
    // 'inline' forces unified; 'auto' lets Monaco fall back to inline when
    // the container is below DIFF_INLINE_BREAKPOINT. The breakpoint and
    // useInlineViewWhenSpaceIsLimited are only honoured in 'auto' mode.
    renderSideBySide: splitViewMode !== 'inline',
    renderSideBySideInlineBreakpoint: splitViewMode === 'auto' ? DIFF_INLINE_BREAKPOINT : undefined,
    useInlineViewWhenSpaceIsLimited: splitViewMode === 'auto',
    enableSplitViewResizing: true,
    // Kill Monaco's built-in DiffEditorHunkToolbar arrow (the mysterious "->"
    // icon between panes). We render our own per-hunk Stage / Revert toolbar
    // instead, see installDiffHunkActionWidgets.
    renderGutterMenu: false,
    readOnly: !canEditFile,
    originalEditable: false,
    minimap: { enabled: false },
    wordWrap: 'on' as const,
    diffWordWrap: 'on' as const,
    fontFamily: PIERRE_LIKE_MONACO_FONT,
    fontSize: diffFontSize,
    lineHeight: Math.round(diffFontSize * 1.5),
    renderIndicators: true,
    renderMarginRevertIcon: false,
    diffAlgorithm: 'advanced' as const,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    hideUnchangedRegions: {
      enabled: true,
      minimumLineCount: 3,
      contextLineCount: 3,
      revealLineCount: 20
    }
  }), [diffFontSize, canEditFile, splitViewMode])

  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    if (!isOpen) {
      if ((window as any).__onwardGitDiffDebugTerminalId === terminalId) {
        delete (window as any).__onwardGitDiffDebug
        delete (window as any).__onwardGitDiffDebugTerminalId
      }
      return
    }
    const api: GitDiffDebugApi = {
      isOpen: () => isOpenRef.current,
      getFileList: () => diffResultRef.current?.files ?? [],
      getVisibleFileList: () => visibleFileListRef.current,
      getFileListViewMode: () => fileListViewMode,
      setFileListViewMode: (mode: GitDiffFileListViewMode) => {
        if (!isGitDiffFileListViewMode(mode)) return false
        setFileListViewMode(mode)
        return true
      },
      getVisibleTreeRows: () => {
        const rows: Array<{ type: 'dir' | 'file'; path: string; depth: number; name: string }> = []
        const walk = (nodes: DiffFileTreeNode[], depth: number) => {
          for (const node of nodes) {
            rows.push({ type: node.type, path: node.path, depth, name: node.name })
            if (node.type === 'dir' && !collapsedDiffTreeDirs.has(node.key)) {
              walk(node.children ?? [], depth + 1)
            }
          }
        }
        walk(buildDiffFileTree(visibleFileListRef.current, 'debug'), 0)
        return rows
      },
      getRepoList: () => diffResultRef.current?.repos ?? [],
      getVisibleRepoItems: () => visibleRepoItemsRef.current,
      setRepoExpanded,
      setRepoFilter: updateRepoFilter,
      getSelectedFile: () => {
        const file = selectedFileRef.current
        return file ? {
          filename: file.filename,
          originalFilename: file.originalFilename,
          status: file.status,
          changeType: file.changeType
        } : null
      },
      selectFileByPath: (path: string) => {
        const files = diffResultRef.current?.files ?? []
        const target = files.find((file) =>
          file.filename === path || file.originalFilename === path
        )
        if (target) {
          handleFileSelect(target)
          return true
        }
        return false
      },
      selectFileByIndex: (index: number) => {
        const files = diffResultRef.current?.files ?? []
        const target = files[index]
        if (target) {
          handleFileSelect(target)
          return true
        }
        return false
      },
      isSelectedReady: () => {
        const file = selectedFileRef.current
        const key = file ? getFileKey(file) : null
        if (!key) return false
        const state = fileContentsRef.current[key]
        return Boolean(state && !state.loading && !state.error && !state.isBinary)
      },
      getSelectedFileContent: () => {
        const file = selectedFileRef.current
        const key = file ? getFileKey(file) : null
        if (!key) return null
        const state = fileContentsRef.current[key]
        if (!state) return null
        return {
          originalContent: state.originalContent ?? null,
          modifiedContent: state.modifiedContent ?? null,
          draftContent: state.draftContent ?? null,
          isBinary: Boolean(state.isBinary),
          loading: Boolean(state.loading),
          error: state.error ?? null
        }
      },
      getCachedFileContentByPath: (path: string, changeType?: GitFileStatus['changeType']) => {
        const files = diffResultRef.current?.files ?? []
        const file = files.find((candidate) =>
          (candidate.filename === path || candidate.originalFilename === path) &&
          (!changeType || candidate.changeType === changeType)
        )
        const key = file ? getFileKey(file) : null
        if (!file || !key) return null
        const state = fileContentsRef.current[key]
        if (!state) return null
        return {
          filename: file.filename,
          changeType: file.changeType,
          originalContent: state.originalContent ?? null,
          modifiedContent: state.modifiedContent ?? null,
          draftContent: state.draftContent ?? null,
          isBinary: Boolean(state.isBinary),
          loading: Boolean(state.loading),
          error: state.error ?? null
        }
      },
      // Renderer prefetch is a lightweight thin layer over the main-side
      // content cache (see comment near the prefetch useEffect). This
      // selector returns its progress so the staleness autotest's
      // GDS-32 (first-selection-uses-prefetched-body-cache) check passes.
      getPrefetchState: () => ({ ...rendererPrefetchSnapshotRef.current }),
      getLastClickLatency: () => clickLatencyTrackerRef.current.getLast(),
      getLastClickLatencyForFile: (fileKey: string) =>
        clickLatencyTrackerRef.current.getLastForFile(fileKey),
      getClickLatencyHistory: () => clickLatencyTrackerRef.current.getHistory(),
      resetClickLatencyHistory: () => clickLatencyTrackerRef.current.reset(),
      setSelectedDraftContent: (content: string) => {
        const file = selectedFileRef.current
        const key = file ? getFileKey(file) : null
        if (!key) return false
        const current = fileContentsRef.current[key]
        if (!current) return false
        const nextDraft = content === current.modifiedContent ? undefined : content
        const next = {
          ...fileContentsRef.current,
          [key]: {
            ...current,
            draftContent: nextDraft
          }
        }
        fileContentsRef.current = next
        setFileContents(next)
        setEditMessage(null)
        return true
      },
      getIsDraftDirty: () => isDraftDirtyRef.current,
      getRestoreNotice: () => diffRestoreNotice,
      getScrollTop: () => diffEditorRef.current?.getModifiedEditor().getScrollTop() ?? 0,
      getFirstVisibleLine: () => {
        const editor = diffEditorRef.current
        if (!editor) return 0
        const file = selectedFileRef.current
        const fileKey = file ? getFileKey(file) : null
        const restoredAnchor = fileKey ? restoredAnchorRef.current[fileKey] : null
        const currentScrollTop = editor.getModifiedEditor().getScrollTop()
        if (restoredAnchor?.line && Math.abs(currentScrollTop - restoredAnchor.scrollTop) <= SCROLL_RESTORE_TOLERANCE) {
          return restoredAnchor.line
        }
        const ranges = editor.getModifiedEditor().getVisibleRanges()
        return ranges.length > 0 ? ranges[0].startLineNumber : 0
      },
      scrollToFraction: (fraction: number) => {
        const editor = diffEditorRef.current
        if (!editor) return false
        const modifiedEditor = editor.getModifiedEditor()
        const scrollHeight = modifiedEditor.getScrollHeight()
        const clientHeight = modifiedEditor.getLayoutInfo().height
        const max = Math.max(0, scrollHeight - clientHeight)
        const next = Math.max(0, Math.min(max, max * Math.max(0, Math.min(1, fraction))))
        modifiedEditor.setScrollTop(next)
        window.requestAnimationFrame(() => {
          if (!isDraftDirtyRef.current) {
            captureDiffView()
          }
        })
        return true
      },
      scrollToLine: (line: number) => {
        const editor = diffEditorRef.current
        if (!editor) return false
        editor.getModifiedEditor().revealLineNearTop(line)
        window.requestAnimationFrame(() => {
          if (!isDraftDirtyRef.current) {
            captureDiffView()
          }
        })
        return true
      },
      getDiffFontSize: () => getTerminalStyle(terminalId)?.gitDiffFontSize ?? DEFAULT_GIT_DIFF_FONT_SIZE,
      getCwd: () => activeCwd || null,
      getRepoRoot: () => diffResult?.cwd || null,
      isSubmodulesLoading: () => Boolean(diffResult?.submodulesLoading),
      getTiming: () => {
        const timing = timingRef.current
        return {
          openRequestedAt: timing.openRequestedAt,
          shellShownAt: timing.shellShownAt,
          cwdReadyAt: timing.cwdReadyAt,
          diffLoadedAt: timing.diffLoadedAt,
          openToShellMs: timing.openRequestedAt !== null && timing.shellShownAt !== null
            ? Math.round(timing.shellShownAt - timing.openRequestedAt)
            : null,
          openToCwdReadyMs: timing.openRequestedAt !== null && timing.cwdReadyAt !== null
            ? Math.round(timing.cwdReadyAt - timing.openRequestedAt)
            : null,
          openToDiffLoadedMs: timing.openRequestedAt !== null && timing.diffLoadedAt !== null
            ? Math.round(timing.diffLoadedAt - timing.openRequestedAt)
            : null,
          cwdReadyToDiffLoadedMs: timing.cwdReadyAt !== null && timing.diffLoadedAt !== null
            ? Math.round(timing.diffLoadedAt - timing.cwdReadyAt)
            : null
        }
      },
      getLoadState: () => ({
        inFlight: loadInFlightRef.current,
        queued: loadQueuedRef.current
          ? {
              reset: Boolean(loadQueuedRef.current.reset),
              silent: Boolean(loadQueuedRef.current.silent),
              force: Boolean(loadQueuedRef.current.force)
            }
          : null,
        hasDiffResult: Boolean(diffResultRef.current),
        fileCount: diffResultRef.current?.files?.length ?? null,
        submodulesLoading: Boolean(diffResultRef.current?.submodulesLoading),
        hasLastDiff: Boolean(lastDiffRef.current),
        lastDiffAgeMs: lastDiffRef.current ? Date.now() - lastDiffRef.current.at : null
      }),
      getSplitViewState: () => measureDiffSplitState(),
      getDiffNavigationState: () => ({
        changeCount: diffEditorRef.current?.getLineChanges()?.length ?? 0,
        currentIndex: diffNavigationIndexRef.current
      }),
      getResponsiveLayoutState: () => {
        const editor = diffEditorRef.current
        const container = editor?.getContainerDomNode() ?? null
        return {
          mode: editor ? getDiffLayoutMode(editor) : null,
          containerWidth: container ? Math.round(container.getBoundingClientRect().width) : null,
          inlineBreakpoint: DIFF_INLINE_BREAKPOINT,
          useInlineViewWhenSpaceIsLimited: true
        }
      },
      setSplitViewRatio: (ratio: number) => {
        if (!Number.isFinite(ratio)) return false
        const editor = diffEditorRef.current
        if (!editor) return false
        const normalized = persistDiffSplitRatio(ratio)
        editor.updateOptions({ splitViewDefaultRatio: normalized })
        return true
      },
      setFileListWidth: (width: number) => {
        if (!Number.isFinite(width)) return false
        const normalized = Math.max(MIN_FILE_LIST_WIDTH, Math.min(MAX_FILE_LIST_WIDTH, Math.round(width)))
        setFileListWidth(normalized)
        localStorage.setItem(STORAGE_KEY_FILE_LIST_WIDTH, String(normalized))
        updateUIPreferences({ gitDiffFileListWidth: normalized })
        window.requestAnimationFrame(() => {
          diffEditorRef.current?.layout()
        })
        return true
      },
      dragSplitViewRatio: async (ratio: number) => dragDiffSplitRatio(ratio),
      navigateDiffChange: (direction: 'previous' | 'next') => navigateDiffChange(direction),
      refreshChanges: async () => refreshChanges(),
      getTermsPopoverOpen: () => termsPopoverOpen,
      toggleTermsPopover: () => {
        setTermsPopoverOpen((prev) => !prev)
        return true
      },
      getHunkActionWidgetCount: () => {
        return Math.max(
          document.querySelectorAll('.git-diff-hunk-actions').length,
          diffHunkActionDisposablesRef.current.length
        )
      },
      getHunkActionDebugState: () => {
        const editor = diffEditorRef.current
        const file = selectedFileRef.current
        const key = file ? getFileKey(file) : null
        const state = key ? fileContentsRef.current[key] : null
        return {
          hasEditor: Boolean(editor),
          hasMonaco: Boolean(monacoRef.current),
          selectedFile: file
            ? { filename: file.filename, changeType: file.changeType, status: file.status }
            : null,
          selectedFileKey: key,
          hasState: Boolean(state),
          loading: state ? Boolean(state.loading) : null,
          error: state?.error ?? null,
          isBinary: state ? Boolean(state.isBinary) : null,
          isDraftDirty: isDraftDirtyRef.current,
          lineChanges: editor?.getLineChanges()?.length ?? 0,
          widgetDomCount: document.querySelectorAll('.git-diff-hunk-actions').length,
          visibleWidgetDomCount: document.querySelectorAll('.git-diff-hunk-actions.is-visible').length,
          widgetDisposableCount: diffHunkActionDisposablesRef.current.length
        }
      },
      revealFirstHunkActionForTest: () => {
        // Toolbars are always visible now; this helper just ensures the
        // install ran and the first widget exists.
        let first = diffHunkActionWidgetHandlesRef.current[0]
        if (!first) {
          const editor = diffEditorRef.current
          const monaco = monacoRef.current
          if (editor && monaco) {
            installDiffHunkActionWidgets(editor, monaco)
            first = diffHunkActionWidgetHandlesRef.current[0]
          }
        }
        return Boolean(first)
      },
      hideHunkActionsForTest: () => {
        // No-op — toolbars are no longer hover-revealed. Kept for autotest
        // backwards compatibility; intentionally does nothing.
      },
      triggerFirstHunkAction: async (action: DiffHunkAction) => {
        const editor = diffEditorRef.current
        const changes = editor?.getLineChanges() ?? []
        const first = changes[0]
        if (!first) return false
        return await runDiffHunkAction(action, {
          id: `debug:0:${first.originalStartLineNumber}-${first.originalEndLineNumber}:${first.modifiedStartLineNumber}-${first.modifiedEndLineNumber}`,
          index: 0,
          originalStartLineNumber: first.originalStartLineNumber,
          originalEndLineNumber: first.originalEndLineNumber,
          modifiedStartLineNumber: first.modifiedStartLineNumber,
          modifiedEndLineNumber: first.modifiedEndLineNumber
        })
      },
      setSelectedLineRangeForTest: (start: number, end: number, side: SelectionSide = 'additions') => {
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false
        if (side !== 'additions' && side !== 'deletions') return false
        const editor = diffEditorRef.current
        const targetEditor = side === 'deletions' ? editor?.getOriginalEditor() : editor?.getModifiedEditor()
        const lineCount = targetEditor?.getModel()?.getLineCount() ?? 0
        if (!targetEditor || lineCount <= 0) return false
        const normalizedStart = Math.max(1, Math.min(Math.floor(Math.min(start, end)), lineCount))
        const normalizedEnd = Math.max(normalizedStart, Math.min(Math.floor(Math.max(start, end)), lineCount))
        const decorations: monacoTypes.editor.IModelDeltaDecoration[] = []
        for (let line = normalizedStart; line <= normalizedEnd; line += 1) {
          decorations.push({
            range: {
              startLineNumber: line,
              startColumn: 1,
              endLineNumber: line,
              endColumn: 1
            },
            options: {
              isWholeLine: true,
              className: 'git-diff-selected-line'
            }
          })
        }
        if (side === 'deletions') {
          modifiedDecorationsRef.current?.clear()
          originalDecorationsRef.current = targetEditor.createDecorationsCollection(decorations)
        } else {
          originalDecorationsRef.current?.clear()
          modifiedDecorationsRef.current = targetEditor.createDecorationsCollection(decorations)
        }
        setSelectedLineRangeValue({
          start: normalizedStart,
          end: normalizedEnd,
          side,
          endSide: side
        })
        return true
      },
      triggerLineAction: async (action: 'keep' | 'deny') => {
        return await runLineAction(action)
      },
      getImagePreviewState: () => {
        const file = selectedFileRef.current
        const key = file ? getFileKey(file) : null
        if (!key) return null
        const state = fileContentsRef.current[key]
        if (!state) return null
        return {
          isImage: Boolean(state.isImage),
          isSvg: Boolean(state.isSvg),
          isBinary: state.isBinary,
          hasOriginalUrl: Boolean(state.originalImageUrl),
          hasModifiedUrl: Boolean(state.modifiedImageUrl),
          compareMode: imageCompareMode,
          displayMode: imageDisplayMode,
          loading: state.loading
        }
      },
      getFileActionState: () => {
        if (!selectedFile) return null
        return {
          fileActionsVisible: canShowFileActionPanel,
          lineActionsVisible: canShowLineActionPanel,
          keepDisabled: !selectedFileState || selectedFileState.loading || isActionPending || isDraftDirty,
          denyDisabled: !selectedFileState || selectedFileState.loading || isActionPending || isDraftDirty,
          pending: isActionPending,
          toolbarVisible: Boolean(document.querySelector('.git-diff-action-bar')),
          actionPanelVisible: Boolean(document.querySelector('.git-diff-action-panel')),
          visibleLabels: Array.from(document.querySelectorAll('.git-diff-action-button-label'))
            .map((node) => (node.textContent ?? '').trim())
            .filter(Boolean)
        }
      },
      triggerFileAction: async (action: 'keep' | 'deny') => {
        if (!selectedFile) return false
        if (action === 'keep') {
          await handleKeep()
          return true
        }
        await handleDeny()
        return true
      },
      getPdfCompareState: () => inspectPdfCompareDom(),
      getEpubCompareState: () => inspectEpubCompareDom()
    }
    ;(window as any).__onwardGitDiffDebug = api
    ;(window as any).__onwardGitDiffDebugTerminalId = terminalId
    return () => {
      if ((window as any).__onwardGitDiffDebug === api) {
        delete (window as any).__onwardGitDiffDebug
        delete (window as any).__onwardGitDiffDebugTerminalId
      }
    }
  }, [
    activeCwd,
    diffRestoreNotice,
    diffResult,
    visibleFileList,
    visibleRepoItems,
    dragDiffSplitRatio,
    getFileKey,
    measureDiffSplitState,
    collapsedDiffTreeDirs,
    fileListViewMode,
    handleDeny,
    handleFileSelect,
    handleKeep,
    imageCompareMode,
    imageDisplayMode,
    installDiffHunkActionWidgets,
    isActionPending,
    isDraftDirty,
    isOpen,
    canShowFileActionPanel,
    canShowLineActionPanel,
    navigateDiffChange,
    persistDiffSplitRatio,
    refreshChanges,
    runDiffHunkAction,
    runLineAction,
    setFileListViewMode,
    setRepoExpanded,
    selectedFile,
    selectedFileKey,
    selectedFileState,
    terminalId,
    termsPopoverOpen,
    updateUIPreferences,
    updateRepoFilter
  ])

  // Make sure the readOnly switch takes effect immediately
  useEffect(() => {
    diffEditorRef.current?.getModifiedEditor().updateOptions({ readOnly: !canEditFile })
  }, [canEditFile])

  // Ensure diffWordWrap and split-view mode are always synced to the live
  // DiffEditor instance. Monaco's @monaco-editor/react wrapper calls
  // updateOptions when the options prop changes, but a few fields need to be
  // pushed explicitly to defeat staleness on rapid toggles.
  useEffect(() => {
    const editor = diffEditorRef.current
    if (!editor) return
    editor.updateOptions({
      diffWordWrap: 'on',
      renderSideBySide: splitViewMode !== 'inline',
      renderSideBySideInlineBreakpoint: splitViewMode === 'auto' ? DIFF_INLINE_BREAKPOINT : undefined,
      useInlineViewWhenSpaceIsLimited: splitViewMode === 'auto'
    } as any)
  }, [diffEditorOptions, splitViewMode])

  const language = useMemo(() => {
    return resolveMonacoLanguageId(selectedFile?.filename)
  }, [selectedFile])

  const originalModelPath = useMemo(() => {
    if (!selectedFile) return undefined
    const repoSegment = hashString(selectedFile.repoRoot || activeCwd || 'repo')
    const originalPath = (selectedFile.originalFilename || selectedFile.filename)
      .split('/')
      .map(encodeURIComponent)
      .join('/')
    return `inmemory://model/onward-git-diff/${repoSegment}/original/${originalPath}`
  }, [activeCwd, selectedFile])

  const modifiedModelPath = useMemo(() => {
    if (!selectedFile) return undefined
    const repoSegment = hashString(selectedFile.repoRoot || activeCwd || 'repo')
    const filePath = selectedFile.filename
      .split('/')
      .map(encodeURIComponent)
      .join('/')
    return `inmemory://model/onward-git-diff/${repoSegment}/modified/${filePath}`
  }, [activeCwd, selectedFile])

  const diffView = useMemo(() => {
    if (DEBUG_GIT_DIFF) {
      perfCountersRef.current.diffViewBuild += 1
    }
    if (!selectedFile || !selectedFileState) return null
    if (selectedFileState.error || selectedFileState.isBinary || selectedFileState.isSvg) return null
    return (
      <DiffEditor
        original={selectedFileState.originalContent}
        modified={effectiveModifiedContent}
        language={language}
        originalModelPath={originalModelPath}
        modifiedModelPath={modifiedModelPath}
        keepCurrentOriginalModel={true}
        keepCurrentModifiedModel={true}
        theme={PIERRE_LIKE_MONACO_THEME}
        beforeMount={ensurePierreLikeMonacoTheme}
        options={diffEditorOptions}
        onMount={handleEditorDidMount}
        className="git-diff-monaco"
        height="100%"
      />
    )
  }, [selectedFile, selectedFileState, language, diffEditorOptions, effectiveModifiedContent, handleEditorDidMount, modifiedModelPath, originalModelPath])

  const fileGroups = useMemo(() => {
    const groups: Record<GitFileStatus['changeType'], GitFileStatus[]> = {
      unstaged: [],
      staged: [],
      untracked: [],
      conflict: []
    }
    visibleFileList.forEach((file) => {
      groups[file.changeType].push(file)
    })
    return groups
  }, [visibleFileList])

  const groupedFileList = useMemo(() => {
    const groups = [
      { key: 'conflict', label: t('gitDiff.changeType.conflict'), files: fileGroups.conflict },
      { key: 'unstaged', label: t('gitDiff.changeType.unstaged'), files: fileGroups.unstaged },
      { key: 'staged', label: t('gitDiff.changeType.staged'), files: fileGroups.staged },
      { key: 'untracked', label: t('gitDiff.changeType.untracked'), files: fileGroups.untracked }
    ]
    return groups.filter(group => group.files.length > 0)
  }, [fileGroups, t])

  // Multi-repo layout: group by project first, then by change type. Keeps the
  // sidebar readable when several repos (e.g. submodules) share the workspace
  // instead of squeezing a truncated repo badge onto every file row.
  const repoSections = useMemo(() => {
    if (!hasMultipleRepos || !diffResult) return null
    type Section = {
      repoRoot: string
      repoLabel: string
      isSubmodule: boolean
      depth: number
      conflict: GitFileStatus[]
      unstaged: GitFileStatus[]
      staged: GitFileStatus[]
      untracked: GitFileStatus[]
    }
    const map = new Map<string, Section>()
    const ensureSection = (root: string, label: string, isSubmodule: boolean, depth: number) => {
      const existing = map.get(root)
      if (existing) return existing
      const section: Section = {
        repoRoot: root,
        repoLabel: label,
        isSubmodule,
        depth,
        conflict: [],
        unstaged: [],
        staged: [],
        untracked: []
      }
      map.set(root, section)
      return section
    }
    for (const repo of diffResult.repos ?? []) {
      ensureSection(repo.root, repo.label, repo.isSubmodule, repo.depth)
    }
    const fallbackCwd = diffResult.cwd || ''
    for (const file of diffResult.files) {
      if (repoFilter && file.repoRoot !== repoFilter) continue
      const root = file.repoRoot || fallbackCwd
      const label = file.repoLabel || root.split('/').pop() || root
      const section = ensureSection(root, label, Boolean(file.isSubmoduleEntry), 0)
      section[file.changeType].push(file)
    }
    return Array.from(map.values())
      .map((section) => ({
        repoRoot: section.repoRoot,
        repoLabel: section.repoLabel,
        isSubmodule: section.isSubmodule,
        depth: section.depth,
        totalCount: section.conflict.length + section.unstaged.length + section.staged.length + section.untracked.length,
        groups: [
          { key: 'conflict', label: t('gitDiff.changeType.conflict'), files: section.conflict },
          { key: 'unstaged', label: t('gitDiff.changeType.unstaged'), files: section.unstaged },
          { key: 'staged', label: t('gitDiff.changeType.staged'), files: section.staged },
          { key: 'untracked', label: t('gitDiff.changeType.untracked'), files: section.untracked }
        ].filter((group) => group.files.length > 0)
      }))
      .filter((section) => section.totalCount > 0)
      .sort((a, b) => {
        if (a.isSubmodule !== b.isSubmodule) return a.isSubmodule ? 1 : -1
        if (a.depth !== b.depth) return a.depth - b.depth
        return a.repoLabel.localeCompare(b.repoLabel)
      })
  }, [diffResult, hasMultipleRepos, repoFilter, t])

  useEffect(() => {
    if (!repoFilter || !selectedFile) return
    if (selectedFile.repoRoot === repoFilter) return
    clearActiveDiffSelection({ detachEditor: true })
  }, [clearActiveDiffSelection, repoFilter, selectedFile])

  useEffect(() => {
    if (!DEBUG_GIT_DIFF) return
    if (perfIntervalRef.current) return
    perfIntervalRef.current = window.setInterval(() => {
      const snapshot = { ...perfCountersRef.current }
      perfCountersRef.current.renders = 0
      perfCountersRef.current.loadDiff = 0
      perfCountersRef.current.diffViewBuild = 0
      const hasActivity = Object.values(snapshot).some(count => count > 0)
      if (hasActivity) {
        debugLog('perf:1s', {
          ...snapshot,
          selectedFile: selectedFileRef.current?.filename ?? null,
          cwd: activeCwd ?? null
        })
      }
    }, 1000)
    return () => {
      if (perfIntervalRef.current) {
        window.clearInterval(perfIntervalRef.current)
        perfIntervalRef.current = null
      }
    }
  }, [activeCwd])

  // Render Git not installed prompt
  const renderGitNotInstalled = () => (
    <div className="git-diff-not-installed">
      <div className="git-diff-warning-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 9v4M12 17h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            stroke="#e2c08d"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h3 className="git-diff-warning-title">{t('gitDiff.warning.gitMissing.title')}</h3>
      <p className="git-diff-warning-text">{t('gitDiff.warning.gitMissing.message')}</p>
      <div className="git-diff-install-guide">
        <p className="git-diff-guide-title">{t('gitDiff.installGuide')}</p>
        <ul className="git-diff-guide-list">
          <li><code>macOS:</code> brew install git</li>
          <li><code>Linux:</code> sudo apt install git</li>
          <li><code>Windows:</code> <a href="https://git-scm.com/download/win" target="_blank" rel="noopener noreferrer">https://git-scm.com/download/win</a></li>
        </ul>
      </div>
      <button className="git-diff-close-btn" onClick={requestClose}>
        {t('gitDiff.returnToTerminal')}
      </button>
    </div>
  )

  const renderSvgDiffEditor = useCallback((fileState: FileContentState) => {
    return (
      <div className="git-diff-editor-container">
        <DiffEditor
          key={`svg-text-${selectedFileKey || 'empty'}::${diffEditorResetNonce}`}
          original={fileState.originalContent}
          modified={effectiveModifiedContent}
          language="xml"
          theme="vs-dark"
          options={diffEditorOptions}
          onMount={handleEditorDidMount}
          className="git-diff-monaco"
          height="100%"
        />
      </div>
    )
  }, [diffEditorOptions, effectiveModifiedContent, handleEditorDidMount, selectedFileKey, diffEditorResetNonce])

  const renderImagePreview = useCallback((fileState: FileContentState, file: GitFileStatus) => {
    const status = file.status === 'A' || file.status === '?'
      ? 'added'
      : file.status === 'D'
        ? 'deleted'
        : 'modified'
    return (
      <GitImagePreview
        fileState={fileState as GitImagePreviewFileState}
        status={status}
        labels={{
          statusAdded: t('gitDiff.image.status.added'),
          statusDeleted: t('gitDiff.image.status.deleted'),
          statusModified: t('gitDiff.image.status.modified'),
          svg: t('gitDiff.image.svg'),
          viewVisual: t('gitDiff.image.view.visual'),
          viewText: t('gitDiff.image.view.text'),
          compareTwoUp: t('gitDiff.image.compare.twoUp'),
          compareSwipe: t('gitDiff.image.compare.swipe'),
          compareOnion: t('gitDiff.image.compare.onion'),
          displayOriginal: t('gitDiff.image.display.original'),
          displayFit: t('gitDiff.image.display.fit'),
          labelOriginal: t('gitDiff.image.label.original'),
          labelAdded: t('gitDiff.image.label.added'),
          labelModified: t('gitDiff.image.label.modified'),
          opacity: t('gitDiff.image.opacity')
        }}
        imageDisplayMode={imageDisplayMode}
        imageCompareMode={imageCompareMode}
        svgViewMode={svgViewMode}
        onImageDisplayModeChange={toggleImageDisplayMode}
        onImageCompareModeChange={toggleImageCompareMode}
        onSvgViewModeChange={setSvgViewMode}
        renderSvgDiffEditor={(state) => renderSvgDiffEditor(state as FileContentState)}
      />
    )
  }, [
    imageCompareMode,
    imageDisplayMode,
    renderSvgDiffEditor,
    t,
    toggleImageCompareMode,
    toggleImageDisplayMode,
    svgViewMode
  ])

  // Render non-Git repository prompts
  const renderNotGitRepo = () => (
    <div className="git-diff-not-installed">
      <div className="git-diff-warning-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 9v4M12 17h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            stroke="#858585"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h3 className="git-diff-warning-title">{t('gitDiff.warning.notRepo.title')}</h3>
      <p className="git-diff-warning-text">{diffResult?.error || t('gitDiff.warning.notRepo.message')}</p>
      <p className="git-diff-cwd">{diffResult?.cwd}</p>
      <button className="git-diff-close-btn" onClick={requestClose}>
        {t('gitDiff.returnToTerminal')}
      </button>
    </div>
  )

  // Rendering without change prompt
  const renderNoChanges = () => (
    <div className="git-diff-not-installed">
      <div className="git-diff-warning-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <path
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            stroke="#89d185"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h3 className="git-diff-warning-title">{t('gitDiff.warning.noChanges.title')}</h3>
      <p className="git-diff-warning-text">{t('gitDiff.warning.noChanges.message')}</p>
      <p className="git-diff-cwd">{diffResult?.cwd}</p>
      <button className="git-diff-close-btn" onClick={requestClose}>
        {t('gitDiff.returnToTerminal')}
      </button>
    </div>
  )

  const renderDiffDetail = () => {
    if (!selectedFile) {
      return (
        <div className="git-diff-no-selection">
          {t('gitDiff.selectFile')}
        </div>
      )
    }

    const fileState = selectedFileState
    const headerTitle = selectedFile.originalFilename && (selectedFile.status === 'R' || selectedFile.status === 'C')
      ? `${selectedFile.originalFilename} → ${selectedFile.filename}`
      : selectedFile.filename
    return (
      <>
        {diffRestoreNotice && (
          <div className="git-diff-restore-banner">
            <div className="git-diff-restore-text">
              {diffRestoreNotice.message}
            </div>
            <div className="git-diff-restore-actions">
              <button
                className="git-diff-restore-btn primary"
                onClick={() => {
                  scrollToFirstChange()
                }}
              >
                {t('gitDiff.restore.jumpToChange')}
              </button>
              <button
                className="git-diff-restore-btn"
                onClick={() => {
                  scrollToTop()
                }}
              >
                {t('gitDiff.restore.backToTop')}
              </button>
              <button
                className="git-diff-restore-btn ghost"
                onClick={() => setDiffRestoreNotice(null)}
              >
                {t('gitDiff.restore.close')}
              </button>
            </div>
          </div>
        )}
        <div className="git-diff-detail-header">
          <div className="git-diff-detail-info">
            <span
              className="git-diff-file-status"
              style={{ color: statusColors[selectedFile.status] }}
            >
              [{statusText[selectedFile.status]}]
            </span>
            {selectedFile.isSubmoduleEntry && (
              <span className="git-diff-submodule-badge" title={t('gitDiff.status.submodule')}>S</span>
            )}
            <span className="git-diff-change-type">
              {changeTypeText[selectedFile.changeType]}
            </span>
            <span
              className="git-diff-detail-filename"
              title={t('gitDiff.filenameCopyHint')}
              onDoubleClick={handleFilenameDblClick}
            >
              {headerTitle}
            </span>
            {isDraftDirty && (
              <span className="git-diff-file-dirty">{t('gitDiff.unsaved')}</span>
            )}
            {copyMessage && (
              <span className={`path-copy-toast ${copyMessage.type}`}>
                {copyMessage.text}
              </span>
            )}
          </div>
          {(canShowLineActionPanel || canShowFileActionPanel || canShowEditActionPanel) && (
            <div className="git-diff-detail-actions-row">
              {canShowLineActionPanel && (
                <div className="git-diff-action-bar" aria-label={t('gitDiff.line.title')}>
                  <span className={`git-diff-line-count ${lineActionStatus.valid ? '' : 'invalid'}`}>
                    {lineActionStatus.label}
                  </span>
                  {lineMessage && (
                    <span className={`git-diff-toast-message ${lineMessage.type}`}>
                      {lineMessage.text}
                    </span>
                  )}
                  <div className="git-diff-action-button-group">
                    <button
                      className="git-diff-action-button success git-diff-line-keep-btn"
                      onClick={handleLineKeep}
                      disabled={!canUseLineActions || !lineActionStatus.valid || isLineActionPending}
                      title={t('gitDiff.line.keepTitle')}
                    >
                      <StageActionIcon />
                      <span className="git-diff-action-button-label">
                        {isLineKeepPending ? t('gitDiff.processing') : lineKeepLabel}
                      </span>
                    </button>
                    <button
                      className="git-diff-action-button danger git-diff-line-deny-btn"
                      onClick={handleLineDeny}
                      disabled={!canUseLineActions || !lineActionStatus.valid || isLineActionPending}
                      title={t('gitDiff.line.denyTitle')}
                    >
                      <DiscardActionIcon />
                      <span className="git-diff-action-button-label">
                        {isLineDenyPending ? t('gitDiff.processing') : lineDenyLabel}
                      </span>
                    </button>
                    <button
                      className="git-diff-action-button neutral git-diff-line-clear-btn"
                      onClick={clearLineSelection}
                      disabled={!lineActionStatus.hasSelection || isLineActionPending}
                      title={t('gitDiff.line.clear')}
                    >
                      <ClearActionIcon />
                      <span className="git-diff-action-button-label">{t('gitDiff.line.clear')}</span>
                    </button>
                  </div>
                </div>
              )}
              {canShowFileActionPanel && (
                <div className="git-diff-action-bar" aria-label={t('gitDiff.fileActions.title')}>
                  {actionMessage && (
                    <span className={`git-diff-toast-message ${actionMessage.type}`}>
                      {actionMessage.text}
                    </span>
                  )}
                  <div className="git-diff-action-button-group">
                    <button
                      className="git-diff-action-button success git-diff-keep-btn"
                      onClick={handleKeep}
                      disabled={!selectedFileState || selectedFileState.loading || isActionPending || isDraftDirty}
                      title={selectedFile.changeType === 'staged' ? t('gitDiff.fileActions.keepStagedTitle') : t('gitDiff.fileActions.keepTitle')}
                    >
                      <StageActionIcon />
                      <span className="git-diff-action-button-label">
                        {isKeepPending ? t('gitDiff.processing') : fileKeepLabel}
                      </span>
                    </button>
                    <button
                      className="git-diff-action-button danger git-diff-deny-btn"
                      onClick={handleDeny}
                      disabled={!selectedFileState || selectedFileState.loading || isActionPending || isDraftDirty}
                      title={selectedFile.changeType === 'staged' ? t('gitDiff.fileActions.unstageTitle') : t('gitDiff.fileActions.denyTitle')}
                    >
                      <DiscardActionIcon />
                      <span className="git-diff-action-button-label">
                        {isDenyPending ? t('gitDiff.processing') : fileDenyLabel}
                      </span>
                    </button>
                  </div>
                </div>
              )}
              {canShowEditActionPanel && (
                <div className="git-diff-action-bar" aria-label={t('gitDiff.fileActions.editTitle')}>
                  {editMessage && (
                    <span className={`git-diff-toast-message ${editMessage.type}`}>
                      {editMessage.text}
                    </span>
                  )}
                  {isDraftDirty && (
                    <span className="git-diff-unsaved">{t('gitDiff.unsaved')}</span>
                  )}
                  {isDraftDirty && (
                    <div className="git-diff-action-button-group">
                      <button
                        className="git-diff-action-button primary git-diff-save-btn"
                        onClick={handleSaveDraft}
                        disabled={!canSaveDraft}
                      >
                        <SaveActionIcon />
                        <span className="git-diff-action-button-label">
                          {isSavingEdit ? t('gitDiff.saving') : t('gitDiff.saveFile')}
                        </span>
                      </button>
                      <button
                        className="git-diff-action-button neutral git-diff-discard-btn"
                        onClick={discardDraft}
                        disabled={!isDraftDirty || isSavingEdit}
                      >
                        <ClearActionIcon />
                        <span className="git-diff-action-button-label">{t('gitDiff.discardDraft')}</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className={`git-diff-detail-content${diffRevealPhase !== 'idle' ? ` diff-phase-${diffRevealPhase}` : ''}`}>
          {(!fileState || fileState.loading) && (
            <div className="git-diff-loading">
              <div className="git-diff-loading-dots" aria-hidden="true"><span /><span /><span /></div>
              <span>{t('gitDiff.loadingFile')}</span>
            </div>
          )}
          {fileState && !fileState.loading && fileState.error && (
            <div className="git-diff-no-content">
              {fileState.error}
            </div>
          )}
          {fileState && !fileState.loading && !fileState.error && fileState.isImage && (fileState.isBinary || fileState.isSvg) && (
            renderImagePreview(fileState, selectedFile)
          )}
          {fileState && !fileState.loading && !fileState.error && fileState.isPdf && (
            <GitPdfCompare
              status={
                (selectedFile?.status === 'A' || selectedFile?.status === '?') ? 'added'
                  : selectedFile?.status === 'D' ? 'deleted'
                    : 'modified' as GitPdfStatus
              }
              originalPreviewData={fileState.originalPreviewData}
              modifiedPreviewData={fileState.modifiedPreviewData}
              originalSize={fileState.originalPreviewSize}
              modifiedSize={fileState.modifiedPreviewSize}
              filename={selectedFile?.filename ?? ''}
              viewerUrl={pdfViewerUrl}
              labels={{
                statusAdded: t('gitDiff.pdfCompare.statusAdded'),
                statusDeleted: t('gitDiff.pdfCompare.statusDeleted'),
                statusModified: t('gitDiff.pdfCompare.statusModified'),
                labelOriginal: t('gitDiff.pdfCompare.labelOriginal'),
                labelAdded: t('gitDiff.pdfCompare.labelAdded'),
                labelModified: t('gitDiff.pdfCompare.labelModified'),
                noOriginal: t('gitDiff.pdfCompare.noOriginal'),
                noModified: t('gitDiff.pdfCompare.noModified')
              }}
            />
          )}
          {fileState && !fileState.loading && !fileState.error && fileState.isEpub && (
            <GitEpubCompare
              status={
                (selectedFile?.status === 'A' || selectedFile?.status === '?') ? 'added'
                  : selectedFile?.status === 'D' ? 'deleted'
                    : 'modified' as GitEpubStatus
              }
              originalPreviewData={fileState.originalPreviewData}
              modifiedPreviewData={fileState.modifiedPreviewData}
              originalSize={fileState.originalPreviewSize}
              modifiedSize={fileState.modifiedPreviewSize}
              filename={selectedFile?.filename ?? ''}
              labels={{
                statusAdded: t('gitDiff.epubCompare.statusAdded'),
                statusDeleted: t('gitDiff.epubCompare.statusDeleted'),
                statusModified: t('gitDiff.epubCompare.statusModified'),
                chapterAdded: t('gitDiff.epubCompare.chapterAdded'),
                chapterDeleted: t('gitDiff.epubCompare.chapterDeleted'),
                chapterModified: t('gitDiff.epubCompare.chapterModified'),
                chapterUnchanged: t('gitDiff.epubCompare.chapterUnchanged'),
                labelOriginal: t('gitDiff.epubCompare.labelOriginal'),
                labelModified: t('gitDiff.epubCompare.labelModified'),
                noOriginal: t('gitDiff.epubCompare.noOriginal'),
                noModified: t('gitDiff.epubCompare.noModified'),
                loading: t('gitDiff.epubCompare.loading'),
                error: t('gitDiff.epubCompare.error'),
                chapters: t('gitDiff.epubCompare.chapters'),
                resources: t('gitDiff.epubCompare.resources'),
                noResourceChanges: t('gitDiff.epubCompare.noResourceChanges'),
                resourceAdded: t('gitDiff.epubCompare.resourceAdded'),
                resourceDeleted: t('gitDiff.epubCompare.resourceDeleted'),
                resourceModified: t('gitDiff.epubCompare.resourceModified')
              }}
            />
          )}
          {fileState && !fileState.loading && !fileState.error && fileState.isBinary && !fileState.isImage && !fileState.isPdf && !fileState.isEpub && (
            <div className="git-diff-no-content">
              {t('gitDiff.binaryUnsupported')}
            </div>
          )}
          {fileState && !fileState.loading && !fileState.error && !fileState.isBinary && !fileState.isSvg && (
            <div className="git-diff-editor-container">
              {diffView}
            </div>
          )}
        </div>
      </>
    )
  }

  const renderLoadingShell = (message: string, repoContexts?: GitRepoContext[]) => {
    const loadingRepos = [...(repoContexts ?? [])]
      .filter((repo) => repo.isSubmodule || repo.loading)
      .sort(sortRepoContexts)

    return (
      <div className="git-diff-main git-diff-main-loading">
        <div className="git-diff-file-list" style={{ width: fileListWidth }}>
          {loadingRepos.length > 0 && (
            <div className="git-diff-repo-filter">
              <div className="git-diff-repo-filter-item active loading">
                <span className="git-diff-repo-filter-label">{t('gitDiff.repo.all')}</span>
                <span className="git-diff-repo-filter-count loading">...</span>
              </div>
              {loadingRepos.map((repo) => (
                <div
                  key={repo.root}
                  className="git-diff-repo-filter-item loading"
                  title={repo.root}
                >
                  <span className="git-diff-repo-filter-label">{repo.label}</span>
                  <span className="git-diff-repo-filter-count loading">...</span>
                </div>
              ))}
            </div>
          )}
          <div className="git-diff-file-list-header">
            {t('gitDiff.fileList', { count: 0 })}
          </div>
          <div className="git-diff-file-list-content git-diff-file-list-content-loading">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={`git-diff-skeleton-${index}`}
                className={`git-diff-file-skeleton${index % 3 === 0 ? ' short' : index % 3 === 1 ? ' medium' : ''}`}
              >
                <span className="git-diff-file-skeleton-status" />
                <span className="git-diff-file-skeleton-line" />
                <span className="git-diff-file-skeleton-stats" />
              </div>
            ))}
          </div>
          <div className="git-diff-resizer" />
        </div>

        <div className="git-diff-detail git-diff-detail-loading">
          <div className="git-diff-loading">
            <div className="git-diff-loading-dots" aria-hidden="true"><span /><span /><span /></div>
            <span>{message}</span>
          </div>
        </div>
      </div>
    )
  }

  // Main content rendering
  const renderContent = () => {
    if (!diffResult) {
      return renderLoadingShell(t('gitDiff.loading'))
    }

    if (!diffResult.gitInstalled) {
      return renderGitNotInstalled()
    }

    if (!diffResult.isGitRepo) {
      return renderNotGitRepo()
    }

    if (diffResult.success && diffResult.files.length === 0 && diffResult.submodulesLoading) {
      return renderLoadingShell(t('gitDiff.loadingSubmodules'), diffResult.repos)
    }

    if (!diffResult.success || diffResult.files.length === 0) {
      return renderNoChanges()
    }

    const filteredFileCount = visibleFileList.length

    return (
      <div className="git-diff-main">
        <div className="git-diff-file-list" style={{ width: fileListWidth }}>
          {diffResult.superprojectRoot && (
            <div
              className="git-diff-superproject-hint"
              onClick={() => {
                void loadDiffFromRoot(diffResult.superprojectRoot!)
              }}
            >
              <span>{t('gitDiff.repo.inSubmodule')}</span>
              <span style={{ color: 'var(--accent)', cursor: 'pointer' }}>{t('gitDiff.repo.viewParent')}</span>
            </div>
          )}
          {diffResult.submodulesLoading && (
            <div className="git-diff-loading" style={{ minHeight: 'auto', justifyContent: 'flex-start', padding: '8px 12px', gap: '8px' }}>
              <div className="git-diff-loading-dots" aria-hidden="true"><span /><span /><span /></div>
              <span>{t('gitDiff.loadingSubmodules')}</span>
            </div>
          )}
          {hasMultipleRepos && diffResult.repos && (
            <div className="git-diff-repo-filter">
              <div
                className={`git-diff-repo-filter-item${repoFilter === null ? ' active' : ''}`}
                onClick={() => updateRepoFilter(null)}
              >
                <span className="git-diff-repo-filter-label">{t('gitDiff.repo.all')}</span>
                <span className="git-diff-repo-filter-count">{diffResult.files.length}</span>
              </div>
              {visibleRepoItems.map((repo) => {
                const canSelectRepo = !repo.loading && repo.changeCount > 0
                return (
                  <div
                    key={repo.root}
                    className={`git-diff-repo-filter-item${repoFilter === repo.root ? ' active' : ''}${repo.loading ? ' loading' : ''}`}
                    style={{ paddingLeft: `${12 + (repo.treeDepth * 14)}px` }}
                    onClick={() => {
                      if (canSelectRepo) {
                        updateRepoFilter(repo.root)
                      }
                    }}
                    title={repo.root}
                  >
                    <button
                      type="button"
                      className={`git-diff-repo-toggle${repo.hasChildren ? '' : ' hidden'}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleRepoExpanded(repo.root)
                      }}
                      aria-label={repo.expanded ? t('gitDiff.repo.collapse') : t('gitDiff.repo.expand')}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d={repo.expanded ? 'M4 6l4 4 4-4H4z' : 'M6 4l4 4-4 4V4z'} />
                      </svg>
                    </button>
                    <span className="git-diff-repo-filter-label">{repo.displayLabel}</span>
                    <span className={`git-diff-repo-filter-count${repo.loading ? ' loading' : ''}`}>
                      {repo.loading ? '...' : repo.changeCount}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          <div className="git-diff-file-list-header">
            <span className="git-diff-file-list-title">{t('gitDiff.fileList', { count: filteredFileCount })}</span>
            <div className="git-diff-file-list-view-toggle" role="group" aria-label={t('gitDiff.fileListViewMode')}>
              <button
                type="button"
                className={`git-diff-view-mode-button${fileListViewMode === 'tree' ? ' active' : ''}`}
                onClick={() => setFileListViewMode('tree')}
                aria-pressed={fileListViewMode === 'tree'}
                title={t('gitDiff.fileListView.treeTitle')}
              >
                <TreeViewIcon />
                <span>{t('gitDiff.fileListView.tree')}</span>
              </button>
              <button
                type="button"
                className={`git-diff-view-mode-button${fileListViewMode === 'flat' ? ' active' : ''}`}
                onClick={() => setFileListViewMode('flat')}
                aria-pressed={fileListViewMode === 'flat'}
                title={t('gitDiff.fileListView.flatTitle')}
              >
                <FlatViewIcon />
                <span>{t('gitDiff.fileListView.flat')}</span>
              </button>
            </div>
          </div>
          <div className="git-diff-file-list-content">
            {(() => {
              const renderFileItem = (file: GitFileStatus, options?: { depth?: number; treeLeafName?: string }) => {
                const fileKey = diffResult?.cwd ? buildFileKey(file.repoRoot || diffResult.cwd, file) : file.filename
                const isSelected = selectedFileKey === fileKey
                const fileState = fileContents[fileKey]
                const isDirty = fileState?.draftContent !== undefined &&
                  fileState.draftContent !== fileState.modifiedContent
                const depth = options?.depth ?? 0
                const setiFile = resolveSetiFileIcon(options?.treeLeafName ?? file.filename)
                return (
                  <div
                    key={fileKey}
                    className={`git-diff-file-item ${options ? 'tree-leaf ' : ''}${isSelected ? 'selected' : ''}`}
                    style={options ? { paddingLeft: `${12 + depth * 14}px` } : undefined}
                    onClick={() => handleFileSelect(file)}
                    onContextMenu={(e) => handleFileContextMenu(e, file)}
                  >
                    {options && <span className="git-diff-tree-spacer" />}
                    {options && (
                      <span
                        className="git-diff-tree-icon file git-diff-tree-seti-icon"
                        style={{ color: setiFile.color }}
                        // eslint-disable-next-line react/no-danger -- SVG from MIT seti-icons (VS Code Seti family); sanitized with DOMPurify
                        dangerouslySetInnerHTML={{ __html: sanitizeSetiSvgOnce(setiFile.svg) }}
                      />
                    )}
                    <span
                      className="git-diff-file-status"
                      style={{ color: statusColors[file.status] }}
                      title={statusText[file.status]}
                    >
                      {file.status}
                    </span>
                    {file.isSubmoduleEntry && (
                      <span
                        className="git-diff-submodule-badge"
                        title={t('gitDiff.status.submodule')}
                      >
                        S
                      </span>
                    )}
                    <span
                      className="git-diff-file-name"
                      title={file.originalFilename && (file.status === 'R' || file.status === 'C')
                        ? `${file.originalFilename} → ${file.filename}`
                        : file.filename}
                    >
                    {options?.treeLeafName ?? file.filename}
                    </span>
                    {isDirty && (
                      <span className="git-diff-file-dirty">{t('gitDiff.unsaved')}</span>
                    )}
                    <span className="git-diff-file-stats">
                      {file.additions > 0 && (
                        <span className="git-diff-stat-add">+{file.additions}</span>
                      )}
                      {file.deletions > 0 && (
                        <span className="git-diff-stat-del">-{file.deletions}</span>
                      )}
                    </span>
                  </div>
                )
              }
              const renderTreeNode = (node: DiffFileTreeNode, depth: number): JSX.Element => {
                if (node.type === 'file' && node.file) {
                  return renderFileItem(node.file, { depth, treeLeafName: node.name }) as JSX.Element
                }
                const isCollapsed = collapsedDiffTreeDirs.has(node.key)
                const isExpanded = !isCollapsed
                return (
                  <div key={node.key} className="git-diff-tree-node">
                    <div
                      className="git-diff-tree-item dir"
                      style={{ paddingLeft: `${12 + depth * 14}px` }}
                      onClick={() => {
                        setCollapsedDiffTreeDirs((prev) => {
                          const next = new Set(prev)
                          if (next.has(node.key)) next.delete(node.key)
                          else next.add(node.key)
                          return next
                        })
                      }}
                    >
                      <span className={`git-diff-tree-toggle ${isExpanded ? 'open' : ''}`}>
                        <svg viewBox="0 0 10 10" fill="currentColor" aria-hidden={true}>
                          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                      <span className="git-diff-tree-icon dir">
                        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden={true}>
                          <path d="M1.75 3a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h12.5a.75.75 0 0 0 .75-.75V5.5a.75.75 0 0 0-.75-.75H7.5a.75.75 0 0 1-.53-.22l-.97-.97A.75.75 0 0 0 5.47 3H1.75Z" />
                        </svg>
                      </span>
                      <span className="git-diff-tree-name" title={node.path}>{node.name}</span>
                      <span className="git-diff-tree-count">{node.count}</span>
                    </div>
                    {isExpanded && node.children?.map((child) => renderTreeNode(child, depth + 1))}
                  </div>
                )
              }
              const renderGroup = (group: { key: string; label: string; files: GitFileStatus[] }) => (
                <div key={group.key} className="git-diff-file-group">
                  <div className="git-diff-file-group-title">
                    {group.label} ({group.files.length})
                  </div>
                  {fileListViewMode === 'tree'
                    ? buildDiffFileTree(group.files, `${diffResult.cwd || activeCwd || ''}::${group.key}`).map((node) => renderTreeNode(node, 0))
                    : group.files.map((file) => renderFileItem(file))}
                </div>
              )
              if (repoSections) {
                return repoSections.map((section) => (
                  <div key={section.repoRoot} className="git-diff-repo-section">
                    <div className="git-diff-repo-header" title={section.repoRoot}>
                      <span className="git-diff-repo-name">{section.repoLabel}</span>
                      <span className="git-diff-repo-count">{section.totalCount}</span>
                    </div>
                    {section.groups.map((group) => (
                      <div key={group.key} className="git-diff-file-group">
                        <div className="git-diff-file-group-title">
                          {group.label} ({group.files.length})
                        </div>
                        {fileListViewMode === 'tree'
                          ? buildDiffFileTree(group.files, `${section.repoRoot}::${group.key}`).map((node) => renderTreeNode(node, 0))
                          : group.files.map((file) => renderFileItem(file))}
                      </div>
                    ))}
                  </div>
                ))
              }
              return groupedFileList.map(renderGroup)
            })()}
          </div>

          {/* Width adjustment drag bar */}
          <div
            className="git-diff-resizer"
            onMouseDown={handleResizeMouseDown}
          />
        </div>

        {/* Diff content */}
        <div className="git-diff-detail">
          {renderDiffDetail()}
        </div>
      </div>
    )
  }

  // Top-row header actions (next to the diff title): just the Terms info
  // popover and an optional Return-to-Terminal close button. Diff-session
  // actions (split mode, hunk navigation, jump-to-editor, refresh) live in
  // the working-directory bar instead — see renderCwdBarActions.
  const renderTopHeaderActions = useCallback((includeClose: boolean) => (
    <>
      <div className="git-diff-terms-help">
        <SubpagePanelButton
          className="git-diff-terms-button"
          onClick={() => setTermsPopoverOpen((prev) => !prev)}
          title={t('gitDiff.terms.buttonTitle')}
          aria-expanded={termsPopoverOpen}
        >
          <InfoActionIcon />
          <span>{t('gitDiff.terms.button')}</span>
        </SubpagePanelButton>
        {termsPopoverOpen && (
          <div className="git-diff-terms-popover" role="dialog" aria-label={t('gitDiff.terms.title')}>
            <div className="git-diff-terms-title">{t('gitDiff.terms.title')}</div>
            <dl>
              <dt>{t('gitDiff.terms.changes.title')}</dt>
              <dd>{t('gitDiff.terms.changes.description')}</dd>
              <dt>{t('gitDiff.terms.staged.title')}</dt>
              <dd>{t('gitDiff.terms.staged.description')}</dd>
              <dt>{t('gitDiff.terms.untracked.title')}</dt>
              <dd>{t('gitDiff.terms.untracked.description')}</dd>
              <dt>{t('gitDiff.terms.uncommitted.title')}</dt>
              <dd>{t('gitDiff.terms.uncommitted.description')}</dd>
            </dl>
          </div>
        )}
      </div>
      {includeClose && (
        <SubpagePanelButton className="git-diff-close" onClick={requestClose} title={t('gitDiff.returnToTerminal')}>
          {t('gitDiff.returnToTerminal')}
        </SubpagePanelButton>
      )}
    </>
  ), [requestClose, t, termsPopoverOpen])

  // Working-directory bar action cluster: view-mode toggle, hunk navigation,
  // jump-to-editor, refresh-changes. These are diff-session actions (apply
  // to the whole diff, not a specific file) so they live alongside the cwd
  // path rather than in either the top title bar or the per-file detail row.
  const renderCwdBarActions = useCallback(() => (
    <>
      {canShowSplitModeToggle && (
        <div
          className="git-diff-split-mode-toggle"
          role="group"
          aria-label={t('gitDiff.viewMode.label')}
          data-testid="git-diff-split-mode-toggle"
        >
          <button
            type="button"
            className={`git-diff-split-mode-button${splitViewMode === 'auto' ? ' active' : ''}`}
            onClick={() => setSplitViewMode('auto')}
            aria-pressed={splitViewMode === 'auto'}
            title={t('gitDiff.viewMode.autoTitle')}
            data-mode="auto"
          >
            {t('gitDiff.viewMode.auto')}
          </button>
          <button
            type="button"
            className={`git-diff-split-mode-button${splitViewMode === 'split' ? ' active' : ''}`}
            onClick={() => setSplitViewMode('split')}
            aria-pressed={splitViewMode === 'split'}
            title={t('gitDiff.viewMode.splitTitle')}
            data-mode="split"
          >
            {t('gitDiff.viewMode.split')}
          </button>
          <button
            type="button"
            className={`git-diff-split-mode-button${splitViewMode === 'inline' ? ' active' : ''}`}
            onClick={() => setSplitViewMode('inline')}
            aria-pressed={splitViewMode === 'inline'}
            title={t('gitDiff.viewMode.inlineTitle')}
            data-mode="inline"
          >
            {t('gitDiff.viewMode.inline')}
          </button>
        </div>
      )}
      <div className="git-diff-change-nav" aria-label={t('gitDiff.nav.changeNavigation')}>
        <SubpagePanelButton
          className="git-diff-nav-button"
          onClick={() => navigateDiffChange('previous')}
          title={t('gitDiff.nav.previousChange')}
          aria-label={t('gitDiff.nav.previousChange')}
        >
          <span aria-hidden="true">↑</span>
        </SubpagePanelButton>
        <SubpagePanelButton
          className="git-diff-nav-button"
          onClick={() => navigateDiffChange('next')}
          title={t('gitDiff.nav.nextChange')}
          aria-label={t('gitDiff.nav.nextChange')}
        >
          <span aria-hidden="true">↓</span>
        </SubpagePanelButton>
      </div>
      <SubpagePanelButton
        className="git-diff-jump-editor"
        onClick={handleOpenEditor}
        disabled={Boolean(jumpToEditorDisabledReason)}
        title={jumpToEditorDisabledReason ?? t('gitDiff.jumpToEditorTitle')}
      >
        <JumpToEditorIcon />
        <span>{t('gitDiff.jumpToEditor')}</span>
      </SubpagePanelButton>
      <SubpagePanelButton
        className="git-diff-refresh-changes"
        onClick={() => {
          void refreshChanges()
        }}
        disabled={isRefreshingChanges || cwdPending}
        title={t('gitDiff.refreshChangesTitle')}
      >
        <RefreshActionIcon />
        <span>{isRefreshingChanges ? t('gitDiff.refreshingChanges') : t('gitDiff.refreshChanges')}</span>
      </SubpagePanelButton>
    </>
  ), [
    canShowSplitModeToggle,
    cwdPending,
    handleOpenEditor,
    isRefreshingChanges,
    jumpToEditorDisabledReason,
    navigateDiffChange,
    refreshChanges,
    setSplitViewMode,
    splitViewMode,
    t
  ])

  const overlayClassName = `git-diff-overlay ${isPanel ? 'panel' : ''}`
  const modalClassName = `git-diff-modal ${isPanel ? 'panel' : ''}`
  const modalStyle = isPanel ? { width: '100%', height: '100%' } : { width: modalSize.width, height: modalSize.height }
  const displayedCwd = diffResult?.cwd || (!cwdPending ? cwd : null)
  const displayedWorkingDirectory = displayedCwd && (!diffResult || diffResult.isGitRepo) ? displayedCwd : null
  const useSharedPanelHeader = isPanel && panelShellMode === 'internal'
  const keepMountedInPanel = isPanel
  const {
    title: cwdTitle,
    onDoubleClick: handleCwdDblClick,
    feedback: cwdFeedback
  } = useCwdCopyHandler(displayedWorkingDirectory, t, 'gitDiff.copyFailed')
  const externalPanelActions = useMemo(() => renderTopHeaderActions(true), [renderTopHeaderActions])
  const externalPanelMetaExtra = useMemo(() => renderCwdBarActions(), [renderCwdBarActions])
  const externalPanelShellState = useMemo<SubpagePanelShellState>(() => ({
    current: 'diff',
    onSelect: handleSelectSubpage,
    workingDirectoryLabel: t('gitDiff.workingDirectory'),
    workingDirectoryPath: displayedWorkingDirectory,
    workingDirectoryTitle: cwdTitle,
    onWorkingDirectoryDoubleClick: handleCwdDblClick,
    workingDirectoryFeedback: cwdFeedback,
    actions: externalPanelActions,
    metaExtra: externalPanelMetaExtra,
    taskTitle
  }), [cwdFeedback, cwdTitle, displayedWorkingDirectory, externalPanelActions, externalPanelMetaExtra, handleCwdDblClick, handleSelectSubpage, t, taskTitle])

  useLayoutEffect(() => {
    if (!isPanel || panelShellMode !== 'external' || !onPanelShellStateChange) return
    if (!isOpen) {
      onPanelShellStateChange(null)
      return
    }
    onPanelShellStateChange(externalPanelShellState)
    return () => {
      onPanelShellStateChange(null)
    }
  }, [
    externalPanelShellState,
    isOpen,
    isPanel,
    onPanelShellStateChange,
    panelShellMode
  ])

  if (!isOpen && !keepMountedInPanel) return null

  return (
    <div
      className={`${overlayClassName} ${isOpen ? 'is-open' : 'is-hidden'}`}
      onClick={isPanel ? undefined : requestClose}
      aria-hidden={!isOpen}
    >
      <div
        className={modalClassName}
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {!isPanel && (
          <>
            {/* Pop-up window size adjustment handle */}
            <div className="git-diff-modal-resize-n" onMouseDown={(e) => handleModalResizeMouseDown(e, 'n')} />
            <div className="git-diff-modal-resize-s" onMouseDown={(e) => handleModalResizeMouseDown(e, 's')} />
            <div className="git-diff-modal-resize-e" onMouseDown={(e) => handleModalResizeMouseDown(e, 'e')} />
            <div className="git-diff-modal-resize-w" onMouseDown={(e) => handleModalResizeMouseDown(e, 'w')} />
            <div className="git-diff-modal-resize-ne" onMouseDown={(e) => handleModalResizeMouseDown(e, 'ne')} />
            <div className="git-diff-modal-resize-nw" onMouseDown={(e) => handleModalResizeMouseDown(e, 'nw')} />
            <div className="git-diff-modal-resize-se" onMouseDown={(e) => handleModalResizeMouseDown(e, 'se')} />
            <div className="git-diff-modal-resize-sw" onMouseDown={(e) => handleModalResizeMouseDown(e, 'sw')} />
          </>
        )}

        {(() => {
          const debugPanel = (
            <GitDiffDebugPanel
              tracker={clickLatencyTrackerRef.current}
              cwd={activeCwd ?? ''}
              terminalId={terminalId}
              collapsed={debugPanelCollapsed}
              onToggleCollapsed={handleDebugPanelToggle}
            />
          )
          return useSharedPanelHeader ? (
            <SubpagePanelShell
              current="diff"
              onSelect={handleSelectSubpage}
              workingDirectoryLabel={t('gitDiff.workingDirectory')}
              workingDirectoryPath={displayedWorkingDirectory}
              workingDirectoryTitle={cwdTitle}
              onWorkingDirectoryDoubleClick={handleCwdDblClick}
              workingDirectoryFeedback={cwdFeedback}
              taskTitle={taskTitle}
              actions={renderTopHeaderActions(true)}
              metaExtra={renderCwdBarActions()}
            >
              {debugPanel}
              <div className="git-diff-body">
                {renderContent()}
              </div>
            </SubpagePanelShell>
          ) : panelShellMode === 'external' && isPanel ? (
            <>
              {debugPanel}
              <div className="git-diff-body">
                {renderContent()}
              </div>
            </>
          ) : (
          <>
            {/* Header */}
            <div className="git-diff-header">
              <div className="git-diff-header-main">
                <h2 className="git-diff-title">
                  <span className="git-diff-title-main">{t('gitDiff.title')}</span>
                  {taskTitle ? (
                    <span className="git-diff-task-label subpage-task-source" title={taskTitle}>
                      <span className="subpage-task-source-name">{taskTitle}</span>
                    </span>
                  ) : null}
                </h2>
                <SubpageSwitcher current="diff" onSelect={handleSelectSubpage} />
              </div>
              <div className="git-diff-header-actions">
                {renderTopHeaderActions(true)}
              </div>
            </div>

            {/* working directory + diff-session actions */}
            <div
              className="git-diff-cwd-bar"
              onDoubleClick={displayedWorkingDirectory ? handleCwdDblClick : undefined}
              title={displayedWorkingDirectory ? cwdTitle : undefined}
            >
              {displayedWorkingDirectory ? (
                <>
                  <span className="git-diff-cwd-label">{t('gitDiff.workingDirectory')}</span>
                  <span className="git-diff-cwd-path">{displayedWorkingDirectory}</span>
                  {cwdFeedback}
                </>
              ) : <span className="git-diff-cwd-path" />}
              <div className="git-diff-cwd-bar-actions">
                {renderCwdBarActions()}
              </div>
            </div>

            {/* Performance diagnostics panel (always visible) */}
            {debugPanel}

            {/* Body */}
            <div className="git-diff-body">
              {renderContent()}
            </div>
          </>
          )
        })()}

        {/* right click menu */}
        {contextMenu && (
          <div
            className="git-diff-context-menu"
            style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="git-diff-context-item"
              onClick={() => void copyContextMenuPath(contextMenu.targetFile, 'name')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1h-11zM5 5.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1H8.5v7a.5.5 0 0 1-1 0V6H5.5a.5.5 0 0 1-.5-.5z" /></svg>
              <span>{t('common.copyName')}</span>
            </button>
            <button
              className="git-diff-context-item"
              onClick={() => void copyContextMenuPath(contextMenu.targetFile, 'relative')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><circle cx="5" cy="11.5" r="1" /><path d="M7 10a.5.5 0 0 1 .354.146l2 2a.5.5 0 0 1-.708.708L7 11.207l-1.646 1.647a.5.5 0 0 1-.708-.708l2-2A.5.5 0 0 1 7 10z" /></svg>
              <span>{t('common.copyRelativePath')}</span>
            </button>
            <button
              className="git-diff-context-item"
              onClick={() => void copyContextMenuPath(contextMenu.targetFile, 'absolute')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><path d="M8.5 9a.5.5 0 0 0-.894-.447l-2 4a.5.5 0 1 0 .894.447l2-4z" /></svg>
              <span>{t('common.copyAbsolutePath')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
