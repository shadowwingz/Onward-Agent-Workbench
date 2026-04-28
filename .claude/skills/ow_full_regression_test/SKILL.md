---
name: ow_full_regression_test
description: Run the Onward full automated-test regression. Invoked explicitly by the user. Test mode (default): clean dev build (`--build` mandatory), runs `python3 test/autotest/run-full-regression.py --build`, then reports pass/fail/skip counts and failing-runner names. No analysis, no edits. Repair mode (`--repair`): clusters FAIL/TIMEOUT entries from the newest `test/full-regression-results/<timestamp>/` by root cause, then per-cluster Plan-Mode → fix → `--build --only run-<suite>` verify loop tracked in `repair-progress.json`, finishing with one final `--build` full pass. Clean mode (`--clean`): wipes accumulated test artefacts (traces, regression results, autotest scratch) by delegating to `scripts/clean-test-data.py` so the user can reset before a fresh run without leaving the skill. The three modes do not chain.
---

# ow_full_regression_test

Three independent modes, picked explicitly by the user:

- **Test mode** (default) — clean build → run regression → report
  pass/fail counts. Stops there. No analysis, no edits.
- **Repair mode** (`--repair`) — work on the failures from the most
  recent test run. Cluster → Plan Mode → fix → targeted verify →
  final full pass.
- **Clean mode** (`--clean`) — wipe gitignored test artefacts and
  report the reclaim. No tests run, no fixes applied.

They do not chain. A normal regression run never auto-triggers
repair or clean. `--repair` never auto-runs a fresh regression or a
clean first; it operates on the existing case file on disk.
`--clean` never runs tests. If the user passes more than one mode
flag at once (e.g. `--build --clean`, `--repair --clean`), ask which
they meant before doing anything. The user picks each transition.

---

## Mode A — Test mode (default)

The user wants to run the regression and see what state the codebase
is in. Nothing more. Three steps, then stop.

### Step 1 — Mandatory clean dev build

Every invocation MUST start with `--build`. The flag wipes `out/` and
`release/` then runs `pnpm dist:dev` before the runner list executes,
so the autotest is provably running against a package built from the
current source tree. A stale `release/mac-arm64/Under Development …
.app` is the single biggest source of "fixed it but the test still
fails" / "didn't touch it but the test now fails" confusion in this
project, so this is non-negotiable — even if you "just rebuilt" five
minutes ago, build again. The only exception is `--list`, which
doesn't run any test.

### Step 2 — Run the orchestrator

`test/autotest/run-full-regression.py` is the single source of truth
for the runner list, the per-runner 5-minute timeout, the exact-name
kill / cleanup contract, and the output layout. Do not invoke
individual `.sh` runners by hand or wrap the orchestrator in another
driver.

```bash
python3 test/autotest/run-full-regression.py --build
```

Common scopes the user might want (each keeps `--build`):

| User intent                                  | Invocation                                                                |
|----------------------------------------------|---------------------------------------------------------------------------|
| Full pass                                    | `python3 test/autotest/run-full-regression.py --build`                    |
| Re-run a specific suite                      | `python3 test/autotest/run-full-regression.py --build --only run-<suite>` |
| Skip a known-broken runner this round        | `python3 test/autotest/run-full-regression.py --build --skip run-<suite>` |
| List planned scripts only (no build, no run) | `python3 test/autotest/run-full-regression.py --list`                     |

A full pass typically takes 25–70 minutes (≈ 5–10 min build + 20–60
min runners). Run it in the background when feasible so the rest of
the conversation stays usable. If `pnpm dist:dev` itself fails, the
orchestrator stops before the runner list executes — read the build
error and report it to the user.

### Step 3 — Report counts only

Outputs land in `test/full-regression-results/<local-timestamp>/`
(directory name format `YYYYMMDDTHHMMSS`):

- `summary.log` — full streamed output + final pass/fail summary
- `summary.json` — machine-readable per-runner result
- `logs/<suite>.log` — per-runner stdout/stderr, one file each

Read `summary.json` and report to the user:

1. The numeric tally — `passed`, `failed`, `skipped`, `errored` —
   quoted verbatim.
2. The names of failing runners (`script` field for any entry whose
   `status` is `FAIL` or `TIMEOUT`). Just names. No log excerpts,
   no theories.
3. The full path to the run directory so the user can inspect it.
4. If failures > 0, end with one line: "Run `--repair` to enter
   repair mode for these failures."

**Do not** open `logs/<suite>.log`, do not search for assertion
markers, do not group by root cause, do not enter Plan Mode, do not
propose fixes. Test mode stops at "here's the score." The user picks
the next move.

---

## Mode B — Repair mode (`--repair`)

The user has already run the regression at least once and now wants
to fix the failures. Triggered by `--repair`, "fix / repair the
failures from the last full regression".

### Why production code, not tests

Every runner under `test/autotest/` and harness under `test/unittest/`
codifies a contract the application must satisfy from the user's
point of view. When a runner fails, the default assumption is that
the production code drifted from the contract, NOT that the test is
wrong:

> Treat the test as ground truth. Read the failure log carefully.
> Form a hypothesis about the production code path. Modify the
> production code until the test passes again.

Touching a test file is reserved for two narrow exceptions, both of
which require user confirmation before any edit:

1. The test itself contains a verifiable bug (wrong selector,
   off-by-one, stale fixture path).
2. The user has since intentionally removed the behaviour the test
   pinned.

When in doubt: leave the test alone, fix production.

### Hard precondition

Repair mode requires that a previous full regression run already
exists on disk. If `test/full-regression-results/` contains no
timestamped run directory, or the newest run directory has no
`summary.json` (the run was interrupted before write), STOP and tell
the user verbatim:

> `--repair` needs at least one prior full-regression run. Please
> run `python3 test/autotest/run-full-regression.py --build` first,
> then re-issue `--repair`.

Do **not** silently fall back to running a fresh regression — the
user said "repair", not "run".

### Step 1 — Locate the newest run

List `test/full-regression-results/` and pick the directory whose
name (format `YYYYMMDDTHHMMSS`) sorts last. Quote its full path back
to the user so they can confirm you're operating on the run they
had in mind — if they meant an older one they can redirect before
any work starts.

### Step 2 — Extract failures

Read `<run-dir>/summary.json`. Build the work list from every entry
whose `status` is `FAIL` or `TIMEOUT`. If the list is empty, report

> Previous run (`<run-dir>`) was already green — nothing to repair.

and exit. Do not run anything else.

### Step 3 — Initialise the progress file

Create `<run-dir>/repair-progress.json` (or reopen if a prior repair
pass against this run was interrupted). The original `summary.json`
and `summary.log` are the case file for the failing run and must
remain untouched — all repair-mode progress lives in this side-car
so the original evidence is preserved.

```json
{
  "source_run_dir": "test/full-regression-results/<YYYYMMDDTHHMMSS>",
  "started_at": "<ISO-8601 local>",
  "clusters": [
    {
      "id": "cluster-1",
      "hypothesis": "<one-sentence root-cause guess>",
      "scripts": ["test/autotest/run-<suite>-autotest.sh", "..."],
      "status": "pending",
      "verify_run_dir": null,
      "notes": ""
    }
  ],
  "final_full_run": null,
  "final_status": "in_progress"
}
```

Per-cluster `status`: `pending` (not started), `fixed` (production
change applied, not yet re-verified), `verified` (targeted re-run
green), `deferred` (user explicitly asked to skip this cluster this
round). Top-level `final_status`: `in_progress`, `all_green`,
`new_failures`.

### Step 4 — Cluster by root cause

Failures in the same subsystem most likely share one bug. For each
failing entry, open `logs/<suite>.log` and scan in this order for
markers: `[AutoTest] FAIL`, `AssertionError`, then `Error:` /
`error occurred in handler`. Scroll back from the marker to find the
test id (e.g. `PFM-42-…`, `SN-13-…`) and the observed-vs-expected
delta.

Group failures whose log evidence points at the same subsystem (e.g.
ProjectEditor markdown outline restore, Git Diff submodule discovery)
into one cluster. Order clusters by the size of the script set they
cover (largest first): fixing a shared root cause early often turns
several runners green in one cycle and keeps the verify-rebuild count
down. Write the clusters into `repair-progress.json`.

If a failure log is opaque, use the Explore subagent (or Grep / Read
directly) to walk the suspect code path before forming a hypothesis;
guessing wastes the user's time more than research does.

### Step 5 — Per-cluster fix loop

For each cluster whose `status` is `pending`:

**5a. Enter Plan Mode** with `EnterPlanMode`. Plan Mode blocks file
edits while you're still hypothesising; it surfaces your reasoning
to the user up front so they can redirect before code changes
happen. The plan must contain:

1. **Failure signature** — runner name(s), test id(s), ≤ 5 key log
   lines per runner.
2. **Root-cause hypothesis** — which production file / function /
   IPC contract drifted, and why that drift produces the observed
   failure. Cite specific `file:line` references.
3. **Proposed fix** — exact change, why it restores the contract
   without violating other guarantees in `CLAUDE.md` (input
   responsiveness, off-renderer threading, perf-trace instrumentation,
   multilingual i18n, cross-platform parity).
4. **Test-touch declaration** — state plainly **"no test files will
   be modified"**. If an exception applies (see "Why production code,
   not tests" above), name the test file, the line, the suspected
   bug in the test, and ask the user to confirm.
5. **Verification scope** — every script the cluster covers, listed
   so the re-run command is unambiguous.

Wait for `ExitPlanMode` (user approval). If the plan needs adjustment
after their feedback, stay in Plan Mode and revise — do not exit and
re-enter.

**5b. Apply the fix** after approval:

- Edit only the production files named in the plan. No adjacent
  refactors, no "while I'm here" cleanups.
- Do not modify any file under `test/autotest/**`, `test/unittest/**`,
  or `src/autotest/**` unless the plan declared a test-fix exception
  and the user approved it.
- Do not run `pnpm dist:dev` manually here — step 5c always uses
  `--build`, which performs the clean dev build immediately before
  the targeted re-run. Doing it twice wastes 5–10 minutes per cycle.
- Set the cluster's `status` to `fixed` in `repair-progress.json`
  immediately after edits, before running anything, so the file
  mirrors disk state even if 5c crashes.

**5c. Verify** with the orchestrator:

```bash
python3 test/autotest/run-full-regression.py --build --only run-<suite>
```

This rebuilds the dev package from your fix (clean `out/` +
`release/`, then `pnpm dist:dev`) and runs **only** the cluster's
scripts against the fresh package. If the cluster covers multiple
scripts, pass `--only` once per script (the orchestrator accepts
repeated `--only` filters).

- **Green**: set `status` to `verified`, record the new run
  directory in `verify_run_dir`, move on to the next `pending`
  cluster.
- **Still red**: return to step 5a for the **same** cluster — do
  not move on, do not silently iterate fixes. One plan, one
  approval, one fix; if the first attempt missed, the second gets
  its own plan and its own user approval.

If the user explicitly tells you to skip a cluster ("leave the EPUB
one for later"), set its status to `deferred` and continue.

### Step 6 — Final full-regression confirmation

Once every cluster is `verified` or `deferred`, run **one** final
full pass to catch cross-cluster regressions the targeted re-runs
could not see:

```bash
python3 test/autotest/run-full-regression.py --build
```

Record the new run directory in `final_full_run`.

- **All green** (`failed: 0`, ignoring scripts owned by `deferred`
  clusters which will still show red): set `final_status` to
  `all_green` and deliver the four-question task-completion report
  required by `CLAUDE.md`. End with: "Files staged: …, ready to
  commit when you are." DO NOT run `git commit`.
- **Something else regressed**: set `final_status` to
  `new_failures`, then re-enter repair mode against this newer run
  — a fresh repair pass starts, with its own `repair-progress.json`
  inside the newer timestamp dir, and its own per-cluster Plan-Mode
  approvals. Do not auto-loop without the user.

### Resumability

If repair is interrupted (the user closes the session, an edit
fails, a build dies), the next `--repair` invocation should:

1. Find the newest run dir.
2. If it has a `repair-progress.json` whose `final_status` is
   `in_progress`, reopen and continue from the first cluster whose
   status is not `verified` / `deferred`.
3. If the newest dir has *no* progress file but has FAIL entries,
   start fresh against it.
4. If a *newer* run dir exists than the one referenced by an older
   in-flight `repair-progress.json`, prefer the newer run — it
   supersedes the older case file. Tell the user so they know the
   older repair pass is being abandoned.

---

## Mode C — Clean mode (`--clean`)

The user wants to free disk space or get a clean slate before the
next `--build` run. Mode C is a thin wrapper that delegates to
`scripts/clean-test-data.py` — the single source of truth for which
gitignored test artefacts are safe to wipe.

### Sub-arguments

Accept exactly two pass-through tokens:

| User input                          | Script invocation                              |
|-------------------------------------|------------------------------------------------|
| `--clean` (no extra)                | dry-run preview, then `--yes` delete           |
| `--clean dry` / `--dry-run` / `-n`  | dry-run preview only; nothing deleted          |
| `--clean force` / `yes` / `-y`      | skip dry-run, run `--yes` immediately          |

For category-specific cleanup (`--traces`, `--regression`,
`--autotest-results`), invoke the script directly:
`python3 scripts/clean-test-data.py --traces` (etc.). Mode C
deliberately does not mirror the full flag matrix — duplicating it
would just create drift the next time the script gains a flag, and
power users can call the script with one extra word.

### Command flow

1. **Plan first.** Run

   ```bash
   python3 scripts/clean-test-data.py --dry-run
   ```

   and quote the output back to the user verbatim. The size column
   and per-category counts are the entire point of the preview — do
   not summarise them away.

2. **Confirm and delete.** If the user did not pass `force` / `yes`
   / `-y`, run the real command **with `--yes`**:

   ```bash
   python3 scripts/clean-test-data.py --yes
   ```

   The `--yes` bypasses the script's own TTY prompt because the
   harness cannot answer it; the user's chance to abort was reading
   the dry-run plan in step 1.

   If the user passed `dry` / `-n` in step 1, **stop here** — do not
   delete anything.

3. **Report the reclaim.** The script prints
   `Deleted N file(s), reclaimed X MB.` at the end — quote that line
   back as the closing summary.

### What gets deleted / preserved

Do **not** inline the target list here — it would drift. The
authoritative inventory lives in `scripts/clean-test-data.py`'s
`TARGETS` table (and its module docstring). In short: gitignored
test artefacts under `traces/` and `test/full-regression-results/`
and `test/autotest/results/` are removed; committed fixtures,
source code, and `.gitkeep` markers are preserved.

### Mid-repair safety

If a `<run-dir>/repair-progress.json` exists with `final_status:
in_progress`, Mode C is destructive to the active case file —
`test/full-regression-results/` is exactly what the repair loop
reads from. Before running anything, warn the user:

> A repair pass against `<run-dir>` is in progress
> (`repair-progress.json`, `final_status: in_progress`). Cleaning
> now will delete that case file. Confirm to proceed.

and require an explicit "yes, clean" before invoking the script.

---

## Boundaries

**Always:**

- Treat tests as the contract; production code is what drifts.
- Use `--build` on every regression invocation — Mode A's run, Mode
  B's per-cluster verify, and Mode B's final pass alike.

**Never:**

- Auto-chain the three modes. Mode A reports counts and stops; Mode
  B operates on existing artefacts; Mode C only deletes. `--clean`
  never runs tests, never auto-runs `--build`, never auto-enters
  `--repair`. The user picks each transition.
- Modify files under `test/autotest/**`, `test/unittest/**`, or
  `src/autotest/**` without an explicit plan-stage acknowledgement
  AND user approval.
- Create commits automatically. Stage the change and report; the
  user calls the commit.
- Disable, skip, or comment out a failing test to "make the build
  green". That destroys the regression contract.
- Delete or edit `traces/` or `test/full-regression-results/`
  artefacts to mask a failure. `--clean` is the supported reset
  path; use it only when starting a fresh run is what the user
  wants.
- Reimplement deletion in Mode C. `--clean` MUST shell out to
  `scripts/clean-test-data.py`; do not call `rm`, `shutil.rmtree`,
  or maintain a parallel target list inline.
- Run `--clean` while a `repair-progress.json` with `final_status:
  in_progress` exists, without explicit user reconfirmation —
  wiping `test/full-regression-results/` mid-repair destroys the
  case file the repair loop reads from.
- Edit the original `summary.json` / `summary.log` of any prior
  regression run, even during `--repair`. Repair-mode progress goes
  into the side-car `repair-progress.json`.
- Wrap or substitute `run-full-regression.py`. The orchestrator
  owns the runner list, timeout, and kill contract; modifying its
  `SCRIPTS` list is a separate change reviewed on its own merits.
- Apply more than one fix cluster per Plan Mode pass. One plan, one
  approval, one fix.
- Start `--repair` when no prior run exists on disk. Refuse, point
  the user at `python3 test/autotest/run-full-regression.py --build`,
  and wait.

---

## Quick reference

| Output                                    | Use it to …                                                                  |
|-------------------------------------------|------------------------------------------------------------------------------|
| `summary.json`                            | Read pass/fail tally; in repair mode, loop over `status == "FAIL"` / `"TIMEOUT"` |
| `summary.log`                             | Quote the final PASS/FAIL block back to the user                             |
| `logs/<suite>.log`                        | (Repair mode only) find the assertion line and surrounding context           |
| `traces/test-logs/<suite>.log`            | Same as above, also live-tailable while a run is going                       |
| `repair-progress.json`                    | `--repair` side-car: cluster status (`pending` / `fixed` / `verified` / `deferred`) + final pass result |
| `python3 …/run-full-regression.py --list` | Pre-flight: confirm every runner is registered                               |
| `python3 scripts/clean-test-data.py --dry-run` | Mode C pre-flight: preview which artefacts `--clean` would delete       |

---

## When the run is large

For a full pass (≈ 5–10 min build + up to ~1 h of runners), launch
in the background so the conversation remains usable while the
runner works:

```bash
python3 test/autotest/run-full-regression.py --build
```

Use the orchestrator's per-runner `PASS / FAIL` lines to track
progress. Do not poll aggressively; check back when the background
task finishes.
