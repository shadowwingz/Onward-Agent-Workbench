<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Current State 2026-05-08

## 1. What We Are Doing

The goal is to support a new Task terminal right-click flow: inside the terminal content area, the user can choose a pinned Prompt and send it directly to the Task that was right-clicked, then execute it immediately.

Confirmed product rules:

- Selecting a pinned Prompt must send and execute immediately, not just insert text into the terminal input.
- The target is the Task that was right-clicked, not necessarily the current active Task.
- The menu wording should follow the existing `Send and execute to Task` semantics.
- Pinned Prompts should be shown in the same manual pin order used in Prompt History.
- Prompt editor `Import Pin` should use the same manual pin order.
- Sending a pinned Prompt from the Task context menu must not update `lastUsedAt` or `sendHistory`.
- The new entry belongs only in the terminal content area, not in the Task header, path, or branch area.

## 2. Solution Approach

The main principle is to reuse the existing send-and-execute path instead of implementing new terminal input logic.

Existing related code:

- Prompt editor right-click menu already has an `Import Pin` submenu in `src/components/PromptNotebook/PromptEditorContextMenu.tsx`.
- Prompt History already has a send-and-execute-to-Task flow in `src/components/PromptNotebook/PromptNotebook.tsx`.
- Actual terminal sending ultimately goes through `handleSendAndExecuteOnTerminals` in `src/App.tsx`, which already handles single-line input, multi-line input, bracketed paste, and delayed Enter delivery.
- The Task terminal content area already has a right-click menu in `src/components/TerminalGrid/TerminalGrid.tsx`.

Implementation path:

- Pass the global pinned Prompt list from `App.tsx` into each `TerminalGrid`.
- Add an `onSendAndExecutePinnedPrompt` callback to `TerminalGrid`, and call the existing `handleSendAndExecuteOnTerminals([terminalId], prompt.content)` when a pinned Prompt is chosen.
- Add a `Send and execute to Task` submenu to the terminal content right-click menu, with items ordered according to the global pinned Prompt order.
- When a submenu item is clicked, only send and execute; do not call `onUpdatePrompt`, so `lastUsedAt` and `sendHistory` remain unchanged.
- Update `PromptEditorContextMenu.tsx` to stop sorting pinned Prompts by `lastUsedAt/updatedAt`; instead, preserve the order passed in from the parent.
- Add i18n strings for both English and Chinese.
- Add trace events:
  - `RENDERER_TERMINAL_CTX_MENU_OPEN`
  - `RENDERER_TERMINAL_CTX_PINNED_PROMPT_SEND`
- Update `infra/trace.md` and `test/README.md` so trace and test indexing stay aligned.

## 3. Issues Encountered

Product decisions that had to be resolved:

- The term "import to terminal" was ambiguous: insert only, or send and execute. The final decision was send and execute immediately.
- The target Task had to be clarified: active Task, or the Task under the right-click. The final decision was the right-clicked Task.
- It had to be clarified whether sending should update Prompt history metadata. The final decision was no metadata update.
- There were two historical ordering behaviors for pinned Prompts: manual Prompt History ordering, and `lastUsedAt` ordering in the Prompt editor import menu. This work standardizes both surfaces on manual pin order.

Implementation issues:

- `TerminalGrid` previously knew only the terminal id and selection state for its context menu. It did not know about the global pinned Prompt list, so that list had to be passed down from `App.tsx`.
- The terminal right-click listener is attached as a native DOM event on the xterm container. To avoid rebinding the listener every time the pinned list changes, the trace payload now reads the pinned count from a ref.
- The PromptNotebook autotest debug API originally did not expose a pinned reorder entry or send history counts. To verify manual order and "no metadata update", the debug API was extended with `reorderPinnedPrompts` and `sendHistoryCount`.
- The terminal submenu still has to preserve Copy / Paste / Select All / Clear behavior, and it must not interfere with xterm selection or paste semantics.
- `pgrep -lx` on macOS truncates long process names in its display, but exact-name matching still works. During cleanup, a plain `pkill -x` did not terminate the main process, so the exact-name `pkill -9 -x "Under Development 2.0.1-master"` path was used instead. No broad pattern matching was used.

## 4. Verification Status

Already verified:

- `pnpm typecheck`
- `git diff --check`
- `ONWARD_DIST_DEV_OPEN=0 rm -rf out release && ONWARD_DIST_DEV_OPEN=0 pnpm dist:dev`
- Manual launch of the dev app: `release/mac-arm64/Under Development 2.0.1-master.app`
- `test/autotest/run-prompt-editor-context-menu-autotest.sh`

Relevant regression results:

- `PECM-38-import-pin-manual-order` passed, confirming Prompt editor `Import Pin` follows manual pin order.
- `TPCM-01-terminal-pin-menu-manual-order` passed, confirming the terminal right-click pin submenu follows manual pin order.
- `TPCM-02-terminal-pin-menu-sends-to-right-clicked-task` passed, confirming the prompt is sent to the right-clicked Task.
- `TPCM-03-terminal-pin-menu-does-not-touch-prompt-history` passed, confirming `lastUsedAt` and `sendHistory` are unchanged.

The full `run-prompt-editor-context-menu` suite passed with 38/38.

## 5. Current Workspace State

Modified but not committed:

- `infra/trace.md`
- `src/App.tsx`
- `src/autotest/test-prompt-editor-context-menu.ts`
- `src/autotest/types.ts`
- `src/components/PromptNotebook/PromptEditorContextMenu.tsx`
- `src/components/PromptNotebook/PromptNotebook.tsx`
- `src/components/TerminalGrid/TerminalGrid.css`
- `src/components/TerminalGrid/TerminalGrid.tsx`
- `src/i18n/core.ts`
- `src/utils/perf-trace-names.ts`
- `test/README.md`
- `current-state-0508.md`

No git commit has been created yet.
