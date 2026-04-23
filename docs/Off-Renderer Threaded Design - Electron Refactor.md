<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Off-Renderer Threaded Design: Electron Refactor

## Goal

The renderer main thread should only handle three categories of work:

1. User input: Prompt input, shortcuts, mouse events, and focus.
2. UI commit work: DOM mounting, layout measurement, xterm writes, and Monaco APIs.
3. Lightweight state switching: small objects, small lists, and bounded synchronous work.

Work that scales with large files, large lists, many Terminals, or many Tasks should not run in the renderer by default.

## Hard Rules

- CPU work that does not need the DOM should move to a Worker, utility process, or main worker.
- Refresh work that can be merged asynchronously must be batched; it must not trigger full React or Terminal updates for every event.
- Prompt input has the highest priority. Task output, Git status, search results, and AppState persistence must not preempt Prompt input.
- UI work that must remain in the renderer should still run through priority queues, rAF, idle callbacks, and budgeted slices.
- Every performance refactor must keep baseline JSON and compare Prompt input p95, p99, p999, and max latency, not only averages.

## Worker Targets

| Target | Suitable work |
|---|---|
| Renderer Web Worker | Markdown/HTML sanitization, JSON parse/stringify, list derivation, search ranking, pure CPU data transforms |
| Main worker thread | AppState persistence/normalization, Git, SQLite, project file indexing, file read transforms |
| Utility process | Future heavy CPU or unstable parser tasks that require stronger isolation |
| Renderer | DOM, focus, cursor, xterm.write, Monaco, context menus, visible-area measurement |

## Must Move Out Of Renderer

| Priority | Operation | Current location | Target |
|---|---|---|---|
| P0 | Markdown preview HTML sanitization | `src/components/ProjectEditor/ProjectEditor.tsx:2447` | Move to `markdownPreviewWorker` or a dedicated sanitizer worker; renderer only mounts safe HTML |
| P0 | AppState startup normalization | `src/contexts/AppStateContext.tsx:396` | Main process or AppState worker returns normalized state |
| P0 | Prompt import parsing and comparison | `src/App.tsx:399`, `src/App.tsx:408` | Worker parses, validates, and deduplicates; renderer only shows confirmation UI |
| P0 | Prompt export JSON.stringify | `src/App.tsx:378` | Worker or utility process assembles and serializes |
| P0 | Full Terminal buffer reads and concatenation | `src/terminal/terminal-session-manager.ts:405` | Keep bounded snapshots in renderer; move full processing to a Worker |
| P1 | ChangeLog Markdown parse and sanitize | `src/components/ChangeLogModal/ChangeLogModal.tsx:78`, `src/components/ChangeLogModal/ChangeLogModal.tsx:83` | Precompile, use a Worker, or process in main |
| P1 | Mermaid SVG generation | `src/utils/mermaidRenderer.ts:48` | Generate SVG in the background; renderer only mounts and adds interaction |
| P1 | Large search result apply/group rebuild | `src/components/ProjectEditor/GlobalSearch/useGlobalSearch.ts:165` | Worker keeps the result index; renderer consumes visible results in batches |
| P1 | Project file preview large-file conversion | `electron/main/project-editor-utils.ts:422` | Main worker converts; renderer does not receive unbounded payloads |
| P2 | Prompt task history derived statistics | `src/components/PromptNotebook/PromptNotebook.tsx:221` | Move to Worker or incremental index once data grows |
| P2 | Git Diff / Git History large-payload post-processing | `src/components/GitDiffViewer/GitDiffViewer.tsx:1306`, `src/components/GitHistoryViewer/GitHistoryViewer.tsx:920` | Move large dataset processing to main/Worker; renderer applies paged results |

## Can Stay In Renderer

| Operation | Current location | Constraint |
|---|---|---|
| Terminal output flush | `src/terminal/terminal-output-scheduler.ts:251` | Must continue through lanes, budgets, visibility, and Prompt priority |
| xterm.write | `src/terminal/terminal-session-manager.ts:1216` | Must remain in renderer but must not bypass `TerminalOutputScheduler` |
| Terminal visibility sync | `src/components/TerminalGrid/TerminalGrid.tsx:368` | Merge changes to avoid independent per-Terminal jitter |
| Terminal overflow/layout measurement | `src/components/TerminalGrid/TerminalGrid.tsx:767` | DOM measurement must remain in renderer, but only with rAF throttling and no continuous forced reflow |
| Terminal attach / detach / fit | `src/components/TerminalGrid/TerminalGrid.tsx:826`, `src/components/TerminalGrid/TerminalGrid.tsx:899` | Initialize in batches to avoid mounting the full cost of multiple Terminals in one frame |
| Preview DOM search / highlight | `src/components/ProjectEditor/PreviewSearch/usePreviewSearch.ts:32` | Can stay because it operates on DOM; needs debounce, limits, and visible-area priority |
| Mermaid pan/zoom | `src/utils/mermaidPanZoom.ts:62` | DOM interaction layer; initialize only visible diagrams |
| Monaco outline provider | `src/components/ProjectEditor/Outline/useOutlineSymbols.ts:67` | Monaco API stays in renderer; Markdown-only fallback can move to Worker later |
| PromptList sorting and highlight | `src/components/PromptNotebook/PromptList.tsx:216`, `src/components/PromptNotebook/PromptList.tsx:316` | Small lists can stay; large lists need virtualization and visible-only highlight |
| Small localStorage layout preferences | Git Diff / Git History / ProjectEditor modal size | Only low-frequency, small-object, debounced writes are allowed |
| SVG icon sanitize cache | `src/components/ProjectEditor/setiFileIconTheme.ts:24` | Existing cache can stay; list rendering must not repeatedly sanitize |

## Existing Good Boundaries

- Terminal output already uses `TerminalOutputScheduler`; future changes must not bypass it with direct xterm writes.
- `rendererWorkScheduler` exists but is currently narrow; expand it to more renderer-derived work.
- Markdown parse/highlight/KaTeX already flows through `src/workers/markdownPreviewWorker.ts`; add sanitization to the same boundary later.
- Project file indexing and ripgrep search already have main-worker paths; next work should exclude irrelevant directories and control bulk result return.
- Git, SQLite, and AppState have worker foundations; continue moving remaining large serialization and normalization work out.

## Refactor Phases

### Phase 1: Renderer Load Inventory

- Keep the existing Prompt latency baseline.
- Add renderer long-task sampling for tasks over 50 ms, including lane, component, and operation name.
- Add 1-second counters for AppState updates, Terminal flush, xterm.write, DOMPurify, Mermaid, Git polling, and search apply.
- Emit before/after JSON.

### Phase 2: Move P0 Work

- Move Markdown sanitization from renderer to worker.
- Move AppState startup normalization from renderer to main worker.
- Move Prompt import/export parse, diff, and JSON stringify to worker.
- Replace full Terminal buffer reads with bounded snapshots plus background processing.

### Phase 3: Move P1 Work

- Move ChangeLog Markdown parse/sanitize out of renderer.
- Move Mermaid SVG generation to background work or delay it to visible areas.
- Change search result apply to paged or visible-result consumption.
- Route Project preview large-file conversion through a main worker and cap IPC payloads.

### Phase 4: Tighten Renderer-Only Work

- Split TerminalGrid layout, fit, and attach across frames.
- Restrict Preview search to visible areas or process it in slices.
- Add a PromptList virtualization threshold and highlight only visible items.
- Slice application of large Git Diff / Git History results.

### Phase 5: Acceptance

Required scenarios:

1. Six Tasks streaming output at the same time.
2. Six Tasks running heavy commands at the same time, including Git operations.
3. Continuous typing in the Prompt input area.
4. Prompt List / Prompt History context menu remains open and is not dismissed by Task refreshes.

Acceptance metrics:

| Metric | Requirement |
|---|---|
| Prompt input p99 | Must improve over baseline |
| Prompt input p999 | Must improve over baseline |
| Prompt input max | Must not show multi-second freezes |
| Long task count | Must decrease |
| Terminal visible output | Batching is allowed, but visible output must not be lost |
| Hidden task output | Must not continuously occupy the renderer |
| Context menu | Task refresh must not remount the page and dismiss the menu |

## Final Rule

Before any new feature enters the renderer, answer these questions:

1. Does it require DOM, focus, cursor, xterm, or Monaco?
2. Does it scale linearly or worse with file size, Prompt count, Terminal count, or Git repository size?
3. Does it run while the user is typing?
4. Can it be canceled, merged, or sliced?

If the answer to question 1 is no, and the answer to question 2 or 3 is yes, default to a Worker.
