/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve as resolvePath } from 'path'

const MAX_TERMINAL_CWD_LENGTH = 4096
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/
const WINDOWS_DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/
const WINDOWS_UNC_RE = /^\\\\[^\\]+\\[^\\]+/

function normalizeTerminalCwdCandidate(value: string | null | undefined): string | null {
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

export function expandTerminalCwdCandidate(rawCwd: string | null | undefined): string | null {
  const candidate = normalizeTerminalCwdCandidate(rawCwd)
  if (!candidate) return null
  if (candidate === '~') return homedir()
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return join(homedir(), candidate.slice(2))
  }
  return candidate
}

export function resolveExistingTerminalCwd(rawCwd: string | null | undefined): string | null {
  const expanded = expandTerminalCwdCandidate(rawCwd)
  if (!expanded) return null
  try {
    const realPath = realpathSync(expanded)
    return statSync(realPath).isDirectory() ? realPath : null
  } catch {
    try {
      return statSync(expanded).isDirectory() ? resolvePath(expanded) : null
    } catch {
      return null
    }
  }
}

export function isUsableTerminalCwd(rawCwd: string | null | undefined): boolean {
  return resolveExistingTerminalCwd(rawCwd) !== null
}
