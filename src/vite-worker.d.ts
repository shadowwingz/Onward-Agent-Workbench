/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

declare module '*?worker' {
  const WorkerFactory: {
    new (): Worker
  }
  export default WorkerFactory
}
