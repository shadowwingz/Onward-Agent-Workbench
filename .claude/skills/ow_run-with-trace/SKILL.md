---
name: ow_run-with-trace
description: Launch the Onward dev build with ONWARD_PERF_TRACE=1 so a Chrome Trace Event Format file is captured under `traces/perf/`. After the user quits the app, automatically open the trace in a local Perfetto UI (no prompt). If no dev build exists yet, build it first via `pnpm dist:dev`. Use when the user says "run with trace" / "抓取性能日志 / 打开性能追踪" / wants to inspect perf interactively. Development-only; never runs against a production build.
---

# Run with Trace

Interactive dev-time perf capture.

## Behaviour

1. If the dev `.app` binary isn't present, build it once.
2. Kill any existing instance of the same dev build and wipe
   `traces/perf/` so you get a clean session.
3. Launch the binary with `ONWARD_PERF_TRACE=1` + `ONWARD_REPO_ROOT`
   (the logger then writes to `<repoRoot>/traces/perf/perf-trace-*.json`
   instead of `userData/debug/`).
4. Go silent — the user is interacting with the app. Do not issue more
   tool calls until the launcher process exits. You will receive a
   task-end notification when they quit.
5. **Immediately** run `bash infra/scripts/open_trace.sh` without
   asking. That boots local `trace_processor_shell --httpd :9001` and
   opens the browser to a version-pinned Perfetto UI URL. Trace never
   leaves localhost.

## Execution flow

### Phase 1 — Preflight

Derive values from the repo:

```bash
REPO_ROOT="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" && pwd)"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
APP_NAME="Under Development ${VERSION}-${BRANCH}"
APP_BIN="$REPO_ROOT/release/mac-arm64/${APP_NAME}.app/Contents/MacOS/${APP_NAME}"
```

All subsequent commands use these names.

### Phase 2 — Build if missing

If `[ ! -x "$APP_BIN" ]`, the dev binary doesn't exist yet. Build it
once:

```bash
cd "$REPO_ROOT"
rm -rf out release && ONWARD_DIST_DEV_OPEN=0 pnpm dist:dev
```

- `ONWARD_DIST_DEV_OPEN=0` stops the build script from auto-launching
  the app — this skill manages the launch itself.
- Use `run_in_background: true` when invoking this via the Bash tool
  (builds take 2-5 minutes); wait for the task-end notification before
  proceeding.

If `$APP_BIN` already exists, skip the build. Do not pre-emptively
`rm -rf out release` just to rebuild — reuse the existing binary,
that's the whole point of phase 2 being conditional.

### Phase 3 — Clean state

```bash
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 0.5
rm -rf "$REPO_ROOT/traces/perf"
mkdir -p "$REPO_ROOT/traces/perf"
```

Exact-name `pkill -x` only — per the project process-safety hard rule
(never wildcard match for `pkill`). `rm -rf traces/perf` keeps the
UI's "latest.txt" pointer cleanly aimed at this session.

### Phase 4 — Launch with trace

Use the Bash tool with `run_in_background: true`. The command:

```bash
ONWARD_PERF_TRACE=1 ONWARD_REPO_ROOT="$REPO_ROOT" "$APP_BIN"
```

After the call returns with a background task id, tell the user
briefly what's running and go silent. Example short message:

> Onward is running with perf trace on. Use it normally; Cmd+Q to quit.
> I'll auto-open the trace when the app closes.

Then **do not issue any further tool calls**. Do not poll. Do not ask
the user for anything. Just wait for the task-end notification.

### Phase 5 — Auto-open trace (no prompt)

When the task-end notification arrives (the launcher process has
exited — the user quit the app), immediately run:

```bash
bash "$REPO_ROOT/infra/scripts/open_trace.sh"
```

Do NOT ask for permission. The user has already opted into this flow
by invoking the skill; they explicitly said "auto-open" when the
skill was designed. The script:

- Picks the newest `traces/perf/*.json`.
- Bootstraps `trace_processor_shell` into
  `~/.local/share/perfetto/prebuilts/` on first run.
- Starts `trace_processor_shell --httpd --http-port=9001 <file>`.
- Opens the browser to
  `https://ui.perfetto.dev/v<tp_ver>-<sha>/#!/?rpc_port=9001` — pinned
  UI build to match tp_shell build.

After the script returns, report to the user:
- Trace file path.
- Event count (`grep -c '"ph":' <file>` as a rough counter).
- Pinned UI URL.
- tp_shell PID (for later `kill <pid>` when they're done browsing).

## Guardrails

- **Dev mode only.** This skill is for development iteration. Do not
  run it against a production `dist` build — `ONWARD_PERF_TRACE` is
  honoured in production but production users don't have a
  `<repoRoot>/traces/` directory; fallback routes traces to
  `userData/debug/` and the open_trace helper won't find them. If the
  user asks for trace capture against a production build, redirect
  them to `ONWARD_REPO_ROOT=<someDir>` + manually scripted capture.
- **Never ask "should I open the trace?"** The user already said no
  prompt. Auto-open is the contract.
- **Exact-name pkill only.** Never `pkill -f` or `pkill <partial>` —
  per the project-wide process-safety hard rule.
- **Don't `rm -rf out release` unless actually building.** The
  CLAUDE.md rule about "clean before build" applies after code
  changes. This skill doesn't change code; reusing the existing dev
  binary is the whole point.
- **Don't set `ONWARD_AUTOTEST=1`.** That flag triggers the autotest
  harness in the renderer — we want normal interactive operation.

## Failure modes and recovery

| Symptom | Likely cause | Recovery |
|---|---|---|
| `$APP_BIN` doesn't exist after build | Build actually failed; task exit code non-zero | Read the tail of the build log, surface the error, stop. Do NOT attempt to run an older binary. |
| Launch exits instantly (1-2 seconds, nothing in traces/perf/) | Another instance was holding port / crashed on startup | Re-check with `pgrep -lx "$APP_NAME"`; if stuck, `pkill -x "$APP_NAME"` and retry phase 4. |
| `traces/perf/*.json` missing after quit | Shutdown didn't flush (SIGTERM/will-quit both skipped) | Rare; signal handlers cover 4 paths. Report the missing file; suggest the user re-run and quit via Cmd+Q rather than force-quit. |
| `open_trace.sh` reports "trace_processor_shell not found; downloading…" on first run | Expected — binary is downloaded on demand | Wait; it's a ~20 MB one-time fetch. |
| Browser doesn't pop up | macOS `open` failed silently | Print the URL explicitly so the user can click it. |

## Related

- `infra/scripts/open_trace.sh` — the post-quit opener this skill drives.
- `electron/main/perf-trace-logger.ts` — the emitter that responds to
  `ONWARD_PERF_TRACE=1`.
- `infra/trace.md` — authoritative trace system index, event catalog,
  SQL examples.
- `docs/debug-env-variables.md` — `ONWARD_PERF_TRACE` and
  `ONWARD_REPO_ROOT` reference.
- `CLAUDE.md` Hard rule § 2 ("after capturing a perf trace, end the
  response with open_trace.sh") — this skill is the canonical
  executor of that rule.
