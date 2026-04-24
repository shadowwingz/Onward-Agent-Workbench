/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single source of truth for perf-trace event names.
 *
 * CLAUDE.md Hard rule § 3 requires every trace event to register its
 * name here before instrumenting. The writer side (main or renderer)
 * imports these constants instead of writing string literals so the
 * name set can be grepped / refactored centrally and the Perfetto SQL
 * queries in `infra/trace.md` have a stable vocabulary.
 *
 * The full trace system index — including which events are emitted
 * today, which are planned, and how to extend — lives in
 * `infra/trace.md`. Keep both in sync when adding events.
 *
 * Naming convention:
 *   main:<dotted.subject>        — main process
 *   renderer:<dotted.subject>    — renderer process
 *   worker.<kind>:<dotted.subject> — Node Worker thread or utility proc
 *
 * Values are the literal strings written into Chrome trace JSON `name`
 * fields. Downstream tools (Perfetto UI, trace_processor_shell SQL)
 * match on these. Do NOT change an existing string — append new
 * constants instead.
 */
export const PERF_TRACE_EVENT = {
  // ───────── Main process — lifecycle ─────────
  MAIN_TRACE_START: 'main:trace-start',
  MAIN_TRACE_STOP: 'main:trace-stop',
  MAIN_APP_BEFORE_QUIT: 'main:app.before-quit',
  MAIN_APP_WILL_QUIT: 'main:app.will-quit',

  // ───────── Main process — event-loop + stall monitor ─────────
  MAIN_EVENT_LOOP_STALL: 'main:event-loop-stall',
  MAIN_EVENT_LOOP_METRICS_RESET: 'main:event-loop-metrics-reset',

  // ───────── Main process — Git subsystem ─────────
  MAIN_GIT_RUNTIME_SUMMARY: 'main:git-runtime-summary',
  MAIN_GIT_RUNTIME_SUMMARY_ERROR: 'main:git-runtime-summary-error',
  MAIN_GITWATCH_SUMMARY: 'main:gitwatch-summary',

  // ───────── Main process — renderer process lifecycle ─────────
  MAIN_RENDERER_PROCESS_GONE: 'main:renderer-process-gone',
  MAIN_RENDERER_UNRESPONSIVE: 'main:renderer-unresponsive',

  // ───────── Main process — terminal IPC summary ─────────
  MAIN_TERMINAL_DATA_IPC_SUMMARY: 'main:terminal-data-ipc-summary',

  // ───────── Main process — AppState persistence ─────────
  MAIN_APP_STATE_SAVE: 'main:app-state-save',
  MAIN_APP_STATE_SAVE_ERROR: 'main:app-state-save-error',

  // ───────── Main process — IPC hot paths (latency ph='X') ─────────
  // Newly instrumented; see `electron/main/ipc-handlers.ts`.
  MAIN_IPC_PROJECT_READ_FILE: 'main:ipc.project.read-file',
  MAIN_IPC_PROJECT_SAVE_FILE: 'main:ipc.project.save-file',
  MAIN_IPC_GIT_GET_DIFF: 'main:ipc.git.get-diff',
  MAIN_IPC_GIT_GET_HISTORY: 'main:ipc.git.get-history',
  MAIN_IPC_TERMINAL_SPAWN: 'main:ipc.terminal.spawn',

  // ───────── Workers — app-state ─────────
  WORKER_APP_STATE_LATENCY: 'main:app-state-worker-latency',
  WORKER_APP_STATE_TIMEOUT: 'main:app-state-worker-timeout',
  WORKER_APP_STATE_ERROR: 'main:app-state-worker-error',
  WORKER_APP_STATE_EXIT: 'main:app-state-worker-exit',

  // ───────── Workers — git-ipc ─────────
  WORKER_GIT_IPC_LATENCY: 'main:git-ipc-worker-latency',
  WORKER_GIT_IPC_TIMEOUT: 'main:git-ipc-worker-timeout',
  WORKER_GIT_IPC_ERROR: 'main:git-ipc-worker-error',
  WORKER_GIT_IPC_EXIT: 'main:git-ipc-worker-exit',

  // ───────── Workers — git-status ─────────
  WORKER_GIT_STATUS_LATENCY: 'main:git-status-worker-latency',
  WORKER_GIT_STATUS_TIMEOUT: 'main:git-status-worker-timeout',
  WORKER_GIT_STATUS_ERROR: 'main:git-status-worker-error',
  WORKER_GIT_STATUS_EXIT: 'main:git-status-worker-exit',

  // ───────── Workers — project-fs ─────────
  WORKER_PROJECT_FS_LATENCY: 'main:project-fs-worker-latency',
  WORKER_PROJECT_FS_TIMEOUT: 'main:project-fs-worker-timeout',
  WORKER_PROJECT_FS_ERROR: 'main:project-fs-worker-error',
  WORKER_PROJECT_FS_EXIT: 'main:project-fs-worker-exit',

  // ───────── Workers — sqlite ─────────
  WORKER_SQLITE_LATENCY: 'main:sqlite-worker-latency',
  WORKER_SQLITE_TIMEOUT: 'main:sqlite-worker-timeout',
  WORKER_SQLITE_ERROR: 'main:sqlite-worker-error',
  WORKER_SQLITE_EXIT: 'main:sqlite-worker-exit',

  // ───────── Workers — ripgrep (global search) ─────────
  WORKER_RIPGREP_LATENCY: 'main:ripgrep-worker-latency',
  WORKER_RIPGREP_TIMEOUT: 'main:ripgrep-worker-timeout',
  WORKER_RIPGREP_ERROR: 'main:ripgrep-worker-error',
  WORKER_RIPGREP_EXIT: 'main:ripgrep-worker-exit',
  WORKER_RIPGREP_BINARY_MISSING: 'main:ripgrep-binary-missing',
  WORKER_RIPGREP_START_ERROR: 'main:ripgrep-worker-start-error',

  // ───────── Renderer — lifecycle ─────────
  RENDERER_TRACE_START: 'renderer:trace-start',

  // ───────── Renderer — perf observers (existing) ─────────
  RENDERER_EVENT_LOOP_STALL: 'renderer:event-loop-stall',
  RENDERER_FRAME_STALL: 'renderer:frame-stall',
  RENDERER_LONGTASK: 'renderer:longtask',
  RENDERER_PROMPT_INPUT_PAINT: 'renderer:prompt-input-paint',
  RENDERER_PERF_SNAPSHOT: 'renderer:perf-snapshot',
  RENDERER_APPSTATE_SUMMARY: 'renderer:appstate-summary',

  // ───────── Renderer — Web events (window level) ─────────
  // Coverage per user request: "Web events + user input response".
  RENDERER_WINDOW_VISIBILITY_CHANGE: 'renderer:window.visibility-change',
  RENDERER_WINDOW_FOCUS: 'renderer:window.focus',
  RENDERER_WINDOW_BLUR: 'renderer:window.blur',
  RENDERER_WINDOW_PAGEHIDE: 'renderer:window.pagehide',

  // ───────── Renderer — user input: prompt ─────────
  RENDERER_PROMPT_EDITOR_SUBMIT: 'renderer:prompt.editor.submit',
  RENDERER_PROMPT_EDITOR_CANCEL: 'renderer:prompt.editor.cancel-edit',
  RENDERER_PROMPT_SENDER_DISPATCH: 'renderer:prompt.sender.dispatch',

  // ───────── Renderer — user input: terminal ─────────
  RENDERER_TERMINAL_FOCUS_CHANGE: 'renderer:terminal.focus-change',
  RENDERER_TERMINAL_SEND_INPUT: 'renderer:terminal.send-input',

  // ───────── Renderer — user input: project editor ─────────
  RENDERER_PROJECT_FILE_OPEN: 'renderer:project.file-open',
  RENDERER_PROJECT_SUBPAGE_NAVIGATE: 'renderer:project.subpage-navigate',
  RENDERER_PROJECT_SEARCH_GLOBAL: 'renderer:project.search.global',

  // ───────── Renderer — IPC bridge latency (end-to-end) ─────────
  // Wrap `window.electronAPI.*` hot-path calls with a `ph:'X'` span so
  // renderer→main→renderer round trips show up on the renderer thread
  // track alongside the input events that triggered them.
  RENDERER_IPC_PROJECT_READ_FILE: 'renderer:ipc.project.read-file',
  RENDERER_IPC_GIT_GET_DIFF: 'renderer:ipc.git.get-diff',
  RENDERER_IPC_TERMINAL_WRITE: 'renderer:ipc.terminal.write',

  // ───────── Renderer — async rendering hot paths ─────────
  RENDERER_MARKDOWN_RENDER: 'renderer:markdown.render',
  RENDERER_MARKDOWN_SANITIZE: 'renderer:markdown.dompurify-sanitize',
  RENDERER_MARKDOWN_MERMAID: 'renderer:markdown.mermaid-render',
  RENDERER_MONACO_VIEWSTATE_RESTORE: 'renderer:monaco.viewstate-restore',
  RENDERER_XTERM_WEBGL_INIT: 'renderer:xterm.webgl-context-init'
} as const

export type PerfTraceEventName = typeof PERF_TRACE_EVENT[keyof typeof PERF_TRACE_EVENT]
