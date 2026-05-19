/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { CLICK_PHASE_EVENT_NAMES } from './click-phase-event-names.ts'

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
  MAIN_IPC_PROJECT_READ_FILE_CHUNK: 'main:ipc.project.read-file-chunk',
  MAIN_IPC_PROJECT_SAVE_FILE: 'main:ipc.project.save-file',
  MAIN_IPC_GIT_GET_DIFF: 'main:ipc.git.get-diff',
  MAIN_IPC_GIT_GET_FILE_CONTENT: 'main:ipc.git.get-file-content',
  MAIN_IPC_GIT_GET_HISTORY: 'main:ipc.git.get-history',
  MAIN_IPC_TERMINAL_SPAWN: 'main:ipc.terminal.spawn',

  // ───────── Main process — PTY child process lifecycle ─────────
  // Covers every node-pty spawn, so terminal-startup cost and abnormal
  // exits are visible per terminalId instead of only the 1s aggregate.
  MAIN_PTY_SPAWN: 'main:pty.spawn',
  MAIN_PTY_EXIT: 'main:pty.exit',
  MAIN_PTY_KILL: 'main:pty.kill',

  // ───────── Main process — Git CLI per-exec latency ─────────
  // One ph='X' slice per execFile(git ...) call; tagged with the first
  // arg as `subcommand` so Perfetto SQL can group by `status`/`diff`/etc.
  MAIN_GIT_EXEC: 'main:git.exec',

  // ───────── Main process — non-git child-process exec ─────────
  // `git-utils.ts::execFileAsync` is also used for adjacent probes
  // (lsof for terminal cwd, future helpers). Routing those to a
  // distinct event name keeps `main:git.exec` honest — so percentile
  // queries on git pressure do not accidentally include lsof spawns.
  MAIN_PROC_EXEC: 'main:proc.exec',

  // ───────── Main process — updater/installer child-process spawns ─────────
  // Downloads/installers that Onward fires off via child_process.
  MAIN_UPDATER_SPAWN: 'main:updater.spawn',

  // ───────── Workers — ripgrep process lifecycle (inside rg worker) ─────────
  // Runs on the ripgrep Node Worker Thread; forwarded to the main
  // trace file through parentPort -> performanceTrace.
  WORKER_RIPGREP_PROCESS_SPAWN: 'worker.ripgrep:process.spawn',
  WORKER_RIPGREP_PROCESS_EXIT: 'worker.ripgrep:process.exit',

  // ───────── Workers — markdown preview (renderer Web Worker) ─────────
  // Emitted by the renderer-side client when a postMessage response
  // returns; carries the worker-measured parse+highlight+katex duration.
  WORKER_MARKDOWN_RENDER_COMPLETE: 'worker.markdown:render-complete',

  // ───────── PTY data flow — per-Task tid lane ─────────
  // Every event in this block is emitted on the per-terminal virtual
  // tid managed by `performance-trace::assignTaskTid`. Main-side task
  // lanes are `pid=1 tid>=10000`; renderer-side are `pid=2 tid>=20000`.
  // The first emission for a terminalId auto-writes a thread_name
  // metadata packet `task-<shortId>` so Perfetto UI shows each Task
  // as its own row.
  MAIN_TERMINAL_DATA_IPC_SEND: 'main:terminal-data.ipc-send',
  MAIN_PTY_WRITE: 'main:pty.write',
  RENDERER_TERMINAL_DATA_IPC_RECV: 'renderer:terminal-data.ipc-recv',
  RENDERER_TERMINAL_DATA_FAST_PATH: 'renderer:terminal-data.fast-path',
  RENDERER_TERMINAL_DATA_SCHEDULER_ENQUEUE: 'renderer:terminal-data.scheduler-enqueue',
  RENDERER_TERMINAL_DATA_SCHEDULER_FLUSH: 'renderer:terminal-data.scheduler-flush',
  RENDERER_TERMINAL_DATA_XTERM_WRITE: 'renderer:terminal-data.xterm-write',

  // ───────── GUI entries (new) ─────────
  RENDERER_TAB_CREATE: 'renderer:tab.create',
  RENDERER_TAB_SWITCH: 'renderer:tab.switch',
  RENDERER_TERMINAL_SPLIT_ADD: 'renderer:terminal.split-add',
  RENDERER_GITDIFF_OPEN: 'renderer:gitdiff.open',
  RENDERER_GITHISTORY_OPEN: 'renderer:githistory.open',
  RENDERER_SETTINGS_OPEN: 'renderer:settings.open',
  RENDERER_CHANGELOG_OPEN: 'renderer:changelog.open',

  // ───────── Background — project file index + tree watch ─────────
  MAIN_FILE_INDEX_BUILD: 'main:file-index.build',
  MAIN_FILE_INDEX_UPDATE: 'main:file-index.update',
  MAIN_PROJECT_TREE_WATCH_EVENT: 'main:project-tree-watch.event',
  MAIN_PROJECT_TREE_WATCH_BATCH: 'main:project-tree-watch.batch',
  MAIN_PROJECT_TREE_WATCH_IGNORED_SUMMARY: 'main:project-tree-watch.ignored-summary',

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
  // Right-click on the prompt input textarea opens a custom context menu
  // (cut/copy/paste/paste-plain, import pinned, save-as-pinned, insert
  // cwd/branch/task title, history, format tools, send-to-task, clear).
  // Instant marker (ph='i') with payload counts so usage frequency and
  // populated submenus are observable without leaking content.
  RENDERER_PROMPT_EDITOR_CTX_MENU_OPEN: 'renderer:prompt.editor.ctx-menu-open',
  // Measures the renderer-side layout pass that keeps Send-to-Task and
  // Import Pin submenus inside the viewport. Args contain only geometry
  // and clamp metadata; no prompt or pinned-prompt content is recorded.
  RENDERER_PROMPT_EDITOR_CTX_SUBMENU_LAYOUT: 'renderer:prompt.editor.ctx-submenu-layout',
  // User changed the global Prompt input mode preference from the title-row
  // selector. Args carry the target mode and tab count only.
  RENDERER_PROMPT_INPUT_MODE_CHANGE: 'renderer:prompt.input-mode-change',
  // Mousedown past EOL/EOF physically pads the textarea value with spaces
  // and newlines, then setSelectionRange to the target. Args carry a
  // breakdown of the input → paint pipeline:
  //   measureMs / handlerMs — synchronous work (cell metrics + value mutate)
  //   caretMs / paintMs / durationMs — outer rAF (caret) + inner rAF (paint)
  // resolvePhase() promotes events with `durationMs` to ph='X' span, so
  // slice.dur SQL queries work directly. row/col/padded retained for
  // outlier hunting (wild clicks generating KB-scale padding).
  RENDERER_PROMPT_EDITOR_VIRTUAL_CARET: 'renderer:prompt.editor.virtual-caret',

  // ───────── Renderer — user input: terminal ─────────
  RENDERER_TERMINAL_FOCUS_CHANGE: 'renderer:terminal.focus-change',
  // Right-click on a Task terminal content area opens the custom terminal
  // context menu. Args carry only selection and pinned-prompt counts.
  RENDERER_TERMINAL_CTX_MENU_OPEN: 'renderer:terminal.ctx-menu-open',
  // Selecting a pinned Prompt from the terminal context menu dispatches it
  // to the right-clicked Task. Args carry payload byte count, never content.
  RENDERER_TERMINAL_CTX_PINNED_PROMPT_SEND: 'renderer:terminal.ctx-pinned-prompt-send',
  RENDERER_TERMINAL_SEND_INPUT: 'renderer:terminal.send-input',

  // ───────── Renderer — user input: project editor ─────────
  RENDERER_PROJECT_FILE_OPEN: 'renderer:project.file-open',
  RENDERER_PROJECT_HTML_PREVIEW_RELOAD: 'renderer:project.html-preview-reload',
  RENDERER_PROJECT_HTML_PREVIEW_SEARCH: 'renderer:project.html-preview-search',
  RENDERER_PROJECT_HTML_PREVIEW_ZOOM: 'renderer:project.html-preview-zoom',
  RENDERER_PROJECT_FILE_BROWSER_COLLAPSE: 'renderer:project.file-browser-collapse',
  RENDERER_PROJECT_EDITOR_REOPEN_RESTORE: 'renderer:project.editor-reopen-restore',
  RENDERER_PROJECT_SUBPAGE_NAVIGATE: 'renderer:project.subpage-navigate',
  RENDERER_PROJECT_SEARCH_GLOBAL: 'renderer:project.search.global',

  // ───────── Renderer — IPC bridge latency (end-to-end) ─────────
  // Wrap `window.electronAPI.*` hot-path calls with a `ph:'X'` span so
  // renderer→main→renderer round trips show up on the renderer thread
  // track alongside the input events that triggered them.
  RENDERER_IPC_PROJECT_READ_FILE: 'renderer:ipc.project.read-file',
  RENDERER_IPC_PROJECT_READ_FILE_CHUNK: 'renderer:ipc.project.read-file-chunk',
  RENDERER_IPC_GIT_GET_DIFF: 'renderer:ipc.git.get-diff',
  RENDERER_IPC_TERMINAL_WRITE: 'renderer:ipc.terminal.write',

  // ───────── Renderer — async rendering hot paths ─────────
  RENDERER_MARKDOWN_RENDER: 'renderer:markdown.render',
  RENDERER_MARKDOWN_SANITIZE: 'renderer:markdown.dompurify-sanitize',
  RENDERER_MARKDOWN_MERMAID: 'renderer:markdown.mermaid-render',
  // Instant event emitted when preview restore reaches phase:idle. Payload:
  // cause, hadWork (whether any markdown/worker/mermaid signal was pending
  // during this restore cycle), durationMs.
  RENDERER_MARKDOWN_PREVIEW_REVEAL: 'renderer:markdown.preview-reveal',
  RENDERER_MARKDOWN_SESSION_CACHE_CAPTURE: 'renderer:markdown.session-cache-capture',
  RENDERER_MONACO_VIEWSTATE_RESTORE: 'renderer:monaco.viewstate-restore',
  RENDERER_XTERM_WEBGL_INIT: 'renderer:xterm.webgl-context-init',

  // ───────── Renderer — terminal renderer surface lifecycle ─────────
  // Tracks the WebGL renderer lifecycle behind the "blank Task after
  // desktop swipe" failure mode. The VS Code-aligned path lets xterm's
  // WebglAddon report unrecovered context loss, then disposes WebGL so
  // xterm's DOM renderer can keep the live terminal buffer visible.
  RENDERER_XTERM_RENDERER_CONTEXT_LOST: 'renderer:xterm.renderer.context-lost',
  RENDERER_XTERM_RENDERER_CONTEXT_RESTORED: 'renderer:xterm.renderer.context-restored',
  RENDERER_XTERM_RENDERER_RESTORE_DEFERRED: 'renderer:xterm.renderer.restore-deferred',
  RENDERER_XTERM_RENDERER_REFRESH_AFTER_RESTORE: 'renderer:xterm.renderer.refresh-after-restore',
  RENDERER_XTERM_RENDERER_CONTEXT_LOSS_FALLBACK: 'renderer:xterm.renderer.context-loss-fallback',
  RENDERER_XTERM_RENDERER_ENSURE_WEBGL: 'renderer:xterm.renderer.ensure-webgl',
  RENDERER_XTERM_RENDERER_DISPOSE_WEBGL: 'renderer:xterm.renderer.dispose-webgl',
  RENDERER_XTERM_RENDERER_FAILURE: 'renderer:xterm.renderer.failure',

  // ───────── Main process — Git Diff cache & freshness ─────────
  // Bug 1: parent-repo file list erroneously surfaces submodule entries when
  // only the submodule's internal worktree (m/u flags) is dirty — the parent
  // index has nothing to show. The filter event records each submodule entry
  // decision at parse time so SQL can verify "kept iff c=C" against a trace.
  // Bug 2: the 3-second request cache returned stale data after FS mutations
  // because invalidation was time-based. The GitStateMirror authority now
  // emits the FS-driven freshness signal; this layer records cache-hit /
  // cache-invalidate plus subpage.freshness-check on Diff/Editor/History entry.
  MAIN_GIT_DIFF_CACHE_HIT: 'main:git.diff.cache-hit',
  MAIN_GIT_DIFF_CACHE_INVALIDATE: 'main:git.diff.cache-invalidate',
  // Retired: kept so old trace readers can parse historical captures.
  MAIN_GIT_DIFF_FS_WATCH_EVENT: 'main:git.diff.fs-watch-event',
  MAIN_GIT_DIFF_SUBMODULE_FILTER: 'main:git.diff.submodule-filter',
  MAIN_GIT_DIFF_CONTENT_CACHE_HIT: 'main:git.diff.content-cache.hit',
  MAIN_GIT_DIFF_CONTENT_CACHE_MISS: 'main:git.diff.content-cache.miss',
  MAIN_GIT_DIFF_CONTENT_CACHE_INVALIDATE_PROJECT: 'main:git.diff.content-cache.invalidate-project',
  MAIN_GIT_DIFF_CONTENT_CACHE_INVALIDATE_LRU: 'main:git.diff.content-cache.invalidate-lru',
  MAIN_GIT_DIFF_PRECOMPUTE_SCHEDULE: 'main:git.diff.precompute.schedule',
  MAIN_GIT_DIFF_PRECOMPUTE_SKIP_TOO_LARGE: 'main:git.diff.precompute.skip-too-large',
  RENDERER_SUBPAGE_FRESHNESS_CHECK: 'renderer:subpage.freshness-check',

  // ───────── Main process — Git Repository Snapshot Service ─────────
  // Lesson #13 follow-up: the read-side surface (Diff / History / Editor
  // scope / Quick Open) had three independent code paths that each carried
  // partial submodule semantics — `parseStatusPorcelainV2Z`,
  // `collectSubmodulesFromGitmodules`, and `filterMeaninglessSubmoduleEntries`.
  // The snapshot service is the canonical place where ".gitmodules + git
  // submodule status + getGitRepoMeta validation" converge into one
  // immutable structural answer. Every consumer that needs "what are the
  // submodules of this cwd?" goes through this service.
  //
  // Phase 1 (this round) migrates loadGitDiff. Later phases will migrate
  // History, Editor scope + Quick Open. The trace events let us observe
  // cache health (capture vs hit) and detect stale-cache regressions long
  // before they become user-visible bugs.
  MAIN_GIT_SNAPSHOT_CAPTURE: 'main:git.snapshot.capture',
  MAIN_GIT_SNAPSHOT_CACHE_HIT: 'main:git.snapshot.cache-hit',
  MAIN_GIT_SNAPSHOT_INVALIDATE: 'main:git.snapshot.invalidate',

  // ───────── Renderer — Task name auto-follow Git branch ─────────
  // (a) RENDERER_TASK_NAME_RESOLVE: ph='i' instant marker emitted whenever
  // the auto-follow rule decides what to do for a given terminal on a
  // GIT_TERMINAL_INFO update. payload = { taskId, source: 'manual'|
  // 'auto-branch'|'cleared-by-repo-switch'|'fallback'|'skipped-disabled',
  // autoFollow, repoRoot, branch }. Lets traces explain *why* a name
  // changed (or didn't).
  // (b) RENDERER_TASK_NAME_MANUAL_CLEAR: ph='i' fired when the cwd has
  // moved to a different repo and the previous manual override has just
  // been erased by the rule. payload = { taskId, prevRepoRoot, newRepoRoot,
  // newBranch }. Useful for verifying user-visible "manual name expired"
  // moments line up with what the SQL queries expect.
  RENDERER_TASK_NAME_RESOLVE: 'renderer:task-name.resolve',
  RENDERER_TASK_NAME_MANUAL_CLEAR: 'renderer:task-name.manual-clear',

  // ───────── Renderer — Task layout (8-grid + Custom) ─────────
  // Layout transitions ride the renderer thread because TerminalGrid has
  // to recompute grid-column / grid-row for every Task cell and run
  // FitAddon resizes. All four events are emitted as ph='i' instants
  // (the existing renderer perfTrace wrapper only emits instants) and
  // carry a `durationMs` payload field on transitions so SQL queries can
  // still build latency histograms via `args.durationMs`.
  // (a) APPLY: every layoutMode → displayLayoutMode transition that
  //     completes (ensureReady resolved). Captures transitionMs.
  // (b) EDITOR_OPEN: when CustomLayoutEditor mounts.
  // (c) DOWNSIZE_DIALOG_OPEN: when DownsizeConfirmDialog mounts.
  // (d) TERMINAL_DESTROY_BY_DOWNSIZE: per-Task destroy emitted before
  //     terminalSessionManager.dispose; tagged with the per-Task tid via
  //     perfTraceTask so it lines up on the Task's row in Perfetto.
  RENDERER_CUSTOM_LAYOUT_APPLY: 'renderer:custom-layout.apply',
  RENDERER_CUSTOM_LAYOUT_EDITOR_OPEN: 'renderer:custom-layout.editor-open',
  RENDERER_DOWNSIZE_DIALOG_OPEN: 'renderer:downsize-dialog.open',
  RENDERER_TERMINAL_DESTROY_BY_DOWNSIZE: 'renderer:terminal.destroy-by-downsize',

  // ───────── Autotest bundle-marker (V10 closed-loop check) ─────────
  // Emitted ONLY by the `debug:emit-bundle-marker` IPC, which is
  // gated on ONWARD_AUTOTEST=1. The diagnostic-bundle verifier's V10
  // check searches for an event with this exact name + matching args
  // in the bundled chunks, proving the operation→write→bundle→verify
  // closed loop is intact end-to-end. Production code paths must not
  // emit this name. The string is duplicated as a literal in
  // `electron/main/diagnostic-bundle.ts::AUTOTEST_BUNDLE_MARKER_NAME`
  // so the bundler stays decoupled from the registry; if you rename
  // here, also update there (and forever after — registry contract).
  AUTOTEST_BUNDLE_MARKER: 'autotest:bundle-marker',

  // ────────────────────────────────────────────────────────────────────
  // GitStateMirror refactor (worker-thread mirror + pub/sub IPC).
  //
  // The mirror is the single source of truth for branch / repo name /
  // status colour / file list / per-file diff body. These events bracket
  // the four critical paths the GSM autotest suite asserts on:
  //
  //   1. cwd switch:
  //        renderer:terminal.osc-cwd-detected   (xterm.js parses OSC)
  //          → main:git-state-mirror.cwd-switched   (router routes to worker)
  //          → worker:git-state-mirror.recompute-status-done   (git status)
  //          → main:git-state-mirror.fanout   (delta to subscribers)
  //          → renderer:terminal-title.{branch,color}-rendered   (DOM)
  //
  //   2. file mutation:
  //        worker:git-state-mirror.watcher-fire (or .watcher-filtered)
  //          → worker:git-state-mirror.recompute-status-done
  //          → main:git-state-mirror.fanout
  //          → renderer:git-diff.body-rendered (or terminal-title.*)
  //
  // The two `renderer:terminal-title.*` markers feed the GSM-01..09 latency
  // assertions; `worker:git-state-mirror.watcher-filtered` lets GDS-39
  // assert the .git whitelist is doing its job.
  RENDERER_TERMINAL_OSC_CWD_DETECTED: 'renderer:terminal.osc-cwd-detected',
  MAIN_GIT_STATE_MIRROR_CWD_SWITCHED: 'main:git-state-mirror.cwd-switched',
  WORKER_GIT_STATE_MIRROR_WATCHER_FIRE: 'worker:git-state-mirror.watcher-fire',
  WORKER_GIT_STATE_MIRROR_WATCHER_FILTERED: 'worker:git-state-mirror.watcher-filtered',
  WORKER_GIT_STATE_MIRROR_RECOMPUTE_DONE: 'worker:git-state-mirror.recompute-status-done',
  MAIN_GIT_STATE_MIRROR_FANOUT: 'main:git-state-mirror.fanout',
  MAIN_GIT_STATE_MIRROR_WORKER_SHUTDOWN: 'main:git-state-mirror.worker-shutdown',
  RENDERER_TERMINAL_TITLE_BRANCH_RENDERED: 'renderer:terminal-title.branch-rendered',
  RENDERER_TERMINAL_TITLE_COLOR_RENDERED: 'renderer:terminal-title.color-rendered',
  RENDERER_GIT_DIFF_MANUAL_REFRESH: 'renderer:git-diff.manual-refresh',
  RENDERER_GIT_DIFF_HUNK_NAVIGATE: 'renderer:git-diff.hunk-navigate',
  RENDERER_GIT_DIFF_HUNK_ACTION: 'renderer:git-diff.hunk-action',
  RENDERER_GIT_DIFF_HUNK_WIDGET_INSTALL: 'renderer:git-diff.hunk-widget-install',
  RENDERER_GIT_DIFF_BODY_PREFETCH: 'renderer:git-diff.body-prefetch',
  RENDERER_GIT_DIFF_FILE_LOAD: 'renderer:git-diff.file-load',
  RENDERER_GIT_DIFF_BODY_RENDERED: 'renderer:git-diff.body-rendered',
  RENDERER_GIT_DIFF_CACHE_INVALIDATION: 'renderer:git-diff.cache-invalidation',
  RENDERER_GIT_DIFF_FILE_LIST_MODE_CHANGE: 'renderer:git-diff.file-list-mode-change',
  RENDERER_GIT_DIFF_JUMP_TO_EDITOR: 'renderer:git-diff.jump-to-editor',
  RENDERER_GIT_DIFF_SPLIT_MODE_TOGGLE: 'renderer:git-diff.split-mode-toggle',
  RENDERER_PROJECT_EDITOR_JUMP_TO_DIFF: 'renderer:project-editor.jump-to-diff',

  // ───────── Renderer — Git Diff click → paint phase chain ─────────
  // Settled spans (ph='X') emitted once a click measurement seals. They
  // reproduce the JadeTree phase decomposition the in-app debug panel
  // surfaces, so a Perfetto trace contains the same diagnostic chain
  // without extracting it from `__onwardGitDiffDebug.getHistory()`.
  // Payload always carries `durationMs` (auto-routed to ph='X' by
  // performance-trace::resolvePhase) plus `fileKey` / `filename` /
  // `cacheState` / `totalMs` for joinability. The literal strings live
  // in `./click-phase-event-names.ts` (a leaf module imported by the
  // emitter and the registry alike) so renaming an event only happens
  // in one place.
  RENDERER_GIT_DIFF_CLICK_PHASE_IPC: CLICK_PHASE_EVENT_NAMES.IPC,
  RENDERER_GIT_DIFF_CLICK_PHASE_STATE_SET: CLICK_PHASE_EVENT_NAMES.STATE_SET,
  RENDERER_GIT_DIFF_CLICK_PHASE_MODEL_BIND: CLICK_PHASE_EVENT_NAMES.MODEL_BIND,
  RENDERER_GIT_DIFF_CLICK_PHASE_MOUNT: CLICK_PHASE_EVENT_NAMES.MOUNT,
  RENDERER_GIT_DIFF_CLICK_PHASE_DIFF_COMPUTE: CLICK_PHASE_EVENT_NAMES.DIFF_COMPUTE,
  RENDERER_GIT_DIFF_CLICK_PHASE_DOM_COMMIT: CLICK_PHASE_EVENT_NAMES.DOM_COMMIT,
  RENDERER_GIT_DIFF_CLICK_PHASE_PAINT: CLICK_PHASE_EVENT_NAMES.PAINT,
  RENDERER_GIT_DIFF_CLICK_PHASE_TOKENIZE_SETTLE: CLICK_PHASE_EVENT_NAMES.TOKENIZE_SETTLE,
  RENDERER_GIT_DIFF_CLICK_PHASE_COLD_MOUNT: CLICK_PHASE_EVENT_NAMES.COLD_MOUNT,
  RENDERER_GIT_DIFF_CLICK_PHASE_REVEAL_TIMEOUT: CLICK_PHASE_EVENT_NAMES.REVEAL_TIMEOUT,
  RENDERER_GIT_DIFF_CLICK_TOTAL: CLICK_PHASE_EVENT_NAMES.TOTAL
} as const

export type PerfTraceEventName = typeof PERF_TRACE_EVENT[keyof typeof PERF_TRACE_EVENT]
