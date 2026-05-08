/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export interface OutlineScrollCaptureGuardInput {
  captureKey: string | null
  pendingRestoreKey: string | null
  previousScrollTop: number | undefined
  nextScrollTop: number
}

export function shouldCaptureOutlineScrollTop(input: OutlineScrollCaptureGuardInput): boolean {
  const nextScrollTop = Number.isFinite(input.nextScrollTop) ? Math.max(0, input.nextScrollTop) : 0
  const previousScrollTop =
    typeof input.previousScrollTop === 'number' && Number.isFinite(input.previousScrollTop)
      ? Math.max(0, input.previousScrollTop)
      : 0

  if (
    input.captureKey &&
    input.pendingRestoreKey === input.captureKey &&
    previousScrollTop > 0 &&
    nextScrollTop <= 0
  ) {
    return false
  }

  return true
}
