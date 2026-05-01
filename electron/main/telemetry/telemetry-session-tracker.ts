/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow } from 'electron'
import { getTelemetryService } from './telemetry-service'
import { getAppStateStorage } from '../app-state-storage'
import { TELEMETRY_HEARTBEAT_INTERVAL_MS, TELEMETRY_FAST_HEARTBEAT } from './telemetry-constants'

const EFFECTIVE_HEARTBEAT_MS = TELEMETRY_FAST_HEARTBEAT ? 5_000 : TELEMETRY_HEARTBEAT_INTERVAL_MS

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

// Active-time tracking: only accumulate when the window is focused
let activeMs = 0
let lastFocusedAt: number | null = null

/**
 * Notify the tracker that the window gained focus.
 */
export function onWindowFocused(): void {
  if (lastFocusedAt === null) {
    lastFocusedAt = Date.now()
  }
}

/**
 * Notify the tracker that the window lost focus.
 */
export function onWindowBlurred(): void {
  if (lastFocusedAt !== null) {
    activeMs += Date.now() - lastFocusedAt
    lastFocusedAt = null
  }
}

/**
 * Get total active (focused) duration in milliseconds.
 */
export function getSessionDurationMs(): number {
  let total = activeMs
  if (lastFocusedAt !== null) {
    total += Date.now() - lastFocusedAt
  }
  return total
}

/**
 * Collect a snapshot of current workspace usage for heartbeat events.
 */
function getUsageSnapshot(): Record<string, string | number | boolean> {
  try {
    const state = getAppStateStorage().get()
    const tabCount = state.tabs?.length ?? 0
    const totalTerminals = state.tabs?.reduce(
      (sum, tab) => sum + (tab.terminals?.length ?? 0), 0
    ) ?? 0
    const activeTab = state.tabs?.find(t => t.id === state.activeTabId)
    // Telemetry exposes layoutMode as a flat int (effective Task count) so
    // historical dashboards keep working. Custom layouts surface the cell
    // count instead of a stable preset value.
    let layoutMode = 1
    const tabLayout = activeTab?.layoutMode as
      | { kind?: 'preset' | 'custom'; count?: number; presetId?: string }
      | number
      | undefined
    if (typeof tabLayout === 'number') {
      layoutMode = tabLayout
    } else if (tabLayout && typeof tabLayout === 'object') {
      if (tabLayout.kind === 'preset' && typeof tabLayout.count === 'number') {
        layoutMode = tabLayout.count
      } else if (tabLayout.kind === 'custom' && typeof tabLayout.presetId === 'string') {
        const preset = (state as { customLayoutPresets?: Array<{ id: string; cells?: unknown[] }> })
          .customLayoutPresets?.find(p => p.id === tabLayout.presetId)
        layoutMode = Array.isArray(preset?.cells) ? preset!.cells.length : 1
      }
    }

    return {
      activeMs: getSessionDurationMs(),
      tabCount,
      terminalCount: totalTerminals,
      layoutMode
    }
  } catch {
    return { activeMs: getSessionDurationMs() }
  }
}

/**
 * Start periodic session heartbeat events and wire up focus tracking.
 */
export function startSessionHeartbeat(mainWindow: BrowserWindow): void {
  if (heartbeatTimer) return

  // Initialize focus state based on current window state
  if (mainWindow.isFocused()) {
    onWindowFocused()
  }

  // Listen for focus/blur on the window
  mainWindow.on('focus', onWindowFocused)
  mainWindow.on('blur', onWindowBlurred)

  heartbeatTimer = setInterval(() => {
    getTelemetryService().track('session/heartbeat', getUsageSnapshot())
    // Check if daily upload is due
    getTelemetryService().tryDailyUpload()
  }, EFFECTIVE_HEARTBEAT_MS)

  if (TELEMETRY_FAST_HEARTBEAT) {
    console.log(`[Telemetry] Fast heartbeat enabled: ${EFFECTIVE_HEARTBEAT_MS}ms (ONWARD_TELEMETRY_FAST_HEARTBEAT=1)`)
  }
}

/**
 * Stop the heartbeat timer (called on app quit).
 */
export function stopSessionHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  // Finalize active time if window is still focused
  onWindowBlurred()
}
