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

async function getPathStatToken(path: string): Promise<string> {
  try {
    const st = await fs.stat(path, { bigint: true })
    return `${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.mode}`
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
