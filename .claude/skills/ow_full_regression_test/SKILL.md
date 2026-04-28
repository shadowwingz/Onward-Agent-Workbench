---
name: ow_full_regression_test
description: Run the Onward full automated-test regression — always preceded by a clean dev build (`--build` is mandatory on every invocation, no exceptions) — via `python3 test/autotest/run-full-regression.py --build`, parse the run's summary + per-runner logs, then for any failure enter Plan Mode to root-cause the bug and propose a fix to PRODUCTION code (never the test). Use this whenever the user wants to "run the full regression", "run all autotests", "verify nothing is broken", "see what's failing", "triage / fix regression failures", or asks to repair recent autotest breakage. Default policy: tests are the contract, production code drifts — most fixes touch `src/` or `electron/`, not `test/autotest/`. Trigger this skill even when the user only asks for half of the loop ("run regression and tell me what failed", or "fix the markdown autotest"); the workflow handles partial scopes via `--only`, and `--build` still runs first.
---

# ow_full_regression_test

End-to-end runbook: full regression → log analysis → Plan-Mode-gated
fix → rebuild → scoped re-run → done.

## Why production code, not tests

Every runner under `test/autotest/` and harness under `test/unittest/`
codifies a contract the application must satisfy from the user's point
of view. When a runner fails, the default assumption is that the
production code drifted from the contract, NOT that the test is wrong.
The heuristic, in one line:

> Treat the test as ground truth. Read the failure log carefully. Form
> a hypothesis about the production code path. Modify the production
> code until the test passes again.

Touching a test file is reserved for two narrow exceptions:

1. The test itself contains a verifiable bug (wrong selector, off-by-
   one, stale fixture path) — surface this in the plan, name the file
   and line, and ask the user to confirm before editing it.
2. The user has since intentionally removed the behaviour the test
   pinned — same: ask before editing.

When in doubt: leave the test alone, fix production.

## Phase 1 — Run the regression (always with a fresh build)

`test/autotest/run-full-regression.py` is the single source of truth
for the runner list, the per-runner 5-minute timeout, the exact-name
kill / cleanup contract, and the output layout. Do not invoke
individual `.sh` runners by hand or wrap the orchestrator in another
driver.

**Mandatory pre-build — no exceptions.** Every regression invocation
in this skill MUST start with `--build`. The flag wipes `out/` and
`release/` then runs `pnpm dist:dev` before the runner list executes,
so the autotest is provably running against a package built from your
current source tree. A stale `release/mac-arm64/Under Development …
.app` is the single biggest source of "fixed it but the test still
fails" / "didn't touch it but the test now fails" confusion in this
project, so this is non-negotiable — even if you "just rebuilt" five
minutes ago, build again. The only exception is `--list`, which
doesn't run any test.

```bash
python3 test/autotest/run-full-regression.py --build
```

Common scopes the user might want (every command keeps `--build`):

| User intent                               | Invocation                                                                          |
|-------------------------------------------|-------------------------------------------------------------------------------------|
| Full pass                                 | `python3 test/autotest/run-full-regression.py --build`                              |
| Re-run a specific suite                   | `python3 test/autotest/run-full-regression.py --build --only run-<suite>`           |
| Skip a known-broken runner this round     | `python3 test/autotest/run-full-regression.py --build --skip run-<suite>`           |
| List planned scripts only (no build, no run) | `python3 test/autotest/run-full-regression.py --list`                            |

A full pass typically takes 25–70 minutes (≈ 5–10 min build + 20–60
min runners). Run it in the background when feasible so the rest of
the conversation stays usable; the orchestrator prints `PASS` /
`FAIL` per runner and a final summary. If `pnpm dist:dev` itself
fails, the orchestrator stops before the runner list executes — read
the build error and fix it before re-running.

## Phase 2 — Read the results

Outputs land in `test/full-regression-results/<local-timestamp>/`
(directory name is the host's local time, format `YYYYMMDDTHHMMSS`):

- `summary.log` — full streamed output + final pass/fail summary
- `summary.json` — machine-readable per-runner result
- `logs/<suite>.log` — per-runner stdout/stderr, one file each

Workflow:

1. Read `summary.json`. Filter for entries whose `status` is `FAIL` or
   `TIMEOUT`. The `passed` / `failed` counts at the top give you the
   shape of the run; quote them back to the user verbatim.
2. For each failing entry, open `logs/<suite>.log` and search for
   markers in this order: `[AutoTest] FAIL`, `AssertionError`, then
   `Error:` / `error occurred in handler`. Scroll back from the marker
   to find the test id (e.g. `PFM-42-…`, `SN-13-…`) and the observed-vs-
   expected delta.
3. Group failures by likely root cause **before** going further.
   Two failures in the same subsystem (e.g. ProjectEditor markdown
   outline restore, or Git Diff submodule discovery) often share one
   bug. Do not propose one fix per runner if the upstream cause is
   shared.

If a failure log is opaque, use the Explore subagent (or Grep / Read
directly) to walk the suspect code path before forming a hypothesis;
guessing wastes the user's time more than research does.

## Phase 3 — Plan Mode (mandatory before any edit)

Before writing or editing **any** source file, enter Plan Mode using
the `EnterPlanMode` tool. Plan Mode blocks file edits while you are
still hypothesising; it surfaces your reasoning to the user up front
so they can redirect before code changes happen.

The plan must include, for each failure cluster:

1. **Failure signature** — runner name, test id, ≤ 5 key log lines.
2. **Root-cause hypothesis** — which production file / function / IPC
   contract drifted, and why that drift produces the observed failure.
   Cite specific `file:line` references.
3. **Proposed fix** — exact change, why this change restores the
   contract without violating other guarantees documented in
   `CLAUDE.md` (input responsiveness, off-renderer threading, perf-
   trace instrumentation, multilingual i18n, cross-platform parity).
4. **Test-touch declaration** — state plainly **"no test files will
   be modified"**. If an exception applies (see "Why production code,
   not tests" above), name the test file, the line, the suspected bug
   in the test, and ask the user to confirm.
5. **Verification scope** — which `--only run-<suite>` substring(s)
   will be used to re-run the affected runner(s) after the fix.

Wait for the user to approve via `ExitPlanMode` before doing any
editing. If the plan needs adjustment after their feedback, stay in
Plan Mode and revise — do not exit and re-enter.

## Phase 4 — Apply the fix

After the user approves and you exit Plan Mode:

1. Edit only the production files named in the plan. Do not drift
   into adjacent refactors, "while I'm here" cleanups, or unrelated
   improvements — those belong in their own change.
2. **Do not** modify any file under `test/autotest/**`,
   `test/unittest/**`, or `src/autotest/**` unless the plan explicitly
   declared a test-fix exception and the user approved it.
3. **Do not** run `pnpm dist:dev` manually here. Phase 5 always uses
   `--build`, which performs the clean dev build (`rm -rf out release
   && pnpm dist:dev`) immediately before the targeted re-run. Doing
   it twice wastes 5–10 minutes per cycle and adds nothing — letting
   the orchestrator own the build keeps "package built" and "test
   ran" provably adjacent in time, which is the property that makes
   the verification trustworthy.

## Phase 5 — Verify (always with a fresh build)

Re-run only the affected runner(s) through the orchestrator. `--build`
is required here just like in Phase 1: it rebuilds your fix and runs
the targeted suites against that fresh package in one command, so the
verification can never drift from the source you just edited.

```bash
python3 test/autotest/run-full-regression.py --build --only run-<suite>
```

Confirm the new run reports `Failed: 0` for the targeted scope. If
something else regressed in the meantime, return to Phase 3
(re-enter Plan Mode) — do not iterate fixes silently. Each fix /
verify cycle deserves its own plan, and each re-verify carries its
own `--build`.

When every previously-failing runner in scope is green, deliver the
four-question task-completion report required by CLAUDE.md:

1. What was the goal, and what design approach did you use?
2. What changes were made, to which files?
3. How do you assess this round — is the change a clean fix or a
   patch-style workaround?
4. What is the better follow-up improvement? Any technical debt
   introduced or revealed?

End with: "Files staged: …, ready to commit when you are." DO NOT run
`git commit` — per the CLAUDE.md hard rule, the user decides when to
commit.

## Boundaries

- **Never** modify files under `test/autotest/**`, `test/unittest/**`,
  or `src/autotest/**` without an explicit plan-stage acknowledgement
  AND user approval.
- **Never** create commits automatically. Stage the change and report;
  the user calls the commit.
- **Never** disable, skip, or comment out a failing test to "make the
  build green". That destroys the regression contract.
- **Never** delete or edit `traces/` or `test/full-regression-results/`
  artefacts to mask a failure. Use `/ow_clean-test-data` to reset them
  when (and only when) starting a fresh run is what the user wants.
- **Never** wrap or substitute `run-full-regression.py`. The
  orchestrator owns the runner list, timeout, and kill contract;
  modifying its `SCRIPTS` list is a separate change reviewed on its
  own merits.
- **Never** apply more than one fix cluster per Plan Mode pass without
  re-entering Plan Mode in between. One plan, one approval, one fix.

## Quick reference

| Output                                  | Use it to …                                              |
|-----------------------------------------|----------------------------------------------------------|
| `summary.json`                          | Loop over results; pick `status == "FAIL"` / `"TIMEOUT"` |
| `summary.log`                           | Quote the final PASS/FAIL block back to the user         |
| `logs/<suite>.log`                      | Find the assertion line and surrounding context          |
| `traces/test-logs/<suite>.log`          | Same as above, also live-tailable while a run is going   |
| `python3 …/run-full-regression.py --list` | Pre-flight: confirm every runner is registered          |

## When the run is large

For a full pass (≈ 5–10 min build + up to ~1 h of runners), launch in
the background so the conversation remains usable while the runner
works:

```bash
python3 test/autotest/run-full-regression.py --build
```

Use the orchestrator's per-runner `PASS / FAIL` lines to track
progress. Do not poll aggressively; check back when the background
task finishes. While the build phase is running, the runner list has
not started yet — that window is a good time to pre-read the codebase
areas a recent change touched so the failure analysis in Phase 3 is
faster.
