/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure cat-file ref classification. Kept dependency-free so it is unit-testable
 * under `node --experimental-strip-types` without pulling in the heavy
 * git-utils / child_process graph.
 *
 * Whether a cat-file ref points at MUTABLE state that the long-running
 * `git cat-file --batch` process must NOT serve. The batch caches the index in
 * memory at first access, so any index ref (`:<path>`, `:0:<path>`,
 * `:1:<path>`, …) read after a `git add` / stage / partial-stage returns the
 * STALE startup index blob (surfaced as staged diffs showing HEAD/base content
 * on both sides — GDS-22 / GDS-33). Callers route these to the per-call path
 * which re-reads the current index. Immutable refs — `HEAD:<path>`,
 * `<commit>:<path>`, blob oids — are batch-safe.
 */
export function isMutableIndexRef(ref: string): boolean {
  return ref.startsWith(':')
}
