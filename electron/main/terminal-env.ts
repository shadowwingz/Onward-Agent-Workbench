/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TerminalEnvVarEntry {
  key?: string
  value?: string
}

function findEnvKey(env: NodeJS.ProcessEnv, targetKey: string): string | undefined {
  const normalizedTarget = targetKey.toLowerCase()
  return Object.keys(env).find(key => key.toLowerCase() === normalizedTarget)
}

function deleteEnvKey(env: NodeJS.ProcessEnv, targetKey: string): void {
  const key = findEnvKey(env, targetKey)
  if (key) delete env[key]
}

function readEnvValue(env: NodeJS.ProcessEnv, targetKey: string): string | undefined {
  const key = findEnvKey(env, targetKey)
  return key ? env[key] : undefined
}

function setEnvValue(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const existingKey = findEnvKey(env, key)
  if (existingKey && existingKey !== key) delete env[existingKey]
  env[key] = value
}

function isZeroValue(value: string | undefined): boolean {
  return (value ?? '').trim() === '0'
}

function stripSurroundingQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

export function buildColorCapableTerminalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }

  deleteEnvKey(env, 'NO_COLOR')

  if (isZeroValue(readEnvValue(env, 'FORCE_COLOR'))) {
    deleteEnvKey(env, 'FORCE_COLOR')
  }
  if (isZeroValue(readEnvValue(env, 'CLICOLOR'))) {
    deleteEnvKey(env, 'CLICOLOR')
  }

  if (!readEnvValue(env, 'COLORTERM')) {
    setEnvValue(env, 'COLORTERM', 'truecolor')
  }
  if (!readEnvValue(env, 'CLICOLOR')) {
    setEnvValue(env, 'CLICOLOR', '1')
  }

  return env
}

export function applyTerminalUserEnvVars(
  baseEnv: NodeJS.ProcessEnv,
  userEnvVars: ReadonlyArray<TerminalEnvVarEntry>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }

  for (const entry of userEnvVars) {
    const key = stripSurroundingQuotes((entry.key || '').trim())
    const value = stripSurroundingQuotes(entry.value ?? '')
    if (key) setEnvValue(env, key, value)
  }

  return env
}
