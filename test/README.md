<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onward test suite

The full regression run and every automated-test design decision are
owned by a single Python orchestrator:

```
test/autotest/run-full-regression.py
```

## Run the full suite

```bash
python3 test/autotest/run-full-regression.py
```

Output lands in `test/full-regression-results/<local-timestamp>/`
(directory name is the host's local time, format `YYYYMMDDTHHMMSS`):

- `summary.log` — full streamed output + final pass/fail summary
- `summary.json` — machine-readable result of every runner
- `logs/<suite>.log` — per-runner stdout/stderr, one file each

That directory is gitignored — runs stay local, share the relevant
excerpts (PASS / FAIL summary, the failing per-runner log) with
reviewers instead of committing the artefacts.

Useful flags: `--build`, `--only <substr>`, `--skip <substr>`,
`--app-bin <path>`, `--list`. See `python3 test/autotest/run-full-regression.py --help`.

## Adding or modifying an automated test

When the user asks for a new automated test or for the test system to
change, edit `test/autotest/run-full-regression.py` directly. Reshape
the rest of the suite around it — do not introduce a separate driver
or checklist.

1. Create the runner under `test/autotest/run-<suite>-autotest.sh`
   (and the `.ps1` mirror for Windows when applicable). Every runner
   must carry an SPDX header and write its log to
   `<repoRoot>/traces/test-logs/<suite>.log`.
2. Append the new runner to the `SCRIPTS` list inside
   `test/autotest/run-full-regression.py`.
3. Reusable fixtures go under `test/autotest/fixtures/<suite>/`.
   Per-run scratch goes under the OS temp dir or
   `test/autotest/results/<suite>/` (gitignored).
4. Unit-only harnesses (Node `node --test` or `assert`-style) go under
   `test/unittest/`.

## Hard rule — Test iteration loop (run → exit → read → fix → rebuild → repeat)

When the user asks you to run tests, or when you are using automated /
unit tests to drive a fix-and-verify loop, follow this strict sequence
on every iteration. Do not overlap steps.

1. **Run the test** as a single one-shot invocation. Foreground for
   short runs; background (`run_in_background: true`) for long runs so
   the harness notifies you on exit. The test must write to a
   persisted log file (`<repoRoot>/traces/test-logs/<suite>.log` for
   autotest runners; `test/full-regression-results/<timestamp>/` for
   the orchestrator).
2. **Wait for the test process to exit on its own.** Foreground runs
   block automatically; background runs send a completion notification.
   Do not poll, do not `sleep`-loop, do not `ScheduleWakeup` to peek
   early.
3. **Exit / kill the application** if the test left an Electron build
   running (use the `pkill -x "<exact-process-name>"` pattern). The
   next compile must start from a clean process table.
4. **Read the persisted log file** with the `Read` tool after the
   process is gone.
5. **Analyse the failure(s) and apply the code fix.**
6. **Rebuild** via `rm -rf out release && pnpm dist:dev` (or a
   narrower build if the change permits, e.g. `tsc --noEmit` or a
   unit-only re-run).
7. **Re-run** the test as another one-shot, again wait for exit, again
   kill the app on completion, again read the log.

Repeat 1–7 until green. Do not declare success based on partial
output or a "looks fine so far" stream snapshot.

### Forbidden patterns inside this loop

- Using `Monitor` to watch the test's log file.
- `tail -f <log>` piped into a polling loop.
- `grep -m1` / `while read` / `until grep -q … <log>; do sleep N; done`
  waiters that block on a specific log line.
- Re-`Read`ing the log file repeatedly while the test is still running,
  hoping the line you need has appeared.

The test owns its lifecycle: wait for the **process** to exit, then
read the **file**. The persisted log is the source of truth, not a
live stream.

**Why this rule exists:** live-stream waiters race with buffered
output, mask early crashes (the line you're waiting for never gets
flushed), entangle Claude's process tree with the test's, and waste
cache window on idle polling. Run-then-analyse keeps the evidence
chain reproducible and each iteration deterministic.
