/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type ProjectTreeWatchIgnoreReason =
  | 'git'
  | 'nodeModules'
  | 'cache'
  | 'dsStore'

// High-frequency directories the renderer's Cmd+P / file-index never needs.
// Without this filter, the app's own git-status polling on the user's repo
// flickers `.git/index.lock`, `.git/objects/*`, `.git/FETCH_HEAD` on every
// poll. Each one used to round-trip main -> renderer -> main and re-fire all
// file-index subscribers, pinning the renderer while a markdown preview was
// open. Skipping these at the fs.watch boundary drops them before they enter
// the debounce queue.
const IGNORED_PREFIXES: ReadonlyArray<{ prefix: string; reason: ProjectTreeWatchIgnoreReason }> = [
  { prefix: '.git/', reason: 'git' },
  { prefix: 'node_modules/', reason: 'nodeModules' },
  { prefix: '.cache/', reason: 'cache' },
  { prefix: '.next/', reason: 'cache' },
  { prefix: 'dist/.cache/', reason: 'cache' },
  { prefix: '.turbo/', reason: 'cache' },
  { prefix: '.parcel-cache/', reason: 'cache' }
]

const IGNORED_BASENAMES: ReadonlyMap<string, ProjectTreeWatchIgnoreReason> = new Map([
  ['.DS_Store', 'dsStore'],
  ['.git', 'git'],
  ['node_modules', 'nodeModules']
])

// rel uses forward slashes (caller is responsible for normalisation).
export function getIgnoredRelReason(rel: string): ProjectTreeWatchIgnoreReason | null {
  for (const { prefix, reason } of IGNORED_PREFIXES) {
    if (rel === prefix.slice(0, -1) || rel.startsWith(prefix)) return reason
  }
  const lastSlash = rel.lastIndexOf('/')
  const basename = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel
  return IGNORED_BASENAMES.get(basename) ?? null
}

export function isIgnoredRel(rel: string): boolean {
  return getIgnoredRelReason(rel) !== null
}
