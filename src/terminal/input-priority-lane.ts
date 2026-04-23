/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

type SchedulingNavigator = Navigator & {
  scheduling?: {
    isInputPending?: (options?: { includeContinuous?: boolean }) => boolean
  }
}

const PROMPT_INPUT_SELECTOR = [
  '.prompt-editor-content',
  '.prompt-editor-title',
  '.prompt-search-input'
].join(',')

const DEFAULT_INPUT_PROTECTION_MS = 140

function isPromptInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest(PROMPT_INPUT_SELECTOR))
}

export class InputPriorityLane {
  private listening = false
  private promptInputUntil = 0
  private focusedTaskInputUntil = 0
  private promptFocused = false

  start(): void {
    if (this.listening || typeof document === 'undefined') return
    this.listening = true

    document.addEventListener('keydown', this.handleInputEvent, true)
    document.addEventListener('beforeinput', this.handleInputEvent, true)
    document.addEventListener('input', this.handleInputEvent, true)
    document.addEventListener('compositionstart', this.handleInputEvent, true)
    document.addEventListener('compositionupdate', this.handleInputEvent, true)
    document.addEventListener('compositionend', this.handleInputEvent, true)
    document.addEventListener('focusin', this.handleFocusEvent, true)
    document.addEventListener('focusout', this.handleFocusEvent, true)
    this.refreshPromptFocus()
  }

  stop(): void {
    if (!this.listening || typeof document === 'undefined') return
    this.listening = false

    document.removeEventListener('keydown', this.handleInputEvent, true)
    document.removeEventListener('beforeinput', this.handleInputEvent, true)
    document.removeEventListener('input', this.handleInputEvent, true)
    document.removeEventListener('compositionstart', this.handleInputEvent, true)
    document.removeEventListener('compositionupdate', this.handleInputEvent, true)
    document.removeEventListener('compositionend', this.handleInputEvent, true)
    document.removeEventListener('focusin', this.handleFocusEvent, true)
    document.removeEventListener('focusout', this.handleFocusEvent, true)
  }

  noteHighPriorityInput(windowMs = DEFAULT_INPUT_PROTECTION_MS): void {
    this.notePromptInput(windowMs)
  }

  notePromptInput(windowMs = DEFAULT_INPUT_PROTECTION_MS): void {
    this.promptInputUntil = Math.max(this.promptInputUntil, performance.now() + windowMs)
  }

  noteFocusedTaskInput(windowMs = DEFAULT_INPUT_PROTECTION_MS): void {
    this.focusedTaskInputUntil = Math.max(this.focusedTaskInputUntil, performance.now() + windowMs)
  }

  hasRecentHighPriorityInput(): boolean {
    return this.hasRecentPromptInput() || this.hasRecentFocusedTaskInput()
  }

  hasRecentPromptInput(): boolean {
    return performance.now() < this.promptInputUntil
  }

  hasRecentFocusedTaskInput(): boolean {
    return performance.now() < this.focusedTaskInputUntil
  }

  shouldYieldToPromptInput(): boolean {
    if (this.hasRecentPromptInput()) return true
    if (!this.promptFocused) return false
    return this.hasBrowserInputPending()
  }

  shouldYieldToInput(): boolean {
    if (this.shouldYieldToPromptInput()) return true
    if (this.hasRecentFocusedTaskInput()) return true
    return this.hasBrowserInputPending()
  }

  private hasBrowserInputPending(): boolean {
    const scheduling = (navigator as SchedulingNavigator).scheduling
    try {
      return scheduling?.isInputPending?.({ includeContinuous: false }) === true
    } catch {
      return false
    }
  }

  private handleInputEvent = (event: Event): void => {
    if (!isPromptInputTarget(event.target)) return
    this.promptFocused = true
    this.notePromptInput()
  }

  private handleFocusEvent = (): void => {
    window.setTimeout(() => this.refreshPromptFocus(), 0)
  }

  private refreshPromptFocus(): void {
    this.promptFocused = isPromptInputTarget(document.activeElement)
  }
}

export const inputPriorityLane = new InputPriorityLane()

if (typeof window !== 'undefined') {
  inputPriorityLane.start()
  ;(window as unknown as { __onwardInputPriorityLane?: InputPriorityLane }).__onwardInputPriorityLane = inputPriorityLane
}
