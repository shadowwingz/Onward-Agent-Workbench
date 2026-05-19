/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

window.__ONWARD_HTML_EXTERNAL_READY = true
window.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('external-status')
  if (status) {
    status.textContent = 'external script ready'
  }
})
