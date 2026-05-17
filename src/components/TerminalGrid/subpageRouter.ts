/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SubpageId, SubpageNavigateEventDetail } from '../../types/subpage'

export type SubpageRouteIntent = 'open' | 'switch' | 'jump' | 'close' | 'restore'

export type SubpageRouteEntryPoint =
  | 'shortcut'
  | 'dropdown'
  | 'subpage-switcher'
  | 'deep-link'
  | 'escape'
  | 'session-restore'
  | 'legacy-event'
  | 'debug'

export interface SubpageRouteFileTarget {
  filePath: string
  repoRoot: string | null
  diffFilePath?: string | null
  diffRepoRoot?: string | null
}

export interface SubpageRouteCommand {
  intent: SubpageRouteIntent
  entryPoint: SubpageRouteEntryPoint
  terminalId: string
  from: SubpageId | null
  target: SubpageId | null
  targetFile: SubpageRouteFileTarget | null
  source: SubpageId | null
  returnTarget: SubpageId | null
}

export interface BuildSubpageRouteCommandInput {
  intent: SubpageRouteIntent
  entryPoint: SubpageRouteEntryPoint
  terminalId: string
  from?: SubpageId | null
  target?: SubpageId | null
  filePath?: string | null
  repoRoot?: string | null
  source?: SubpageId | null
  returnTarget?: SubpageId | null
  diffFilePath?: string | null
  diffRepoRoot?: string | null
}

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function buildTargetFile(input: BuildSubpageRouteCommandInput): SubpageRouteFileTarget | null {
  const filePath = normalizeString(input.filePath)
  if (!filePath) return null
  return {
    filePath,
    repoRoot: normalizeString(input.repoRoot),
    diffFilePath: normalizeString(input.diffFilePath),
    diffRepoRoot: normalizeString(input.diffRepoRoot)
  }
}

export function buildSubpageRouteCommand(input: BuildSubpageRouteCommandInput): SubpageRouteCommand {
  return {
    intent: input.intent,
    entryPoint: input.entryPoint,
    terminalId: input.terminalId,
    from: input.from ?? null,
    target: input.target ?? null,
    targetFile: buildTargetFile(input),
    source: input.source ?? null,
    returnTarget: input.returnTarget ?? null
  }
}

export function shouldApplySubpageTargetFile(command: SubpageRouteCommand): boolean {
  return command.intent === 'jump' || command.intent === 'open'
}

export function isSubpageSwitch(command: SubpageRouteCommand): boolean {
  return command.intent === 'switch' && command.from !== command.target
}

export function routeCommandToNavigateDetail(command: SubpageRouteCommand): SubpageNavigateEventDetail {
  return {
    terminalId: command.terminalId,
    target: command.target ?? undefined,
    filePath: shouldApplySubpageTargetFile(command) ? command.targetFile?.filePath ?? null : null,
    repoRoot: shouldApplySubpageTargetFile(command) ? command.targetFile?.repoRoot ?? null : null,
    source: command.source,
    returnTarget: command.returnTarget,
    diffFilePath: shouldApplySubpageTargetFile(command) ? command.targetFile?.diffFilePath ?? null : null,
    diffRepoRoot: shouldApplySubpageTargetFile(command) ? command.targetFile?.diffRepoRoot ?? null : null,
    intent: command.intent,
    entryPoint: command.entryPoint,
    from: command.from
  }
}

export function legacyNavigateDetailToRouteCommand(
  detail: SubpageNavigateEventDetail,
  currentSubpage: SubpageId | null,
  fallbackEntryPoint: SubpageRouteEntryPoint = 'legacy-event'
): SubpageRouteCommand | null {
  const terminalId = normalizeString(detail.terminalId)
  const target = detail.target ?? null
  if (!terminalId || !target) return null
  const hasFileTarget = Boolean(normalizeString(detail.filePath))
  const explicitIntent = detail.intent ?? null
  const inferredIntent: SubpageRouteIntent = explicitIntent
    ?? (hasFileTarget ? 'jump' : currentSubpage && currentSubpage !== target ? 'switch' : 'open')
  return buildSubpageRouteCommand({
    intent: inferredIntent,
    entryPoint: detail.entryPoint ?? fallbackEntryPoint,
    terminalId,
    from: detail.from ?? currentSubpage,
    target,
    filePath: detail.filePath,
    repoRoot: detail.repoRoot,
    source: detail.source,
    returnTarget: detail.returnTarget,
    diffFilePath: detail.diffFilePath,
    diffRepoRoot: detail.diffRepoRoot
  })
}

export function subpageRouteCommandToDebugLabel(command: SubpageRouteCommand): string {
  return `${command.entryPoint}:${command.intent}:${command.from ?? 'none'}->${command.target ?? 'none'}`
}
