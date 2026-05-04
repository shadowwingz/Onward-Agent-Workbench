/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Re-dispatch a forwarded `onward:pdf:hostKey` postMessage payload as a
 * synthetic KeyboardEvent on the host document. The pdf.js viewer iframe
 * is sandboxed, so its keystrokes don't bubble across the iframe boundary;
 * viewer.js forwards Cmd/Ctrl+P and Escape via postMessage and host
 * components (PdfReader, GitPdfCompare) call this to fire the host's
 * existing keyboard handlers (ProjectEditor, useSubpageEscape) unchanged.
 *
 * The synthetic event has `isTrusted=false` but native document-level
 * `addEventListener('keydown', ...)` listeners still fire, which is what
 * the host handlers use.
 */
export function redispatchPdfHostKey(data: Record<string, unknown>): void {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: String(data.key ?? ''),
    code: String(data.code ?? ''),
    metaKey: Boolean(data.metaKey),
    ctrlKey: Boolean(data.ctrlKey),
    shiftKey: Boolean(data.shiftKey),
    altKey: Boolean(data.altKey),
    bubbles: true,
    cancelable: true
  }))
}
