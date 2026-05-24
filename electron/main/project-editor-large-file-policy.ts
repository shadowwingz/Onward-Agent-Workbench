/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/** @deprecated Project Editor no longer prompts at this threshold. */
export const PROJECT_TEXT_WARNING_SIZE = 3 * 1024 * 1024
export const PROJECT_TEXT_EAGER_LIMIT = 30 * 1024 * 1024
export const PROJECT_FILE_CHUNK_SIZE = 512 * 1024

export interface ProjectTextReadPolicy {
  openMode: 'text' | 'large-text'
  eagerRead: boolean
  readOnly: boolean
  requiresConfirmation: false
}

export function classifyProjectTextRead(sizeBytes: number): ProjectTextReadPolicy {
  const largeText = Number.isFinite(sizeBytes) && sizeBytes > PROJECT_TEXT_EAGER_LIMIT
  return {
    openMode: largeText ? 'large-text' : 'text',
    eagerRead: !largeText,
    readOnly: largeText,
    requiresConfirmation: false
  }
}
