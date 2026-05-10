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

type Disposable = { dispose: () => void }

function parseOsc7(data: string): string | null {
  // file://hostname/path  → /path  (urldecode)
  //
  // Windows note: a Windows path arrives URI-encoded as
  //   file://<host>/C:/Users/me/repo
  // The slice below produces `/C:/Users/me/repo`, but the real Windows path
  // is `C:/Users/me/repo` (no leading slash). Without stripping the slash,
  // the consumer's `path.resolve('/C:/Users/me/repo')` yields garbage
  // (`C:\C:\Users\me\repo` on Win32). Detect the `/<letter>:` shape and
  // drop the leading slash.
  if (!data.startsWith('file://')) return null
  const rest = data.slice('file://'.length)
  const slash = rest.indexOf('/')
  let path = slash >= 0 ? rest.slice(slash) : rest
  if (/^\/[A-Za-z]:/.test(path)) {
    path = path.slice(1)
  }
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function parseOsc633(data: string): string | null {
  // 633 has many sub-commands. We only care about "P;Cwd=<path>".
  if (!data.startsWith('P;Cwd=')) return null
  return data.slice('P;Cwd='.length)
}

function parseOsc1337(data: string): string | null {
  // iTerm2 emits many sub-commands. Match "CurrentDir=<path>".
  if (!data.startsWith('CurrentDir=')) return null
  return data.slice('CurrentDir='.length)
}

function parseOsc9(data: string): string | null {
  // OSC 9 ; 9 ; <path>  — note the leading "9;" is consumed by the OSC
  // identifier, so the parser callback's data is "9;<path>" or just "<path>"
  // depending on the emitter. Accept both.
  if (data.startsWith('9;')) return data.slice('9;'.length) || null
  return data || null
}

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

  const handle = (dialect: 'osc7' | 'osc633' | 'osc1337' | 'osc9', cwd: string | null): boolean => {
    if (!cwd) return false
    const trimmed = cwd.trim()
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

  disposers.push(parser.registerOscHandler(633,  (data) => handle('osc633',  parseOsc633(data))))
  disposers.push(parser.registerOscHandler(7,    (data) => handle('osc7',   parseOsc7(data))))
  disposers.push(parser.registerOscHandler(1337, (data) => handle('osc1337', parseOsc1337(data))))
  disposers.push(parser.registerOscHandler(9,    (data) => handle('osc9',   parseOsc9(data))))

  return {
    dispose: () => {
      for (const d of disposers) {
        try { d.dispose() } catch { /* ignore */ }
      }
    }
  }
}
