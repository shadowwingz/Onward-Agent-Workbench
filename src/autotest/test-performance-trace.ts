/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const RAW_SECRET = 'performance-trace-raw-content-should-not-appear'
const RAW_COMMAND_PREFIX = 'PTTRACE_RAW_SHOULD_NOT_APPEAR'

function statusDetail(status: Awaited<ReturnType<typeof window.electronAPI.debug.getPerfTraceStatus>>): Record<string, unknown> {
  return { ...status }
}

function createTraceCommand(marker: string): string {
  if (window.electronAPI.platform === 'win32') {
    return `Write-Output '${marker}'`
  }
  return `printf '${marker}\\n'`
}

export async function testPerformanceTrace(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, log, sleep, waitFor, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('performance-trace:start', { suite: 'PerformanceTrace' })

  const baselineStatus = await window.electronAPI.debug.getPerfTraceStatus()
  _assert('PT-01-enabled', baselineStatus.enabled === true && baselineStatus.initialized === true, statusDetail(baselineStatus))
  _assert('PT-02-content-capture-disabled-by-default', baselineStatus.captureContent === false, statusDetail(baselineStatus))

  if (cancelled()) return results

  window.electronAPI.debug.recordPerfTrace({
    name: 'test.performance_trace.marker',
    cat: 'test',
    ph: 'i',
    ts: Math.round((performance.timeOrigin + performance.now()) * 1000),
    args: {
      caseName: 'PT-03-marker-event',
      safeValue: 'schema-marker',
      contentPreview: RAW_SECRET
    }
  })

  const apisReady = await waitFor('performance-trace-debug-apis', () => {
    return Boolean(window.__onwardPromptSenderDebug && window.__onwardPromptNotebookDebug && window.__onwardTerminalDebug)
  }, 8000, 100)
  _assert('PT-03-golden-debug-apis', apisReady, {
    promptSender: Boolean(window.__onwardPromptSenderDebug),
    promptNotebook: Boolean(window.__onwardPromptNotebookDebug),
    terminalDebug: Boolean(window.__onwardTerminalDebug)
  })

  if (apisReady && !cancelled()) {
    const senderApi = window.__onwardPromptSenderDebug!
    const notebookApi = window.__onwardPromptNotebookDebug!
    const terminalDebugApi = window.__onwardTerminalDebug!
    const cards = senderApi.getTerminalCards()
    const targetId = cards[0]?.id ?? terminalId
    _assert('PT-04-golden-terminal-available', Boolean(targetId), {
      cardCount: cards.length,
      targetId: targetId ?? null
    })

    if (targetId) {
      const selectTargetTerminal = async (): Promise<boolean> => {
        senderApi.deselectAllTerminals()
        await sleep(120)
        if (!senderApi.selectTerminal(targetId)) return false
        return await waitFor('performance-trace-terminal-selected', () => {
          return window.__onwardPromptSenderDebug?.getSelectedTerminalIds().includes(targetId) === true
        }, 2000, 80)
      }

      const sendMarker = `${RAW_COMMAND_PREFIX}_SEND_${Date.now()}`
      const sendCommand = createTraceCommand(sendMarker)
      notebookApi.setEditorContent(sendCommand)
      const sendEditorSynced = await waitFor('performance-trace-send-editor-sync', () => {
        return window.__onwardPromptNotebookDebug?.getEditorContent() === sendCommand
      }, 3000, 80)
      const selectedForSend = await selectTargetTerminal()
      const sent = await senderApi.clickAction('send')
      const sendIdle = await waitFor('performance-trace-send-idle', () => {
        return window.__onwardPromptSenderDebug?.isSubmitting() === false
      }, 5000, 100)
      const selectedForExecute = await selectTargetTerminal()
      const executed = await senderApi.clickAction('execute')
      const executeIdle = await waitFor('performance-trace-execute-idle', () => {
        return window.__onwardPromptSenderDebug?.isSubmitting() === false
      }, 5000, 100)
      const sendOutputSeen = await waitFor('performance-trace-send-output', () => {
        return (terminalDebugApi.getTailText(targetId, 60) ?? '').includes(sendMarker)
      }, window.electronAPI.platform === 'win32' ? 9000 : 6000, 120)
      _assert('PT-05-golden-send-then-execute', sendEditorSynced && selectedForSend && sent && sendIdle && selectedForExecute && executed && executeIdle && sendOutputSeen, {
        targetId,
        marker: sendMarker,
        sendEditorSynced,
        selectedForSend,
        sent,
        sendIdle,
        selectedForExecute,
        executed,
        executeIdle,
        sendOutputSeen
      })

      const sendExecuteMarker = `${RAW_COMMAND_PREFIX}_SEND_EXEC_${Date.now()}`
      const sendExecuteCommand = createTraceCommand(sendExecuteMarker)
      notebookApi.setEditorContent(sendExecuteCommand)
      const sendExecuteEditorSynced = await waitFor('performance-trace-send-execute-editor-sync', () => {
        return window.__onwardPromptNotebookDebug?.getEditorContent() === sendExecuteCommand
      }, 3000, 80)
      const selectedForSendExecute = await selectTargetTerminal()
      const sendExecuteClicked = await senderApi.clickAction('sendAndExecute')
      const sendExecuteIdle = await waitFor('performance-trace-send-execute-idle', () => {
        return window.__onwardPromptSenderDebug?.isSubmitting() === false
      }, 6000, 100)
      const sendExecuteOutputSeen = await waitFor('performance-trace-send-execute-output', () => {
        return (terminalDebugApi.getTailText(targetId, 80) ?? '').includes(sendExecuteMarker)
      }, window.electronAPI.platform === 'win32' ? 9000 : 6000, 120)
      _assert('PT-06-golden-send-and-execute', sendExecuteEditorSynced && selectedForSendExecute && sendExecuteClicked && sendExecuteIdle && sendExecuteOutputSeen, {
        targetId,
        marker: sendExecuteMarker,
        sendExecuteEditorSynced,
        selectedForSendExecute,
        sendExecuteClicked,
        sendExecuteIdle,
        sendExecuteOutputSeen
      })

      let apiPort = 0
      let apiReady = false
      for (let attempt = 0; attempt < 50; attempt += 1) {
        apiPort = await window.electronAPI.debug.getApiServerPort()
        if (apiPort > 0) {
          apiReady = true
          break
        }
        await sleep(100)
      }
      const apiMarker = `${RAW_COMMAND_PREFIX}_API_${Date.now()}`
      const apiCommand = createTraceCommand(apiMarker)
      let apiStatus = 0
      let apiResponseOk = false
      if (apiReady) {
        try {
          const response = await window.electronAPI.debug.postApiTerminalWrite({
            terminalId: targetId,
            text: apiCommand,
            execute: true
          })
          apiStatus = response.status
          apiResponseOk = response.ok
        } catch {
          apiResponseOk = false
        }
      }
      const apiOutputSeen = apiResponseOk
        ? await waitFor('performance-trace-api-output', () => {
          return (terminalDebugApi.getTailText(targetId, 100) ?? '').includes(apiMarker)
        }, window.electronAPI.platform === 'win32' ? 9000 : 6000, 120)
        : false
      _assert('PT-07-golden-api-prompt-bridge', apiReady && apiResponseOk && apiOutputSeen, {
        targetId,
        apiPort,
        apiStatus,
        apiResponseOk,
        apiOutputSeen
      })
    }
  }

  if (terminalId) {
    const flowId = `autotest-performance-trace-${Date.now()}`
    await window.electronAPI.terminal.write(terminalId, 'echo performance-trace-autotest\r', { traceFlowId: flowId })
    await sleep(1600)
  }

  const flushStatus = await window.electronAPI.debug.flushPerfTrace()
  _assert('PT-08-flush-produced-file', Boolean(flushStatus.filePath) && flushStatus.eventCount > baselineStatus.eventCount, statusDetail(flushStatus))
  _assert('PT-09-no-dropped-events', flushStatus.droppedEvents === 0, statusDetail(flushStatus))

  log('performance-trace:file', {
    filePath: flushStatus.filePath,
    eventCount: flushStatus.eventCount,
    droppedEvents: flushStatus.droppedEvents
  })
  log('performance-trace:done')

  return results
}
