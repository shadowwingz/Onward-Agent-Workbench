/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure-logic helper for the preview-restore phase machine.
 *
 * `isPreviewWorkPending` answers: should `queuePreviewReveal` install the
 * conservative safety timer (work might still produce more state changes)
 * or take the fast path (everything is already settled, finalize on the
 * next paint frame)?
 *
 * Locked down by test/unittest/preview-restore-settle.test.mts.
 */

export type PreviewWorkSignals = {
  markdownRenderPending: boolean
  workerInFlight: boolean
  workerQueued: boolean
  mermaidPending: number
  mermaidInFlight: boolean
}

export function isPreviewWorkPending(signals: PreviewWorkSignals): boolean {
  return (
    signals.markdownRenderPending ||
    signals.workerInFlight ||
    signals.workerQueued ||
    signals.mermaidInFlight ||
    signals.mermaidPending > 0
  )
}
