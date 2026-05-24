/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'path'

export type GitFileContentWorkerRequestOptions = {
  force?: boolean
  allowLargeFile?: boolean
}

export type GitDiffWorkerRequestOptions = {
  force?: boolean
  scope?: string
}

export type GitFileContentWorkerKeyFile = {
  filename: string
  status: string
  originalFilename?: string
  changeType: string
  isSubmoduleEntry?: boolean
}

export function stableStringifyForWorkerKey(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringifyForWorkerKey).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringifyForWorkerKey(record[key])}`).join(',')}}`
}

export function repoKeyForWorker(cwd: string, repoRoot?: string | null): string {
  return resolve(repoRoot || cwd)
}

export function buildGitFileContentWorkerDedupeKey(
  cwd: string,
  file: GitFileContentWorkerKeyFile,
  repoRoot?: string,
  options?: GitFileContentWorkerRequestOptions
): string | undefined {
  if (options?.force) return undefined
  return `git-ipc:file-content:${repoKeyForWorker(cwd, repoRoot)}:${stableStringifyForWorkerKey(file)}:${stableStringifyForWorkerKey(options ?? {})}`
}

export function buildGitDiffWorkerDedupeKey(
  cwd: string,
  options?: GitDiffWorkerRequestOptions
): string | undefined {
  if (options?.force) return undefined
  return `git-ipc:diff:${resolve(cwd)}:${stableStringifyForWorkerKey(options ?? {})}`
}
