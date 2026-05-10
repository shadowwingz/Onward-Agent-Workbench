/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Canonical strings for the Git Diff click → render phase chain. This
// module is intentionally a *leaf* (zero downstream imports) so it can
// be loaded by:
//   1. the production bundler (Vite / electron-vite) without wiring,
//   2. Node's `--experimental-strip-types` test loader, which cannot
//      resolve extensionless bundler-style imports across multiple hops,
//   3. perf-trace-names.ts, which hands these values back to the rest of
//      the trace registry under the `RENDERER_GIT_DIFF_CLICK_PHASE_*`
//      keys for SQL / Perfetto consumers.
//
// Single source of truth for these strings — DO NOT inline a
// duplicate copy elsewhere. If you need them in another module, import
// from here.

export const CLICK_PHASE_EVENT_NAMES = {
  IPC: 'renderer:git-diff.click-phase.ipc',
  STATE_SET: 'renderer:git-diff.click-phase.state-set',
  MODEL_BIND: 'renderer:git-diff.click-phase.model-bind',
  MOUNT: 'renderer:git-diff.click-phase.mount',
  DIFF_COMPUTE: 'renderer:git-diff.click-phase.diff-compute',
  DOM_COMMIT: 'renderer:git-diff.click-phase.dom-commit',
  PAINT: 'renderer:git-diff.click-phase.paint',
  TOKENIZE_SETTLE: 'renderer:git-diff.click-phase.tokenize-settle',
  COLD_MOUNT: 'renderer:git-diff.click-phase.cold-mount',
  REVEAL_TIMEOUT: 'renderer:git-diff.click-phase.reveal-timeout',
  TOTAL: 'renderer:git-diff.click-phase.total'
} as const

export type ClickPhaseEventName = typeof CLICK_PHASE_EVENT_NAMES[keyof typeof CLICK_PHASE_EVENT_NAMES]
