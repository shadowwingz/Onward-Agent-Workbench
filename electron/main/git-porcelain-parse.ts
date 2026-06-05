/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure parsers for `git status --porcelain=2 --branch -z` output and the
 * helpers that build `GitFileStatus` records. Extracted from the mirror
 * worker entry (`git-state-mirror-worker-entry.ts`) so unit tests can
 * load the parser without bringing the worker's top-level
 * `parentPort` / `process.exit` side-effects with it.
 *
 * Behaviour is intentionally kept in sync with
 * `git-utils.ts:parseStatusPorcelainV2Z` so the renderer sees the same
 * shape whether the source is the legacy RPC path or a mirror push.
 */

import type {
  GitChangeType,
  GitFileStatus,
  GitStatusCode,
  TerminalGitStatus
} from './git-utils'
// Explicit `.ts` extension (sanctioned by tsconfig `allowImportingTsExtensions`)
// so the strip-types unit-test loader can resolve this leaf → leaf value import;
// esbuild / electron-vite bundle it the same as any extensionless import.
import {
  collectXyCategories,
  deriveTerminalGitStatus,
  type GitChangeCategory
} from './git-status-classify.ts'

export function normalizeGitStatusCode(raw: string): GitStatusCode {
  switch (raw) {
    case 'M': case 'A': case 'D': case 'R': case 'C': case '?': case '!':
      return raw
    case 'U':
      return '!'
    default:
      return 'M'
  }
}

export function buildGitResourceFields(
  changeType: GitChangeType,
  status: GitStatusCode
): Pick<GitFileStatus, 'resourceGroup' | 'originalRef' | 'modifiedRef'> {
  if (changeType === 'conflict') {
    return { resourceGroup: 'merge', originalRef: null, modifiedRef: 'workingTree' }
  }
  if (changeType === 'staged') {
    return {
      resourceGroup: 'index',
      originalRef: status === 'A' || status === '?' ? 'empty' : 'HEAD',
      modifiedRef: status === 'D' ? 'empty' : 'index'
    }
  }
  if (changeType === 'untracked') {
    return { resourceGroup: 'untracked', originalRef: 'empty', modifiedRef: 'workingTree' }
  }
  return {
    resourceGroup: 'workingTree',
    originalRef: status === 'A' || status === '?' ? 'empty' : 'index',
    modifiedRef: status === 'D' ? 'empty' : 'workingTree'
  }
}

export function makeGitFileStatus(params: {
  filename: string
  originalFilename?: string
  status: GitStatusCode
  changeType: GitChangeType
  repoRoot: string
  isSubmoduleEntry?: boolean
  submoduleFlags?: GitFileStatus['submoduleFlags']
}): GitFileStatus {
  return {
    filename: params.filename,
    originalFilename: params.originalFilename,
    status: params.status,
    additions: 0, // numstat is RPC-side; mirror only carries the change set
    deletions: 0,
    changeType: params.changeType,
    ...buildGitResourceFields(params.changeType, params.status),
    repoRoot: params.repoRoot,
    ...(params.isSubmoduleEntry ? { isSubmoduleEntry: true as const } : {}),
    ...(params.submoduleFlags ? { submoduleFlags: params.submoduleFlags } : {})
  }
}

export function getFieldAfterSpaceCount(record: string, spacesBeforeField: number): string | null {
  let spaces = 0
  for (let idx = 0; idx < record.length; idx += 1) {
    if (record[idx] === ' ') {
      spaces += 1
      if (spaces === spacesBeforeField) {
        return record.slice(idx + 1)
      }
    }
  }
  return null
}

export interface ParsedStatus {
  branch: string | null
  status: TerminalGitStatus
  files: GitFileStatus[]
}

/**
 * Parse `git status --porcelain=2 --branch -z` output.
 *
 * Emits TWO GitFileStatus entries when both the index and worktree sides
 * are non-clean (one with changeType='staged', one with 'unstaged') —
 * matches the existing renderer contract.
 */
export function parseStatusPorcelainV2Z(output: string, repoRoot: string): ParsedStatus {
  const files: GitFileStatus[] = []
  let branch: string | null = null
  let branchOid: string | null = null
  const categories = new Set<GitChangeCategory>()
  if (!output) return { branch, status: 'clean', files }

  const tokens = output.split('\0')
  let i = 0
  while (i < tokens.length) {
    const record = tokens[i]
    if (!record) { i += 1; continue }

    // Headers may share a chunk before the first NUL.
    if (record.startsWith('# ')) {
      const headerLines = record.split('\n')
      for (const headerLine of headerLines) {
        if (headerLine.startsWith('# branch.head ')) {
          branch = headerLine.slice('# branch.head '.length).trim()
        } else if (headerLine.startsWith('# branch.oid ')) {
          branchOid = headerLine.slice('# branch.oid '.length).trim()
        }
      }
      i += 1
      continue
    }

    const line = record.replace(/^\n+/, '')
    if (!line) { i += 1; continue }

    if (line.startsWith('? ')) {
      const filename = line.slice(2)
      if (filename) {
        categories.add('add')
        files.push(makeGitFileStatus({
          filename,
          status: '?',
          changeType: 'untracked',
          repoRoot
        }))
      }
      i += 1
      continue
    }

    if (!line.startsWith('1 ') && !line.startsWith('2 ') && !line.startsWith('u ')) {
      i += 1
      continue
    }

    const type = line.charAt(0)
    const xy = line.slice(2, 4)
    const indexStatus = xy.charAt(0)
    const worktreeStatus = xy.charAt(1)
    const sub = line.slice(5, 9)
    const isSubmoduleEntry = sub.charAt(0) === 'S'
    const submoduleFlags = isSubmoduleEntry
      ? {
          commitChanged: sub.charAt(1) === 'C',
          workTreeModified: sub.charAt(2) === 'M',
          untrackedContent: sub.charAt(3) === 'U'
        }
      : undefined

    const filename = getFieldAfterSpaceCount(
      line,
      type === '1' ? 8 : type === '2' ? 9 : 10
    )
    const originalFilename = type === '2' ? (tokens[i + 1] || undefined) : undefined

    if (!filename) {
      i += type === '2' ? 2 : 1
      continue
    }

    if (type === 'u') {
      // Unmerged record → conflict → modify bucket (never classify its XY: an
      // 'AA' / 'DD' conflict is an edit to existing content, not add/delete).
      categories.add('mod')
      files.push(makeGitFileStatus({
        filename,
        status: '!',
        changeType: 'conflict',
        repoRoot,
        isSubmoduleEntry,
        submoduleFlags
      }))
      i += 1
      continue
    }

    // Type-1 ordinary change or type-2 rename/copy: a new path (A/R/C) is a
    // single 'add'; a genuinely two-sided file (e.g. 'MD') contributes each
    // side's change kind, so it can resolve to 'mixed'.
    collectXyCategories(`${indexStatus}${worktreeStatus}`, categories)

    if (indexStatus && indexStatus !== '.') {
      files.push(makeGitFileStatus({
        filename,
        originalFilename: indexStatus === 'R' || indexStatus === 'C' ? originalFilename : undefined,
        status: normalizeGitStatusCode(indexStatus),
        changeType: 'staged',
        repoRoot,
        isSubmoduleEntry,
        submoduleFlags
      }))
    }

    if (worktreeStatus && worktreeStatus !== '.') {
      files.push(makeGitFileStatus({
        filename,
        originalFilename: worktreeStatus === 'R' || worktreeStatus === 'C' ? originalFilename : undefined,
        status: normalizeGitStatusCode(worktreeStatus),
        changeType: 'unstaged',
        repoRoot,
        isSubmoduleEntry,
        submoduleFlags
      }))
    }

    i += type === '2' ? 2 : 1
  }

  if (branch === '(detached)' || branch === '(initial)' || branch === 'HEAD') {
    branch = branchOid ? branchOid.slice(0, 7) : null
  }

  return { branch, status: deriveTerminalGitStatus(categories), files }
}
