/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export const BASELINE_TOKEN_BETA = 'ONWARD_TERMINAL_BASELINE_TOKEN'

export function renderBeta(index: number): string {
  return `${BASELINE_TOKEN_BETA}:${index * 2}`
}
