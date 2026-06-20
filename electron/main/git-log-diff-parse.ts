/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure parser for the git-op aggregation A2 batch:
 *
 *   git -c core.quotepath=false log --raw --numstat \
 *       --format='%x1e%H%x1f%P' -n N <ref>
 *
 * ONE invocation returns the most-recent N commits AND, for each, the file
 * changes (status from `--raw`, line counts from `--numstat`) — replacing the
 * previous N×2 per-commit `git diff --name-status` + `git diff --numstat`
 * spawns (the dominant EDR-tax source: a real trace showed the History prewarm
 * running ~135s of serial slow-git per project). The History prewarm parses
 * this once and primes the L9 commit-diff cache for every commit.
 *
 * Format (observed):
 *   \x1e<sha>\x1f<space-separated parents>\n   ← --format record
 *   \n                                          ← blank line
 *   :<m> <m> <s> <s> <STATUS>\t<path>\n  ...     ← --raw block (status per file)
 *   <add>\t<del>\t<path>\n  ...                  ← --numstat block (counts per file)
 * The --raw and --numstat blocks list the SAME files in the SAME order, so we
 * merge them by index — robust against rename path-formatting differences.
 *
 * Pure + leaf (no I/O, no Electron, no git-utils import) so it is unit-testable.
 * Image/pdf/svg decoration is applied by the caller (git-utils) which owns those
 * helpers; this parser returns the raw {filename, status, additions, deletions}.
 */

export type ParsedDiffStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U'

export interface ParsedLogFile {
  filename: string
  originalFilename?: string
  status: ParsedDiffStatus
  additions: number
  deletions: number
  /** True when --numstat reported `-` for both columns (binary file). */
  binary: boolean
}

export interface ParsedLogCommitDiff {
  sha: string
  parents: string[]
  files: ParsedLogFile[]
}

const RS = '\x1e' // record separator — commit boundary (from --format %x1e)
const US = '\x1f' // unit separator — between %H and %P

function normalizeStatus(raw: string): ParsedDiffStatus {
  const head = raw.charAt(0).toUpperCase()
  switch (head) {
    case 'M': case 'A': case 'D': case 'R': case 'C': case 'T': case 'U':
      return head
    default:
      return 'M'
  }
}

function parseCount(token: string): { n: number; binary: boolean } {
  if (token === '-') return { n: 0, binary: true }
  const n = Number.parseInt(token, 10)
  return { n: Number.isFinite(n) ? n : 0, binary: false }
}

interface RawEntry { status: ParsedDiffStatus; filename: string; originalFilename?: string }
interface NumEntry { additions: number; deletions: number; binary: boolean }

/**
 * Parse one commit chunk's diff body (everything after the `<sha>\x1f<parents>`
 * header line). Returns files merged from the --raw + --numstat blocks by index.
 */
function parseCommitBody(lines: string[]): ParsedLogFile[] {
  const raw: RawEntry[] = []
  const num: NumEntry[] = []
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith(':')) {
      // --raw: ":<m> <m> <s> <s> <STATUS>\t<path>" or "...\t<old>\t<new>" (rename/copy).
      const tabIdx = line.indexOf('\t')
      if (tabIdx < 0) continue
      const header = line.slice(0, tabIdx)
      const rest = line.slice(tabIdx + 1).split('\t')
      const headerParts = header.split(' ')
      const status = normalizeStatus(headerParts[headerParts.length - 1] || 'M')
      if ((status === 'R' || status === 'C') && rest.length >= 2) {
        raw.push({ status, originalFilename: rest[0], filename: rest[1] })
      } else {
        raw.push({ status, filename: rest[0] })
      }
      continue
    }
    // --numstat: "<add>\t<del>\t<path>" (path may be "old => new" for renames).
    const parts = line.split('\t')
    if (parts.length >= 3 && /^[-0-9]/.test(parts[0])) {
      const a = parseCount(parts[0])
      const d = parseCount(parts[1])
      num.push({ additions: a.n, deletions: d.n, binary: a.binary || d.binary })
    }
  }
  const files: ParsedLogFile[] = []
  const count = Math.max(raw.length, num.length)
  for (let i = 0; i < count; i += 1) {
    const r = raw[i]
    const n = num[i]
    if (!r) continue // numstat without a matching raw entry — skip (defensive)
    files.push({
      filename: r.filename,
      ...(r.originalFilename ? { originalFilename: r.originalFilename } : {}),
      status: r.status,
      additions: n ? n.additions : 0,
      deletions: n ? n.deletions : 0,
      binary: n ? n.binary : false
    })
  }
  return files
}

export function parseGitLogRawNumstat(output: string): ParsedLogCommitDiff[] {
  if (!output) return []
  const commits: ParsedLogCommitDiff[] = []
  // The stream starts with a leading RS before the first commit; split drops the
  // empty leading element.
  const chunks = output.split(RS)
  for (const chunk of chunks) {
    if (!chunk.trim()) continue
    const lines = chunk.split('\n')
    const headerLine = lines[0] ?? ''
    const usIdx = headerLine.indexOf(US)
    if (usIdx < 0) {
      // Header missing the unit separator — treat whole first token as sha.
      const sha = headerLine.trim()
      if (!sha) continue
      commits.push({ sha, parents: [], files: parseCommitBody(lines.slice(1)) })
      continue
    }
    const sha = headerLine.slice(0, usIdx).trim()
    if (!sha) continue
    const parents = headerLine.slice(usIdx + 1).trim().split(/\s+/).filter(Boolean)
    commits.push({ sha, parents, files: parseCommitBody(lines.slice(1)) })
  }
  return commits
}
