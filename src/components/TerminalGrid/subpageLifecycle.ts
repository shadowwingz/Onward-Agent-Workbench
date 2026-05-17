/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SubpageId } from '../../types/subpage'
import type { SubpageRouteCommand } from './subpageRouter'
import type { SubpageSnapshot } from './subpageStateMemory'

export interface SubpageLifecycleContext {
  command: SubpageRouteCommand
}

export interface SubpageLifecycleController {
  beforeLeave?: (context: SubpageLifecycleContext) => SubpageSnapshot | null | void | Promise<SubpageSnapshot | null | void>
  afterEnter?: (context: SubpageLifecycleContext) => void | Promise<void>
}

export interface SubpageLifecycleRegistry {
  register(subpage: SubpageId, controller: SubpageLifecycleController): () => void
  get(subpage: SubpageId): SubpageLifecycleController | null
  beforeLeave(subpage: SubpageId | null, context: SubpageLifecycleContext): Promise<SubpageSnapshot | null>
  afterEnter(subpage: SubpageId | null, context: SubpageLifecycleContext): Promise<void>
}

export function createSubpageLifecycleRegistry(): SubpageLifecycleRegistry {
  const controllers = new Map<SubpageId, SubpageLifecycleController>()

  return {
    register(subpage, controller) {
      controllers.set(subpage, controller)
      return () => {
        if (controllers.get(subpage) === controller) {
          controllers.delete(subpage)
        }
      }
    },
    get(subpage) {
      return controllers.get(subpage) ?? null
    },
    async beforeLeave(subpage, context) {
      if (!subpage) return null
      const controller = controllers.get(subpage)
      if (!controller?.beforeLeave) return null
      return (await controller.beforeLeave(context)) ?? null
    },
    async afterEnter(subpage, context) {
      if (!subpage) return
      const controller = controllers.get(subpage)
      if (!controller?.afterEnter) return
      await controller.afterEnter(context)
    }
  }
}
