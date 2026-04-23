/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export const BASELINE_TOKEN_ALPHA = 'ONWARD_TERMINAL_BASELINE_TOKEN'

export function renderAlpha(index: number): string {
  return `${BASELINE_TOKEN_ALPHA}:${index}`
}
