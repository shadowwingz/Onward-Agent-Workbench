/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * xterm.js OSC handler addon for cwd extraction.
 *
 * Registers parser hooks for the four cwd-bearing OSC dialects mature
 * terminal emulators emit, in priority order:
 *
 *   OSC 633 ; P ; Cwd=<path>      VS Code-proprietary; richest payload
 *   OSC 7   ; file://host/<path>  Cross-emulator standard (Terminal.app,
 *                                 WezTerm, Ghostty, kitty, Alacritty)
 *   OSC 1337 ; CurrentDir=<path>  iTerm2 fallback
 *   OSC 9   ; 9 ; <path>          cmder / ConEmu lineage (Windows)
 *
 * Each handler returns `true` to consume the bytes so they don't render.
 * On every successful parse we record a `renderer:terminal.osc-cwd-detected`
 * trace event and push the new cwd to the GitStateMirror via
 * `window.electronAPI.git.pushCwd(terminalId, cwd)`. The router routes that
 * to the worker, which switches its watcher root and recomputes — the chain
 * the GSM-01..09 latency assertions hinge on.
 */

import type { Terminal as XTerm } from '@xterm/xterm'
import { perfTrace } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { parseTerminalCwdOsc, type TerminalCwdOscDialect } from '../../utils/terminal-cwd-osc'

type Disposable = { dispose: () => void }

export interface OscCwdAddonOptions {
  terminalId: string
  pushCwd: (terminalId: string, cwd: string) => void
}

/**
 * Install OSC handlers on `terminal` and return a disposer that unregisters
 * them. Idempotent — calling install twice on the same terminal stacks
 * disposers but each registration consumes its own bytes safely.
 */
export function installOscCwdAddon(terminal: XTerm, opts: OscCwdAddonOptions): Disposable {
  const disposers: Disposable[] = []

  const handle = (dialect: TerminalCwdOscDialect, data: string): boolean => {
    const trimmed = parseTerminalCwdOsc(dialect, data)
    if (!trimmed) return false
    perfTrace(PERF_TRACE_EVENT.RENDERER_TERMINAL_OSC_CWD_DETECTED, {
      terminalId: opts.terminalId,
      cwd: trimmed,
      dialect
    })
    try { opts.pushCwd(opts.terminalId, trimmed) } catch { /* ignore */ }
    return true
  }

  // Some xterm.js builds expose `parser` only when explicitly enabled; guard
  // both the property and the registerOscHandler method itself so the addon
  // never throws if a future version moves the API.
  const parser = (terminal as unknown as { parser?: { registerOscHandler?: (id: number, h: (data: string) => boolean) => Disposable } }).parser
  if (!parser?.registerOscHandler) {
    return { dispose: () => { /* no-op */ } }
  }

  disposers.push(parser.registerOscHandler(633,  (data) => handle('osc633', data)))
  disposers.push(parser.registerOscHandler(7,    (data) => handle('osc7', data)))
  disposers.push(parser.registerOscHandler(1337, (data) => handle('osc1337', data)))
  disposers.push(parser.registerOscHandler(9,    (data) => handle('osc9', data)))

  return {
    dispose: () => {
      for (const d of disposers) {
        try { d.dispose() } catch { /* ignore */ }
      }
    }
  }
}
