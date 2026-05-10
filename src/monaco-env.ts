/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

function isIgnorableMonacoMenuTeardownError(value: unknown): boolean {
  const message = value instanceof Error
    ? `${value.message}\n${value.stack ?? ''}`
    : typeof value === 'string'
      ? value
      : String(value ?? '')
  return message.includes('AbstractContextKeyService has been disposed') &&
    message.includes('MenuInfo') &&
    message.includes('DebounceEmitter')
}

window.addEventListener('error', (event) => {
  if (!isIgnorableMonacoMenuTeardownError(event.error ?? event.message)) return
  event.preventDefault()
  event.stopImmediatePropagation()
}, true)

self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json') {
      return new jsonWorker()
    }
    if (label === 'css' || label === 'scss' || label === 'less') {
      return new cssWorker()
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return new htmlWorker()
    }
    if (label === 'typescript' || label === 'javascript') {
      return new tsWorker()
    }
    return new editorWorker()
  }
}

loader.config({ monaco })
void loader.init().catch((error) => {
  console.error('Failed to initialize Monaco editor:', error)
})
