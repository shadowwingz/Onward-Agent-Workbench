/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure-logic helper for the preview-restore phase machine.
 *
 * `isPreviewWorkPending` answers: should `queuePreviewReveal` keep waiting
 * for a render/mermaid/layout event (work might still produce more state
 * changes), or take the fast path because everything is already settled?
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

export type PreviewRevealSignals = PreviewWorkSignals & {
  isMarkdownRenderAllowed: boolean
  renderedHtmlLength: number
  phase: 'idle' | 'waiting-html' | 'restoring-layout' | 'revealing'
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

export function shouldRevealSettledPreview(signals: PreviewRevealSignals): boolean {
  if (!signals.isMarkdownRenderAllowed) return false
  if (signals.renderedHtmlLength <= 0) return false
  if (signals.phase === 'idle' || signals.phase === 'revealing') return false
  return !isPreviewWorkPending(signals)
}
