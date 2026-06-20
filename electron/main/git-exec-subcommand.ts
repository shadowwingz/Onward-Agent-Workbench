/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Extract the real git subcommand from an argv array for trace diagnostics.
 *
 * git commands in this codebase are built with leading global option pairs —
 * most commonly `-c core.quotepath=false` (and sometimes `-c core.autocrlf=…`)
 * for cross-platform output stability — so `args[0]` is the config FLAG, not the
 * subcommand. Recording `args[0]` made every `diff` / `status` / `log` /
 * `cat-file` spawn collapse into a single `-c` bucket in the perf trace (a real
 * trace showed 33 spawns / 74s all masked as `-c`), defeating per-subcommand
 * cost analysis. This helper skips leading global options to surface the actual
 * subcommand (`status` / `diff` / `log` / `rev-parse` / `cat-file` / …).
 *
 * Pure + dependency-free so `test/unittest` loads it with no Electron build.
 *
 * Recognised leading global-option shapes (git's own grammar):
 *   - `-c name=value`  → two argv tokens (the value is a separate element)
 *   - `-C <path>`      → two argv tokens
 *   - any other `--flag` / `--flag=value` / `-x` before the subcommand → one token
 * The first token that does NOT start with `-` is the subcommand.
 */
export function extractGitSubcommand(args: readonly string[]): string | null {
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (typeof a !== 'string') return null
    // `-c name=value` and `-C <path>` consume a following value token.
    if (a === '-c' || a === '-C') {
      i += 2
      continue
    }
    // Any other leading option (`--no-pager`, `--git-dir=…`, `-p`, …) is a
    // single token; skip it and keep scanning for the subcommand.
    if (a.startsWith('-')) {
      i += 1
      continue
    }
    return a
  }
  return null
}
