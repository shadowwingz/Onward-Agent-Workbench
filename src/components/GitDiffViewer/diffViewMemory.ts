/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GitFileStatus } from '../../types/electron'

export type DiffViewAnchor = {
  line: number | null
  scrollTop: number
}

export type DiffViewMemoryEntry = {
  fileKey: string
  filePath: string
  originalFilename?: string
  anchor: DiffViewAnchor | null
  scrollTop: number
  signature: string | null
  updatedAt: number
}

export type DiffViewMemory = {
  selectedFileKey: string | null
  entries: Record<string, DiffViewMemoryEntry>
}

export function buildGitDiffFileKey(repoRoot: string, file: GitFileStatus): string {
  const original = file.originalFilename ?? ''
  return `${repoRoot}::${file.changeType}::${file.status}::${original}::${file.filename}`
}

function findMatchingFile(
  files: GitFileStatus[],
  candidate: Pick<GitFileStatus, 'filename' | 'changeType' | 'originalFilename'>
): GitFileStatus | null {
  const exact = files.find((file) =>
    file.filename === candidate.filename &&
    file.changeType === candidate.changeType
  )
  if (exact) return exact
  return files.find((file) =>
    file.filename === candidate.filename &&
    (file.originalFilename ?? '') === (candidate.originalFilename ?? '')
  ) ?? null
}

export function resolveGitDiffRestoredSelection(
  files: GitFileStatus[],
  repoRoot: string,
  memory: DiffViewMemory | null,
  activeSelection: GitFileStatus | null
): GitFileStatus | null {
  if (files.length === 0) return null
  if (activeSelection) {
    const match = findMatchingFile(files, activeSelection)
    if (match) return match
  }
  const selectedFileKey = memory?.selectedFileKey
  if (!selectedFileKey) return null
  const direct = files.find((file) =>
    buildGitDiffFileKey(file.repoRoot || repoRoot, file) === selectedFileKey
  )
  if (direct) return direct
  const entry = memory?.entries[selectedFileKey]
  if (!entry) return null
  return files.find((file) =>
    file.filename === entry.filePath &&
    (file.originalFilename ?? '') === (entry.originalFilename ?? '')
  ) ?? files.find((file) => file.filename === entry.filePath) ?? null
}
