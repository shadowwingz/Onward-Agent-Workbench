/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import './monaco-env'
import App from './App'
import './types/electron.d.ts'
import { installRendererPerfTrace } from './utils/perf-trace'

installRendererPerfTrace()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
