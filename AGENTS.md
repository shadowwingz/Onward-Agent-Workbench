<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

- Hard rule: **Never create git commits automatically.** Only commit when (a) the user explicitly asks for a commit, or (b) the commit step is a built-in operation of a Skill the user just invoked (for example `/merge_worktree`'s merge commit, or `/generate_git_commit`). This applies to all branches without exception. "I just fixed a bug, so I'll commit it" is forbidden — staging the change and reporting back is the correct flow; the user decides when to commit.

For platform-related commands, always consider these three platforms:
1. macOS
2. Linux
3. Windows
- Use the development build for compilation and debugging by default (`pnpm dist:dev`), unless the user explicitly asks for a production build.
- After modifying code, trigger a build using the following command. Before building, you must fully delete the `out` and `release` directories; otherwise stale code may be packaged. `rm -rf` and `pnpm dist:dev` must be run in the same command joined with `&&`; do not run them separately.
    # Clean and package (development build)
    rm -rf out release && pnpm dist:dev

- After a successful `pnpm dist:dev`, the build script automatically opens the packaged app (macOS `open`, Windows `start`, Linux `xdg-open`) for a smoke test. Auto-launch is skipped when `CI` is truthy (set `ONWARD_DIST_DEV_OPEN=1` to force) or when `ONWARD_DIST_DEV_OPEN=0` is set. See `docs/debug-env-variables.md`.
    If the user explicitly asks for a production build:
    # Clean and package (production build)
    rm -rf out release && pnpm dist
- After every code change, you must perform a startup test and confirm at minimum that the application can launch normally and enter the main UI. When `pnpm dist:dev` auto-opens the packaged app, a clean launch counts as the startup test; if exact launch control is required, set `ONWARD_DIST_DEV_OPEN=0` and launch manually once.
- Hard rule — Launching the app for testing: before opening the built `.app`, you must first kill any existing instance of the same application using **exact name matching** (`pkill -x "<exact-process-name>"`). Never use wildcards or partial matches. Chain the kill and open in one command: `pkill -x "Under Development <version>-<branch>" 2>/dev/null; sleep 0.5; open "<path-to-.app>"`.
    - **Absolutely forbidden during testing**: broad patterns such as `pkill -9 "Under Development"`, `pkill "Under Development"`, `pkill -f "Under Development"`, `pkill "Under Development <version>-<branch> Helper"`, or any `pkill` invocation that resolves via substring/regex instead of the exact process name. Such commands also terminate the user's Claude Code session, other branch builds, unrelated helpers, and anything whose name merely contains the shared prefix. This applies even to the `-9` signal: SIGKILL does not excuse a loose selector.
    - The exact process name MUST be passed as the final argument with `-x` and nothing else. Helper processes (for example, `Under Development <version>-<branch> Helper`, `Under Development <version>-<branch> Helper (GPU)`, `Under Development <version>-<branch> Helper (Renderer)`) are cleaned up automatically by the OS once the parent main process exits — do NOT kill them yourself.
    - When in doubt, always run `pgrep -lx "<exact-name>"` first to confirm exactly which processes will be targeted, and only then run `pkill -x "<exact-name>"`. If `pgrep` returns nothing, there is nothing to kill.
- Multilingual / UI Copy Development Rules:
    - The application currently supports `en` and `zh-CN`, with English as the default language. Whenever user-visible copy is added or modified, all supported languages must be designed and implemented together. Updating only one language is not allowed.
    - User-visible copy includes, but is not limited to, page titles, buttons, settings items, menus, tray menus, dialogs, toasts, tooltips, placeholders, empty states, error messages, context menus, and status text.
    - Any new or modified UI copy must be integrated through the i18n module / dictionary and accessed by key. Do not continue hardcoding single-language strings inside components.
    - For multilingual changes that affect UI layout or interaction, you must also verify language-specific differences in text length, wrapping, truncation, alignment, button width, and dialog layout, to ensure every supported language remains usable and visually correct.
    - If a change affects language settings, persisted storage, main-process menus, the tray, system dialogs, or other non-renderer copy, you must also update the corresponding settings storage, main-process mappings, and fallback logic.
- ## Automated tests — directory layout, fixture rules, cleanup
    - **Repo layout** (single source of truth — never invent other paths):
        - `test/autotest/` — every test program: `.sh` / `.ps1` runners, `run-full-regression.py` orchestrator, `run-with-timeout.mjs`, `resolve-dev-app-bin.sh` / `Resolve-DevAppBin.ps1`, `create-*-fixture.mjs` / `prepare-*-fixture.mjs`, E2E sources `test-*.{ts,mjs,js}`, validators / verifiers, stress harnesses.
        - `test/autotest/fixtures/` — every reusable fixture: per-suite directories (`<suite>/`), the SQLite corpus (`sqlite/`), and content fixtures (`markdown-*.md`, `mermaid-*.md`, `outline-fixture.py`, `dl_math_foundations.md`, `preview-search-complex.md`, etc.).
        - `test/autotest/results/` — runner-internal scratch output (gitignored).
        - `test/unittest/` — Node test runner / `assert`-style unit harnesses (`*.test.{mjs,mts}`, `*-unit.mjs`).
        - `test/full-regression-results/` — `run-full-regression.py` output (`summary.log`, `summary.json`, `logs/<suite>.log`); local-only, gitignored.
        - `test/` top level holds **only** `README.md` plus the four directories above. Do not create new files at `test/` top level.
    - **Hard rule — Test program / fixture placement:**
        - Any new runner, orchestrator, fixture builder, or E2E test source goes under `test/autotest/`. Any new unit harness goes under `test/unittest/`. Reusable fixtures (binaries, sample repos, sample source files, content samples) go under `test/autotest/fixtures/<suite>/`.
        - Fixture files MUST live on disk, not inlined. Do NOT embed base64 blobs inside `.ts` / `.js` test sources for PDFs, EPUBs, images, sample git repos, or sample source files. Tests should copy the fixture into their working directory via a terminal command (`cp` on POSIX, `Copy-Item` on Windows) so the flow mirrors what a real user would see.
        - When the user asks for an automated test after describing requirements, you MUST: (0) start by surveying existing runners under `test/autotest/run-*-autotest.sh` and prefer amending one whose feature surface overlaps — see the 5-step SOP's Step 0 below for the decision rule, (a) create scripts that exercise common paths + high-frequency paths + stress paths, (b) materialise fixtures on disk under `test/autotest/fixtures/<suite>/`, (c) run every case, and (d) only report completion when every assertion is green.
    - **Hard rule — Test fixture isolation (cwd):**
        1. Never read from or operate against the user's real data. Do not target `$HOME`, `~`, `/`, or any path outside the project.
        2. Tests must operate exclusively inside a dedicated test working directory you create for that suite.
        3. If the working directory does not exist, create it before the test runs.
        4. The committed reusable fixtures live under `test/autotest/fixtures/<suite>/` so they ship with the repo and CI can reuse them; a per-run scratch copy is materialised inside the OS temp dir (`${TMPDIR:-/tmp}` on macOS/Linux, `%TEMP%` on Windows) or under `test/autotest/results/<suite>/` (gitignored).
    - **Hard rule — Scratch locations and cleanup:**
        - Anything created during a test run must live either under the project tree (preferably `test/autotest/fixtures/<suite>/` for committed fixtures or `test/autotest/results/<suite>/` for scratch) or under the OS temp directory. Never under the user's Home, Desktop, or any system-level path.
        - After the test finishes — pass or fail — delete every scratch file or directory you created. Committed reusable fixtures under `test/autotest/fixtures/**` are exempt and must be preserved.
        - Deletion applies equally to success, failure, and signal paths: wrap cleanup in a `trap` (bash) / `finally` (Python / Node) / `Register-EngineEvent` (PowerShell) so it still runs when a test aborts or is interrupted.
    - **Hard rule — Autotest fixture placement and `__autotest_*` sweep:**
        - When designing a new TS autotest under `src/autotest/**`, fixtures it constructs at runtime must be created in the OS temp directory, NOT directly inside `rootPath` / `ONWARD_AUTOTEST_CWD` when that path is the repo root. Writing into the repo root pollutes the working tree and shows up in `git status` after every run, especially when the app crashes mid-test before TS-side cleanup runs.
        - Existing autotests that still write `__autotest_*` entries into `rootPath` are legacy. Until they migrate, every runner that invokes them MUST install an `EXIT` trap (bash) / `finally` block (Python / Node) that sweeps direct repo-root children matching `__autotest_*` and removes them. The Python orchestrator `test/autotest/run-full-regression.py` performs the same sweep after every script as defence-in-depth — runner-level traps are still required, the orchestrator sweep does not replace them.
        - The `__autotest_` filename prefix is reserved as a sentinel for "autotest-generated fixture, safe to delete on cleanup". Do not reuse it for any persistent file or for fixtures intended to live under `test/autotest/fixtures/**`. If `__autotest_*` entries persist in the repo root after a test run, that is a bug — fix the source autotest's cleanup OR the runner's EXIT trap; do not just `rm` and move on.
        - Preferred long-term path: TS allocates a per-suite tempdir via main-process IPC (or accepts an explicit `ONWARD_AUTOTEST_FIXTURE_DIR`), constructs fixtures inside it, and the runner sets that env to a `mktemp -d` path it owns and removes on EXIT. This makes the leak class structurally impossible.
- Icon sizing guidelines
    - The macOS app icon must follow the safe-area proportions from Apple Design Resources to avoid appearing oversized in the Dock / Mission Control.
    - Use `resources/icon.svg` as the single source of truth. After changes, fully regenerate `resources/icons/**`, `icon.icns`, `icon.ico`, and `icon.png`.
    - When the app icon display size looks wrong, first check the content-to-canvas ratio rather than the resolution; add more padding by scaling down the content.
    - macOS status bar icons must follow the Template convention: the filename must contain `Template`, and the code must explicitly call `setTemplateImage(true)`; avoid incorrect colors in light/dark mode.
    - After generating tray icons, update all referenced paths so the resource filenames and code stay consistent.
- After the build completes, show the current status. For `pnpm dist:dev`, the script usually launches the packaged app automatically; if not (e.g. `ONWARD_DIST_DEV_OPEN=0`), provide the manual command, for example: `open "project-dir/release/mac-arm64/Under Development <version>-<branch>.app"` (macOS). The dev-build product name format is `Under Development <package.json version>-<branch>`, e.g. `Under Development 2.0.1-master`.
- Whenever `CLAUDE.md` is modified, automatically run `./claude-sync-to-agents.sh`.
- Git commit messages must be written in English.
- Hard rule: all code comments must use English. Do not use any Simplified Chinese in code comments.
- Do not manually edit generated Change Log HTML files under `resources/changelog/**` (including `resources/changelog/html/**`) when modifying code or fixing bugs. These HTML files are compiled artifacts; update the source Markdown / JSON and regenerate derived assets through the changelog scripts only when release or Change Log work explicitly requires it.
- Copyright and license compliance:
    - Never copy or adapt code from third-party projects, Stack Overflow, blog posts, or any other external source without verifying its license compatibility with Apache-2.0. Do not reproduce substantial code blocks whose origin is unclear. When in doubt, write an original implementation instead of reusing external snippets.
    - Generated code must not introduce any dependency or code snippet licensed under GPL, LGPL, AGPL, SSPL, or any other copyleft license incompatible with Apache-2.0.
    - Before adding a new production dependency, verify its license is Apache-2.0 compatible (MIT, BSD, ISC, Apache-2.0 are safe; MPL-2.0 requires review; GPL/LGPL/AGPL are forbidden).
    - Every new source file must include the standard SPDX header: `SPDX-FileCopyrightText: 2026 OPPO` and `SPDX-License-Identifier: Apache-2.0`.
    - After adding new dependencies, run `pnpm generate-notices` to regenerate `ThirdPartyNotices.txt` and verify no incompatible licenses were introduced.
- Hard rule — Trace artefact location: every runtime trace / profile / screenshot / coverage report / dev-mode log this repo produces must land under `<repoRoot>/traces/` (the directory is gitignored; `traces/.gitkeep` keeps the path on fresh clones). Production builds fall back to `userData/debug/` because end-users have no checkout; dev and autotest always resolve `traces/` in the repo (`ONWARD_REPO_ROOT` override for packaged autotest runs). Do not write traces to `/tmp/`, the Desktop, the user's Home, or anywhere else.
- Hard rule — After capturing a perf trace: end the response with a one-liner that opens the trace in Perfetto UI — `bash infra/scripts/open_trace.sh traces/perf/<newest>.json` (the script boots a local `trace_processor_shell --httpd` + a version-pinned `ui.perfetto.dev` URL — zero cloud upload, zero UI/processor build drift). If the user says "open the trace", execute the command, don't just print it.
- Hard rule — Per-feature perf instrumentation (dynamic): for **every** feature-type piece of work — new feature, bug fix, refactor — you MUST identify which code paths it introduces or touches and add a perf-trace event for each measurable path. Treat this as a dynamic decision per change, not a one-time checklist:
    1. Enumerate the code paths the change adds or modifies. Classify each as main-thread work, renderer work, Worker / utility-process work, Web / DOM event handler, or user-input handler.
    2. For every path that is on a hot loop, is latency-sensitive from the user's point of view, or could regress silently under load, register an event name in `src/utils/perf-trace-names.ts` and instrument it (`perfTraceLogger.record(…)` main, `perfTrace(…)` renderer).
    3. Duration-bearing paths emit `ph='X'` spans (duration in ms in the payload); instantaneous events emit `ph='i'`.
    4. Update `infra/trace.md` § 2 "Implemented trace events" with the new rows, and move anything you implement off the § 3 "Planned" list.
    5. Regression coverage: if the event represents a user-visible perf signal, add a matching runner under `test/autotest/run-<suite>-autotest.sh` and append it to the `SCRIPTS` list in `test/autotest/run-full-regression.py`.
  `infra/trace.md` is the authoritative index — consult it before writing any perf-related code, and keep it current. This rule overrides any instinct to "add instrumentation later"; instrumentation is part of the feature's definition of done.
- Debugging principles (performance / lag issues):
    - **Data-first**: no performance optimization, lag diagnosis, or "experience" tweak without a trace in hand. When data is missing, report that a capture is needed and take one; do not guess the bottleneck from reading code.
    - Analyze the current code and the user's requirements first, and prioritize a detailed automated test plan. The test plan must include:
        1. Common paths
        2. High-frequency operation paths
        3. Stress-test paths
    - Sample first, then add logs: use `sample` / profiling to locate hot functions first, then add logs to verify causality.
    - Lock down a reliably reproducible path and time window first: fix the path, steps, and timeline to ensure stable reproduction.
    - Standardize key counters: AppState updates, Git polling, render / DOMPurify counts, etc. They must be observable at a 1-second granularity.
    - Avoid weak stress tests: editing volume and switching frequency must be high enough to surface peak load.
    - Prioritize concurrency and reentrancy checks: determine whether polling, timers, or async tasks are stacking; add throttling / deduplication first.
    - Cleanup must be complete on close / switch: cancel pending worker, timer, idle, and raf tasks to prevent leftover work.
    - Keep the evidence chain closed: profiling, logs, and code must agree, with before / after comparison.
    - **Event-name registry**: any new trace event must be registered in `src/utils/perf-trace-names.ts` before it is instrumented anywhere. `infra/trace.md` § 2 is the authoritative index; update it whenever an event is added, renamed, or retired.
- Hard rule — Renderer scheduling and input responsiveness:
    - Before creating features, fixing bugs, or solving performance issues, consult `docs/Off-Renderer Threaded Design - Electron Refactor.md` to decide whether the implementation belongs on the Renderer thread or in an asynchronous Worker / main worker / utility process. This design decision is mandatory for any work that can affect input responsiveness, rendering cadence, AppState, terminal output, Git, search, file indexing, parsing, sanitization, serialization, or large-list processing.
    - The renderer must be treated primarily as the user input loop. Do not run terminal parsing, Git work, project search, DOM sanitization, large diff processing, or other expensive work directly on the renderer thread when it can be moved to the main process, a utility process, or a Worker Thread.
    - Use a multi-queue priority scheduler for renderer work. Separate at least Prompt input, focused Task input/output, visible Task output, hidden Task output, and background maintenance into independent queues so one queue cannot monopolize the renderer.
    - Terminal and Task refreshes must be batched. Do not flush every Task immediately on every data event. Prefer a fixed cadence such as 20 ms or a frame-budgeted equivalent, then coalesce all pending Task output for that batch.
    - Prompt input has the highest priority. When focus is inside the Prompt input area, input handling and paint must preempt terminal output, Git updates, search updates, AppState propagation, and background UI refresh.
    - A Task with keyboard focus, mouse focus, or active user interaction receives a temporary priority boost for its input/output lane. The boost must be time-bounded and must not starve Prompt input.
    - PTY output is not user focus. Background Task output must not continuously promote all Tasks to interactive priority; terminal GitWatch/status work must be coalesced per repository, deduplicated across terminals, and kept out of untracked-file enumeration unless the user explicitly opens a Git feature that needs it.
    - If Prompt input and focused Task output compete, Prompt input wins. This is the global priority rule for scheduling conflicts.
    - Hidden or non-visible Task output must not continuously cross IPC or call renderer write paths. Keep it buffered, summarized, or dropped according to the terminal output model until a visible consumer requests it.
    - All long-running or high-volume operations must have cancellation, deduplication, and cleanup on close / switch. Pending worker jobs, timers, idle callbacks, animation-frame callbacks, and IPC subscriptions must be cancelled when their owner view is no longer active.
    - Every renderer scheduling change must preserve an automated baseline comparison for Prompt input latency and multi-Task terminal pressure. Do not accept a performance refactor without before / after JSON results and threshold gates.
- Context menu rules: any action available through a context menu must include an SVG icon (`width="14" height="14" viewBox="0 0 16 16" fill="currentColor"`). The menu item structure must be `<svg> + <span>text</span>`, using `display: flex; align-items: center; gap: 8px` to keep all context menus visually consistent.
- Context menu icon registry is maintained in `docs/context-menu-icon-registry.md`. Consult it on demand before adding or changing any context menu action, rather than keeping the full registry inline in `CLAUDE.md`.
- Unified context menu CSS rules (all components must follow):
    - Container: `background: var(--panel); border-radius: 10px; padding: 6px; box-shadow: var(--shadow-1); animation: *-context-fade-in 0.15s ease`
    - Menu item: `border-radius: 6px; hover background: color-mix(in srgb, var(--accent) 15%, transparent)`
    - Danger item hover: `background: rgba(239, 68, 68, 0.15)`
    - Separator: `margin: 4px 6px`
- Development principle: any subpage entered from the terminal entry point (such as Git Diff, Git History, or the Project Editor) must respond to ESC consistently and return to the terminal. Prefer reusing a shared ESC handling mechanism (for example, a common Hook) to avoid inconsistent implementations across pages.
- Process management safety: when killing or searching for processes (e.g., `taskkill`, `Get-Process`, `pkill`), always use the exact process name — never use wildcards or partial matches. Using wildcards risks terminating unrelated processes.
- Debug environment variables: when the user asks to add a debug switch for a specific feature, implement it as an `ONWARD_*` environment variable. Each variable controls exactly one concern, uses `1` to enable, is read once at startup, and logs a message when active. See `docs/debug-env-variables.md` for the full design, variable reference, and implementation guide.
- Hard rule — Cross-platform development (Windows / macOS / Linux):
    - Every new feature and bug fix must be designed and validated for all three platforms from the start. Do not implement for one platform first and "port later."
    - When creating a new feature or fixing a bug, always consider macOS, Linux, and Windows compatibility at the same time. This is a mandatory execution requirement, not an optional follow-up check.
    - The preferred design is three-platform independence: each platform's solution should be as decoupled as possible, without relying on another platform's behavior, tooling, path format, shell semantics, or fallback logic to work correctly.
    - If cross-platform dependency is truly unavoidable, the dependency must be isolated and made explicit with clear platform-specific branches or adapters (for example, `process.platform` dispatch, separate platform handlers, or clearly named platform conditionals). Do not hide cross-platform coupling inside shared implicit logic.
    - Platform-divergent areas require explicit per-platform branching (e.g., `process.platform` checks). The most error-prone areas, based on historical experience, include:
        1. **Git operations** (Git History, Git Diff): line-ending handling (`CRLF` vs `LF`), path separators (`\` vs `/`), shell escaping, locale-dependent output, and Git executable resolution differ significantly across platforms.
        2. **Terminal / shell operations**: default shell (`cmd.exe` / `powershell` vs `bash` / `zsh`), environment variable syntax (`%VAR%` vs `$VAR`), signal handling (`SIGTERM` vs `taskkill`), and PTY implementations vary.
        3. **File-system operations**: path length limits, case sensitivity, reserved filenames (`CON`, `NUL`, etc. on Windows), symlink behavior, and file-locking semantics.
    - When writing or reviewing platform-related code, always ask: "Will this behave correctly on the other two platforms?" If unsure, add explicit handling or at minimum a `TODO(cross-platform)` comment explaining the risk.
    - Automated tests that touch any of the above areas should include platform-specific assertions or be clearly marked as platform-conditional.
- Hard rule — New feature / bug-fix 5-step SOP:
    0. **Discover before authoring.** Before creating any new runner, look up the feature surface in `test/README.md` § 2 *Feature × Test Index*. That table is the canonical "feature → test" map. Decision rule:
        - **Amend an existing runner** when the new case exercises the same feature surface, the same subsystem, or the same component as one already listed in the index. Adding a 21st assertion to `run-project-editor-markdown-navigation-autotest.sh` is the right move; creating `run-project-editor-markdown-navigation-outline-arrow-autotest.sh` is not.
        - **Create a new runner** only when the new case crosses a subsystem boundary, owns a distinct fixture / setup cost, or needs an independent timeout / kill scope.
        - When in doubt, lean toward amend — the regression set is already 30+ runners, and one runner with N assertions is cheaper to maintain than N runners with one assertion each.
        - **Fallback path**: only when § 2 has no row whose feature surface clearly overlaps, do `ls test/autotest/run-*-autotest.sh` and `grep -rl "<keyword>" test/autotest/` (subsystem name or component, e.g. `markdown`, `git-diff`, `project-editor`, `outline`). The fallback is acceptable, but you must add or update the corresponding row in § 2 in the same change set so the next person doesn't pay the same `ls`/`grep` cost.
        Quote the discovery result back to the user before authoring so they can redirect early ("found row `<X>` → amend `run-<X>`" / "no row matches — will create `run-<Y>` and add the row").
    1. Create the runner under `test/autotest/run-<suite>-autotest.sh` (and the matching `.ps1` for Windows) **only if Step 0 found no adjacent runner**; otherwise amend the existing one. Every runner must carry an SPDX header and write its log to `<repoRoot>/traces/test-logs/<suite>.log`. If you created a new runner, append it to the `SCRIPTS` list in `test/autotest/run-full-regression.py` so the orchestrator picks it up. If you amended an existing runner, no `SCRIPTS` change is needed — it's already registered, and duplicating an entry would make the orchestrator run the same suite twice per regression.
    2. Fixtures go under `test/autotest/fixtures/<suite>/`. Reusable binaries live as real files, not base64 blobs in TS. Committed fixtures are excluded from the automated-test cleanup rule.
    3. If the change has a perf dimension, add the new event name to `src/utils/perf-trace-names.ts` first, then instrument, then update `infra/trace.md` § 2.
    4. Before reporting the task complete, run the trace self-check (`test/autotest/run-trace-infra-self-check-autotest.sh`) and the affected runner via `python3 test/autotest/run-full-regression.py --only run-<suite>`; confirm both are green.
    5. **Sync the test index.** Any change to `test/autotest/run-*-autotest.sh` or `test/autotest/test-*.ts` (new runner, new assertion-ID prefix, or amended scope on an existing runner) MUST update `test/README.md` § 2 *Feature × Test Index* in the same change set. The index is the single source of truth for "what feature is locked by which runner" — stale rows are worse than missing rows. Add the row when you create the runner, edit the description and assertion-ID list when you amend a runner, and delete the row if you retire one.
- Every task completion report must include:
    1. What is the task goal of the code, and what solution / design approach was used?
    2. What changes were made to which files?
    3. Finally, how do you evaluate this round of feature iteration? Is the repository change a very good / elegant design, or only a temporary patch-style solution?
    4. What would be a better follow-up improvement direction? Check whether any technical debt remains in the current repository?

## Release Channels and Tag Convention

The app supports two update channels with different tag formats and auto-update behavior:

| Channel | Tag format | Auto-check | Auto-download | Example |
|---------|-----------|------------|---------------|---------|
| **Daily** | `v2.1.0-daily.20260409.1` | Every hour | Yes | Production releases for all users |
| **Dev** | `v2.1.0-dev.20260409.1` | No | No | Development/debug builds, manual update only |

- **Hard rule**: Before pushing any tag that triggers a CI build, always ask the user which channel to target (daily or dev). Use the `/ow_push-daily-build` skill which handles channel selection automatically.
- **Branch constraint (enforced by CI)**: Daily channel tags must be created from the `master` branch. The CI workflow will reject daily tags whose commit is not on master. Only Dev channel tags are allowed on non-master branches.
- Both channels produce full artifacts and publish manifests to gh-pages (under `updates/daily/` or `updates/dev/` respectively).
- Dev channel users see "Manual check required" in Settings and must click Check → Download → Restart manually.
- Daily channel users receive automatic background checks and downloads.

## Full Regression Testing

When the user asks for a full regression run, execute `python3 test/autotest/run-full-regression.py`. That Python file is the single source of truth for the regression set, the per-runner timeout, the kill / cleanup contract, and the output layout. To add or remove a case, modify its `SCRIPTS` list directly — do not introduce a separate driver, checklist, or wrapper script. Output lands in `test/full-regression-results/<UTC-timestamp>/` (`summary.log`, `summary.json`, `logs/<suite>.log`); that directory is gitignored — share its contents by quoting the relevant excerpts back to the user, not by committing the run.

**Note**: `SCRIPTS` only grows when Step 0 of the 5-step SOP concludes "no adjacent runner exists." Amending an existing runner does not require a `SCRIPTS` edit — the runner is already registered, and duplicating an entry will make the orchestrator run the same suite twice per regression.

## Lessons Learned

Before starting complex feature development, read `docs/lessons.md` for historical lessons learned to avoid repeating past mistakes.
