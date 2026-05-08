/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

type MonacoModelLike = {
  uri?: {
    path?: string
    fsPath?: string
    toString?: () => string
  }
  getValue: () => string
}

export type OutlineParseSource =
  | {
    ready: true
    content: string
    model: MonacoModelLike | null
    source: 'matched-model' | 'snapshot'
  }
  | {
    ready: false
    content: ''
    model: null
    source: 'waiting-for-snapshot'
  }

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function normalizeOutlinePathForCompare(value: string): string {
  let normalized = safeDecodeUriComponent(value)
    .replace(/\\/g, '/')
    .replace(/^file:\/+/i, '/')
    .replace(/^\/([A-Za-z]:\/)/, '$1')
    .replace(/\/+/g, '/')

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }
  normalized = normalized.replace(/^\/+/, '')
  return normalized.toLowerCase()
}

function modelUriCandidates(model: MonacoModelLike | null): string[] {
  if (!model?.uri) return []
  const candidates = [model.uri.fsPath, model.uri.path, model.uri.toString?.()]
  return candidates.filter((value): value is string => Boolean(value))
}

export function doesModelUriMatchFilePath(
  model: MonacoModelLike | null,
  filePath: string | null
): boolean {
  if (!model || !filePath) return false
  const normalizedFilePath = normalizeOutlinePathForCompare(filePath)
  if (!normalizedFilePath) return false

  return modelUriCandidates(model).some((candidate) => {
    const normalizedCandidate = normalizeOutlinePathForCompare(candidate)
    return (
      normalizedCandidate === normalizedFilePath ||
      normalizedCandidate.endsWith(`/${normalizedFilePath}`)
    )
  })
}

export function resolveOutlineParseSource(options: {
  filePath: string | null
  contentPath: string | null
  content: string
  model: MonacoModelLike | null
}): OutlineParseSource {
  const { filePath, contentPath, content, model } = options
  if (!filePath) {
    return { ready: false, content: '', model: null, source: 'waiting-for-snapshot' }
  }

  if (doesModelUriMatchFilePath(model, filePath)) {
    return {
      ready: true,
      content: model?.getValue() ?? content,
      model,
      source: 'matched-model'
    }
  }

  if (contentPath === filePath) {
    return {
      ready: true,
      content,
      model: null,
      source: 'snapshot'
    }
  }

  return { ready: false, content: '', model: null, source: 'waiting-for-snapshot' }
}
