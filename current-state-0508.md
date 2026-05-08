# Current State - 2026-05-08

Branch: `0503-pdf-issue`

## 1. What we are trying to do

The work focuses on restoring Markdown preview in Project Editor so the high-frequency path feels close to instantaneous:

1. Open Markdown Preview inside Editor.
2. Press `ESC` to leave back to Tasks / Terminal.
3. Re-enter Editor through the shortcut path.
4. Expected result: cached Markdown preview should appear immediately, without visible waiting or an empty-state flash.

The user then reported two concrete symptoms:

1. Re-entering Editor via shortcut sometimes flashes `Select a file to start editing`.
2. The Markdown preview body appears first, while the top Tasks shell (`Diff / Editor / History`, task title, Save, Return, etc.) appears later, which looks like body and shell are rendering asynchronously.

So the task is not just removing Markdown preview delay. The reopen flow also has to:

- use the correct terminal / cwd / editor scope,
- restore the last opened Markdown file and preview state,
- avoid empty-state flashes,
- show shell and preview body in the same paint,
- and be covered by automated regression tests.

## 2. Solution approach

### 2.1 Remove the hard wait from preview reveal

We found that when the Markdown session cache hits, the HTML content returns to the DOM quickly, but the `PREVIEW_RESTORE_REVEAL_SETTLE_MS = 1300 ms` hard wait keeps it hidden with CSS, so it still feels like a full redraw.

The current approach is to move reveal decisions away from a fixed sleep and toward a real work-pending fast path:

- add and maintain the pure-logic `isPreviewWorkPending` check for sanitizer, layout, outline, and scroll restoration work,
- let both cache-hit and cache-miss paths prefer event-driven / fast-path reveal,
- keep perf trace data so reveal duration, cause, and had-work state can be asserted in automation.

### 2.2 Reopen Editor with the correct context

The `Select a file to start editing` flash means that one frame during reopen does not have the previous file/session state.

The fix direction is:

- keep the last Project Editor terminal / scope in the App layer,
- do not clear terminal focus/scope into an unrecoverable state when Editor closes,
- reopen using the last Project Editor scope instead of relying on a focus state that may have already changed,
- add an open token around async cwd resolution so stale cwd results cannot overwrite a newer open.

### 2.3 Make shell and body appear together

The screenshot shows that Project Editor body is restored before the TerminalGrid shell above it. That means body and shell are not being synchronized in the same render pass.

The fix direction is:

- move active subpage sync from a normal `useEffect` to layout-time sync,
- retain the last shell state so reopen can paint shell and body together,
- set the active subpage before starting the Project Editor open path,
- assert in automation that there is no frame where body is visible but shell is not.

### 2.4 Cover the high-frequency path with automation

The added tests do not only check the final state; they also inspect the transition:

- exit with `ESC`,
- re-enter through the shortcut action,
- sample consecutive DOM frames,
- assert there is no empty-state flash,
- assert the preview came from retained/cache restore,
- assert shell is not later than body,
- repeat 5 times to avoid timing noise from a single sample.

## 3. Main changes already made

### 3.1 `src/App.tsx`

- Added an autotest-only shortcut debug API so automation can drive the real shortcut action path.
- Preserved the Project Editor terminal/scope from the last open.
- Restored last focus owner / last focused terminal / active terminal when Editor closes, so shortcut reopen does not lose context.
- Added a Project Editor open token to prevent stale async cwd results from overriding the new state.
- Kept retained reopen synchronous for the same terminal and resolved cwd first for other reopen cases.

### 3.2 `src/components/TerminalGrid/TerminalGrid.tsx`

- Moved active subpage synchronization into the layout phase.
- Added retained shell state so Project Editor body does not appear before the top shell.
- Set active subpage before opening Project Editor from the shortcut path.
- Extended `RENDERER_SUBPAGE_FRESHNESS_CHECK` trace coverage for Project Editor shortcut open.

### 3.3 `src/components/ProjectEditor/ProjectEditor.tsx`

- Kept the Markdown preview clean active view so reopen can restore it directly.
- Reworked preview reveal to use the actual work-pending fast path instead of always waiting 1300 ms on cache hit.
- Reworked outline scroll restore to use `ResizeObserver`, `MutationObserver`, and an rAF fallback.
- Waited for Monaco model URI and content to align before restoring cursor/view state, so async model updates do not overwrite the restored cursor.

### 3.4 Tests and docs

- Added and updated the Project Editor Markdown session restore autotest to cover `ESC -> shortcut reopen`.
- Added assertions for:
  - shortcut debug API availability,
  - reopen actually coming from the shortcut path,
  - no `Select a file to start editing` flash,
  - retained Markdown preview use,
  - no body-before-shell frame,
  - all 5 repeat trials passing.
- Updated `test/README.md` feature/test index.
- Updated `infra/trace.md` trace event descriptions.

## 4. Problems encountered

### 4.1 rAF-only sampling can stall packaged autotests

The first reopen sampler used only `requestAnimationFrame`, which can stall in the packaged autotest environment and hang the test.

Fix:

- switch the sampler to rAF plus a `setTimeout(32)` fallback,
- keep frame-level observation without making the runner depend on rAF always firing.

### 4.2 Shortcut reopen could use the wrong cwd

Once the reopen test was added, it exposed that Editor close cleared the active terminal / focus scope in a way that let shortcut reopen fall back to the wrong cwd.

Fix:

- save the last Project Editor scope in the App layer,
- restore terminal focus when Editor closes,
- use a token to prevent stale async cwd results from winning.

### 4.3 Multi-terminal scope had a stale cwd render race

Even after focus was restored, opening Editor could render one frame from `terminal.lastCwd` before `git.getTerminalCwd()` returned the correct cwd.

Fix:

- do not immediately open from stale cwd on a non-retained reopen,
- resolve the current terminal cwd first, then open Project Editor,
- ignore expired resolution results with the open token.

### 4.4 Monaco model content updates could overwrite cursor restore

The restore test showed the cursor could be restored correctly, then moved to EOF when Monaco model content updated afterward.

Fix:

- make `waitForEditorModelReady` check both model path and model content,
- apply view state / cursor only after the model is truly ready.

### 4.5 `useOutlineSymbols` had a model-swap race

Earlier technical debt noted that `editor.getModel()?.getValue()` could read stale content during file switches, causing outline parsing to use the wrong file. The old 1300 ms hard wait was partly hiding that race.

Current direction:

- extract outline parse input handling into clearer pure logic,
- cover stale model / expected path / content fallback combinations with unit tests,
- keep observing large Markdown switches for outline jitter in real usage.

## 5. Validation status

Already run:

- `pnpm test:unit` passed.
- `rm -rf out release && ONWARD_DIST_DEV_OPEN=0 pnpm dist:dev` passed.
- `bash test/autotest/run-project-editor-restore-autotest.sh` passed.
- `bash test/autotest/run-project-editor-markdown-session-restore-autotest.sh` passed, including the new shortcut reopen path.
- `bash test/autotest/run-project-editor-multi-terminal-scope-autotest.sh` passed.
- `bash test/autotest/run-markdown-preview-latency-autotest.sh` passed.
- `bash test/autotest/run-project-editor-markdown-navigation-autotest.sh` passed.

The current dev app was launched from:

```bash
release/mac-arm64/Under Development 2.0.1-0503-pdf-issue.app
```

## 6. Remaining risk / follow-up

1. The user still needs to try the real `Project_Forward` workspace, especially:
   - `Notes/LLM_Study_Notes/training_schedule_study/generate_rope_plots.py`
   - `Notes/LLM_Study_Notes/training_schedule_study/training_schedule_comprehensive.md`

2. If a visible flash remains, the next step is to capture a perf trace or frame sequence and check:
   - whether the Project Editor open token is using the retained scope,
   - whether shell and body are visible in the first frame,
   - preview reveal cause and duration,
   - whether file selection state still drops to empty during reopen.

3. The code is not committed yet.

4. The working tree contains the feature changes, tests, and docs from this round.
