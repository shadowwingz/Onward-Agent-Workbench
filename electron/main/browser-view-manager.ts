/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow, WebContentsView, session, type Event as ElectronEvent, type WebContents } from 'electron'
import { fileURLToPath } from 'url'
import { isAbsolute, relative, resolve } from 'path'
import { IPC } from '../shared/ipc-channels'
import { normalizeHtmlPreviewZoomFactor, stepHtmlPreviewZoomFactor } from '../../src/utils/html-file'

const BROWSER_PARTITION = 'persist:browser'

export interface BrowserCreateOptions {
  allowFile?: boolean
  fileRoot?: string
}

export interface BrowserScrollState {
  x: number
  y: number
  scrollWidth: number
  scrollHeight: number
  clientWidth: number
  clientHeight: number
}

export interface BrowserFindInPageOptions {
  forward?: boolean
  findNext?: boolean
  matchCase?: boolean
}

function isAllowedNetworkUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url === 'about:blank'
}

function normalizeFileRoot(fileRoot: string | undefined): string | null {
  if (!fileRoot?.trim()) return null
  try {
    return resolve(fileRoot)
  } catch {
    return null
  }
}

function isPathInsideRoot(pathname: string, root: string): boolean {
  const resolvedPath = resolve(pathname)
  const resolvedRoot = resolve(root)
  const comparablePath = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
  const comparableRoot = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot
  if (comparablePath === comparableRoot) return true
  const rel = relative(comparableRoot, comparablePath)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function normalizeScrollState(value: unknown): BrowserScrollState {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    x: readNonNegativeNumber(raw.x),
    y: readNonNegativeNumber(raw.y),
    scrollWidth: readNonNegativeNumber(raw.scrollWidth),
    scrollHeight: readNonNegativeNumber(raw.scrollHeight),
    clientWidth: readNonNegativeNumber(raw.clientWidth),
    clientHeight: readNonNegativeNumber(raw.clientHeight)
  }
}

interface BrowserViewInfo {
  view: WebContentsView
  attached: boolean
  isFullscreen: boolean
  savedBounds: { x: number; y: number; width: number; height: number } | null
  allowFile: boolean
  fileRoot: string | null
  findFallback: {
    query: string
    matches: number
    activeMatchOrdinal: number
  }
}

type WebContentsWithFrameNavigation = WebContents & {
  on(
    event: 'will-frame-navigate',
    listener: (event: ElectronEvent, details: { url?: string } | string) => void
  ): WebContents
}

class BrowserViewManager {
  private readonly views = new Map<string, BrowserViewInfo>()
  private mainWindow: BrowserWindow | null = null
  private sessionInitialized = false
  private rememberCookies = true

  init(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.initSession()
  }

  create(id: string, url?: string, options?: BrowserCreateOptions): { success: boolean; id: string; error?: string } {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, id, error: 'Main window is not initialized' }
    }
    if (this.views.has(id)) {
      return { success: false, id, error: `Browser view ${id} already exists` }
    }

    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: BROWSER_PARTITION,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true
      }
    })

    const info: BrowserViewInfo = {
      view,
      attached: false,
      isFullscreen: false,
      savedBounds: null,
      allowFile: Boolean(options?.allowFile),
      fileRoot: normalizeFileRoot(options?.fileRoot),
      findFallback: {
        query: '',
        matches: 0,
        activeMatchOrdinal: 0
      }
    }
    if (info.allowFile && !info.fileRoot) {
      try {
        view.webContents.close()
      } catch {
        // Ignore close failures while rejecting invalid preview roots.
      }
      return { success: false, id, error: 'File browser view requires a valid file root' }
    }
    this.views.set(id, info)
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })

    this.setupEventForwarding(id, info)

    if (url && url !== 'about:blank') {
      if (!this.isAllowedUrlForInfo(info, url)) {
        this.views.delete(id)
        try {
          view.webContents.close()
        } catch {
          // Ignore close failures while rejecting invalid preview URLs.
        }
        return { success: false, id, error: 'URL is not allowed for this browser view' }
      }
      void view.webContents.loadURL(url)
    }

    return { success: true, id }
  }

  destroy(id: string): boolean {
    const info = this.views.get(id)
    if (!info) return false

    try {
      if (info.attached && this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.contentView.removeChildView(info.view)
      }
    } catch {
      // Ignore detach failures during shutdown.
    }

    info.attached = false

    try {
      if (!info.view.webContents.isDestroyed()) {
        info.view.webContents.close()
      }
    } catch {
      // Ignore destroy failures during shutdown.
    }

    this.views.delete(id)
    if (this.views.size === 0 && !this.rememberCookies) {
      void this.clearCookies().catch(() => {
        // Ignore cookie cleanup failures during browser view teardown.
      })
    }
    return true
  }

  navigate(id: string, input: string): boolean {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return false

    const normalizedUrl = this.normalizeUrl(input)
    if (!normalizedUrl) return false

    void info.view.webContents.loadURL(normalizedUrl)
    return true
  }

  goBack(id: string): boolean {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return false
    if (!info.view.webContents.navigationHistory.canGoBack()) return false
    info.view.webContents.navigationHistory.goBack()
    return true
  }

  goForward(id: string): boolean {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return false
    if (!info.view.webContents.navigationHistory.canGoForward()) return false
    info.view.webContents.navigationHistory.goForward()
    return true
  }

  reload(id: string): boolean {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return false
    info.view.webContents.reload()
    return true
  }

  stop(id: string): boolean {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return false
    info.view.webContents.stop()
    return true
  }

  getZoomFactor(id: string): { success: boolean; zoomFactor?: number; error?: string } {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) {
      return { success: false, error: `Browser view ${id} is not available` }
    }
    return {
      success: true,
      zoomFactor: normalizeHtmlPreviewZoomFactor(info.view.webContents.getZoomFactor())
    }
  }

  setZoomFactor(id: string, zoomFactor: number): { success: boolean; zoomFactor?: number; error?: string } {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) {
      return { success: false, error: `Browser view ${id} is not available` }
    }
    const nextZoomFactor = normalizeHtmlPreviewZoomFactor(zoomFactor)
    info.view.webContents.setZoomFactor(nextZoomFactor)
    return { success: true, zoomFactor: nextZoomFactor }
  }

  async evaluateForTest(id: string, script: string): Promise<{ success: boolean; value?: unknown; error?: string }> {
    if (process.env.ONWARD_AUTOTEST !== '1') {
      return { success: false, error: 'Browser evaluation is only available during autotest' }
    }
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) {
      return { success: false, error: `Browser view ${id} is not available` }
    }
    try {
      const value = await info.view.webContents.executeJavaScript(script, true)
      return { success: true, value }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async getScrollState(id: string): Promise<{ success: boolean; state?: BrowserScrollState; error?: string }> {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) {
      return { success: false, error: `Browser view ${id} is not available` }
    }
    try {
      const value = await info.view.webContents.executeJavaScript(`(() => {
        const doc = document.documentElement;
        const body = document.body;
        return {
          x: window.scrollX || doc.scrollLeft || (body ? body.scrollLeft : 0) || 0,
          y: window.scrollY || doc.scrollTop || (body ? body.scrollTop : 0) || 0,
          scrollWidth: Math.max(doc.scrollWidth || 0, body ? body.scrollWidth || 0 : 0),
          scrollHeight: Math.max(doc.scrollHeight || 0, body ? body.scrollHeight || 0 : 0),
          clientWidth: doc.clientWidth || window.innerWidth || 0,
          clientHeight: doc.clientHeight || window.innerHeight || 0
        };
      })()`, true)
      return { success: true, state: normalizeScrollState(value) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async restoreScrollState(id: string, state: BrowserScrollState): Promise<{ success: boolean; state?: BrowserScrollState; error?: string }> {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) {
      return { success: false, error: `Browser view ${id} is not available` }
    }
    const normalized = normalizeScrollState(state)
    try {
      const value = await info.view.webContents.executeJavaScript(`(() => {
        const targetX = ${JSON.stringify(normalized.x)};
        const targetY = ${JSON.stringify(normalized.y)};
        const apply = () => {
          window.scrollTo(targetX, targetY);
        };
        apply();
        requestAnimationFrame(() => {
          apply();
          requestAnimationFrame(apply);
        });
        const doc = document.documentElement;
        const body = document.body;
        return {
          x: window.scrollX || doc.scrollLeft || (body ? body.scrollLeft : 0) || 0,
          y: window.scrollY || doc.scrollTop || (body ? body.scrollTop : 0) || 0,
          scrollWidth: Math.max(doc.scrollWidth || 0, body ? body.scrollWidth || 0 : 0),
          scrollHeight: Math.max(doc.scrollHeight || 0, body ? body.scrollHeight || 0 : 0),
          clientWidth: doc.clientWidth || window.innerWidth || 0,
          clientHeight: doc.clientHeight || window.innerHeight || 0
        };
      })()`, true)
      return { success: true, state: normalizeScrollState(value) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  findInPage(id: string, text: string, options?: BrowserFindInPageOptions): { success: boolean; requestId?: number; error?: string } {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) {
      return { success: false, error: `Browser view ${id} is not available` }
    }
    const query = text.trim()
    if (!query) {
      info.view.webContents.stopFindInPage('clearSelection')
      return { success: true, requestId: 0 }
    }
    const requestId = info.view.webContents.findInPage(query, {
      forward: options?.forward ?? true,
      findNext: options?.findNext ?? false,
      matchCase: options?.matchCase ?? false
    })
    void this.emitFindInPageFallback(id, info, query, requestId, options)
    return { success: true, requestId }
  }

  stopFindInPage(id: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'clearSelection'): boolean {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return false
    info.view.webContents.stopFindInPage(action)
    info.findFallback = {
      query: '',
      matches: 0,
      activeMatchOrdinal: 0
    }
    return true
  }

  setBounds(id: string, rect: { x: number; y: number; width: number; height: number }): boolean {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return false

    if (info.isFullscreen) {
      info.savedBounds = rect
      return true
    }

    info.view.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    })
    return true
  }

  show(id: string): boolean {
    const info = this.views.get(id)
    if (!info || !this.mainWindow || this.mainWindow.isDestroyed()) return false
    if (info.attached) return true

    try {
      this.mainWindow.contentView.addChildView(info.view)
      info.attached = true
      return true
    } catch {
      return false
    }
  }

  hide(id: string): boolean {
    const info = this.views.get(id)
    if (!info || !this.mainWindow || this.mainWindow.isDestroyed()) return false
    if (!info.attached) return true

    try {
      this.mainWindow.contentView.removeChildView(info.view)
      info.attached = false
      return true
    } catch {
      return false
    }
  }

  getNavState(id: string): {
    canGoBack: boolean
    canGoForward: boolean
    url: string
    title: string
    isLoading: boolean
  } | null {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return null

    const wc = info.view.webContents
    return {
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      url: wc.getURL(),
      title: wc.getTitle(),
      isLoading: wc.isLoading()
    }
  }

  async clearCookies(maxAge?: number): Promise<{ removed: number }> {
    const browserSession = session.fromPartition(BROWSER_PARTITION)
    const cookies = await browserSession.cookies.get({})

    if (!maxAge) {
      await browserSession.clearStorageData({ storages: ['cookies'] })
      return { removed: cookies.length }
    }

    const cutoff = Date.now() / 1000 - maxAge
    let removed = 0
    for (const cookie of cookies) {
      if (!cookie.expirationDate || cookie.expirationDate >= cutoff || !cookie.domain) {
        continue
      }

      const cookieUrl = `http${cookie.secure ? 's' : ''}://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`
      try {
        await browserSession.cookies.remove(cookieUrl, cookie.name)
        removed += 1
      } catch {
        // Ignore per-cookie removal failures and continue clearing the rest.
      }
    }

    return { removed }
  }

  setRememberCookies(rememberCookies: boolean): { rememberCookies: boolean } {
    this.rememberCookies = rememberCookies
    return { rememberCookies: this.rememberCookies }
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) {
      this.destroy(id)
    }
  }

  private initSession(): void {
    if (this.sessionInitialized) return
    this.sessionInitialized = true

    const browserSession = session.fromPartition(BROWSER_PARTITION)

    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false)
    })
    browserSession.on('will-download', (event) => {
      event.preventDefault()
    })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const info = this.findInfoByWebContentsId((details as { webContentsId?: number }).webContentsId)
      if (!this.isAllowedUrlForInfo(info, details.url)) {
        callback({ cancel: true })
        return
      }
      callback({})
    })
  }

  private setupEventForwarding(id: string, info: BrowserViewInfo): void {
    const wc = info.view.webContents
    const send = (channel: string, ...args: unknown[]) => {
      try {
        this.mainWindow?.webContents.send(channel, id, ...args)
      } catch {
        // Ignore renderer shutdown races.
      }
    }

    wc.setWindowOpenHandler((details) => {
      if (this.isAllowedUrlForInfo(info, details.url)) {
        void wc.loadURL(details.url)
      }
      return { action: 'deny' }
    })

    wc.on('will-navigate', (event, url) => {
      if (!this.isAllowedUrlForInfo(info, url)) {
        event.preventDefault()
      }
    })

    ;(wc as WebContentsWithFrameNavigation).on('will-frame-navigate', (
      event: ElectronEvent,
      details: { url?: string } | string
    ) => {
      const url = typeof details === 'string'
        ? details
        : typeof details.url === 'string'
          ? details.url
          : null
      if (url && !this.isAllowedUrlForInfo(info, url)) {
        event.preventDefault()
      }
    })

    wc.on('did-navigate', (_event, url) => {
      send(IPC.BROWSER_URL_CHANGED, url)
      this.sendNavState(id)
    })

    wc.on('did-navigate-in-page', (_event, url) => {
      send(IPC.BROWSER_URL_CHANGED, url)
      this.sendNavState(id)
    })

    wc.on('page-title-updated', (_event, title) => {
      send(IPC.BROWSER_TITLE_CHANGED, title)
    })

    wc.on('found-in-page', (_event, result) => {
      const selectionArea = result.selectionArea
      send(IPC.BROWSER_FOUND_IN_PAGE, {
        requestId: result.requestId,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        selectionArea: selectionArea
          ? {
              x: readNonNegativeNumber(selectionArea.x),
              y: readNonNegativeNumber(selectionArea.y),
              width: readNonNegativeNumber(selectionArea.width),
              height: readNonNegativeNumber(selectionArea.height)
            }
          : undefined,
        finalUpdate: result.finalUpdate
      })
    })

    wc.on('did-start-loading', () => {
      send(IPC.BROWSER_LOADING_CHANGED, true)
      this.sendNavState(id)
    })

    wc.on('did-stop-loading', () => {
      send(IPC.BROWSER_LOADING_CHANGED, false)
      this.sendNavState(id)
    })

    wc.on('enter-html-full-screen', () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return

      info.isFullscreen = true
      info.savedBounds = info.view.getBounds()
      const contentBounds = this.mainWindow.getContentBounds()
      info.view.setBounds({
        x: 0,
        y: 0,
        width: contentBounds.width,
        height: contentBounds.height
      })
      send(IPC.BROWSER_FULLSCREEN_CHANGED, true)
    })

    wc.on('leave-html-full-screen', () => {
      info.isFullscreen = false
      if (info.savedBounds) {
        info.view.setBounds(info.savedBounds)
        info.savedBounds = null
      }
      send(IPC.BROWSER_FULLSCREEN_CHANGED, false)
    })

    wc.on('before-input-event', (event, input) => {
      if (
        input.type === 'keyDown' &&
        input.key === 'Escape' &&
        !input.meta &&
        !input.control &&
        !input.alt
      ) {
        if (!info.isFullscreen) {
          send(IPC.BROWSER_ESCAPE_PRESSED)
          event.preventDefault()
        }
      }
    })

    wc.on('before-input-event', (event, input) => {
      const key = input.key.toLowerCase()
      const code = (input as { code?: string }).code?.toLowerCase() ?? ''
      const isZoomShortcut = input.type === 'keyDown' &&
        (input.meta || input.control) &&
        !input.alt &&
        (
          key === '+' ||
          key === '=' ||
          key === '-' ||
          key === '_' ||
          key === '0' ||
          code === 'numpadadd' ||
          code === 'numpadsubtract' ||
          code === 'numpad0'
        )
      if (isZoomShortcut) {
        event.preventDefault()
        const direction = key === '0' || code === 'numpad0'
          ? 'reset'
          : key === '-' || key === '_' || code === 'numpadsubtract'
            ? 'out'
            : 'in'
        const nextZoomFactor = stepHtmlPreviewZoomFactor(wc.getZoomFactor(), direction)
        wc.setZoomFactor(nextZoomFactor)
        this.emitZoomFactorChanged(id, nextZoomFactor, 'shortcut')
        return
      }

      if (
        input.type === 'keyDown' &&
        key === 'f' &&
        (input.meta || input.control) &&
        !input.alt
      ) {
        event.preventDefault()
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.focus()
          this.mainWindow.webContents.focus()
        }
        send(IPC.BROWSER_FIND_SHORTCUT_PRESSED)
      }
    })
  }

  private emitZoomFactorChanged(id: string, zoomFactor: number, source: 'renderer' | 'shortcut'): void {
    try {
      this.mainWindow?.webContents.send(IPC.BROWSER_ZOOM_FACTOR_CHANGED, id, zoomFactor, source)
    } catch {
      // Ignore renderer shutdown races.
    }
  }

  private async emitFindInPageFallback(
    id: string,
    info: BrowserViewInfo,
    query: string,
    requestId: number,
    options?: BrowserFindInPageOptions
  ): Promise<void> {
    const matches = await this.countTextMatches(info, query, options?.matchCase ?? false)
    if (!this.views.has(id) || info.view.webContents.isDestroyed()) return

    const sameQuery = info.findFallback.query === query
    let activeMatchOrdinal = sameQuery && options?.findNext
      ? info.findFallback.activeMatchOrdinal
      : 0
    if (matches > 0) {
      if (activeMatchOrdinal <= 0) {
        activeMatchOrdinal = 1
      } else if (options?.findNext) {
        activeMatchOrdinal += options.forward === false ? -1 : 1
        if (activeMatchOrdinal > matches) activeMatchOrdinal = 1
        if (activeMatchOrdinal < 1) activeMatchOrdinal = matches
      }
    } else {
      activeMatchOrdinal = 0
    }

    info.findFallback = {
      query,
      matches,
      activeMatchOrdinal
    }
    this.sendBrowserEvent(id, IPC.BROWSER_FOUND_IN_PAGE, {
      requestId,
      activeMatchOrdinal,
      matches,
      finalUpdate: true
    })
  }

  private async countTextMatches(info: BrowserViewInfo, query: string, matchCase: boolean): Promise<number> {
    if (!query || info.view.webContents.isDestroyed()) return 0
    try {
      const value = await info.view.webContents.executeJavaScript(`(() => {
        const needle = ${JSON.stringify(query)};
        const haystack = document.body && document.body.innerText ? document.body.innerText : '';
        const source = ${JSON.stringify(matchCase)} ? haystack : haystack.toLocaleLowerCase();
        const target = ${JSON.stringify(matchCase)} ? needle : needle.toLocaleLowerCase();
        if (!target) return 0;
        let count = 0;
        let index = 0;
        while (index <= source.length) {
          const next = source.indexOf(target, index);
          if (next < 0) break;
          count += 1;
          index = next + Math.max(1, target.length);
          if (count >= 10000) break;
        }
        return count;
      })()`, true)
      return Math.max(0, Math.floor(readNonNegativeNumber(value)))
    } catch {
      return 0
    }
  }

  private sendBrowserEvent(id: string, channel: string, ...args: unknown[]): void {
    try {
      this.mainWindow?.webContents.send(channel, id, ...args)
    } catch {
      // Ignore renderer shutdown and serialization races.
    }
  }

  private sendNavState(id: string): void {
    const navState = this.getNavState(id)
    if (!navState) return

    try {
      this.mainWindow?.webContents.send(IPC.BROWSER_NAV_STATE_CHANGED, id, {
        canGoBack: navState.canGoBack,
        canGoForward: navState.canGoForward
      })
    } catch {
      // Ignore renderer shutdown races.
    }
  }

  private normalizeUrl(input: string): string | null {
    const trimmed = input.trim()
    if (!trimmed) return null
    if (trimmed === 'about:blank') return trimmed

    if (/^https?:\/\//i.test(trimmed)) {
      try {
        return new URL(trimmed).toString()
      } catch {
        return null
      }
    }

    if (/^(localhost|[\d.]+)(:\d+)?(\/.*)?$/i.test(trimmed) || /^[^\s]+\.[^\s]+$/.test(trimmed)) {
      try {
        return new URL(`https://${trimmed}`).toString()
      } catch {
        return null
      }
    }

    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
  }

  private findInfoByWebContentsId(webContentsId: number | undefined): BrowserViewInfo | null {
    if (typeof webContentsId !== 'number') return null
    for (const info of this.views.values()) {
      if (!info.view.webContents.isDestroyed() && info.view.webContents.id === webContentsId) {
        return info
      }
    }
    return null
  }

  private isAllowedUrlForInfo(info: BrowserViewInfo | null, url: string): boolean {
    if (isAllowedNetworkUrl(url)) return true
    if (!info?.allowFile) return false
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true
      if (parsed.protocol !== 'file:' || !info.fileRoot) return false
      return isPathInsideRoot(fileURLToPath(parsed), info.fileRoot)
    } catch {
      return false
    }
  }
}

export const browserViewManager = new BrowserViewManager()
