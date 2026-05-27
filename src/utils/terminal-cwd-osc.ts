/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type TerminalCwdOscDialect = 'osc7' | 'osc633' | 'osc1337' | 'osc9'

const MAX_TERMINAL_CWD_LENGTH = 4096
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/
const WINDOWS_DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/
const WINDOWS_UNC_RE = /^\\\\[^\\]+\\[^\\]+/

export function normalizeTerminalCwdCandidate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_TERMINAL_CWD_LENGTH) return null
  if (CONTROL_CHARACTER_RE.test(trimmed)) return null
  if (
    trimmed === '~' ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('~\\') ||
    trimmed.startsWith('/') ||
    WINDOWS_DRIVE_ABSOLUTE_RE.test(trimmed) ||
    WINDOWS_UNC_RE.test(trimmed)
  ) {
    return trimmed
  }
  return null
}

export function parseOsc7Cwd(data: string): string | null {
  if (!data.startsWith('file://')) return null
  const rest = data.slice('file://'.length)
  const slash = rest.indexOf('/')
  let path = slash >= 0 ? rest.slice(slash) : rest
  if (/^\/[A-Za-z]:/.test(path)) {
    path = path.slice(1)
  }
  try {
    return normalizeTerminalCwdCandidate(decodeURIComponent(path))
  } catch {
    return normalizeTerminalCwdCandidate(path)
  }
}

export function parseOsc633Cwd(data: string): string | null {
  if (!data.startsWith('P;Cwd=')) return null
  return normalizeTerminalCwdCandidate(data.slice('P;Cwd='.length))
}

export function parseOsc1337Cwd(data: string): string | null {
  if (!data.startsWith('CurrentDir=')) return null
  return normalizeTerminalCwdCandidate(data.slice('CurrentDir='.length))
}

export function parseOsc9Cwd(data: string): string | null {
  if (!data.startsWith('9;')) return null
  return normalizeTerminalCwdCandidate(data.slice('9;'.length))
}

export function parseTerminalCwdOsc(dialect: TerminalCwdOscDialect, data: string): string | null {
  switch (dialect) {
    case 'osc7':
      return parseOsc7Cwd(data)
    case 'osc633':
      return parseOsc633Cwd(data)
    case 'osc1337':
      return parseOsc1337Cwd(data)
    case 'osc9':
      return parseOsc9Cwd(data)
  }
}
