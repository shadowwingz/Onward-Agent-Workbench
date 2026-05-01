<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onward test suite

This README is the **single source of truth** for "which feature is locked
by which automated test." Read § 2 *Feature × Test Index* before
authoring any new test runner, and update it in the same change set
when you add or modify a runner.

- § 1 — How to run the full regression
- § 2 — Feature × Test Index (read this first when designing tests)
- § 3 — Adding or modifying a test
- § 4 — Layout, fixtures, cleanup

---

## 1. How to run the full regression

```bash
python3 test/autotest/run-full-regression.py
```

Output lands in `test/full-regression-results/<local-timestamp>/`
(host's local time, format `YYYYMMDDTHHMMSS`):

- `summary.log` — full streamed output + final pass/fail summary
- `summary.json` — machine-readable result of every runner
- `logs/<suite>.log` — per-runner stdout/stderr, one file each

That directory is gitignored — runs stay local; share the relevant
excerpts (PASS / FAIL summary, the failing per-runner log) with
reviewers instead of committing the artefacts.

Useful flags: `--build`, `--only <substr>`, `--skip <substr>`,
`--app-bin <path>`, `--list`. See
`python3 test/autotest/run-full-regression.py --help`.

---

## 2. Feature × Test Index

Each row maps a user-visible feature (or a fixed bug, written as
`Bug fix: <symptom>`) to the runner that locks it down. The
parenthesised tokens are assertion-ID prefixes inside the runner's
TypeScript source under `src/autotest/test-*.ts` — `grep` for them to
land on the exact assertion when something fails. Unit-only entries
point at files under `test/unittest/`.

> **5-step SOP § Step 0** (in `CLAUDE.md`): scan this table first. If a
> row already covers the feature surface you are touching, **amend**
> that runner. Only fall back to `ls test/autotest/run-*-autotest.sh`
> + `grep` when the index has no matching row, and add a row for the
> runner you settle on before reporting completion.

### 2.1 Terminal — title, focus, lifecycle, perf

| Feature / Bug | Tests |
|---|---|
| Single-click Task title opens dropdown menu (no debounce) | `run-terminal-title-rename` (TTM-01, TTM-12, TTM-13) |
| Title menu has 4 items: Rename / Auto-follow / Use Branch / Use Repo | `run-terminal-title-rename` (TTM-02) |
| Rename menu item drives inline edit; commit / cancel | `run-terminal-title-rename` (TTM-03, TTM-16, TTM-17) |
| Use Branch / Use Repo writes a frozen customName snapshot | `run-terminal-title-rename` (TTM-04, TTM-05, TTM-08, TTM-09) |
| Disabled menu items when no Git info present | `run-terminal-title-rename` (TTM-06, TTM-07, TTM-10) |
| Auto-follow Git branch (default ON) tracks branch on cwd / branch change | `run-terminal-title-rename` (TTM-21, TTM-22) |
| Manual rename pinned within same repo | `run-terminal-title-rename` (TTM-23) |
| Cross-repo cwd switch clears manual override and adopts new branch | `run-terminal-title-rename` (TTM-24) |
| Auto-follow OFF freezes name; OFF→ON resyncs branch | `run-terminal-title-rename` (TTM-25, TTM-26, TTM-27) |
| Auto-follow checkbox toggles preference, menu stays open | `run-terminal-title-rename` (TTM-28) |
| Bug fix: title double-click no longer enters rename | `run-terminal-title-rename` (TTM-11, TTM-14) |
| Trace events emit on click / snapshot / rename | `run-terminal-title-rename` (TTM-20) |
| Outside-click / Escape closes the title menu | `run-terminal-title-rename` (TTM-18, TTM-19) |
| Per-task ESC routes to terminal, not subpages | `run-subpage-navigation` (SN-*) |
| Terminal viewport keeps bottom-follow during refresh | `run-terminal-autofollow` (TA-02, TA-04, TA-06) |
| Wheel / PageUp scroll detaches viewport from bottom | `run-terminal-autofollow` (TA-03, TA-05) |
| Fit / remount preserves viewport position | `run-terminal-autofollow` (TA-07, TA-08, TA-09, TA-10, TA-11) |
| Bug fix: focus does not jump viewport (preventScroll) | `run-terminal-autofollow` (TA-12) |
| Terminal focus / activation across shortcuts and restore | `run-terminal-focus-activation` (TFA-01, TFA-02, TFA-03) |
| Terminal output rendering perf (frame budget, longtask) | `run-terminal-perf` (TP-*) |
| Multi-task terminal stress under concurrent output | `run-terminal-stress` (ST-*) |
| Off-renderer scheduling architecture invariants | `run-terminal-architecture-baseline` (TAB-00, TAB-01) |
| Terminal layout / state restore across app restart | (`shouldRun('terminal-state-persistence')`, no shell runner) |
| Per-Task font override (style settings) | (`shouldRun('per-agent-font')`, no shell runner) |
| Renderer + main work scheduler unit tests | `test/unittest/main-work-scheduler-unit.mjs`, `renderer-work-scheduler-unit.mjs`, `terminal-output-scheduler-unit.mjs` |
| 8-grid (2x4) preset, Custom layout popover, downsize confirm dialog, focusTerminal 7/8 shortcuts | `run-task-layout` (TLM-00..05) + `test/unittest/task-layout-utils.test.mts` (TLM-U-01..41) |

### 2.2 Tab / Subpage navigation / Settings UI

| Feature / Bug | Tests |
|---|---|
| Editor ↔ Diff ↔ History navigation memory | `run-subpage-navigation` (SN-07, SN-10, SN-12) |
| Cursor / scroll position restored across subpage switches | `run-subpage-viewstate-restore` (SVR-01..15) |
| Auto-updater UI state machine (idle / checking / downloading / restart) | `run-settings-update` (SU-01..10) |
| Bug fix: error-code falls back to localized detail string | `run-settings-update` (SU-06b) |

### 2.3 Git Diff

| Feature / Bug | Tests |
|---|---|
| Diff for terminal cwd at a subdir of the repo | `run-git-diff-subdir` (SD-*) |
| Submodule entries surface in parent diff list | `run-git-diff-submodules` (DSM-*) |
| Recursive submodule traversal | `run-git-diff-recursive-submodules` (RSM-*) |
| Bug fix: parent diff hides "internal-only" dirty submodule entries | `run-git-diff-staleness-and-submodule` (GDS-01..05, GDS-13, GDS-14) |
| Bug fix: 3-second request cache invalidated by FS watcher | `run-git-diff-staleness-and-submodule` (GDS-06..10, GDS-12, GDS-15) |
| Snapshot service caches submodule meta (cache-hit / capture / invalidate) | `run-git-diff-staleness-and-submodule` (GDS-11, GDS-16) |
| Trace markers emitted on watcher / freshness / snapshot paths | `run-git-diff-staleness-and-submodule` (GDS-12, GDS-16) |
| Image diff (PNG / SVG) in Diff modes 2up / swipe / onion | `run-image-diff` (ID-01, ID-02, ID-03, ID-19) |
| Image diff in Git History (PNG / SVG) | `run-image-diff` (ID-13..18) |
| PDF / EPUB compare in Diff (added / deleted / modified) | `run-pdf-epub-diff` (`git-diff-pdf-*`, `git-diff-epub-*`) |
| Cross-platform Git behaviour (CRLF / paths / locale) | `run-git-cross-platform` (XP-*) |

### 2.4 Git History

| Feature / Bug | Tests |
|---|---|
| Commit list, selection, file diff load | `run-git-history` (GH-*) |
| Per-terminal scope: history reflects active terminal cwd | `run-git-history-multi-terminal-scope` (GHMS-*) |
| Nested submodule history view | `run-git-nested-submodules` (GNS-*) |

### 2.5 Project Editor — file ops, layout, restore

| Feature / Bug | Tests |
|---|---|
| Per-file view memory (cursor / scroll / outline / preview anchor) | `run-project-editor-file-memory` (PFM-01..09) |
| File browser scroll persisted across switches and reopens | `run-project-editor-file-memory` (PFM-30..35) |
| Outline scroll persisted across switches and reopens | `run-project-editor-file-memory` (PFM-36..48) |
| Anchor file restored after recent-list eviction + app reopen | `run-project-editor-file-memory` (PFM-10..29) |
| Editor restore on app reopen (last file, cursor, scroll) | `run-project-editor-restore` (PE-*) |
| Restore unit logic (Set / Map serialisation, key normalization) | `run-project-editor-restore-unit` (PEU-*) |
| File open positions exact-line scroll | `run-project-editor-open-position` (POP-*) |
| Editor scope = active terminal (multi-terminal isolation) | `run-project-editor-multi-terminal-scope` (PEMS-*) |
| SQLite viewer (open `.db`, table list, paging) | `run-project-editor-sqlite` (PSQL-*) |
| File index cache + Quick Open behaviour | `run-file-index-cache-ui` (FIC-01..21) |
| File-index unit (cache eviction, dirty key tracking) | `test/unittest/file-index-cache.test.mts` |
| Project tree FS watcher (debounce, batch) | `test/unittest/project-tree-watch-manager.test.mts` |
| Editor auto-refresh on external file mutation | `run-file-watch` (FW-01..05) |
| Global ripgrep search across project | `run-global-search` (GS-01..11) |
| Working directory copy from terminal header | `run-working-directory-copy` (WDC-*) |
| Sidebar outline auto-scroll follows preview / editor | (`shouldRun('sidebar-autoscroll')`, no shell runner; SA-*) |
| Quick file open (unit harness) | (`shouldRun('quick-file-unit')`, no shell runner; QF-*) |

### 2.6 Project Editor — Markdown / preview

| Feature / Bug | Tests |
|---|---|
| Markdown preview renders highlight / image / outline | `run-project-editor-markdown-navigation` (PMN-01..09) |
| Outline scroll memory across switches and reopens | `run-project-editor-markdown-navigation` (PMN-13..17, PMN-39..43) |
| Code-outline (TS / py) symbols + scroll memory | `run-project-editor-markdown-navigation` (PMN-18..23) |
| Read mode keeps preview open on edit toggle | `run-project-editor-markdown-navigation` (PMN-24) |
| Outline target falls back between editor / preview when one is hidden | `run-project-editor-markdown-navigation` (PMN-27..33) |
| Code-wrap preference (inline + block, persists across reopen) | `run-project-editor-markdown-navigation` (PMN-34..44) |
| Markdown session restore (last file + section + mode) | `run-project-editor-markdown-session-restore` (PMSR-*) |
| Markdown LaTeX (KaTeX) rendering in preview | `run-markdown-latex-preview` (MLP-*) |
| Mermaid pan / zoom / fullscreen in preview | `run-mermaid-panzoom` (MPZ-01..02) |
| Preview position restore across file switch (incl. Mermaid layout) | `run-preview-position-restore` (PPR-01..12) |
| In-preview search (next / prev / wrap, centering) | `run-preview-search` (PS-01..12) |
| PDF reader / EPUB reader inside editor | `run-pdf-epub-preview` (`pdf-reader-*`, `epub-*`) |
| PDF / EPUB full-mode read flow | `run-pdf-epub-full` (no fixed prefix) |

### 2.7 Prompt system

| Feature / Bug | Tests |
|---|---|
| Multiline send / execute with bracketed paste guard | `run-prompt-integrity` (PI-01..05) |
| Prompt input latency baseline (typing → paint p95) | `run-prompt-input-latency` (PIL-01, PIL-02) |
| Prompt input long-tail under terminal pressure | `run-prompt-input-longtail` (PILT-01, PILT-02) |
| Prompt list filter / color tag / task badge | `run-prompt-list` (PL-01..12) |
| Prompt editor right-click context menu — undo / cut / copy / paste / clear-content / pinned-import / save-as-pinned / insert cwd / insert branch / insert task title / send-to-task; auto viewport flip + clamp | `run-prompt-editor-context-menu` (PECM-01..03, 05..09, 13..16) |
| Prompt sender grid layout, action buttons, send/execute | `run-prompt-sender` (PS-01..10) |
| Bug fix: terminal grid uncapped, sender respects 50% cap | `run-prompt-sender` (PS-31, PS-32, PS-33) |
| Prompt cleanup (auto / manual, color-aware retention) | (`shouldRun('prompt-cleanup')`, no shell runner; PC-*) |
| Scheduled prompt execution (relative / absolute / recurring) | `run-schedule` (SC-01..18) |

### 2.8 Cross-cutting infrastructure

| Feature / Bug | Tests |
|---|---|
| Trace JSON written and parseable on every dev launch | `run-trace-infra-self-check` (`first main event found`) |
| Per-feature trace events emit and group by Task tid | `run-performance-trace` (PT-*) |
| Telemetry session start, properties, heartbeat | `run-telemetry` (TEL-01..10) |
| Feedback flow basic submit + browser draft | `run-feedback` (FB-*) |
| Feedback UI history list and resolve states | `run-feedback-persistence` (FBU-01..11), `run-feedback` |
| Change Log modal (sidebar entry, prefetch, EN fallback under zh-CN) | `run-change-log` (CL-01..11) |
| Coding agent env vars and storage | `test/unittest/coding-agent-env-vars.test.mjs`, `coding-agent-storage.test.mjs` |
| General regression baseline | (`shouldRun('regression')`, no shell runner; RG-*) |
| Generic stress harness | (`shouldRun('stress')`, no shell runner; ST-*) |

---

## 3. Adding or modifying a test

When the user asks for a new automated test or for the test system to
change, edit `test/autotest/run-full-regression.py` directly. Reshape
the rest of the suite around it — do not introduce a separate driver
or checklist.

### Step 0 (mandatory): consult the index above

1. Scan § 2 for a row whose feature surface overlaps. If found, **amend
   that runner** instead of creating a sibling. Step 0 of the 5-step
   SOP in `CLAUDE.md` is satisfied by the index lookup; you do not
   need to `ls` / `grep` the whole `test/autotest/` directory.
2. If no row matches, fall back to
   `ls test/autotest/run-*-autotest.sh` + `grep -rl <keyword>
   test/autotest/`. Once you settle on a runner (new or amended),
   **add the corresponding row in § 2 of this file in the same change
   set**. The index is worse stale than missing — fix or remove rows
   on the same diff that touched the runner.

### Hard rule — English-only test selectors

Onward's automated test matrix covers **only the English locale**. When
you author or amend an autotest:

- Match buttons, menu items, dialog labels, etc. by their **English**
  `title` / text content only. Do not write a multilingual fallback set
  alongside the English needle (e.g. `['eight', '<other-locale>']`) —
  English alone is sufficient.
- Do **not** add a "read i18n dictionary" helper that imports
  `src/i18n/core.ts` and looks selectors up by key. That is over-design
  for a single-locale matrix.
- Do **not** put zh-CN strings in `src/autotest/test-*.ts`,
  `test/autotest/test-*.{ts,mjs,js}`, or any runner script. The
  project-level `scripts/check-chinese-comments.js` lint will reject
  them at `pnpm dist:dev` time, and test files are not allowlisted.
- Code comments inside test files must also be **English only** — same
  hard rule as the rest of the codebase (see `CLAUDE.md`).

If a future requirement ever demands zh-CN regression coverage, design
that as a dedicated locale-coverage suite at that point — do not
pre-emptively scaffold dual-language selectors in today's tests.

### Authoring a new runner

1. Create the runner under `test/autotest/run-<suite>-autotest.sh`
   (and the `.ps1` mirror for Windows when applicable). Every runner
   must carry an SPDX header and write its log to
   `<repoRoot>/traces/test-logs/<suite>.log`.
2. Append the new runner to the `SCRIPTS` list inside
   `test/autotest/run-full-regression.py`. (If you amended an existing
   runner, no `SCRIPTS` change is needed.)
3. Reusable fixtures go under `test/autotest/fixtures/<suite>/`.
   Per-run scratch goes under the OS temp dir or
   `test/autotest/results/<suite>/` (gitignored).
4. Unit-only harnesses (Node `node --test` or `assert`-style) go under
   `test/unittest/`.
5. Pick an assertion-ID prefix (2–4 uppercase letters) that does not
   collide with an existing one in § 2. Use `<PREFIX>-NN-short-name`
   so traces and `grep` jumps cleanly to the assertion.

### Verifying

Run the trace self-check
(`test/autotest/run-trace-infra-self-check-autotest.sh <APP_BIN>`) plus
the affected runner via
`python3 test/autotest/run-full-regression.py --only run-<suite>`.
Confirm both are green before reporting the task complete.

---

## 4. Layout, fixtures, cleanup

The hard rules live in `CLAUDE.md` § "Automated tests". Quick reference:

- `test/autotest/` — runners (`.sh` / `.ps1`), orchestrator
  (`run-full-regression.py`), fixture builders (`create-*-fixture.mjs`,
  `prepare-*-fixture.mjs`), E2E sources (`test-*.ts` mounted via
  `src/autotest/autotest-runner.ts`).
- `test/autotest/fixtures/<suite>/` — committed reusable fixtures
  (real files, not base64 blobs in TS).
- `test/autotest/results/` — runner-internal scratch (gitignored).
- `test/unittest/` — Node test runner / `assert`-style unit harnesses
  (`*.test.{mjs,mts}`, `*-unit.mjs`).
- `test/full-regression-results/` — orchestrator output (gitignored).
- The `__autotest_*` filename prefix is reserved as a sentinel for
  "autotest-generated fixture, safe to delete on cleanup". Runners
  must install an `EXIT` trap (bash) / `finally` block (Python / Node)
  to sweep direct repo-root children matching `__autotest_*`.

`test/` top level holds **only** this `README.md` plus the four
directories above. Do not create new files at `test/` top level.
