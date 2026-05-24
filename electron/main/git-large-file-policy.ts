/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export const GIT_LARGE_FILE_CONFIRM_SIZE = 3 * 1024 * 1024
export const GIT_FILE_READ_BUFFER_MARGIN = 1024 * 1024

export interface GitLargeFilePromptOptions {
  allowLargeFile?: boolean
}

export function requiresGitLargeFileConfirmation(
  sizeBytes: number,
  options?: GitLargeFilePromptOptions
): boolean {
  return Number.isFinite(sizeBytes) &&
    sizeBytes > GIT_LARGE_FILE_CONFIRM_SIZE &&
    !options?.allowLargeFile
}

export function gitLargeFileReadMaxBuffer(sizeBytes: number | null | undefined): number {
  if (!Number.isFinite(sizeBytes) || (sizeBytes ?? 0) < 0) {
    return GIT_LARGE_FILE_CONFIRM_SIZE + GIT_FILE_READ_BUFFER_MARGIN
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(sizeBytes ?? 0) + GIT_FILE_READ_BUFFER_MARGIN)
}
