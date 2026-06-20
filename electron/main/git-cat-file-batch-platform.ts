/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Platform policy for the long-running `git cat-file --batch` reader
 * (see git-cat-file-batch.ts).
 *
 * Pure, dependency-free (no Electron, no Node beyond types) so it is
 * unit-testable in plain `node --test` and importable from both the batch
 * manager and the test. The long-running-batch MECHANISM is platform-agnostic;
 * this module decides only WHICH git command drives it, per platform:
 *
 *   - **win32** — implemented: the resolved system git. The EDR per-spawn tax
 *     makes the long-running batch a large win here.
 *   - **darwin** — PLACEHOLDER ({@link resolveDarwinBatchGitExecutable}): macOS
 *     should package its OWN platform-specific git command (e.g. a bundled,
 *     code-signed macOS git). Until that lands the placeholder drives the
 *     resolved system git so the mechanism is already active on macOS.
 *   - **other (Linux, …)** — intentionally NOT enabled (returns null). Native
 *     git spawns are cheap there; the caller falls back to per-call cat-file.
 *
 * Feature scope is win32 + darwin only, by request — an explicit per-platform
 * branch per the CLAUDE.md cross-platform rule.
 */

/**
 * PLACEHOLDER — macOS-specific `cat-file --batch` command resolution.
 *
 * TODO(macos): the macOS owner should resolve/return macOS's OWN
 * platform-specific git command here — e.g. an app-bundled, code-signed git
 * binary shipped inside `Resources/` — and return its absolute path. Only this
 * one function needs a macOS-specific body; the batch mechanism is already
 * platform-agnostic.
 *
 * Contract (keep stable when implementing):
 *   - return an absolute path / command string to a git that supports
 *     `cat-file --batch` (any git >= 1.x), OR
 *   - return null to opt macOS out of the batch (falls back to per-call cat-file).
 *
 * INTERIM (until the bundled command lands): drive the resolved SYSTEM git so
 * macOS already benefits from the long-running batch.
 */
export function resolveDarwinBatchGitExecutable(defaultGitExecutable: string): string | null {
  // INTERIM: system git. macOS owner — swap in the bundled platform command.
  return defaultGitExecutable
}

/**
 * Resolve WHICH git command drives `cat-file --batch`, per platform. Pure
 * (platform injected) so it is unit-testable without mocking `process.platform`.
 *
 * @returns the command to spawn, or null when the batch is intentionally NOT
 *   enabled on this platform (caller falls back to per-call cat-file).
 */
export function resolveBatchGitExecutable(
  platform: NodeJS.Platform,
  defaultGitExecutable: string
): string | null {
  switch (platform) {
    case 'win32':
      // Windows: EDR per-spawn tax makes the long-running batch a large win.
      // Resolved system git for now (a Windows-bundled command could slot here).
      return defaultGitExecutable
    case 'darwin':
      return resolveDarwinBatchGitExecutable(defaultGitExecutable)
    default:
      // Linux / others: out of scope by request — native spawns are cheap there.
      return null
  }
}

/** True when the long-running batch is enabled for the given platform. */
export function isBatchSupportedPlatform(platform: NodeJS.Platform): boolean {
  return resolveBatchGitExecutable(platform, 'git') !== null
}
