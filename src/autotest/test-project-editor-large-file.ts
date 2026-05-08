/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const ONE_MB = 1024 * 1024

function buildAsciiFile(sizeBytes: number, label: string): string {
  const line = `${label} Project Editor large-file autotest line with stable ASCII content.\n`
  const block = line.repeat(Math.ceil(64 * 1024 / line.length))
  let out = ''
  while (out.length < sizeBytes) {
    out += block
  }
  return out.slice(0, sizeBytes)
}

function buildBinaryLikeText(label: string): string {
  return `\u0000\u0001\u0002${label}-binary-fixture\n${'ABCDEF0123456789\u0000'.repeat(256)}`
}

async function ensureFolder(rootPath: string, path: string): Promise<void> {
  const result = await window.electronAPI.project.createFolder(rootPath, path)
  if (!result.success && !String(result.error ?? '').includes('already exists')) {
    throw new Error(result.error || `Failed to create ${path}`)
  }
}

export async function testProjectEditorLargeFile(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, rootPath, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const api = () => window.__onwardProjectEditorDebug
  if (
    !api()?.openFileByPathAsUser ||
    !api()?.getDialogState ||
    !api()?.confirmDialog ||
    !api()?.getOpenChoiceDialogState ||
    !api()?.chooseOpenChoice ||
    !api()?.getLargeFileState ||
    !api()?.setLargeFileOffset ||
    !api()?.setBinaryRadix
  ) {
    record('PLF-00-debug-api-available', false, { error: 'large-file debug hooks unavailable' })
    return results
  }

  localStorage.removeItem('project-editor-binary-open-defaults')

  const runId = Date.now()
  const suiteDir = `test/autotest/results/project-editor-large-file/${runId}`
  const smallTextPath = `${suiteDir}/small-1mb.txt`
  const warnedTextPath = `${suiteDir}/warn-4mb.txt`
  const largeTextPath = `${suiteDir}/large-31mb.txt`
  const binaryPathA = `${suiteDir}/unknown-a.myst`
  const binaryPathB = `${suiteDir}/unknown-b.myst`
  const binaryTextPath = `${suiteDir}/unknown-text.rawbin`
  const supportedPngPath = 'resources/test-preview.png'
  const supportedPdfPath = 'test/autotest/fixtures/pdf-epub/onward-autotest.pdf'
  const largeGifPath = 'test/autotest/results/project-editor-large-file/large-preview.gif'

  log('project-editor-large-file:setup', {
    suiteDir,
    smallTextPath,
    warnedTextPath,
    largeTextPath,
    binaryPathA,
    binaryPathB,
    binaryTextPath,
    supportedPngPath,
    supportedPdfPath,
    largeGifPath
  })

  try {
    await ensureFolder(rootPath, 'test/autotest/results')
    await ensureFolder(rootPath, 'test/autotest/results/project-editor-large-file')
    await ensureFolder(rootPath, suiteDir)

    const smallCreate = await window.electronAPI.project.createFile(rootPath, smallTextPath, buildAsciiFile(ONE_MB, 'small'))
    record('PLF-01-create-1mb-text', smallCreate.success, { error: smallCreate.error })
    if (!smallCreate.success || cancelled()) return results

    const warnedCreate = await window.electronAPI.project.createFile(rootPath, warnedTextPath, buildAsciiFile(4 * ONE_MB, 'warn'))
    record('PLF-02-create-4mb-text', warnedCreate.success, { error: warnedCreate.error })
    if (!warnedCreate.success || cancelled()) return results

    const largeCreate = await window.electronAPI.project.createFile(rootPath, largeTextPath, buildAsciiFile(31 * ONE_MB, 'large'))
    record('PLF-03-create-31mb-text', largeCreate.success, { error: largeCreate.error })
    if (!largeCreate.success || cancelled()) return results

    const binaryA = await window.electronAPI.project.createFile(rootPath, binaryPathA, buildBinaryLikeText('first'))
    const binaryB = await window.electronAPI.project.createFile(rootPath, binaryPathB, buildBinaryLikeText('second'))
    const binaryText = await window.electronAPI.project.createFile(rootPath, binaryTextPath, buildBinaryLikeText('text-mode'))
    record('PLF-04-create-unknown-binary-fixtures', binaryA.success && binaryB.success && binaryText.success, {
      binaryA: binaryA.error,
      binaryB: binaryB.error,
      binaryText: binaryText.error
    })
    if (!binaryA.success || !binaryB.success || !binaryText.success || cancelled()) return results

    await api()!.openFileByPathAsUser(smallTextPath)
    const smallOpened = await waitFor(
      'plf-small-opened',
      () => api()?.getActiveFilePath?.() === smallTextPath &&
        (api()?.getEditorContent?.().length ?? 0) >= ONE_MB &&
        !api()?.getLargeFileState?.(),
      12000
    )
    record('PLF-05-1mb-text-opens-eagerly', smallOpened, {
      active: api()?.getActiveFilePath?.(),
      contentLength: api()?.getEditorContent?.().length ?? 0,
      largeState: api()?.getLargeFileState?.()
    })
    if (cancelled()) return results

    const warnedOpen = api()!.openFileByPathAsUser(warnedTextPath)
    const warnedDialog = await waitFor(
      'plf-4mb-warning-dialog',
      () => api()?.getDialogState?.()?.type === 'confirm',
      8000
    )
    record('PLF-06-4mb-text-shows-warning', warnedDialog, {
      dialog: api()?.getDialogState?.()
    })
    api()?.confirmDialog?.()
    await warnedOpen
    const warnedOpened = await waitFor(
      'plf-4mb-opened-after-confirm',
      () => api()?.getActiveFilePath?.() === warnedTextPath &&
        (api()?.getEditorContent?.().length ?? 0) >= 4 * ONE_MB &&
        !api()?.getLargeFileState?.(),
      16000
    )
    record('PLF-07-4mb-text-opens-after-confirm', warnedOpened, {
      contentLength: api()?.getEditorContent?.().length ?? 0,
      largeState: api()?.getLargeFileState?.()
    })
    if (cancelled()) return results

    const largeOpen = api()!.openFileByPathAsUser(largeTextPath)
    const largeDialog = await waitFor(
      'plf-31mb-readonly-dialog',
      () => api()?.getDialogState?.()?.type === 'confirm',
      8000
    )
    record('PLF-08-31mb-text-shows-readonly-warning', largeDialog, {
      dialog: api()?.getDialogState?.()
    })
    api()?.confirmDialog?.()
    await largeOpen
    const largeReady = await waitFor(
      'plf-31mb-readonly-ready',
      () => {
        const state = api()?.getLargeFileState?.()
        return state?.mode === 'large-text' &&
          state.path === largeTextPath &&
          state.readOnly &&
          !state.loading &&
          state.textLength > 0 &&
          state.bytesRead > 0 &&
          (api()?.getEditorContent?.().length ?? -1) === 0
      },
      16000
    )
    record('PLF-09-31mb-text-opens-readonly-chunked', largeReady, {
      state: api()?.getLargeFileState?.(),
      editorContentLength: api()?.getEditorContent?.().length ?? -1
    })
    const movedLargeChunk = await api()?.setLargeFileOffset?.(2 * ONE_MB)
    await sleep(100)
    const chunkMoved = Boolean(movedLargeChunk) && (api()?.getLargeFileState?.()?.offset ?? 0) >= 2 * ONE_MB
    record('PLF-10-31mb-text-can-load-later-chunk', chunkMoved, {
      state: api()?.getLargeFileState?.()
    })
    if (cancelled()) return results

    const binaryOpenA = api()!.openFileByPathAsUser(binaryPathA)
    const binaryChoiceShown = await waitFor(
      'plf-binary-choice-visible',
      () => api()?.getOpenChoiceDialogState?.()?.visible === true,
      8000
    )
    record('PLF-11-unknown-binary-shows-choice-dialog', binaryChoiceShown, {
      choice: api()?.getOpenChoiceDialogState?.()
    })
    api()?.chooseOpenChoice?.('binary', true)
    await binaryOpenA
    const binaryReady = await waitFor(
      'plf-binary-viewer-ready',
      () => {
        const state = api()?.getLargeFileState?.()
        return state?.mode === 'binary' &&
          state.path === binaryPathA &&
          state.readOnly &&
          !state.loading &&
          state.binaryLength > 0
      },
      10000
    )
    record('PLF-12-binary-opens-readonly-viewer', binaryReady, {
      state: api()?.getLargeFileState?.()
    })
    const radixChanged = Boolean(api()?.setBinaryRadix?.(8))
    await sleep(100)
    record('PLF-13-binary-viewer-supports-octal-radix', radixChanged && api()?.getLargeFileState?.()?.binaryRadix === 8, {
      state: api()?.getLargeFileState?.()
    })
    if (cancelled()) return results

    await api()!.openFileByPathAsUser(binaryPathB)
    const rememberedReady = await waitFor(
      'plf-binary-remembered-ready',
      () => {
        const state = api()?.getLargeFileState?.()
        return state?.mode === 'binary' &&
          state.path === binaryPathB &&
          !state.loading &&
          api()?.getOpenChoiceDialogState?.()?.visible === false
      },
      10000
    )
    record('PLF-14-binary-choice-remembers-extension', rememberedReady, {
      state: api()?.getLargeFileState?.(),
      choice: api()?.getOpenChoiceDialogState?.()
    })
    if (cancelled()) return results

    const binaryTextOpen = api()!.openFileByPathAsUser(binaryTextPath)
    const binaryTextChoice = await waitFor(
      'plf-binary-text-choice-visible',
      () => api()?.getOpenChoiceDialogState?.()?.visible === true,
      8000
    )
    record('PLF-15-unknown-binary-can-choose-text', binaryTextChoice, {
      choice: api()?.getOpenChoiceDialogState?.()
    })
    api()?.chooseOpenChoice?.('text', false)
    await binaryTextOpen
    const textModeReady = await waitFor(
      'plf-binary-text-mode-ready',
      () => api()?.getActiveFilePath?.() === binaryTextPath &&
        !api()?.getLargeFileState?.() &&
        (api()?.getEditorContent?.().includes('text-mode') ?? false),
      10000
    )
    record('PLF-16-binary-text-choice-loads-monaco-text', textModeReady, {
      active: api()?.getActiveFilePath?.(),
      contentLength: api()?.getEditorContent?.().length ?? 0,
      largeState: api()?.getLargeFileState?.()
    })
    if (cancelled()) return results

    const pngOpen = api()!.openFileByPathAsUser(supportedPngPath)
    const pngReady = await waitFor(
      'plf-supported-png-preview',
      () => {
        const state = api()?.getImageFilePreviewState?.()
        return api()?.getActiveFilePath?.() === supportedPngPath &&
          api()?.getOpenChoiceDialogState?.()?.visible === false &&
          Boolean(state?.visible && state.loaded && !state.broken)
      },
      10000
    )
    if (!pngReady && api()?.getOpenChoiceDialogState?.()?.visible) {
      api()?.chooseOpenChoice?.('cancel')
    }
    await pngOpen
    record('PLF-17-supported-png-bypasses-binary-choice', pngReady, {
      active: api()?.getActiveFilePath?.(),
      choice: api()?.getOpenChoiceDialogState?.(),
      imageState: api()?.getImageFilePreviewState?.()
    })
    if (cancelled()) return results

    const pdfOpen = api()!.openFileByPathAsUser(supportedPdfPath)
    const pdfReady = await waitFor(
      'plf-supported-pdf-reader',
      () => api()?.getActiveFilePath?.() === supportedPdfPath &&
        api()?.getOpenChoiceDialogState?.()?.visible === false &&
        Boolean(api()?.isPdfReaderVisible?.()),
      10000
    )
    if (!pdfReady && api()?.getOpenChoiceDialogState?.()?.visible) {
      api()?.chooseOpenChoice?.('cancel')
    }
    await pdfOpen
    record('PLF-18-supported-pdf-bypasses-binary-choice', pdfReady, {
      active: api()?.getActiveFilePath?.(),
      choice: api()?.getOpenChoiceDialogState?.(),
      pdfState: api()?.getPdfReaderState?.()
    })
    if (cancelled()) return results

    const largeGifOpen = api()!.openFileByPathAsUser(largeGifPath)
    const largeGifReady = await waitFor(
      'plf-large-gif-preview',
      () => {
        const state = api()?.getImageFilePreviewState?.()
        return api()?.getActiveFilePath?.() === largeGifPath &&
          api()?.getOpenChoiceDialogState?.()?.visible === false &&
          Boolean(state?.visible && state.loaded && !state.broken)
      },
      12000
    )
    if (!largeGifReady && api()?.getOpenChoiceDialogState?.()?.visible) {
      api()?.chooseOpenChoice?.('cancel')
    }
    await largeGifOpen
    const largeGifState = api()?.getImageFilePreviewState?.()
    record('PLF-19-large-gif-bypasses-image-size-limit', largeGifReady, {
      active: api()?.getActiveFilePath?.(),
      choice: api()?.getOpenChoiceDialogState?.(),
      imageState: largeGifState
    })
    record('PLF-20-large-gif-preview-uses-file-url', Boolean(largeGifState?.src.startsWith('file:')), {
      srcPrefix: largeGifState?.src.slice(0, 32) ?? null
    })
  } catch (error) {
    record('PLF-99-unhandled-error', false, { error: String(error) })
  } finally {
    await window.electronAPI.project.deletePath(rootPath, suiteDir)
    localStorage.removeItem('project-editor-binary-open-defaults')
  }

  return results
}
