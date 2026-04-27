---
name: clean-test-data
description: One-click cleanup for ever-growing local test data — Chrome trace exports under `traces/perf/`, autotest logs under `traces/test-logs/`, full-regression run dirs under `test/full-regression-results/`, and renderer-side autotest scratch under `test/autotest/results/`. Use when the user wants to free disk space, clear stale runs before a fresh capture, or get a clean slate for `python3 test/autotest/run-full-regression.py`. Never touches committed fixtures, source code, or anything tracked in git.
---

# clean-test-data

Wipes the gitignored test artefacts that accumulate every time a runner,
the orchestrator, or `ONWARD_PERF_TRACE=1` is invoked. The actual logic
lives in `scripts/clean-test-data.py` — this skill is just the entry
point so the user gets a plan + one-line confirmation, not a silent
delete.

## What gets removed

| Path                                  | Source of growth |
|---------------------------------------|---------------------------------------------------|
| `traces/perf/`                        | Chrome trace JSON written by `ONWARD_PERF_TRACE=1` |
| `traces/test-logs/`                   | Per-runner stdout/stderr from every `.sh` autotest |
| `traces/screenshots/`                 | Ad-hoc capture dumps (if any)                      |
| `traces/profile/`                     | CPU / sampling profile dumps (if any)              |
| `test/full-regression-results/`       | Per-run summary + per-runner logs from the orchestrator |
| `test/autotest/results/`              | Renderer-side autotest scratch                     |

## What is preserved

- `traces/.gitkeep` (the placeholder that keeps `traces/` on fresh clones)
- Every committed fixture under `test/autotest/fixtures/**`
- Anything tracked in git

## Argument routing

The user's `args` (anything they typed after `/clean-test-data`) maps to
flags on `scripts/clean-test-data.py`:

| User input                                  | Script invocation                                       |
|---------------------------------------------|---------------------------------------------------------|
| (no args)                                   | `python3 scripts/clean-test-data.py`                    |
| `dry`, `dry-run`, `--dry-run`, `-n`         | `python3 scripts/clean-test-data.py --dry-run`          |
| `force`, `yes`, `-y`                        | `python3 scripts/clean-test-data.py --yes`              |
| `traces`                                    | `python3 scripts/clean-test-data.py --traces`           |
| `regression`                                | `python3 scripts/clean-test-data.py --regression`       |
| `autotest-results`                          | `python3 scripts/clean-test-data.py --autotest-results` |

Multiple terms can be combined: `traces force` ⇒ `--traces --yes`.

If the user types something the table does not cover, ask once for
clarification before running anything destructive.

## Behaviour

### 1. Plan first

Always start with a dry-run pass so the user sees what would be
deleted, by category and total size:

```bash
python3 scripts/clean-test-data.py --dry-run
```

Quote that output verbatim back to the user. Do not summarise it away
— the size column and the per-category counts are the whole point of
the preview.

### 2. Confirm and delete

If the user did not pass `force` / `yes` / `-y`:

- After the plan is shown, run the real command **with `--yes`** so
  the script does not also ask for confirmation:
  ```bash
  python3 scripts/clean-test-data.py --yes [other flags…]
  ```
  The skill itself has already given the user a chance to abort by
  reading the plan; routing through `--yes` avoids a redundant TTY
  prompt that the harness cannot answer.

If the user passed `dry` / `--dry-run` / `-n`, stop after step 1 and
do **not** delete anything.

### 3. Report the reclaim

The script prints `Deleted N file(s), reclaimed X MB.` at the end —
quote that line back to the user as the closing summary.

## Boundaries

- **Never** delete files outside the targets table above.
- **Never** delete anything tracked in git. The script enforces this
  structurally: it iterates the gitignored target directories only and
  honours per-target `.gitkeep` preservation.
- **Never** use `rm -rf` from the shell directly — go through the
  Python script so cross-platform (macOS / Linux / Windows) behaviour
  stays consistent and the audit-friendly plan output is preserved.
- If a target directory does not exist, that is fine — the script
  silently skips it.

## When the user asks "how much could I free up?"

Run only the dry-run:

```bash
python3 scripts/clean-test-data.py --dry-run
```

Show the plan, then ask whether to proceed. Do not delete unless the
user says yes.
