/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto'
import { getSettingsStorage } from '../settings-storage'
import { TELEMETRY_AUTOTEST_SKIP_CONSENT } from './telemetry-constants'

/**
 * Read the current telemetry consent state from settings.
 * Returns null if the user has not been asked yet.
 *
 * When ONWARD_AUTOTEST_SKIP_CONSENT=1 and no consent has been recorded yet,
 * we report `false` (declined) to the caller so the renderer's first-run
 * consent dialog never mounts. This keeps autotests driven by a fresh
 * `ONWARD_USER_DATA_DIR` from being blocked by a modal consent overlay.
 * Explicit stored values (true/false) are always respected.
 */
export function getTelemetryConsent(): boolean | null {
  const stored = getSettingsStorage().getTelemetryConsent()
  if (stored === null && TELEMETRY_AUTOTEST_SKIP_CONSENT) {
    return false
  }
  return stored
}

/**
 * Read the stored anonymous instance ID.
 * Returns null if telemetry is not enabled.
 */
export function getTelemetryInstanceId(): string | null {
  return getSettingsStorage().getTelemetryInstanceId()
}

/**
 * Set consent and manage instance ID accordingly.
 * - On opt-in: generates a fresh random UUID as instance ID.
 * - On opt-out: clears the instance ID.
 * Returns the new instance ID (or null on opt-out).
 */
export function setTelemetryConsent(consent: boolean): string | null {
  const storage = getSettingsStorage()
  const instanceId = consent ? randomUUID() : null
  storage.setTelemetryConsent(consent, instanceId)
  return instanceId
}
