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
// Single source of truth for these six strings — DO NOT inline a
// duplicate copy elsewhere. If you need them in another module, import
// from here.

export const CLICK_PHASE_EVENT_NAMES = {
  IPC: 'renderer:git-diff.click-phase.ipc',
  STATE_SET: 'renderer:git-diff.click-phase.state-set',
  MOUNT: 'renderer:git-diff.click-phase.mount',
  DIFF_COMPUTE: 'renderer:git-diff.click-phase.diff-compute',
  PAINT: 'renderer:git-diff.click-phase.paint',
  TOTAL: 'renderer:git-diff.click-phase.total'
} as const

export type ClickPhaseEventName = typeof CLICK_PHASE_EVENT_NAMES[keyof typeof CLICK_PHASE_EVENT_NAMES]
