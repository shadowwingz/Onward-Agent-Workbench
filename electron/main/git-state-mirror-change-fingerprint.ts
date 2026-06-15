/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'

import type { MirrorState } from './git-state-mirror-types'

export interface MirrorChangeFingerprintResult {
  fingerprint: string
  fileCount: number
  statCount: number
  missingCount: number
  durationMs: number
}

/**
 * Format a working-tree stat into the change-fingerprint token. Pure (no I/O)
 * so the ctime-exclusion invariant is unit-testable.
 *
 * Deliberately EXCLUDES ctime. On Windows/NTFS the file change-time (ctime) is
 * bumped by metadata-only touches that never change content or mtime —
 * antivirus/EDR open-scan-close, Windows Search indexing, Explorer attribute
 * reads. Including ctimeNs turned that background churn into a constant
 * change-fingerprint flip → spurious `mirror-update` → diff-cache invalidation
 * storm (every list/content/renderer-memory cache layer wiped between clicks),
 * which is the root divergence from macOS (APFS moves ctime in lockstep with
 * mtime, so the same activity never flipped the token). A real edit always
 * bumps nanosecond mtime; size/mode + the hashed rawStatus are the backstops.
 * git and VS Code key freshness on mtime+size, never ctime.
 */
export function formatStatTokenForFingerprint(st: { mtimeNs: bigint; size: bigint; mode: bigint }): string {
  return `${st.mtimeNs}:${st.size}:${st.mode}`
}

async function getPathStatToken(path: string): Promise<string> {
  try {
    const st = await fs.stat(path, { bigint: true })
    return formatStatTokenForFingerprint(st)
  } catch {
    return 'missing'
  }
}

function shouldStatWorkingTreePath(file: MirrorState['files'][number]): boolean {
  return file.changeType === 'unstaged' || file.changeType === 'untracked' || file.changeType === 'conflict'
}

export async function buildMirrorChangeFingerprint(
  repoRoot: string,
  rawStatus: string,
  files: MirrorState['files']
): Promise<MirrorChangeFingerprintResult> {
  const startedAt = Date.now()
  const hash = createHash('sha1')
  hash.update(repoRoot)
  hash.update('\0status:')
  hash.update(rawStatus)

  const worktreePaths = Array.from(new Set(
    files.flatMap((file) => shouldStatWorkingTreePath(file) ? [file.filename] : [])
  )).sort()

  let missingCount = 0
  for (const filePath of worktreePaths) {
    const token = await getPathStatToken(join(repoRoot, filePath))
    if (token === 'missing') missingCount += 1
    hash.update('\0stat:')
    hash.update(filePath)
    hash.update('\0')
    hash.update(token)
  }

  return {
    fingerprint: hash.digest('hex'),
    fileCount: files.length,
    statCount: worktreePaths.length,
    missingCount,
    durationMs: Date.now() - startedAt
  }
}
