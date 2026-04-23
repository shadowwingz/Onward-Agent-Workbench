/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort } from 'worker_threads'
import {
  checkGitInstalled,
  detectSubmodulesRecursive,
  discardGitFile,
  getGitDiff,
  getGitFileContent,
  getGitHistory,
  getGitHistoryDiff,
  getGitHistoryFileContent,
  getGitRepoMeta,
  resolveRepoRoot,
  saveGitFileContent,
  stageGitFile,
  unstageGitFile,
  updateGitIndexContent,
  type GitFileStatus,
  type GitHistoryDiffOptions,
  type GitHistoryFileContentOptions
} from './git-utils'

type GitIpcWorkerMethod =
  | 'checkInstalled'
  | 'resolveRepoRoot'
  | 'getDiff'
  | 'getHistory'
  | 'getHistoryDiff'
  | 'getHistoryFileContent'
  | 'getFileContent'
  | 'saveFileContent'
  | 'stageFile'
  | 'unstageFile'
  | 'discardFile'
  | 'getSubmodules'
  | 'updateIndexContent'
  | 'warmDiffCache'

type WorkerRequest = {
  id: number
  method: GitIpcWorkerMethod
  payload: Record<string, unknown>
}

type WorkerResponse = {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

function stringPayload(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

async function dispatch(method: GitIpcWorkerMethod, payload: Record<string, unknown>): Promise<unknown> {
  const cwd = stringPayload(payload, 'cwd')
  switch (method) {
    case 'checkInstalled':
      return await checkGitInstalled()
    case 'resolveRepoRoot':
      return await resolveRepoRoot(cwd)
    case 'getDiff':
      return await getGitDiff(cwd, payload.options as { scope?: 'root-only' | 'full' } | undefined)
    case 'getHistory':
      return await getGitHistory(cwd, Number(payload.limit) || undefined, Number(payload.skip) || undefined)
    case 'getHistoryDiff':
      return await getGitHistoryDiff(cwd, payload.options as GitHistoryDiffOptions)
    case 'getHistoryFileContent':
      return await getGitHistoryFileContent(cwd, payload.options as GitHistoryFileContentOptions)
    case 'getFileContent':
      return await getGitFileContent(
        cwd,
        payload.file as Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType' | 'isSubmoduleEntry'>,
        typeof payload.repoRoot === 'string' ? payload.repoRoot : undefined
      )
    case 'saveFileContent':
      return await saveGitFileContent(cwd, stringPayload(payload, 'filename'), stringPayload(payload, 'content'))
    case 'stageFile':
      return await stageGitFile(cwd, stringPayload(payload, 'filename'), typeof payload.repoRoot === 'string' ? payload.repoRoot : undefined)
    case 'unstageFile':
      return await unstageGitFile(cwd, stringPayload(payload, 'filename'), typeof payload.repoRoot === 'string' ? payload.repoRoot : undefined)
    case 'discardFile':
      return await discardGitFile(
        cwd,
        payload.file as Pick<GitFileStatus, 'filename' | 'changeType' | 'status' | 'isSubmoduleEntry'>,
        typeof payload.repoRoot === 'string' ? payload.repoRoot : undefined
      )
    case 'getSubmodules': {
      const meta = await getGitRepoMeta(cwd)
      if (!meta.isRepo || !meta.repoRoot || !meta.gitExecutable) return []
      return await detectSubmodulesRecursive(meta.repoRoot, meta.gitExecutable)
    }
    case 'updateIndexContent':
      return await updateGitIndexContent(cwd, stringPayload(payload, 'filename'), stringPayload(payload, 'content'))
    case 'warmDiffCache':
      try {
        await getGitDiff(cwd, { scope: 'full' })
        return { success: true }
      } catch {
        return { success: false }
      }
    default:
      throw new Error(`Unsupported Git IPC worker method: ${method}`)
  }
}

parentPort?.on('message', async (request: WorkerRequest) => {
  const response: WorkerResponse = {
    id: request.id,
    ok: false
  }

  try {
    response.result = await dispatch(request.method, request.payload || {})
    response.ok = true
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error)
  }

  parentPort?.postMessage(response)
})
