/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, ipcMain, BrowserWindow, Menu, dialog, shell, clipboard } from 'electron'
import { join, resolve, sep } from 'path'
import { readFileSync, statSync, writeFileSync } from 'fs'
import { ptyManager, PtyOptions } from './pty-manager'
import { GitWatchManager } from './git-watch-manager'
import { getPromptStorage, Prompt } from './prompt-storage'
import { getTerminalConfigStorage, TerminalWindowConfig } from './terminal-config-storage'
import { getCommandPresetStorage, CommandPreset } from './command-preset-storage'
import { getCodingAgentConfigStorage, CodingAgentConfigInput } from './coding-agent-config-storage'
import { getCodingAgentRuntimeInfo } from './coding-agent-runtime'
import { getAppStateStorage, AppState } from './app-state-storage'
import { readCurrentChangelog } from './changelog'
import { getTelemetryService } from './telemetry/telemetry-service'
import { getTelemetryConsent, setTelemetryConsent } from './telemetry/telemetry-consent'
import { getTerminalCwd, getTerminalGitInfo } from './git-utils'
import type { GitFileStatus, GitHistoryDiffOptions, GitHistoryFileContentOptions } from './git-utils'
import { gitIpcWorkerClient } from './git-ipc-worker-client'
import {
  readProjectFile,
  resolveInRoot,
  saveProjectFile,
  createProjectFile,
  createProjectFolder,
  renameProjectPath,
  deleteProjectPath,
} from './project-editor-utils'
import { projectFsWorkerClient } from './project-fs-worker-client'
import { sqliteWorkerClient } from './sqlite-worker-client'
import { getSettingsStorage, SettingsState, ShortcutConfig } from './settings-storage'
import { getShortcutManager } from './shortcut-manager'
import { getAppInfo } from './app-info'
import { getFeedbackStorage } from './feedback-storage'
import { gitRuntimeManager } from './git-runtime-manager'
import { mainWorkScheduler } from './main-work-scheduler'
import { openExternalUrlWithConfirm } from './external-link-guard'
import { RipgrepSearchManager } from './ripgrep-search'
import { browserViewManager } from './browser-view-manager'
import { FileWatchManager } from './file-watch-manager'
import { ImageWatchManager } from './image-watch-manager'
import { ProjectTreeWatchManager } from './project-tree-watch-manager'
import { gitDiffCacheInvalidator } from './git-diff-cache-invalidator'
import { getUpdateService } from './update-service'
import { perfTraceLogger } from './perf-trace-logger'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { IPC } from '../shared/ipc-channels'

let gitWatchManager: GitWatchManager | null = null
let ripgrepSearchManager: RipgrepSearchManager | null = null
let fileWatchManager: FileWatchManager | null = null
let imageWatchManager: ImageWatchManager | null = null
let projectTreeWatchManager: ProjectTreeWatchManager | null = null
let feedbackDebugLastOpenedUrl: string | null = null
let terminalIpcDiagTimer: ReturnType<typeof setInterval> | null = null

type TerminalInputSequencePayload = {
  kind: 'raw' | 'paste'
  content: string
}

const BRACKETED_PASTE_ENABLE_RE = /\x1b\[\?2004h/g
const BRACKETED_PASTE_DISABLE_RE = /\x1b\[\?2004l/g
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const INTERACTIVE_BOOST_WINDOW_MS = 250

function prepareTextForPaste(text: string): string {
  return text.replace(/\r?\n/g, '\r')
}

function wrapBracketedPaste(text: string, enabled: boolean): string {
  return enabled ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text
}

function updateBracketedPasteMode(current: boolean, data: string): boolean {
  let next = current
  BRACKETED_PASTE_ENABLE_RE.lastIndex = 0
  BRACKETED_PASTE_DISABLE_RE.lastIndex = 0

  for (const _ of data.matchAll(BRACKETED_PASTE_ENABLE_RE)) {
    next = true
  }
  for (const _ of data.matchAll(BRACKETED_PASTE_DISABLE_RE)) {
    next = false
  }
  return next
}

/**
 * Batches PTY output data into periodic flushes to reduce IPC message rate.
 * Instead of sending one IPC message per onData callback (which can be
 * 400-1000/s across 4 terminals), data is buffered and flushed at ~60fps.
 */
type TerminalDataSendPath = 'fast' | 'boost' | 'batched'
type TerminalDataSend = (id: string, data: string, meta: { path: TerminalDataSendPath; bufferAgeMs: number }) => void

class TerminalDataBuffer {
  private chunks: string[] = []
  private totalBytes = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private interactiveBoostUntil = 0
  private visible = true
  private firstPushAt = 0

  // IPC flush interval.  The previous value of 16 ms (~60 fps) sent up to
  // 360 IPC messages/s across 6 terminals, saturating the renderer's main
  // thread with callback processing alone.  100 ms (~10 fps per terminal)
  // reduces IPC traffic to ~60 msgs/s while the renderer-side throttle
  // (50 ms rAF) still provides smooth visual updates by coalescing writes.
  // Terminal text remains highly responsive — 100 ms of buffering is
  // imperceptible for human reading of scrolling output.
  private static readonly FLUSH_INTERVAL_MS = 100
  // Force flush when buffer exceeds 64KB (keeps large bursts responsive)
  private static readonly FORCE_FLUSH_BYTES = 64 * 1024
  private static readonly HIDDEN_MAX_BYTES = 512 * 1024

  constructor(
    private readonly terminalId: string,
    private readonly send: TerminalDataSend
  ) {}

  // Small data threshold for the fast path.  Keystroke echoes from the PTY
  // are typically 1-4 bytes; ANSI escape sequences for cursor movement or
  // colour are ~10-30 bytes.  128 bytes is generous enough to cover all
  // interactive typing feedback while still routing bulk command output
  // through the batched path.
  private static readonly FAST_PATH_THRESHOLD = 128

  // Whether the fast path is enabled for this terminal.  Disabled for
  // hidden terminals to avoid generating high-rate IPC traffic with no
  // user-visible benefit (the renderer buffers hidden terminal data anyway).
  private _fastPathEnabled = true

  setFastPathEnabled(enabled: boolean): void {
    this._fastPathEnabled = enabled
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return
    this.visible = visible
    if (visible) {
      this.flush()
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.trimToMaxBytes(TerminalDataBuffer.HIDDEN_MAX_BYTES)
  }

  notifyInteractiveInput(): void {
    this.interactiveBoostUntil = Date.now() + INTERACTIVE_BOOST_WINDOW_MS
    if (this.visible && this.chunks.length > 0) {
      this.flush()
    }
  }

  push(data: string): void {
    if (this.disposed) return

    if (!this.visible) {
      this.chunks.push(data)
      this.totalBytes += data.length
      this.trimToMaxBytes(TerminalDataBuffer.HIDDEN_MAX_BYTES)
      return
    }

    const interactiveBoostActive = this._fastPathEnabled && Date.now() < this.interactiveBoostUntil

    if (interactiveBoostActive && this.chunks.length > 0) {
      this.flush()
    }

    if (interactiveBoostActive) {
      this.send(this.terminalId, data, { path: 'boost', bufferAgeMs: 0 })
      return
    }

    // Fast path: small interactive data (keystroke echoes, short escape
    // sequences) is sent immediately when no data is already buffered.
    // This eliminates the 100 ms batching delay for interactive typing
    // while keeping the batched path for bulk output.
    // Only enabled for visible terminals — hidden terminals always batch.
    if (
      this._fastPathEnabled &&
      data.length <= TerminalDataBuffer.FAST_PATH_THRESHOLD &&
      this.chunks.length === 0
    ) {
      this.send(this.terminalId, data, { path: 'fast', bufferAgeMs: 0 })
      return
    }

    if (this.chunks.length === 0) {
      this.firstPushAt = Date.now()
    }
    this.chunks.push(data)
    this.totalBytes += data.length

    if (this.totalBytes >= TerminalDataBuffer.FORCE_FLUSH_BYTES) {
      this.flush()
      return
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, TerminalDataBuffer.FLUSH_INTERVAL_MS)
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.chunks.length === 0) return
    const merged = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('')
    const bufferAgeMs = this.firstPushAt > 0 ? Date.now() - this.firstPushAt : 0
    this.chunks = []
    this.totalBytes = 0
    this.firstPushAt = 0
    this.send(this.terminalId, merged, { path: 'batched', bufferAgeMs })
  }

  private trimToMaxBytes(maxBytes: number): void {
    while (this.totalBytes > maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.totalBytes -= dropped.length
    }

    if (this.totalBytes <= maxBytes || this.chunks.length === 0) return

    const retained = this.chunks[0].slice(-maxBytes)
    this.chunks[0] = retained
    this.totalBytes = retained.length
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.visible) {
      this.flush()
    } else {
      this.chunks = []
      this.totalBytes = 0
    }
  }
}

// Active data buffers keyed by terminal ID
const terminalDataBuffers = new Map<string, TerminalDataBuffer>()

// Tracks the desired fast-path state per terminal so that a
// `terminal:set-buffer-fast-path` message arriving before the buffer is
// created (race between renderer setVisibility and terminal:create) is
// not lost.  When a new buffer is created it reads from this map.
const terminalFastPathState = new Map<string, boolean>()
const terminalOutputVisibilityState = new Map<string, boolean>()
const terminalBracketedPasteState = new Map<string, boolean>()

// Buffer request waiting queue
interface TerminalBufferResult {
  success: boolean
  terminalId: string
  content?: string
  totalLines?: number
  returnedLines?: number
  returnedChars?: number
  truncated?: boolean
  capturedAt?: number
  bufferType?: 'normal' | 'alternate'
  error?: string
}

const bufferRequestCallbacks = new Map<string, {
  resolve: (result: TerminalBufferResult) => void
  timer: ReturnType<typeof setTimeout>
}>()

let bufferRequestCounter = 0

// Prompt Bridge request waiting queue
const promptBridgeCallbacks = new Map<string, {
  resolve: (result: PromptBridgeSendResult) => void
  timer: ReturnType<typeof setTimeout>
}>()

let promptBridgeCounter = 0

interface RegisterIpcHandlersOptions {
  onSettingsChanged?: (settings: SettingsState) => void
  onRestartToApplyUpdate?: () => Promise<{ success: boolean; error?: string }>
}

/**
 * Get terminal buffer contents from the renderer process.
 * Requests xterm.js buffer data through IPC.
 */
export function getTerminalBuffer(
  mainWindow: BrowserWindow,
  terminalId: string,
  options?: { mode?: string; lastLines?: number; lastChars?: number; trimTrailingEmpty?: boolean; buffer?: string }
): Promise<TerminalBufferResult> {
  return new Promise((resolve) => {
    if (mainWindow.isDestroyed()) {
      resolve({ success: false, terminalId, error: 'Window was destroyed' })
      return
    }

    const requestId = `buf-${++bufferRequestCounter}-${Date.now()}`

    const timer = setTimeout(() => {
      bufferRequestCallbacks.delete(requestId)
      resolve({ success: false, terminalId, error: 'Request timed out (5 seconds)' })
    }, 5000)

    bufferRequestCallbacks.set(requestId, { resolve, timer })

    mainWindow.webContents.send(IPC.TERMINAL_REQUEST_BUFFER, requestId, terminalId, options)
  })
}

export type PromptBridgeAction = 'send' | 'execute' | 'send-and-execute'

export interface PromptBridgeSendResult {
  success: boolean
  successIds: string[]
  sentOnlyIds: string[]
  failedIds: string[]
  issues?: Array<{
    terminalId: string
    status: 'sent-only' | 'failed'
    reason: 'unsafe-multiline-send' | 'unsafe-multiline-execute' | 'send-failed' | 'execute-failed'
    message: string
    error?: string
  }>
  error?: string
}

/**
 * Send commands to the rendering process via Prompt Bridge
 * The rendering process calls the existing Prompt sending logic (including split-write and history records)
 */
export function sendPromptViaBridge(
  mainWindow: BrowserWindow,
  terminalId: string,
  content: string,
  action: PromptBridgeAction
): Promise<PromptBridgeSendResult> {
  return new Promise((resolve) => {
    if (mainWindow.isDestroyed()) {
      resolve({ success: false, successIds: [], sentOnlyIds: [], failedIds: [terminalId], error: 'Window was destroyed' })
      return
    }

    const requestId = `prompt-bridge-${++promptBridgeCounter}-${Date.now()}`

    // 10 second timeout to cover prompt delivery plus any renderer-side coordination.
    const timer = setTimeout(() => {
      promptBridgeCallbacks.delete(requestId)
      resolve({ success: false, successIds: [], sentOnlyIds: [], failedIds: [terminalId], error: 'Request timed out (10 seconds)' })
    }, 10000)

    promptBridgeCallbacks.set(requestId, { resolve, timer })

    mainWindow.webContents.send(IPC.PROMPT_BRIDGE_SEND, {
      requestId,
      terminalId,
      content,
      action
    })
  })
}

export function registerIpcHandlers(mainWindow: BrowserWindow, options: RegisterIpcHandlersOptions = {}): void {
  const shouldLog = process.env.ONWARD_DEBUG === '1' || process.env.ELECTRON_ENABLE_LOGGING === '1'
  const log = (...args: unknown[]) => {
    if (shouldLog) {
      console.log(...args)
    }
  }

  perfTraceLogger.startGitRuntimeMonitor(() => gitRuntimeManager.getMetrics())

  // --- Diagnostic counters (ONWARD_DEBUG=1 / ONWARD_PERF_TRACE=1) ---
  const ipcDataCounters = new Map<string, { messages: number; bytes: number }>()
  if (shouldLog || perfTraceLogger.isEnabled()) {
    terminalIpcDiagTimer = setInterval(() => {
      for (const [tid, c] of ipcDataCounters) {
        if (c.messages > 0) {
          if (shouldLog) {
            console.log(`[PerfDiag] terminal:data tid=${tid} ipc/s=${c.messages} bytes/s=${c.bytes}`)
          }
          perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_TERMINAL_DATA_IPC_SUMMARY, {
            terminalId: tid,
            messagesPerSecond: c.messages,
            bytesPerSecond: c.bytes
          })
          c.messages = 0
          c.bytes = 0
        }
      }
    }, 1000)
  }

  gitWatchManager = new GitWatchManager((terminalId, info) => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IPC.GIT_TERMINAL_INFO, terminalId, info)
  })
  fileWatchManager = new FileWatchManager(mainWindow)
  imageWatchManager = new ImageWatchManager(mainWindow)
  projectTreeWatchManager = new ProjectTreeWatchManager(mainWindow)

  // When main's FS watcher detects an external mutation we need to:
  //   (1) drop the cached diff inside the git-ipc-worker (where getGitDiff
  //       and gitDiffRequestCache actually live in the normal IPC path), and
  //   (2) tell the renderer so an open GitDiffViewer can re-fetch.
  // Order matters: invalidate the worker cache BEFORE the renderer learns
  // about the change, so any reactive refetch the renderer kicks off lands
  // on a worker whose cache is already empty. The invalidator already
  // debounces, so this never spams either side.
  gitDiffCacheInvalidator.addListener((cwd, reason) => {
    gitIpcWorkerClient.invalidateDiffCache(cwd, reason)
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IPC.GIT_DIFF_CACHE_INVALIDATED, cwd, reason)
  })

  ipcMain.on(IPC.DEBUG_LOG, (_event, payload: { message?: string; data?: unknown }) => {
    log('[RendererDebug]', payload?.message ?? '', payload?.data ?? '')
  })
  ipcMain.on(IPC.DEBUG_PERF_TRACE, (rawEvent, payload: { event?: string; data?: Record<string, unknown>; terminalId?: string }) => {
    if (!payload?.event) return
    // Tag the renderer's WebContents id so the logger can map it to a
    // stable `tid` on the Chrome-trace / Perfetto side. Renderers share
    // pid=2 with tid = wc.id, so individual windows / utilities land on
    // their own thread track in the UI.
    // If `terminalId` is present, the logger routes the event onto the
    // per-Task virtual tid (so every hop for that task lines up on one
    // Perfetto row under the renderer process).
    const wc = rawEvent.sender
    const tid = wc?.id ?? 0
    perfTraceLogger.record(payload.event, payload.data, {
      process: 'renderer',
      tid,
      terminalId: payload.terminalId
    })
  })

  // Listen to buffer responses returned by the renderer process
  ipcMain.on(IPC.TERMINAL_BUFFER_RESPONSE, (_event, requestId: string, result: TerminalBufferResult) => {
    const pending = bufferRequestCallbacks.get(requestId)
    if (pending) {
      clearTimeout(pending.timer)
      bufferRequestCallbacks.delete(requestId)
      pending.resolve(result)
    }
  })

  // Listen to Prompt Bridge responses returned by the renderer process
  ipcMain.on(IPC.PROMPT_BRIDGE_RESPONSE, (_event, requestId: string, result: PromptBridgeSendResult) => {
    const pending = promptBridgeCallbacks.get(requestId)
    if (pending) {
      clearTimeout(pending.timer)
      promptBridgeCallbacks.delete(requestId)
      pending.resolve(result)
    }
  })
  // --- Telemetry ---
  ipcMain.handle(IPC.TELEMETRY_TRACK, (_, name: string, properties?: Record<string, string | number | boolean | null>) => {
    getTelemetryService().track(name, properties ?? undefined)
  })
  ipcMain.handle(IPC.TELEMETRY_GET_CONSENT, () => {
    return getTelemetryConsent()
  })
  ipcMain.handle(IPC.TELEMETRY_SET_CONSENT, (_, consent: boolean) => {
    const instanceId = setTelemetryConsent(consent)
    getTelemetryService().onConsentChanged(consent, instanceId)
    return { instanceId }
  })

  ipcMain.handle(IPC.DEBUG_GET_APP_METRICS, () => {
    return app.getAppMetrics()
  })
  ipcMain.handle(IPC.DEBUG_FOCUS_WINDOW, () => {
    if (mainWindow.isDestroyed()) return false

    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }

    mainWindow.show()
    mainWindow.focus()
    mainWindow.moveTop()

    if (process.platform === 'darwin') {
      app.dock?.show()
      app.focus({ steal: true })
    }

    return mainWindow.isFocused()
  })
  ipcMain.handle(IPC.DEBUG_GET_GIT_RUNTIME_METRICS, () => {
    return gitRuntimeManager.getMetrics()
  })
  ipcMain.handle(IPC.DEBUG_GET_MAIN_WORK_METRICS, () => {
    return mainWorkScheduler.getMetrics()
  })
  ipcMain.handle(IPC.DEBUG_GET_PERF_TRACE_INFO, () => {
    return perfTraceLogger.getInfo()
  })
  ipcMain.handle(IPC.DEBUG_RESET_PERF_TRACE_METRICS, () => {
    return perfTraceLogger.resetEventLoopMetrics()
  })
  ipcMain.handle(IPC.DEBUG_FEEDBACK_RESET, () => {
    feedbackDebugLastOpenedUrl = null
    getFeedbackStorage().debugReset()
  })
  ipcMain.handle(IPC.DEBUG_FEEDBACK_SET_MOCK_ISSUES, (_, issues) => {
    getFeedbackStorage().debugSetMockIssues(Array.isArray(issues) ? issues : [])
  })
  ipcMain.handle(IPC.DEBUG_FEEDBACK_GET_LAST_OPENED_URL, () => {
    return feedbackDebugLastOpenedUrl
  })
  ipcMain.handle(IPC.DEBUG_READ_TELEMETRY_LOG, () => {
    try {
      const logPath = getTelemetryService().logFilePath
      if (!logPath) return ''
      const { readFileSync, existsSync } = require('fs')
      if (!existsSync(logPath)) return ''
      return readFileSync(logPath, 'utf-8')
    } catch {
      return ''
    }
  })
  ipcMain.handle(IPC.DEBUG_QUIT, () => {
    // Flush telemetry and stop PTYs before debug/autotest exit.
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000))
    const shutdown = Promise.all([
      getTelemetryService().shutdown().catch(() => {}),
      ptyManager.shutdownAll().then((result) => {
        if (result.timedOut > 0) {
          console.warn(`[PTY] debug quit shutdown timed out: ${result.timedOut}/${result.total}`)
        }
      }).catch((error) => {
        console.warn('[PTY] debug quit shutdown failed:', error)
      })
    ]).then(() => {})

    Promise.race([shutdown, timeout]).finally(() => app.exit(0))
  })

  // Saved cwd for terminals running coding agents, so that
  // when the agent exits and the renderer calls terminal:create
  // to restart, we can restore the original working directory.
  const agentRestartCwdMap = new Map<string, string>()

  const isUsableTerminalCwd = (cwd: string): boolean => {
    try {
      return statSync(cwd).isDirectory()
    } catch {
      return false
    }
  }

  const createTerminalProcess = (id: string, options?: PtyOptions) => {
    try {
      let restoredPersistedCwd: string | null = null

      // If no cwd provided but we have a saved agent cwd, use it
      if (!options?.cwd) {
        const savedCwd = agentRestartCwdMap.get(id)
        if (savedCwd) {
          options = { ...options, cwd: savedCwd }
        }
      }
      if (!options?.cwd) {
        const persistedCwd = appStateStorage.getTerminalLastCwd(id)
        if (persistedCwd) {
          restoredPersistedCwd = persistedCwd
          options = { ...options, cwd: persistedCwd }
        }
      }
      // Clear the saved cwd after using it once
      agentRestartCwdMap.delete(id)

      if (options?.cwd && !isUsableTerminalCwd(options.cwd)) {
        console.warn('[PTY] Ignoring unusable terminal cwd:', { id, cwd: options.cwd })
        if (restoredPersistedCwd === options.cwd) {
          appStateStorage.setTerminalLastCwd(id, null)
        }
        options = { ...options }
        delete options.cwd
      }

      let ptyProcess
      try {
        ptyProcess = ptyManager.create(id, options)
      } catch (error) {
        if (!restoredPersistedCwd) {
          throw error
        }
        console.warn('[PTY] Falling back to default cwd after persisted cwd restore failed:', {
          id,
          cwd: restoredPersistedCwd,
          error: String(error)
        })
        appStateStorage.setTerminalLastCwd(id, null)
        const fallbackOptions = options ? { ...options } : {}
        delete fallbackOptions.cwd
        ptyProcess = ptyManager.create(id, fallbackOptions)
      }

      // IPC data buffer: merge high-frequency PTY output into batched sends
      const dataBuffer = new TerminalDataBuffer(id, (tid, mergedData, meta) => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.TERMINAL_DATA, tid, mergedData)
          perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_TERMINAL_DATA_IPC_SEND, {
            path: meta.path,
            bytes: mergedData.length,
            bufferAgeMs: meta.bufferAgeMs
          }, { terminalId: tid })
        }
        // Diagnostic counter
        if (shouldLog) {
          let c = ipcDataCounters.get(tid)
          if (!c) { c = { messages: 0, bytes: 0 }; ipcDataCounters.set(tid, c) }
          c.messages += 1
          c.bytes += mergedData.length
        }
      })
      terminalDataBuffers.set(id, dataBuffer)
      terminalBracketedPasteState.set(id, false)

      // Apply any fast-path state that arrived before the buffer was created
      // (e.g. setVisibility(id, false) sent before terminal:create completed).
      const pendingFastPath = terminalFastPathState.get(id)
      if (pendingFastPath !== undefined) {
        dataBuffer.setFastPathEnabled(pendingFastPath)
      }
      const pendingOutputVisibility = terminalOutputVisibilityState.get(id)
      if (pendingOutputVisibility !== undefined) {
        dataBuffer.setVisible(pendingOutputVisibility)
      }

      // Throttle git activity notifications from PTY output (500ms)
      let lastGitActivityAt = 0
      const GIT_ACTIVITY_THROTTLE_MS = 500

      const dataDisposable = ptyProcess.onData((data) => {
        // Parse OSC 9;9 CWD reports from shell integration (Windows)
        ptyManager.detectCwd(id, data)
        const bracketedPasteMode = terminalBracketedPasteState.get(id) ?? false
        terminalBracketedPasteState.set(id, updateBracketedPasteMode(bracketedPasteMode, data))
        dataBuffer.push(data)

        // Notify git watch on PTY output (throttled) instead of on every keystroke
        const now = Date.now()
        if (now - lastGitActivityAt >= GIT_ACTIVITY_THROTTLE_MS) {
          lastGitActivityAt = now
          gitWatchManager?.notifyTerminalActivity(id)
        }
      })

      const exitDisposable = ptyProcess.onExit(({ exitCode, signal }) => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.TERMINAL_EXIT, id, exitCode, signal)
        }
      })

      ptyManager.registerListeners(id, [dataDisposable, exitDisposable])

      return { success: true, id }
    } catch (error) {
      console.error('Failed to create terminal:', error)
      return { success: false, error: String(error) }
    }
  }
  // App info
  ipcMain.handle(IPC.APP_GET_INFO, () => {
    return getAppInfo()
  })

  ipcMain.handle(IPC.FEEDBACK_LOAD, () => {
    return getFeedbackStorage().get()
  })

  ipcMain.handle(IPC.FEEDBACK_UPDATE_PREFERENCES, (_, payload) => {
    return getFeedbackStorage().updatePreferences(
      payload && typeof payload === 'object' ? payload : {}
    )
  })

  ipcMain.handle(IPC.FEEDBACK_CREATE_SUBMISSION, async (_, payload) => {
    const storage = getFeedbackStorage()
    const appInfo = getAppInfo()
    const result = storage.createSubmission(payload, {
      locale: payload?.locale === 'zh-CN' ? 'zh-CN' : 'en',
      platform: appInfo.platform,
      productName: appInfo.productName,
      version: appInfo.version,
      buildChannel: appInfo.buildChannel,
      releaseChannel: appInfo.releaseChannel,
      releaseOs: appInfo.releaseOs,
      createdAt: Date.now()
    })

    if (!result.success || !result.record) {
      return result
    }

    try {
      if (process.env.ONWARD_AUTOTEST === '1') {
        feedbackDebugLastOpenedUrl = result.record.prefilledUrl
        storage.markBrowserOpened(result.record.id)
        return {
          success: true,
          record: storage.getRecord(result.record.id) ?? result.record
        }
      }

      await shell.openExternal(result.record.prefilledUrl)
      storage.markBrowserOpened(result.record.id)
      return {
        success: true,
        record: storage.getRecord(result.record.id) ?? result.record
      }
    } catch (error) {
      storage.removeRecord(result.record.id)
      return {
        success: false,
        error: String(error)
      }
    }
  })

  ipcMain.handle(IPC.FEEDBACK_SYNC, async (_, recordId?: string, force?: boolean) => {
    return await getFeedbackStorage().sync(recordId, force === true)
  })

  ipcMain.handle(IPC.FEEDBACK_REOPEN_IN_BROWSER, async (_, recordId: string) => {
    const storage = getFeedbackStorage()
    const record = storage.getRecord(recordId)
    if (!record) {
      return { success: false, error: 'Feedback record not found.' }
    }

    try {
      if (process.env.ONWARD_AUTOTEST === '1') {
        feedbackDebugLastOpenedUrl = record.prefilledUrl
        storage.markBrowserOpened(recordId)
        return { success: true }
      }

      await shell.openExternal(record.prefilledUrl)
      storage.markBrowserOpened(recordId)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.FEEDBACK_REMOVE_RECORD, (_, recordId: string) => {
    const storage = getFeedbackStorage()
    storage.removeRecord(recordId)
    return storage.get()
  })

  // Read NOTICE / ThirdPartyNotices file for open-source license display
  ipcMain.handle(IPC.APP_READ_NOTICE, () => {
    const basePath = app.isPackaged ? process.resourcesPath : app.getAppPath()
    // Prefer auto-generated ThirdPartyNotices.txt, fall back to NOTICE.txt
    for (const filename of ['ThirdPartyNotices.txt', 'NOTICE.txt']) {
      try {
        return readFileSync(join(basePath, filename), 'utf-8')
      } catch {
        // Try next candidate
      }
    }
    return null
  })

  ipcMain.handle(IPC.CHANGELOG_GET_CURRENT, (_event, locale?: string) => {
    return readCurrentChangelog(locale)
  })

  // URL for the vendored PDF viewer (resources/pdfjs/app/viewer.html).
  // Returned as a properly-encoded file:// URL so the renderer can embed it
  // in an iframe without platform-specific path fiddling.
  ipcMain.handle(IPC.APP_GET_PDF_VIEWER_URL, () => {
    const basePath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    const viewerPath = join(basePath, 'pdfjs', 'app', 'viewer.html')
    const segments = viewerPath.split(sep).join('/').split('/').map(seg => encodeURIComponent(seg))
    const leading = viewerPath.startsWith(sep) || viewerPath.startsWith('/') ? '' : '/'
    return `file://${leading}${segments.join('/')}`
  })

  ipcMain.handle(IPC.UPDATER_GET_STATUS, () => {
    return getUpdateService().getStatus()
  })

  ipcMain.handle(IPC.UPDATER_CHECK_NOW, async () => {
    return await getUpdateService().checkNow()
  })

  ipcMain.handle(IPC.UPDATER_DOWNLOAD_NOW, async () => {
    return await getUpdateService().downloadNow()
  })

  ipcMain.handle(IPC.UPDATER_RESTART_TO_UPDATE, async () => {
    if (!options.onRestartToApplyUpdate) {
      return { success: false, error: 'Restart action is unavailable.' }
    }
    return await options.onRestartToApplyUpdate()
  })

  ipcMain.handle(IPC.UPDATER_DISMISS_BANNER, () => {
    return getUpdateService().dismissBanner()
  })

  // Create a new terminal
  ipcMain.handle(IPC.TERMINAL_CREATE, (_, id: string, options?: PtyOptions) => {
    return createTerminalProcess(id, options)
  })

  // Write data to terminal
  ipcMain.handle(IPC.TERMINAL_WRITE, async (_, id: string, data: string) => {
    // Git activity notification moved to ptyProcess.onData with 500ms throttle
    // (user keystrokes don't change git state; PTY output means command execution)
    return await ptyManager.write(id, data)
  })

  ipcMain.handle(IPC.TERMINAL_SEND_INPUT_SEQUENCE, async (_, id: string, payload: TerminalInputSequencePayload) => {
    if (payload.kind === 'raw') {
      const ok = await ptyManager.write(id, payload.content)
      return ok ? { ok: true } : { ok: false, phase: 'content' as const, error: 'pty write failed' }
    }

    // 'paste' kind — send content without Enter
    const bracketedPasteEnabled = terminalBracketedPasteState.get(id) ?? false
    const prepared = wrapBracketedPaste(prepareTextForPaste(payload.content), bracketedPasteEnabled)
    return await ptyManager.sendInputSequence(id, prepared)
  })

  ipcMain.handle(IPC.TERMINAL_GET_INPUT_CAPABILITIES, (_, id: string) => {
    return {
      bracketedPasteEnabled: terminalBracketedPasteState.get(id) ?? false,
      shellKind: ptyManager.getShellKind(id)
    }
  })

  // Toggle fast-path on the IPC data buffer for a terminal.
  // Called by the renderer when terminal visibility changes so that hidden
  // terminals don't generate high-rate unbatched IPC traffic.
  // The state is also persisted in terminalFastPathState so that it survives
  // the race where setVisibility fires before the buffer is created.
  ipcMain.on(IPC.TERMINAL_SET_BUFFER_FAST_PATH, (_, id: string, enabled: boolean) => {
    terminalFastPathState.set(id, enabled)
    const buf = terminalDataBuffers.get(id)
    if (buf) buf.setFastPathEnabled(enabled)
  })

  ipcMain.on(IPC.TERMINAL_SET_OUTPUT_VISIBILITY, (_, id: string, visible: boolean) => {
    terminalOutputVisibilityState.set(id, visible)
    const buf = terminalDataBuffers.get(id)
    if (buf) buf.setVisible(visible)
  })

  ipcMain.on(IPC.TERMINAL_NOTIFY_INTERACTIVE_INPUT, (_, id: string) => {
    const buf = terminalDataBuffers.get(id)
    if (buf) buf.notifyInteractiveInput()
  })

  // Resize terminal
  ipcMain.handle(IPC.TERMINAL_RESIZE, (_, id: string, cols: number, rows: number) => {
    return ptyManager.resize(id, cols, rows)
  })

  // Dispose terminal
  ipcMain.handle(IPC.TERMINAL_DISPOSE, (_, id: string) => {
    // Flush and dispose the data buffer
    const buf = terminalDataBuffers.get(id)
    if (buf) {
      buf.dispose()
      terminalDataBuffers.delete(id)
    }
    terminalFastPathState.delete(id)
    terminalOutputVisibilityState.delete(id)
    terminalBracketedPasteState.delete(id)
    ipcDataCounters.delete(id)
    gitWatchManager?.unsubscribe(id)
    return ptyManager.dispose(id)
  })

  // Prompt storage handlers
  const promptStorage = getPromptStorage()

  // Load all prompts
  ipcMain.handle(IPC.PROMPT_LOAD, () => {
    return promptStorage.getAll()
  })

  // Save a prompt
  ipcMain.handle(IPC.PROMPT_SAVE, (_, prompt: Prompt) => {
    return promptStorage.save(prompt)
  })

  // Delete a prompt
  ipcMain.handle(IPC.PROMPT_DELETE, (_, id: string) => {
    return promptStorage.delete(id)
  })

  // Terminal config storage handlers
  const terminalConfigStorage = getTerminalConfigStorage()

  // Load terminal config
  ipcMain.handle(IPC.TERMINAL_CONFIG_LOAD, () => {
    return terminalConfigStorage.get()
  })

  // Save terminal config
  ipcMain.handle(IPC.TERMINAL_CONFIG_SAVE, (_, config: TerminalWindowConfig) => {
    return terminalConfigStorage.save(config)
  })

  // Update terminal config (partial)
  ipcMain.handle(IPC.TERMINAL_CONFIG_UPDATE, (_, partial: Partial<TerminalWindowConfig>) => {
    return terminalConfigStorage.update(partial)
  })

  // Dialog handlers
  ipcMain.handle(IPC.DIALOG_OPEN_DIRECTORY, async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      return { success: true, path: result.filePaths[0] }
    } catch (error) {
      console.error('Failed to open directory dialog:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.DIALOG_OPEN_TEXT_FILE, async (_, payload?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: payload?.title || 'Open file',
        properties: ['openFile'],
        filters: payload?.filters?.length
          ? payload.filters
          : [{ name: 'JSON', extensions: ['json'] }, { name: 'Text', extensions: ['txt', 'md'] }]
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      const path = result.filePaths[0]
      const content = readFileSync(path, 'utf-8')
      return { success: true, path, content }
    } catch (error) {
      console.error('Failed to open text file:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.DIALOG_SAVE_TEXT_FILE, async (_, payload: { title?: string; defaultFileName?: string; content: string }) => {
    try {
      if (!payload || typeof payload.content !== 'string') {
        return { success: false, error: 'Invalid export content' }
      }

      const result = await dialog.showSaveDialog(mainWindow, {
        title: payload.title || 'Export file',
        defaultPath: payload.defaultFileName || 'onward-export.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true }
      }

      writeFileSync(result.filePath, payload.content, 'utf-8')
      return { success: true, path: result.filePath }
    } catch (error) {
      console.error('Failed to save text file:', error)
      return { success: false, error: String(error) }
    }
  })

  // Shell handlers
  ipcMain.handle(IPC.SHELL_OPEN_PATH, async (_, targetPath: string) => {
    try {
      const result = await shell.openPath(targetPath)
      if (result) {
        return { success: false, error: result }
      }
      return { success: true }
    } catch (error) {
      console.error('Failed to open path:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.SHELL_OPEN_EXTERNAL, async (_, url: string) => {
    const result = await openExternalUrlWithConfirm(mainWindow, url)
    if (!result.success && result.error && !result.canceled && !result.blocked) {
      console.error('Failed to open external url:', result.error)
    }
    return result
  })

  ipcMain.handle(IPC.CLIPBOARD_WRITE_TEXT, async (_, text: string) => {
    clipboard.writeText(text)
    return true
  })

  ipcMain.handle(IPC.CLIPBOARD_READ_TEXT, async () => {
    return clipboard.readText()
  })

  browserViewManager.init(mainWindow)

  ipcMain.handle(IPC.BROWSER_CREATE, (_, id: string, url?: string) => {
    return browserViewManager.create(id, url)
  })

  ipcMain.handle(IPC.BROWSER_DESTROY, (_, id: string) => {
    return browserViewManager.destroy(id)
  })

  ipcMain.handle(IPC.BROWSER_NAVIGATE, (_, id: string, url: string) => {
    return browserViewManager.navigate(id, url)
  })

  ipcMain.handle(IPC.BROWSER_GO_BACK, (_, id: string) => {
    return browserViewManager.goBack(id)
  })

  ipcMain.handle(IPC.BROWSER_GO_FORWARD, (_, id: string) => {
    return browserViewManager.goForward(id)
  })

  ipcMain.handle(IPC.BROWSER_RELOAD, (_, id: string) => {
    return browserViewManager.reload(id)
  })

  ipcMain.handle(IPC.BROWSER_STOP, (_, id: string) => {
    return browserViewManager.stop(id)
  })

  ipcMain.handle(IPC.BROWSER_SET_BOUNDS, (_, id: string, rect: { x: number; y: number; width: number; height: number }) => {
    return browserViewManager.setBounds(id, rect)
  })

  ipcMain.handle(IPC.BROWSER_SHOW, (_, id: string) => {
    return browserViewManager.show(id)
  })

  ipcMain.handle(IPC.BROWSER_HIDE, (_, id: string) => {
    return browserViewManager.hide(id)
  })

  ipcMain.handle(IPC.BROWSER_GET_NAV_STATE, (_, id: string) => {
    return browserViewManager.getNavState(id)
  })

  ipcMain.handle(IPC.BROWSER_CLEAR_COOKIES, (_, maxAge?: number) => {
    return browserViewManager.clearCookies(maxAge)
  })

  ipcMain.handle(IPC.BROWSER_SET_REMEMBER_COOKIES, (_, rememberCookies: boolean) => {
    return browserViewManager.setRememberCookies(rememberCookies)
  })

  ipcMain.handle(
    IPC.BROWSER_SHOW_COOKIE_MENU,
    (_, options: { rememberCookies: boolean; labels: { remember: string; clearDay: string; clearWeek: string; clearAll: string } }) => {
      return new Promise<{ action: string; rememberCookies?: boolean } | null>((resolve) => {
        const { rememberCookies, labels } = options
        const items: Electron.MenuItemConstructorOptions[] = [
          {
            label: labels.remember,
            type: 'checkbox',
            checked: rememberCookies,
            click: () => resolve({ action: 'toggleRemember', rememberCookies: !rememberCookies })
          }
        ]

        if (rememberCookies) {
          items.push(
            { type: 'separator' },
            { label: labels.clearDay, click: () => resolve({ action: 'clear', rememberCookies: undefined }) },
            { label: labels.clearWeek, click: () => resolve({ action: 'clearWeek', rememberCookies: undefined }) },
            { type: 'separator' },
            { label: labels.clearAll, click: () => resolve({ action: 'clearAll', rememberCookies: undefined }) }
          )
        }

        const menu = Menu.buildFromTemplate(items)
        menu.popup({
          window: mainWindow,
          callback: () => resolve(null)
        })
      })
    }
  )

  // Command preset storage handlers
  const commandPresetStorage = getCommandPresetStorage()

  // Load all command presets
  ipcMain.handle(IPC.COMMAND_PRESET_LOAD, () => {
    return commandPresetStorage.getAll()
  })

  // Save a command preset
  ipcMain.handle(IPC.COMMAND_PRESET_SAVE, (_, preset: CommandPreset) => {
    return commandPresetStorage.save(preset)
  })

  // Delete a command preset
  ipcMain.handle(IPC.COMMAND_PRESET_DELETE, (_, id: string) => {
    return commandPresetStorage.delete(id)
  })

  // Coding Agent configuration storage
  const codingAgentConfigStorage = getCodingAgentConfigStorage()

  ipcMain.handle(IPC.CODING_AGENT_CONFIG_LOAD, (_, command?: string) => {
    return codingAgentConfigStorage.get(command)
  })

  ipcMain.handle(IPC.CODING_AGENT_CONFIG_SAVE, (_, config: CodingAgentConfigInput) => {
    return codingAgentConfigStorage.save(config)
  })

  ipcMain.handle(IPC.CODING_AGENT_CONFIG_UPDATE, (_, id: string, config: CodingAgentConfigInput) => {
    return codingAgentConfigStorage.update(id, config)
  })

  ipcMain.handle(IPC.CODING_AGENT_CONFIG_DELETE, (_, id: string) => {
    return codingAgentConfigStorage.delete(id)
  })

  ipcMain.handle(IPC.CODING_AGENT_PREPARE, async (_, command: string, executablePath?: string) => {
    const info = await getCodingAgentRuntimeInfo(command || '', executablePath || undefined)
    if (!info.success) {
      return { success: false, error: info.error }
    }
    return { success: true }
  })

  ipcMain.handle(IPC.CODING_AGENT_LAUNCH, async (_, payload: { terminalId: string; config: CodingAgentConfigInput; cols?: number; rows?: number }) => {
    const terminalId = payload?.terminalId
    if (!terminalId) {
      return { success: false, error: 'Terminal ID missing' }
    }

    const config = payload.config
    if (!config || !config.command) {
      return { success: false, error: 'Agent configuration missing' }
    }

    const runtimeInfo = await getCodingAgentRuntimeInfo(config.command, config.executablePath || undefined)
    if (!runtimeInfo.success || !runtimeInfo.executablePath) {
      return { success: false, error: runtimeInfo.error || 'Agent not ready' }
    }

    const cwd = await getTerminalCwd(terminalId)
    const cols = payload.cols || 80
    const rows = payload.rows || 24
    const restartCwd = cwd || process.env.HOME || process.cwd()

    // Build environment: merge user-specified environment variables
    const env: NodeJS.ProcessEnv = { ...process.env }
    const userEnvVars = Array.isArray(config.envVars) ? config.envVars : []
    for (const entry of userEnvVars) {
      let key = (entry.key || '').trim()
      let value = entry.value ?? ''
      // Strip surrounding quotes — users may copy KEY="value" from docs
      if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
        key = key.slice(1, -1)
      }
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (key) env[key] = value
    }

    // Parse user-provided extra arguments with shell-aware quoting
    const extraArgs: string[] = []
    const rawArgs = (config.extraArgs || '').trim()
    if (rawArgs) {
      // Match: "quoted string", 'quoted string', or unquoted-token
      const tokens = rawArgs.match(/(?:"[^"]*"|'[^']*'|\S+)/g) || []
      for (const token of tokens) {
        // Strip surrounding quotes
        if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
          extraArgs.push(token.slice(1, -1))
        } else {
          extraArgs.push(token)
        }
      }
    }

    // Save cwd so the renderer's restartShell can restore it after agent exit
    agentRestartCwdMap.set(terminalId, restartCwd)

    // Use the same cleanup path as terminal:dispose to drain buffers and unsubscribe watchers
    const buf = terminalDataBuffers.get(terminalId)
    if (buf) {
      buf.dispose()
      terminalDataBuffers.delete(terminalId)
    }
    ipcDataCounters.delete(terminalId)
    gitWatchManager?.unsubscribe(terminalId)
    ptyManager.dispose(terminalId)

    // Spawn the agent; on exit the renderer's global exit handler will prompt restart
    return createTerminalProcess(terminalId, {
      cols,
      rows,
      cwd: restartCwd,
      env,
      command: runtimeInfo.executablePath,
      args: extraArgs
    })
  })

  // App state storage handlers
  const appStateStorage = getAppStateStorage()

  // Load app state
  ipcMain.handle(IPC.APP_STATE_LOAD, () => {
    log('[IPC] app-state:load')
    return appStateStorage.get()
  })

  // Save app state
  ipcMain.handle(IPC.APP_STATE_SAVE, (_, state: AppState) => {
    return appStateStorage.save(state)
  })
  ipcMain.handle(IPC.APP_STATE_SAVE_PATCH, (_, patch: Partial<AppState>) => {
    return appStateStorage.savePatch(patch)
  })
  ipcMain.handle(IPC.APP_STATE_FLUSH, () => {
    return appStateStorage.flush()
  })

  // Git handlers
  // Check if Git is installed
  ipcMain.handle(IPC.GIT_CHECK_INSTALLED, async () => {
    return await gitIpcWorkerClient.checkInstalled()
  })

  // Resolve git repo root for a given path
  ipcMain.handle(IPC.GIT_RESOLVE_REPO_ROOT, async (_, cwd: string) => {
    return await gitIpcWorkerClient.resolveRepoRoot(cwd)
  })

  // Get Git diff for a directory
  ipcMain.handle(IPC.GIT_GET_DIFF, async (_, cwd: string, options?: { scope?: 'root-only' | 'full'; force?: boolean }) => {
    const result = await gitIpcWorkerClient.getDiff(cwd, options)
    // Register the FS watcher on the MAIN process side, scoped to the
    // resolved repo root rather than the input cwd. When callers open Git
    // Diff from a subdirectory (e.g. `myrepo/src/components/`), the diff
    // covers the whole repo, but a watcher on the subdirectory would miss
    // changes in sibling paths under the same repo. Registering on
    // `result.cwd` (the resolved repoRoot returned by getGitDiff) keeps the
    // watcher's surface aligned with the data surface, so external edits
    // anywhere in the repo trigger the auto-refresh path. Cwds already
    // watched are no-ops here, and `result.cwd` falls back to the input
    // cwd when the path is not a git repo.
    if (result?.cwd) {
      gitDiffCacheInvalidator.registerWatch(result.cwd)
    } else {
      gitDiffCacheInvalidator.registerWatch(cwd)
    }
    return result
  })

  // Get Git history list
  ipcMain.handle(IPC.GIT_GET_HISTORY, async (_, cwd: string, options?: { limit?: number; skip?: number }) => {
    return await gitIpcWorkerClient.getHistory(cwd, options?.limit, options?.skip)
  })

  // Get Git history diff (range + file)
  ipcMain.handle(IPC.GIT_GET_HISTORY_DIFF, async (_, cwd: string, options: GitHistoryDiffOptions) => {
    return await gitIpcWorkerClient.getHistoryDiff(cwd, options)
  })

  ipcMain.handle(IPC.GIT_GET_HISTORY_FILE_CONTENT, async (_, cwd: string, options: GitHistoryFileContentOptions) => {
    return await gitIpcWorkerClient.getHistoryFileContent(cwd, options)
  })

  // Get Git file content for diff view
  ipcMain.handle(IPC.GIT_GET_FILE_CONTENT, async (_, cwd: string, file: Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType' | 'isSubmoduleEntry'>, repoRoot?: string) => {
    return await gitIpcWorkerClient.getFileContent(cwd, file, repoRoot)
  })

  // Save file content to workspace
  ipcMain.handle(IPC.GIT_SAVE_FILE_CONTENT, async (_, cwd: string, filename: string, content: string) => {
    return await gitIpcWorkerClient.saveFileContent(cwd, filename, content)
  })

  ipcMain.handle(IPC.GIT_STAGE_FILE, async (_, cwd: string, filename: string, repoRoot?: string) => {
    return await gitIpcWorkerClient.stageFile(cwd, filename, repoRoot)
  })

  ipcMain.handle(IPC.GIT_UNSTAGE_FILE, async (_, cwd: string, filename: string, repoRoot?: string) => {
    return await gitIpcWorkerClient.unstageFile(cwd, filename, repoRoot)
  })

  ipcMain.handle(IPC.GIT_DISCARD_FILE, async (_, cwd: string, file: Pick<GitFileStatus, 'filename' | 'changeType' | 'status' | 'isSubmoduleEntry'>, repoRoot?: string) => {
    return await gitIpcWorkerClient.discardFile(cwd, file, repoRoot)
  })

  ipcMain.handle(IPC.GIT_GET_SUBMODULES, async (_, cwd: string) => {
    return await gitIpcWorkerClient.getSubmodules(cwd)
  })

  ipcMain.handle(IPC.GIT_UPDATE_INDEX_CONTENT, async (_, cwd: string, filename: string, content: string) => {
    return await gitIpcWorkerClient.updateIndexContent(cwd, filename, content)
  })

  // Get terminal's current working directory
  ipcMain.handle(IPC.GIT_GET_TERMINAL_CWD, async (_, terminalId: string) => {
    return await getTerminalCwd(terminalId)
  })

  // Get terminal's cwd + git branch
  ipcMain.handle(IPC.GIT_GET_TERMINAL_INFO, async (_, terminalId: string) => {
    return await getTerminalGitInfo(terminalId)
  })
  ipcMain.handle(IPC.GIT_SUBSCRIBE_TERMINAL_INFO, async (_event, terminalId: string) => {
    await gitWatchManager?.subscribe(terminalId)
    return { success: true }
  })
  ipcMain.handle(IPC.GIT_UNSUBSCRIBE_TERMINAL_INFO, async (_event, terminalId: string) => {
    gitWatchManager?.unsubscribe(terminalId)
    return { success: true }
  })
  ipcMain.handle(IPC.GIT_NOTIFY_TERMINAL_ACTIVITY, async (_event, terminalId: string) => {
    gitWatchManager?.notifyTerminalActivity(terminalId)
    return { success: true }
  })
  ipcMain.handle(IPC.GIT_NOTIFY_TERMINAL_FOCUS, async (_event, terminalId: string) => {
    gitWatchManager?.notifyTerminalFocus(terminalId)
    return { success: true }
  })
  ipcMain.handle(IPC.GIT_NOTIFY_TERMINAL_GIT_UPDATE, async (_event, terminalId: string) => {
    gitWatchManager?.notifyTerminalGitUpdate(terminalId)
    return { success: true }
  })

  // Background diff cache warming — pre-compute diff so opening the panel is instant
  ipcMain.handle(IPC.GIT_WARM_DIFF_CACHE, async (_, cwd: string) => {
    return await gitIpcWorkerClient.warmDiffCache(cwd)
  })

  // Project editor handlers
  ipcMain.handle(IPC.PROJECT_LIST_DIRECTORY, async (_, root: string, path: string) => {
    return await projectFsWorkerClient.listDirectory(root, path)
  })

  ipcMain.handle(IPC.PROJECT_BUILD_FILE_INDEX, async (_, root: string) => {
    const startMs = Date.now()
    const result = await projectFsWorkerClient.buildFileIndex(root)
    perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_FILE_INDEX_BUILD, {
      fileCount: Array.isArray(result) ? result.length : 0,
      durationMs: Date.now() - startMs
    })
    return result
  })

  ipcMain.handle(IPC.PROJECT_INVALIDATE_FILE_INDEX, async (_, root: string) => {
    perfTraceLogger.record(PERF_TRACE_EVENT.MAIN_FILE_INDEX_UPDATE, { reason: 'invalidate' })
    return await projectFsWorkerClient.invalidateFileIndex(root)
  })

  ipcMain.handle(IPC.PROJECT_SEARCH_FILENAMES, async (_, root: string, query: string, limit?: number) => {
    return await projectFsWorkerClient.searchFilenames(root, query, limit ?? 80)
  })

  ipcMain.handle(IPC.PROJECT_READ_FILE, async (_, root: string, path: string) => {
    return await readProjectFile(root, path)
  })

  ipcMain.handle(IPC.PROJECT_SAVE_FILE, async (_, root: string, path: string, content: string) => {
    const result = await saveProjectFile(root, path, content)
    if (result.success && fileWatchManager) {
      const fullPath = resolveInRoot(resolve(root), path)
      if (fullPath) {
        fileWatchManager.suppressNext(fullPath)
      }
    }
    return result
  })

  ipcMain.handle(IPC.PROJECT_WATCH_FILE, async (_, root: string, path: string) => {
    const fullPath = resolveInRoot(resolve(root), path)
    if (!fullPath) {
      return { success: false, error: 'Invalid path.' }
    }
    fileWatchManager?.watch(fullPath)
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_UNWATCH_FILE, async (_, root: string, path: string) => {
    const fullPath = resolveInRoot(resolve(root), path)
    if (!fullPath) {
      return { success: false }
    }
    fileWatchManager?.unwatch(fullPath)
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_WATCH_IMAGE_FILES, async (_, root: string, relativePaths: string[]) => {
    if (!root || !Array.isArray(relativePaths)) return { success: false }
    imageWatchManager?.watchImages(root, relativePaths)
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_UNWATCH_IMAGE_FILES, async (_, root: string, relativePaths: string[]) => {
    if (!root || !Array.isArray(relativePaths)) return { success: false }
    imageWatchManager?.unwatchImages(root, relativePaths)
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_UNWATCH_ALL_IMAGE_FILES, async () => {
    imageWatchManager?.unwatchAll()
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_CREATE_FILE, async (_, root: string, path: string, content: string) => {
    return await createProjectFile(root, path, content)
  })

  ipcMain.handle(IPC.PROJECT_CREATE_FOLDER, async (_, root: string, path: string) => {
    return await createProjectFolder(root, path)
  })

  ipcMain.handle(IPC.PROJECT_RENAME_PATH, async (_, root: string, oldPath: string, newPath: string) => {
    return await renameProjectPath(root, oldPath, newPath)
  })

  ipcMain.handle(IPC.PROJECT_DELETE_PATH, async (_, root: string, path: string) => {
    return await deleteProjectPath(root, path)
  })

  ipcMain.handle(IPC.PROJECT_SQLITE_GET_SCHEMA, async (_, root: string, path: string) => {
    return await sqliteWorkerClient.getSchema(root, path)
  })

  ipcMain.handle(
    IPC.PROJECT_SQLITE_READ_TABLE_ROWS,
    async (_, root: string, path: string, table: string, limit?: number, offset?: number) => {
      return await sqliteWorkerClient.readTableRows(root, path, table, limit, offset)
    }
  )

  ipcMain.handle(
    IPC.PROJECT_SQLITE_INSERT_ROW,
    async (_, root: string, path: string, table: string, values: Record<string, unknown>) => {
      return await sqliteWorkerClient.insertRow(root, path, table, values)
    }
  )

  ipcMain.handle(
    IPC.PROJECT_SQLITE_UPDATE_ROW,
    async (_, root: string, path: string, table: string, key: unknown, values: Record<string, unknown>) => {
      return await sqliteWorkerClient.updateRow(root, path, table, key, values)
    }
  )

  ipcMain.handle(IPC.PROJECT_SQLITE_DELETE_ROW, async (_, root: string, path: string, table: string, key: unknown) => {
    return await sqliteWorkerClient.deleteRow(root, path, table, key)
  })

  ipcMain.handle(IPC.PROJECT_SQLITE_EXECUTE, async (_, root: string, path: string, sql: string) => {
    return await sqliteWorkerClient.execute(root, path, sql)
  })

  ripgrepSearchManager = new RipgrepSearchManager()

  ipcMain.handle(IPC.PROJECT_SEARCH_START, async (_, options: {
    searchId?: string
    rootPath: string
    query: string
    isRegex: boolean
    isCaseSensitive: boolean
    isWholeWord: boolean
    includeGlob?: string
    excludeGlob?: string
    maxResults?: number
  }) => {
    const searchId = ripgrepSearchManager!.start(mainWindow, options)
    return { searchId }
  })

  ipcMain.handle(IPC.PROJECT_SEARCH_CANCEL, async () => {
    ripgrepSearchManager?.cancel()
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_TREE_WATCH_START, (_event, cwd: string) => {
    if (typeof cwd !== 'string' || cwd.length === 0) return { success: false }
    projectTreeWatchManager?.start(cwd)
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_TREE_WATCH_STOP, (_event, cwd: string) => {
    if (typeof cwd !== 'string' || cwd.length === 0) return { success: false }
    projectTreeWatchManager?.stop(cwd)
    return { success: true }
  })

  // Settings storage handlers
  const settingsStorage = getSettingsStorage()
  const shortcutManager = getShortcutManager()

  // Set main window for shortcut manager
  shortcutManager.setMainWindow(mainWindow)

  // Load settings
  ipcMain.handle(IPC.SETTINGS_LOAD, () => {
    return settingsStorage.get()
  })

  // Save settings
  ipcMain.handle(IPC.SETTINGS_SAVE, (_, settings: SettingsState) => {
    const success = settingsStorage.save(settings)
    if (success) {
      // Re-register shortcuts when settings change
      shortcutManager.registerFromSettings()
      options.onSettingsChanged?.(settingsStorage.get())
    }
    return success
  })

  // Update settings (partial)
  ipcMain.handle(IPC.SETTINGS_UPDATE, (_, partial: Partial<SettingsState>) => {
    const success = settingsStorage.update(partial)
    if (success) {
      // Re-register shortcuts when settings change
      shortcutManager.registerFromSettings()
      options.onSettingsChanged?.(settingsStorage.get())
    }
    return success
  })

  // Register shortcuts from current settings
  ipcMain.handle(IPC.SETTINGS_REGISTER_SHORTCUTS, () => {
    return shortcutManager.registerFromSettings()
  })

  // Check if a shortcut is available
  ipcMain.handle(IPC.SETTINGS_CHECK_SHORTCUT_AVAILABLE, (_, accelerator: string) => {
    return shortcutManager.isShortcutAvailable(accelerator)
  })

  // Check if a shortcut conflicts with existing settings
  ipcMain.handle(IPC.SETTINGS_CHECK_SHORTCUT_CONFLICT, (_, accelerator: string, excludeKey?: string) => {
    return shortcutManager.checkConflict(accelerator, excludeKey as keyof ShortcutConfig)
  })

  // Initialize shortcuts on app start
  shortcutManager.registerFromSettings()
}

/**
 * Set window-level shortcut handling
 * Use before-input-event to intercept keyboard events before Chromium handles them
 */
export function setupWindowShortcuts(mainWindow: BrowserWindow): void {
  const settingsStorage = getSettingsStorage()

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    const settings = settingsStorage.get()
    const shortcuts = settings.shortcuts

    // Build accelerator format
    const parts: string[] = []
    if (input.meta) parts.push('CommandOrControl')
    if (input.control && !input.meta) parts.push('Control')
    if (input.alt) parts.push('Alt')
    if (input.shift) parts.push('Shift')

    let key = input.key
    if (key.length === 1) key = key.toUpperCase()
    parts.push(key)

    const accelerator = parts.join('+')

    // focusTerminal 1-6
    for (let i = 1; i <= 6; i++) {
      const shortcutKey = `focusTerminal${i}` as keyof typeof shortcuts
      if (shortcuts[shortcutKey] === accelerator) {
        event.preventDefault()
        mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'focusTerminal', index: i })
        return
      }
    }

    // switchTab 1-6
    for (let i = 1; i <= 6; i++) {
      const shortcutKey = `switchTab${i}` as keyof typeof shortcuts
      if (shortcuts[shortcutKey] === accelerator) {
        event.preventDefault()
        mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'switchTab', index: i })
        return
      }
    }

    // focusPromptEditor
    if (shortcuts.focusPromptEditor === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'focusPromptEditor' })
      return
    }

    // addToHistory
    if (shortcuts.addToHistory === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'addToHistory' })
      return
    }

    // terminalGitDiff
    if (shortcuts.terminalGitDiff === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'terminalGitDiff' })
      return
    }

    // terminalGitHistory
    if (shortcuts.terminalGitHistory === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'terminalGitHistory' })
      return
    }

    // terminalChangeWorkDir
    if (shortcuts.terminalChangeWorkDir === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'terminalChangeWorkDir' })
      return
    }

    // terminalOpenWorkDir
    if (shortcuts.terminalOpenWorkDir === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'terminalOpenWorkDir' })
      return
    }

    // terminalProjectEditor
    if (shortcuts.terminalProjectEditor === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'terminalProjectEditor' })
      return
    }

    // viewGitDiff
    if (shortcuts.viewGitDiff === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'viewGitDiff' })
    }
  })
}

export function cleanupIpcHandlers(): void {
  // Dispose all terminal data buffers
  for (const [, buf] of terminalDataBuffers) {
    buf.dispose()
  }
  terminalDataBuffers.clear()
  terminalFastPathState.clear()
  terminalOutputVisibilityState.clear()
  if (terminalIpcDiagTimer) {
    clearInterval(terminalIpcDiagTimer)
    terminalIpcDiagTimer = null
  }

  gitWatchManager?.dispose()
  gitWatchManager = null
  gitIpcWorkerClient.dispose()
  sqliteWorkerClient.dispose()
  getAppStateStorage().dispose()
  projectFsWorkerClient.dispose()
  ripgrepSearchManager?.dispose()
  ripgrepSearchManager = null
  fileWatchManager?.dispose()
  fileWatchManager = null
  imageWatchManager?.dispose()
  imageWatchManager = null
  projectTreeWatchManager?.dispose()
  projectTreeWatchManager = null
  gitDiffCacheInvalidator.dispose()
  ipcMain.removeHandler(IPC.APP_GET_INFO)
  ipcMain.removeHandler(IPC.FEEDBACK_LOAD)
  ipcMain.removeHandler(IPC.FEEDBACK_UPDATE_PREFERENCES)
  ipcMain.removeHandler(IPC.FEEDBACK_CREATE_SUBMISSION)
  ipcMain.removeHandler(IPC.FEEDBACK_SYNC)
  ipcMain.removeHandler(IPC.FEEDBACK_REOPEN_IN_BROWSER)
  ipcMain.removeHandler(IPC.FEEDBACK_REMOVE_RECORD)
  ipcMain.removeHandler(IPC.DEBUG_FEEDBACK_RESET)
  ipcMain.removeHandler(IPC.DEBUG_FEEDBACK_SET_MOCK_ISSUES)
  ipcMain.removeHandler(IPC.DEBUG_FEEDBACK_GET_LAST_OPENED_URL)
  ipcMain.removeHandler(IPC.APP_READ_NOTICE)
  ipcMain.removeHandler(IPC.UPDATER_GET_STATUS)
  ipcMain.removeHandler(IPC.UPDATER_CHECK_NOW)
  ipcMain.removeHandler(IPC.UPDATER_DOWNLOAD_NOW)
  ipcMain.removeHandler(IPC.UPDATER_RESTART_TO_UPDATE)
  ipcMain.removeHandler(IPC.UPDATER_DISMISS_BANNER)
  ipcMain.removeHandler(IPC.TERMINAL_CREATE)
  ipcMain.removeHandler(IPC.TERMINAL_WRITE)
  ipcMain.removeHandler(IPC.TERMINAL_SEND_INPUT_SEQUENCE)
  ipcMain.removeHandler(IPC.TERMINAL_GET_INPUT_CAPABILITIES)
  ipcMain.removeAllListeners(IPC.TERMINAL_SET_BUFFER_FAST_PATH)
  ipcMain.removeAllListeners(IPC.TERMINAL_SET_OUTPUT_VISIBILITY)
  ipcMain.removeAllListeners(IPC.TERMINAL_NOTIFY_INTERACTIVE_INPUT)
  ipcMain.removeHandler(IPC.TERMINAL_RESIZE)
  ipcMain.removeHandler(IPC.TERMINAL_DISPOSE)
  ipcMain.removeHandler(IPC.PROMPT_LOAD)
  ipcMain.removeHandler(IPC.PROMPT_SAVE)
  ipcMain.removeHandler(IPC.PROMPT_DELETE)
  ipcMain.removeHandler(IPC.TERMINAL_CONFIG_LOAD)
  ipcMain.removeHandler(IPC.TERMINAL_CONFIG_SAVE)
  ipcMain.removeHandler(IPC.TERMINAL_CONFIG_UPDATE)
  ipcMain.removeHandler(IPC.DIALOG_OPEN_DIRECTORY)
  ipcMain.removeHandler(IPC.DIALOG_OPEN_TEXT_FILE)
  ipcMain.removeHandler(IPC.DIALOG_SAVE_TEXT_FILE)
  ipcMain.removeHandler(IPC.SHELL_OPEN_PATH)
  ipcMain.removeHandler(IPC.SHELL_OPEN_EXTERNAL)
  ipcMain.removeHandler(IPC.CLIPBOARD_WRITE_TEXT)
  ipcMain.removeHandler(IPC.CLIPBOARD_READ_TEXT)
  browserViewManager.destroyAll()
  ipcMain.removeHandler(IPC.BROWSER_CREATE)
  ipcMain.removeHandler(IPC.BROWSER_DESTROY)
  ipcMain.removeHandler(IPC.BROWSER_NAVIGATE)
  ipcMain.removeHandler(IPC.BROWSER_GO_BACK)
  ipcMain.removeHandler(IPC.BROWSER_GO_FORWARD)
  ipcMain.removeHandler(IPC.BROWSER_RELOAD)
  ipcMain.removeHandler(IPC.BROWSER_STOP)
  ipcMain.removeHandler(IPC.BROWSER_SET_BOUNDS)
  ipcMain.removeHandler(IPC.BROWSER_SHOW)
  ipcMain.removeHandler(IPC.BROWSER_HIDE)
  ipcMain.removeHandler(IPC.BROWSER_GET_NAV_STATE)
  ipcMain.removeHandler(IPC.BROWSER_CLEAR_COOKIES)
  ipcMain.removeHandler(IPC.BROWSER_SET_REMEMBER_COOKIES)
  ipcMain.removeHandler(IPC.BROWSER_SHOW_COOKIE_MENU)
  ipcMain.removeHandler(IPC.COMMAND_PRESET_LOAD)
  ipcMain.removeHandler(IPC.COMMAND_PRESET_SAVE)
  ipcMain.removeHandler(IPC.COMMAND_PRESET_DELETE)
  ipcMain.removeHandler(IPC.CODING_AGENT_CONFIG_LOAD)
  ipcMain.removeHandler(IPC.CODING_AGENT_CONFIG_SAVE)
  ipcMain.removeHandler(IPC.CODING_AGENT_CONFIG_UPDATE)
  ipcMain.removeHandler(IPC.CODING_AGENT_CONFIG_DELETE)
  ipcMain.removeHandler(IPC.CODING_AGENT_PREPARE)
  ipcMain.removeHandler(IPC.CODING_AGENT_LAUNCH)
  ipcMain.removeHandler(IPC.APP_STATE_LOAD)
  ipcMain.removeHandler(IPC.APP_STATE_SAVE)
  ipcMain.removeHandler(IPC.APP_STATE_SAVE_PATCH)
  ipcMain.removeHandler(IPC.APP_STATE_FLUSH)
  ipcMain.removeHandler(IPC.GIT_CHECK_INSTALLED)
  ipcMain.removeHandler(IPC.GIT_RESOLVE_REPO_ROOT)
  ipcMain.removeHandler(IPC.GIT_GET_DIFF)
  ipcMain.removeHandler(IPC.GIT_GET_HISTORY)
  ipcMain.removeHandler(IPC.GIT_GET_HISTORY_DIFF)
  ipcMain.removeHandler(IPC.GIT_GET_HISTORY_FILE_CONTENT)
  ipcMain.removeHandler(IPC.GIT_GET_FILE_CONTENT)
  ipcMain.removeHandler(IPC.GIT_SAVE_FILE_CONTENT)
  ipcMain.removeHandler(IPC.GIT_STAGE_FILE)
  ipcMain.removeHandler(IPC.GIT_UNSTAGE_FILE)
  ipcMain.removeHandler(IPC.GIT_DISCARD_FILE)
  ipcMain.removeHandler(IPC.GIT_UPDATE_INDEX_CONTENT)
  ipcMain.removeHandler(IPC.GIT_GET_TERMINAL_CWD)
  ipcMain.removeHandler(IPC.GIT_GET_TERMINAL_INFO)
  ipcMain.removeHandler(IPC.GIT_SUBSCRIBE_TERMINAL_INFO)
  ipcMain.removeHandler(IPC.GIT_UNSUBSCRIBE_TERMINAL_INFO)
  ipcMain.removeHandler(IPC.GIT_NOTIFY_TERMINAL_ACTIVITY)
  ipcMain.removeHandler(IPC.GIT_NOTIFY_TERMINAL_FOCUS)
  ipcMain.removeHandler(IPC.GIT_NOTIFY_TERMINAL_GIT_UPDATE)
  ipcMain.removeHandler(IPC.PROJECT_LIST_DIRECTORY)
  ipcMain.removeHandler(IPC.PROJECT_BUILD_FILE_INDEX)
  ipcMain.removeHandler(IPC.PROJECT_SEARCH_FILENAMES)
  ipcMain.removeHandler(IPC.PROJECT_INVALIDATE_FILE_INDEX)
  ipcMain.removeHandler(IPC.PROJECT_READ_FILE)
  ipcMain.removeHandler(IPC.PROJECT_SAVE_FILE)
  ipcMain.removeHandler(IPC.PROJECT_CREATE_FILE)
  ipcMain.removeHandler(IPC.PROJECT_CREATE_FOLDER)
  ipcMain.removeHandler(IPC.PROJECT_RENAME_PATH)
  ipcMain.removeHandler(IPC.PROJECT_DELETE_PATH)
  ipcMain.removeHandler(IPC.PROJECT_SEARCH_START)
  ipcMain.removeHandler(IPC.PROJECT_SEARCH_CANCEL)
  ipcMain.removeHandler(IPC.PROJECT_TREE_WATCH_START)
  ipcMain.removeHandler(IPC.PROJECT_TREE_WATCH_STOP)
  ipcMain.removeHandler(IPC.PROJECT_WATCH_FILE)
  ipcMain.removeHandler(IPC.PROJECT_UNWATCH_FILE)
  ipcMain.removeHandler(IPC.PROJECT_WATCH_IMAGE_FILES)
  ipcMain.removeHandler(IPC.PROJECT_UNWATCH_IMAGE_FILES)
  ipcMain.removeHandler(IPC.PROJECT_UNWATCH_ALL_IMAGE_FILES)
  ipcMain.removeHandler(IPC.SETTINGS_LOAD)
  ipcMain.removeHandler(IPC.SETTINGS_SAVE)
  ipcMain.removeHandler(IPC.SETTINGS_UPDATE)
  ipcMain.removeHandler(IPC.SETTINGS_REGISTER_SHORTCUTS)
  ipcMain.removeHandler(IPC.SETTINGS_CHECK_SHORTCUT_AVAILABLE)
  ipcMain.removeHandler(IPC.SETTINGS_CHECK_SHORTCUT_CONFLICT)
  ipcMain.removeHandler(IPC.TELEMETRY_TRACK)
  ipcMain.removeHandler(IPC.TELEMETRY_GET_CONSENT)
  ipcMain.removeHandler(IPC.TELEMETRY_SET_CONSENT)
  ipcMain.removeHandler(IPC.DEBUG_GET_APP_METRICS)
  ipcMain.removeHandler(IPC.DEBUG_FOCUS_WINDOW)
  ipcMain.removeHandler(IPC.DEBUG_GET_GIT_RUNTIME_METRICS)
  ipcMain.removeHandler(IPC.DEBUG_GET_MAIN_WORK_METRICS)
  ipcMain.removeHandler(IPC.DEBUG_GET_PERF_TRACE_INFO)
  ipcMain.removeHandler(IPC.DEBUG_RESET_PERF_TRACE_METRICS)
  ipcMain.removeHandler(IPC.DEBUG_READ_TELEMETRY_LOG)
  ipcMain.removeHandler(IPC.DEBUG_QUIT)
  ipcMain.removeAllListeners(IPC.DEBUG_LOG)
  ipcMain.removeAllListeners(IPC.DEBUG_PERF_TRACE)
  ipcMain.removeAllListeners(IPC.TERMINAL_BUFFER_RESPONSE)
  ipcMain.removeAllListeners(IPC.PROMPT_BRIDGE_RESPONSE)
  // Clear all pending buffer requests
  for (const [, pending] of bufferRequestCallbacks) {
    clearTimeout(pending.timer)
  }
  bufferRequestCallbacks.clear()
  // Clean up all pending Prompt Bridge requests
  for (const [, pending] of promptBridgeCallbacks) {
    clearTimeout(pending.timer)
  }
  promptBridgeCallbacks.clear()
  ptyManager.disposeAll()
  // Unregister all shortcuts
  getShortcutManager().unregisterAll()
}
