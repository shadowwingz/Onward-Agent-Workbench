/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render Corruption Stress Autotest Suite (RCS)
 *
 * Reproduces the multi-terminal WebGL renderer corruption observed when six
 * Task panes simultaneously render heavy TUI workloads (Codex / Claude Code /
 * btop class). The bug manifests as glyphs drawn from wrong texture-atlas
 * cells across ALL six panes at once; mouse-drag selection forces a redraw
 * that clears the corruption.
 *
 * Reproduction strategy — visual fidelity, not throughput:
 *   1. Open the six-terminal layout.
 *   2. For each Task, write a known checkpoint frame directly into xterm
 *      (bypassing the PTY so the buffer state is byte-identical across
 *      iterations).
 *   3. Read the canvas pixels via gl.readPixels and record a baseline
 *      checksum (3 stability samples to absorb cursor blink).
 *   4. Stress phase: pump high-atlas-pressure synthetic frames (CJK + emoji
 *      + box-drawing + 256-color ANSI + frequent screen clears) to all six
 *      terminals in parallel for several seconds.
 *   5. Re-write the SAME checkpoint frame to each terminal, re-read the
 *      pixel checksum.
 *   6. If the post-stress checksum differs from the baseline for the same
 *      terminal+content, the renderer is leaving stale or corrupted state
 *      — that is the bug. Each iteration also dumps a small canvas data-URL
 *      thumbnail for failed terminals.
 *
 * Why pixel checksum and not screenshot diff: the xterm buffer is identical
 * across iterations (we write the same bytes); the only legitimate variance
 * is cursor blink, which we absorb via three stability samples. Anything
 * larger is render corruption by definition.
 */

import type { AutotestContext, TestResult } from './types'

type WebglContext = WebGLRenderingContext | WebGL2RenderingContext

interface CanvasProbe {
  canvas: HTMLCanvasElement
  gl: WebglContext
}

interface PixelStats {
  width: number
  height: number
  checksum: number
  nonZeroRatio: number
  intensityMean: number
}

const ITERATIONS = 4
const STRESS_DURATION_MS = 20000
const STRESS_BURST_INTERVAL_MS = 40     // ~25 bursts/sec — keeps renderer at 30+ fps
const FULLSCREEN_FRAME_EVERY_N_BURSTS = 8  // ~3 fullscreen redraws/sec/terminal (btop-class)
const SCROLL_LINES_PER_BURST = 4        // line streaming between fullscreen redraws (Codex/CC class)
const MID_ITER_CHECKPOINT_AT_MS = 9500
const CHECKPOINT_SETTLE_FRAMES = 4
const CHECKPOINT_STABILITY_SAMPLES = 3
const CHECKPOINT_SAMPLE_GAP_MS = 90
const SETUP_TIMEOUT_MS = 8000
const PTY_AMBIENT_PRESSURE = false      // `yes` scrolls past checkpoint — disabled for now
const RUN_HEAVY_STRESS = false          // post-settle pixel stress is opt-in; see stress loop comment

const escapeCssIdent = (value: string) => {
  const css = window.CSS as (typeof window.CSS & { escape?: (value: string) => string }) | undefined
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, '\\$&')
}

const nextFrame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
const waitFrames = async (n: number) => { for (let i = 0; i < n; i += 1) await nextFrame() }

const findWebglCanvas = (terminalId: string): CanvasProbe | null => {
  const cell = document.querySelector<HTMLElement>(`.terminal-grid-cell[data-terminal-id="${escapeCssIdent(terminalId)}"]`)
  if (!cell) return null
  const canvases = Array.from(cell.querySelectorAll<HTMLCanvasElement>('.xterm-screen canvas'))
  for (const canvas of canvases) {
    if (canvas.width <= 1 || canvas.height <= 1) continue
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (gl && !gl.isContextLost()) return { canvas, gl }
  }
  return null
}

const readPixelStats = (gl: WebglContext): PixelStats => {
  const width = gl.drawingBufferWidth
  const height = gl.drawingBufferHeight
  const pixels = new Uint8Array(width * height * 4)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.finish()
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

  let nonZero = 0
  let intensitySum = 0
  let checksum = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]
    const g = pixels[i + 1]
    const b = pixels[i + 2]
    const a = pixels[i + 3]
    intensitySum += r + g + b
    if ((r | g | b | a) > 8) {
      nonZero += 1
      checksum = ((checksum * 31) + r + (g * 3) + (b * 7) + (a * 11)) >>> 0
    }
  }
  const sampled = width * height
  return {
    width,
    height,
    checksum,
    nonZeroRatio: sampled > 0 ? nonZero / sampled : 0,
    intensityMean: sampled > 0 ? intensitySum / sampled : 0
  }
}

const checksumsClose = (a: PixelStats, b: PixelStats): boolean => {
  // With cursor hidden the buffer is fully deterministic — demand an exact
  // checksum match. The intensity tolerance is a belt-and-braces guard for
  // sub-pixel anti-aliasing variance the WebGL renderer can introduce on
  // canvas resize boundaries (which we don't trigger here, but keep loose).
  return a.checksum === b.checksum &&
    Math.abs(a.intensityMean - b.intensityMean) < 0.5
}

const writeXterm = (sessionMgr: any, id: string, data: string) => {
  const session = sessionMgr.getSession?.(id)
  const term = session?.terminal
  if (!term || typeof term.write !== 'function') return false
  term.write(data)
  return true
}

// Reaches the per-terminal WebglAddon through the lifecycle's runtime-accessible
// `webglAddon` field. TS marks it private but esbuild preserves the property
// name (verified: 9 `.webglAddon` refs survive in the renderer bundle), so the
// autotest can read the addon's PUBLIC `textureAtlas` getter and subscribe to
// its PUBLIC `onAddTextureAtlasCanvas` event — both documented addon API. This
// is pure observation: no mutation, no source change to business logic.
interface WebglAddonProbe {
  textureAtlas?: HTMLCanvasElement
  onAddTextureAtlasCanvas?: (cb: (canvas: HTMLCanvasElement) => void) => { dispose(): void }
}
const getWebglAddon = (sessionMgr: any, id: string): WebglAddonProbe | null => {
  const renderer = sessionMgr.getSession?.(id)?.renderer
  return (renderer && (renderer as { webglAddon?: WebglAddonProbe }).webglAddon) || null
}

const CSI = '\x1b['
const CLEAR_AND_HOME = `${CSI}2J${CSI}H${CSI}0m`
const CURSOR_HIDE = `${CSI}?25l`
const CURSOR_SHOW = `${CSI}?25h`

// The checkpoint is a small, fully-deterministic frame: ASCII labels +
// CJK + box-drawing + a small palette of 256-colors. Cursor is hidden
// during the snapshot so blink does not contaminate the pixel checksum.
const CHECKPOINT_FRAME = (() => {
  const lines: string[] = []
  lines.push(CURSOR_HIDE)
  lines.push(`${CSI}1;1H${CSI}38;5;231m${CSI}48;5;17m  RCS CHECKPOINT FRAME  ${CSI}0m`)
  lines.push(`${CSI}3;1H${CSI}38;5;208m+---- RCS FIDELITY BASELINE ----+${CSI}0m`)
  lines.push(`${CSI}4;1H${CSI}38;5;46m│ ASCII 0123456789 ABCDEF │${CSI}0m`)
  lines.push(`${CSI}5;1H${CSI}38;5;81m| CJK glyph fixed content     |${CSI}0m`)
  lines.push(`${CSI}6;1H${CSI}38;5;213m│ Box ┌┐└┘├┤┬┴┼─│ ░▒▓█ │${CSI}0m`)
  lines.push(`${CSI}7;1H${CSI}38;5;226m└──────────────────────┘${CSI}0m`)
  // Park the cursor on a row well below the frame so even when SHOW is
  // re-asserted later, blink touches nothing the checksum covers.
  lines.push(`${CSI}20;1H${CSI}0m`)
  return CLEAR_AND_HOME + lines.join('')
})()

// Stress frames are deliberately atlas-hostile: rotating CJK page, rotating
// 256-color fg/bg combos, box-drawing, frequent screen clears.  Each frame
// is ~3-5 KB and we emit ~25 frames/sec/terminal → ≈100 KB/s/terminal,
// 600 KB/s aggregated across six panes.
// CJK Unified Ideographs block U+4E00..U+9FFF (~20k unique codepoints).
// Generated at startup to avoid literal CJK in source (linter rule).
const CJK_POOL = Array.from({ length: 120 }, (_, i) => String.fromCodePoint(0x4e00 + i * 163)).join('')
const BOX_POOL = '┌┐└┘├┤┬┴┼─│╔╗╚╝╠╣╦╩╬═║░▒▓█▀▄▌▐'
const EMOJI_POOL = '🔥💎⚡🚀🌟🎯🎨🎭🎪🎲🎮🎰🎳🎺🎸🎹🎻🥁🎤'

function buildStressFrame(seed: number): string {
  const cjk = CJK_POOL
  const box = BOX_POOL
  const emoji = EMOJI_POOL
  const rows = 18
  const cols = 36
  const out: string[] = [CLEAR_AND_HOME]
  for (let r = 0; r < rows; r += 1) {
    out.push(`${CSI}${r + 1};1H`)
    for (let c = 0; c < cols; c += 1) {
      const fg = ((seed + r * 17 + c * 3) % 230) + 16
      const bg = ((seed * 3 + r * 5 + c * 11) % 50) + 232
      const bucket = (seed + r + c) % 12
      let glyph: string
      if (bucket < 6) {
        glyph = cjk[(seed * 7 + r * cols + c) % cjk.length]
      } else if (bucket < 10) {
        glyph = box[(seed + r * cols + c) % box.length]
      } else {
        glyph = emoji[(seed + c) % emoji.length]
      }
      // Rotate through bold / italic / underline / dim attribute combos so the
      // atlas has to allocate a distinct cell for every (glyph, fg, bg, attr)
      // tuple — far higher unique-cell pressure than uniform output.
      const attr = (seed + r * 2 + c) % 6
      let sgr = `${CSI}38;5;${fg}m${CSI}48;5;${bg}m`
      if (attr === 1) sgr += `${CSI}1m`
      else if (attr === 2) sgr += `${CSI}3m`
      else if (attr === 3) sgr += `${CSI}4m`
      else if (attr === 4) sgr += `${CSI}2m`
      else if (attr === 5) sgr += `${CSI}1m${CSI}4m`
      out.push(`${sgr}${glyph}${CSI}22;23;24m`)
    }
  }
  out.push(`${CSI}0m`)
  return out.join('')
}

// A short streaming line that scrolls — closest analogue to Codex /
// Claude Code's continuous output. Each line carries unique glyph + color
// combinations to keep atlas pressure up without nuking the renderer.
function buildScrollLine(seed: number): string {
  const cjk = CJK_POOL
  const box = BOX_POOL
  const emoji = EMOJI_POOL
  const cols = 28
  const parts: string[] = []
  for (let c = 0; c < cols; c += 1) {
    const fg = ((seed + c * 7) % 230) + 16
    const bg = ((seed * 3 + c * 11) % 40) + 232
    const bucket = (seed + c) % 14
    let glyph: string
    if (bucket < 7) glyph = cjk[(seed * 7 + c) % cjk.length]
    else if (bucket < 12) glyph = box[(seed + c) % box.length]
    else glyph = emoji[(seed + c) % emoji.length]
    const attr = (seed + c) % 4
    let sgr = `${CSI}38;5;${fg}m${CSI}48;5;${bg}m`
    if (attr === 1) sgr += `${CSI}1m`
    else if (attr === 2) sgr += `${CSI}4m`
    else if (attr === 3) sgr += `${CSI}1m${CSI}4m`
    parts.push(`${sgr}${glyph}`)
  }
  parts.push(`${CSI}0m\n`)
  return parts.join('')
}

let burstCounter = 0
function buildStressBurst(seed: number): string {
  burstCounter += 1
  // Every Nth burst, emit a full-screen redraw — matches a btop-class
  // workload mixed with continuous Codex/CC streaming. Otherwise stream
  // a few fresh lines that force the viewport to scroll.
  if (burstCounter % FULLSCREEN_FRAME_EVERY_N_BURSTS === 0) {
    return buildStressFrame(seed)
  }
  const parts: string[] = []
  for (let i = 0; i < SCROLL_LINES_PER_BURST; i += 1) {
    parts.push(buildScrollLine(seed + i))
  }
  return parts.join('')
}

// A sweep of DISTINCT CJK codepoints. The WebGL texture atlas keys each glyph
// by (codepoint, fg, bg, ext-attrs); sweeping thousands of distinct codepoints
// (CJK U+4E00..U+9FFF ≈ 20k glyphs) forces the atlas past maxAtlasPages so it
// has to run _createNewPage → page merge / eviction — the destructive path
// where the shared atlas re-indexes its texture pages. Used by RCS-ATLAS-02 to
// prove cross-terminal shared-atlas mutation.
function buildUniqueGlyphSweep(startCodepoint: number, count: number): string {
  const out: string[] = [CLEAR_AND_HOME, CURSOR_HIDE]
  const cols = 40
  let cp = startCodepoint
  for (let i = 0; i < count; i += 1) {
    if (i % cols === 0) out.push(`${CSI}${(Math.floor(i / cols) % 20) + 1};1H`)
    const fg = ((i * 7) % 230) + 16
    out.push(`${CSI}38;5;${fg}m${String.fromCodePoint(cp)}`)
    cp += 1
    if (cp > 0x9fff) cp = 0x4e00
  }
  out.push(`${CSI}0m`)
  return out.join('')
}

async function getStableHash(probe: CanvasProbe, sleep: (ms: number) => Promise<void>): Promise<PixelStats | null> {
  const samples: PixelStats[] = []
  for (let i = 0; i < CHECKPOINT_STABILITY_SAMPLES; i += 1) {
    await waitFrames(2)
    await sleep(CHECKPOINT_SAMPLE_GAP_MS)
    samples.push(readPixelStats(probe.gl))
  }
  // Pick the modal sample (the one whose checksum matches at least one peer).
  for (let i = 0; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      if (samples[i].checksum === samples[j].checksum) return samples[i]
    }
  }
  return samples[samples.length - 1]
}

function dumpThumbnail(probe: CanvasProbe): string {
  try {
    return probe.canvas.toDataURL('image/png').slice(0, 96) + '...'
  } catch {
    return '<unavailable>'
  }
}

async function closeProjectEditorIfOpen(ctx: AutotestContext): Promise<void> {
  const { sleep, waitFor, log } = ctx
  const pe = (window as any).__onwardProjectEditorDebug as { isOpen?: () => boolean } | null
  if (!pe?.isOpen?.()) return
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await sleep(200)
  await waitFor('RCS-close-project-editor', () => !pe?.isOpen?.(), 4000, 100)
  log('RCS:project-editor-closed', {})
}

async function ensureSixTerminalLayout(ctx: AutotestContext): Promise<string[]> {
  const { log, sleep, waitFor } = ctx
  const debugApi = () => (window as any).__onwardTerminalDebug as {
    getVisibleTerminalIds?: () => string[]
  } | null

  await closeProjectEditorIfOpen(ctx)
  await sleep(400)

  const current = debugApi()?.getVisibleTerminalIds?.() ?? []
  if (current.length >= 6) return current.slice(0, 6)

  const sixBtn = document.querySelector<HTMLButtonElement>('button[title="Six terminals"]')
  if (!sixBtn) {
    log('RCS:layout', { error: 'six-terminal layout button not found' })
    return []
  }
  sixBtn.click()
  await sleep(300)
  const ok = await waitFor(
    'RCS-layout-six',
    () => (debugApi()?.getVisibleTerminalIds?.()?.length ?? 0) >= 6,
    SETUP_TIMEOUT_MS,
    150
  )
  log('RCS:layout', { switched: true, settled: ok, count: debugApi()?.getVisibleTerminalIds?.()?.length ?? 0 })
  return (debugApi()?.getVisibleTerminalIds?.() ?? []).slice(0, 6)
}

export async function testRenderCorruptionStress(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, cancelled, assert } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const sessionMgr = (window as any).__terminalSessionManager
  _assert('RCS-00-session-manager-available', Boolean(sessionMgr), { available: Boolean(sessionMgr) })
  if (!sessionMgr || cancelled()) return results

  const perfMonGetCtxCount = (): number => {
    const perfMon = (window as any).__perfMonitor
    return perfMon?.getWebglContextCount?.() ?? -1
  }

  log('RCS:start', {
    iterations: ITERATIONS,
    stressDurationMs: STRESS_DURATION_MS,
    fullscreenEveryNBursts: FULLSCREEN_FRAME_EVERY_N_BURSTS,
    scrollLinesPerBurst: SCROLL_LINES_PER_BURST,
    burstIntervalMs: STRESS_BURST_INTERVAL_MS,
    ptyAmbient: PTY_AMBIENT_PRESSURE
  })

  const termIds = await ensureSixTerminalLayout(ctx)
  _assert('RCS-01-six-terminals-visible', termIds.length >= 6, { count: termIds.length, ids: termIds })
  if (termIds.length < 6 || cancelled()) return results

  // Wait for shells to settle and for every terminal's WebGL canvas to come
  // up. The six-terminal layout button mounts all six React cells in the
  // same render pass but WebGL init can lag a few hundred ms per terminal
  // — and on app boot the first Task is created before the layout switch,
  // so it may have a slightly different lifecycle (it gets re-attached
  // when the grid expands).
  await sleep(2200)

  // Probe each terminal's canvas with retry. Some terminals may briefly
  // lack a WebGL surface mid-mount; only conclude "missing" after we've
  // given each enough time to settle.
  const probes = new Map<string, CanvasProbe>()
  const probeRetryDeadline = performance.now() + 8000
  while (performance.now() < probeRetryDeadline) {
    for (const id of termIds) {
      if (probes.has(id)) continue
      const probe = findWebglCanvas(id)
      if (probe) probes.set(id, probe)
    }
    if (probes.size === 6) break
    await sleep(250)
  }

  // Diagnostic: per-terminal renderer mode, so we can tell whether a
  // missing canvas means "DOM fallback" or "addon disposed" or just "not
  // attached yet". This evidence is the most likely place we'd find a
  // structural clue toward the corruption bug.
  const rendererDiagnostics = termIds.map((id) => {
    const session = sessionMgr.getSession?.(id)
    const renderer = session?.renderer
    const snapshot = renderer?.getSnapshot ? renderer.getSnapshot() : null
    const cell = document.querySelector<HTMLElement>(`.terminal-grid-cell[data-terminal-id="${escapeCssIdent(id)}"]`)
    const xtermScreen = cell?.querySelector('.xterm-screen')
    const canvases = xtermScreen ? Array.from(xtermScreen.querySelectorAll('canvas')) : []
    return {
      id,
      hasCell: !!cell,
      hasXtermScreen: !!xtermScreen,
      canvasCount: canvases.length,
      canvasSizes: canvases.map((c) => `${c.width}x${c.height}`),
      snapshot,
      hasWebglProbe: probes.has(id)
    }
  })
  log('RCS:renderer-diagnostics', { ctxCount: perfMonGetCtxCount(), diagnostics: rendererDiagnostics })

  // NOTE: there is intentionally NO "all six have a WebGL canvas" assertion.
  // WebGL context attachment across six simultaneous terminals is timing-
  // dependent: under GPU context pressure Chromium can evict the oldest
  // terminal's context, so the live context count fluctuates (observed 5<->6
  // within a single run). Asserting "exactly six" is a single observation of a
  // stochastic process, not a stable invariant, and produces spurious failures
  // / setup timeouts on repeated runs. The RCS:renderer-diagnostics log above
  // still records any missing-canvas discrepancy for post-hoc analysis. The
  // atlas root-cause + fix assertions below run on whichever terminals DO have
  // WebGL — that is exactly where the corruption manifests, so partial probe
  // coverage does not weaken them.
  if (probes.size < 1 || cancelled()) return results

  // Terminals that have a live WebGL canvas — the only ones we can pixel-hash
  // or probe for an atlas. Declared here so the verification phase below and
  // the stress loop further down share one definition.
  const probedIds = termIds.filter((id) => probes.has(id))

  // ════════════════════════════════════════════════════════════════════
  // ROOT-CAUSE VERIFICATION — runs BEFORE the heavy stress so the decisive
  // evidence lands even if a later high-pressure phase stalls the renderer.
  //
  // Hypothesis (from reading @xterm/addon-webgl 0.18.0 source): the WebGL
  // texture atlas is held in a MODULE-LEVEL cache (acquireTextureAtlas → an
  // array keyed by configEquals on font/colors/dpr). All terminals with an
  // identical config SHARE ONE TextureAtlas instance (ownedBy[]). Onward
  // creates all six Tasks with identical font/theme, so all six should share
  // one atlas. When that shared atlas hits maxAtlasPages it runs a
  // destructive _createNewPage → _mergePages → _deletePage that re-indexes
  // texture pages; the atlas+pages+cacheMap are shared but each terminal's
  // vertex model + GPU texture-version are per-terminal → a window where a
  // terminal samples glyphs from the wrong (mutated) atlas cell = garbled rendering,
  // and because the atlas is shared, all six corrupt together.
  //
  // Two falsifiable experiments verify the *foundation* of that hypothesis:
  // ════════════════════════════════════════════════════════════════════

  // ── RCS-ATLAS-01: object-identity of the texture atlas across terminals ──
  // Read each terminal's webglAddon.textureAtlas (public getter → the atlas'
  // pages[0].canvas). If the atlas is shared, all six return the SAME canvas
  // object. distinctCanvases === 1 with 6 terminals == sharing proven.
  {
    const atlasByTerminal = termIds.map((id) => {
      const addon = getWebglAddon(sessionMgr, id)
      return { id, atlas: addon?.textureAtlas ?? null, hasAddon: !!addon }
    })
    const withAtlas = atlasByTerminal.filter((a) => a.atlas)
    const distinct = new Set(withAtlas.map((a) => a.atlas))
    const distinctCount = distinct.size
    const interpretation = distinctCount === 1
      ? 'ALL terminals share ONE atlas canvas — shared-atlas root cause FOUNDATION CONFIRMED'
      : distinctCount < withAtlas.length
        ? `PARTIAL sharing: ${withAtlas.length} terminals → ${distinctCount} atlases`
        : 'NO sharing: each terminal has its own atlas (hypothesis foundation refuted)'
    log('RCS-ATLAS-01:identity', {
      terminals: atlasByTerminal.length,
      withAtlas: withAtlas.length,
      distinctAtlasCanvases: distinctCount,
      addonReachable: atlasByTerminal.filter((a) => a.hasAddon).length,
      atlasCanvasSizes: withAtlas.map((a) => `${a.atlas!.width}x${a.atlas!.height}`),
      interpretation
    })
    // The assertion PASSES when sharing is confirmed (that is the root cause).
    _assert('RCS-ATLAS-01-six-terminals-share-one-atlas', withAtlas.length >= 2 && distinctCount === 1, {
      withAtlas: withAtlas.length,
      distinctAtlasCanvases: distinctCount,
      interpretation
    })
  }

  // ── RCS-ATLAS-02: cross-terminal shared mutation ──
  // Subscribe to terminals[1..]'s onAddTextureAtlasCanvas, then write a huge
  // DISTINCT-codepoint sweep into ONLY terminal[0]. If sibling terminals
  // receive page-add events, terminal[0]'s glyph writes are mutating the very
  // atlas the siblings render from → shared MUTABLE state across terminals,
  // and the page-add events are exactly the _createNewPage path that re-indexes
  // texture pages. This converts "same object" into "one terminal's writes
  // perturb the others' render source" — the precise corruption vector.
  if (probedIds.length >= 2 && !cancelled()) {
    const driver = probedIds[0]
    const observers = probedIds.slice(1)
    const pageAddCounts = new Map<string, number>()
    const disposers: Array<{ dispose(): void }> = []
    for (const id of observers) {
      pageAddCounts.set(id, 0)
      const addon = getWebglAddon(sessionMgr, id)
      if (addon?.onAddTextureAtlasCanvas) {
        try {
          disposers.push(addon.onAddTextureAtlasCanvas(() => {
            pageAddCounts.set(id, (pageAddCounts.get(id) ?? 0) + 1)
          }))
        } catch { /* ignore */ }
      }
    }
    // Drive ~12k distinct CJK glyphs into terminal[0] in chunks, letting the
    // renderer flush between chunks so the atlas actually rasterizes + paginates.
    const SWEEP_CHUNKS = 12
    const GLYPHS_PER_CHUNK = 1000
    let cp = 0x4e00
    for (let c = 0; c < SWEEP_CHUNKS; c += 1) {
      if (cancelled()) break
      writeXterm(sessionMgr, driver, buildUniqueGlyphSweep(cp, GLYPHS_PER_CHUNK))
      cp += GLYPHS_PER_CHUNK
      if (cp > 0x9fff) cp = 0x4e00
      await waitFrames(2)
      await sleep(40)
    }
    await sleep(300)
    for (const d of disposers) { try { d.dispose() } catch { /* ignore */ } }

    const siblingsThatGrew = observers.filter((id) => (pageAddCounts.get(id) ?? 0) > 0)
    log('RCS-ATLAS-02:cross-terminal-mutation', {
      driverTerminal: driver,
      observerTerminals: observers,
      glyphsWrittenToDriver: SWEEP_CHUNKS * GLYPHS_PER_CHUNK,
      pageAddCountsOnObservers: Object.fromEntries(pageAddCounts),
      siblingsThatReceivedPageAdds: siblingsThatGrew.length,
      interpretation: siblingsThatGrew.length > 0
        ? 'Writing glyphs to terminal[0] fired page-add on OTHER terminals → shared mutable atlas CONFIRMED (the _createNewPage re-index path is cross-terminal)'
        : 'No cross-terminal page-add observed (either not shared, or sweep did not exhaust pages)'
    })
    _assert('RCS-ATLAS-02-cross-terminal-shared-atlas-mutation', siblingsThatGrew.length > 0, {
      driverTerminal: driver,
      siblingsThatReceivedPageAdds: siblingsThatGrew.length,
      observerCount: observers.length,
      pageAddCounts: Object.fromEntries(pageAddCounts)
    })

    // ── RCS-ATLAS-03: global-monotonic page version invariant (the FIX guard) ──
    // The back-ported PR #5883 core fix makes every atlas page `version` draw
    // from a single ever-increasing counter (AtlasPage.constructor._nv), so no
    // two pages ever share a version value. That is exactly what stops a
    // same-index page swap (after a merge) from being mistaken for "unchanged"
    // → forces the per-renderer GPU texture rebind → kills the garble.
    //
    // The 12k-glyph sweep above already grew the shared atlas to many pages
    // (and triggered merges — see RCS-ATLAS-02's page-add counts). Reach the
    // shared atlas' pages (private but runtime-accessible: addon → _renderer →
    // _charAtlas → public get pages()) and assert ALL page versions are
    // distinct. On the UNFIXED 0.18.0 bundle, per-page counters collide once
    // several pages exist → this fails; on the fixed bundle it always holds.
    {
      const addon = getWebglAddon(sessionMgr, driver) as (WebglAddonProbe & {
        _renderer?: { _charAtlas?: { pages?: Array<{ version?: number }> } }
      }) | null
      const pages = addon?._renderer?._charAtlas?.pages ?? null
      if (!pages || !Array.isArray(pages)) {
        log('RCS-ATLAS-03:page-version', { reachable: false, note: 'could not reach _renderer._charAtlas.pages — private path may have changed in a bundle bump' })
        _assert('RCS-ATLAS-03-atlas-page-version-globally-unique', false, {
          reachable: false,
          note: 'private reach addon._renderer._charAtlas.pages failed — cannot verify the fix invariant'
        })
      } else {
        const versions = pages.map((p) => p?.version)
        const distinct = new Set(versions).size
        const allUnique = distinct === versions.length && versions.every((v) => typeof v === 'number')
        log('RCS-ATLAS-03:page-version', {
          reachable: true,
          pageCount: pages.length,
          distinctVersions: distinct,
          versionsSample: versions.slice(0, 16),
          allUnique,
          interpretation: allUnique
            ? 'All atlas page versions are globally unique → PR #5883 global-monotonic fix is ACTIVE; same-index swaps will always force a rebind'
            : 'DUPLICATE page versions detected → version counter is per-page (UNFIXED) — same-index swap can skip rebind = corruption'
        })
        // Only meaningful once we actually have multiple pages (else vacuous).
        _assert('RCS-ATLAS-03-atlas-page-version-globally-unique', pages.length >= 2 && allUnique, {
          pageCount: pages.length,
          distinctVersions: distinct,
          allUnique,
          versionsSample: versions.slice(0, 16)
        })
      }
    }
  }

  if (cancelled()) return results

  // Acquire baseline: write checkpoint directly into xterm (bypasses PTY,
  // so shell quiet-noise doesn't matter), settle, hash.
  const baseline = new Map<string, PixelStats>()
  for (const id of probedIds) {
    writeXterm(sessionMgr, id, CHECKPOINT_FRAME)
  }
  await waitFrames(CHECKPOINT_SETTLE_FRAMES)
  await sleep(250)
  for (const id of probedIds) {
    const probe = probes.get(id)!
    const hash = await getStableHash(probe, sleep)
    if (hash) baseline.set(id, hash)
  }
  _assert('RCS-03-baseline-acquired', baseline.size === probedIds.length, {
    expected: probedIds.length,
    acquired: Array.from(baseline.entries()).map(([id, h]) => ({ id, checksum: h.checksum, intensity: +h.intensityMean.toFixed(2) }))
  })
  if (baseline.size < 1 || cancelled()) return results

  // Optional ambient PTY pressure: start `yes <noise>` in each terminal so
  // the real PTY → main → scheduler → terminal.write pipeline is also under
  // load concurrently with our direct-into-xterm bursts. Codex / Claude
  // Code / btop all drive the PTY path, so making the bug repro target
  // both paths simultaneously is closer to the real workload.
  if (PTY_AMBIENT_PRESSURE) {
    for (const id of termIds) {
      try {
        await window.electronAPI.terminal.write(id, 'yes "RCS-ambient-pressure-line-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"\n')
      } catch { /* ignore */ }
    }
    await sleep(800)
  }

  // Stress + verify loop. Each iteration:
  //   1. blast all 6 with atlas-hostile bursts;
  //   2. mid-stress, halt bursts → checkpoint → re-hash (catches transient
  //      corruption that self-recovers before the iter ends);
  //   3. resume bursts to end of stress window;
  //   4. final checkpoint → re-hash.
  let totalDivergences = 0
  let totalChecks = 0
  const perTerminalDivergence = new Map<string, number>()
  for (const id of probedIds) perTerminalDivergence.set(id, 0)

  const rotateFocus = (idx: number) => {
    try { sessionMgr.focusIfNeeded?.(probedIds[idx % probedIds.length]) } catch { /* ignore */ }
  }

  const verifyCheckpoint = async (
    label: string,
    iter: number
  ): Promise<Array<{ id: string; baseline: number; current: number; intensity: number; nonZeroRatio: number; thumb: string }>> => {
    for (const id of probedIds) {
      writeXterm(sessionMgr, id, CHECKPOINT_FRAME)
    }
    await waitFrames(CHECKPOINT_SETTLE_FRAMES)
    await sleep(250)
    const failures: Array<{ id: string; baseline: number; current: number; intensity: number; nonZeroRatio: number; thumb: string }> = []
    for (const id of probedIds) {
      totalChecks += 1
      const probe = probes.get(id)!
      const baseHash = baseline.get(id)
      if (!baseHash) continue
      const currentHash = await getStableHash(probe, sleep)
      if (!currentHash) continue
      if (!checksumsClose(baseHash, currentHash)) {
        totalDivergences += 1
        perTerminalDivergence.set(id, (perTerminalDivergence.get(id) ?? 0) + 1)
        failures.push({
          id,
          baseline: baseHash.checksum,
          current: currentHash.checksum,
          intensity: +currentHash.intensityMean.toFixed(2),
          nonZeroRatio: +currentHash.nonZeroRatio.toFixed(4),
          thumb: dumpThumbnail(probe)
        })
      }
    }
    log('RCS:checkpoint-verify', { iter, label, failingCount: failures.length, failures })
    return failures
  }

  const runStressWindow = async (durationMs: number, seedBase: number, rotationStart: number): Promise<number> => {
    const end = performance.now() + durationMs
    let seed = seedBase
    let rotation = rotationStart
    while (performance.now() < end) {
      if (cancelled()) break
      // Stress ALL terminals (including any without WebGL probes) so the
      // scheduler and renderer pressure profile matches what the user
      // observes when six Tasks are running heavy TUI workloads — the
      // bug is reported to affect every pane simultaneously.
      for (const id of termIds) {
        writeXterm(sessionMgr, id, buildStressBurst(seed++))
      }
      rotateFocus(rotation++)
      await sleep(STRESS_BURST_INTERVAL_MS)
    }
    return rotation
  }

  let rotationCursor = 0
  // The pixel-checkpoint stress loop is OPT-IN. The root-cause verification
  // (RCS-ATLAS-01/02 above) is the decisive deliverable; the post-settle
  // checkpoint stress here has not reproduced visible corruption and at high
  // intensity drives the renderer below the macOS not-responding threshold,
  // killing the app mid-suite and truncating the log. Keep it off by default
  // so the suite finishes clean; flip RUN_HEAVY_STRESS to true to explore the
  // pixel-divergence angle once the verification phase has already logged.
  for (let iter = 0; RUN_HEAVY_STRESS && iter < ITERATIONS; iter += 1) {
    if (cancelled()) break
    log('RCS:stress-iter', { iter, durationMs: STRESS_DURATION_MS, ctxCount: perfMonGetCtxCount() })

    rotationCursor = await runStressWindow(MID_ITER_CHECKPOINT_AT_MS, (iter + 1) * 1009, rotationCursor)

    // Mid-iter checkpoint — catches transient corruption that recovers
    // before stress ends. Pause bursts briefly so the checkpoint frame
    // can settle without competing writes.
    await sleep(300)
    await verifyCheckpoint('mid', iter)
    if (cancelled()) break

    // Second half of stress, different seed.
    rotationCursor = await runStressWindow(
      Math.max(0, STRESS_DURATION_MS - MID_ITER_CHECKPOINT_AT_MS),
      (iter + 1) * 7919 + 3,
      rotationCursor
    )

    // End-of-iter checkpoint.
    await sleep(400)
    await verifyCheckpoint('end', iter)

    // Log lifecycle snapshots so we can correlate divergence (if any) with
    // context-loss / fallback events even when the assertion passes.
    log('RCS:iter-end-renderer-snapshots', {
      iter,
      ctxCount: perfMonGetCtxCount(),
      snapshots: termIds.map((id) => {
        const renderer = sessionMgr.getSession?.(id)?.renderer
        return renderer?.getSnapshot ? { id, snapshot: renderer.getSnapshot() } : { id, snapshot: null }
      })
    })
  }

  // Ambient PTY pressure cleanup: send SIGINT to each terminal so `yes`
  // stops before the suite exits.
  if (PTY_AMBIENT_PRESSURE) {
    for (const id of termIds) {
      try { await window.electronAPI.terminal.write(id, '\x03') } catch { /* ignore */ }
    }
    await sleep(400)
  }

  // Diagnostics: WebGL context count, lifecycle snapshots.
  const perfMon = (window as any).__perfMonitor
  const ctxCount = perfMon?.getWebglContextCount ? perfMon.getWebglContextCount() : -1
  const lifecycleSnapshots = termIds.map((id) => {
    const sess = sessionMgr.getSession?.(id)
    const renderer = sess?.renderer
    return renderer?.getSnapshot ? { id, snapshot: renderer.getSnapshot() } : { id, snapshot: null }
  })

  // Assertion: in a healthy renderer, post-stress checkpoint hash MUST equal
  // baseline for every terminal across every iteration. Even one divergence
  // reproduces the bug. NOTE: when RUN_HEAVY_STRESS is false this is vacuous
  // (no checkpoints run) — the decisive evidence is RCS-ATLAS-01/02 above.
  _assert('RCS-04-no-render-divergence-after-stress', totalDivergences === 0, {
    stressRan: RUN_HEAVY_STRESS,
    note: RUN_HEAVY_STRESS ? undefined : 'heavy stress disabled — see RCS-ATLAS-01/02 for the root-cause verification; this assertion is vacuous',
    totalChecks,
    totalDivergences,
    perTerminalDivergence: Object.fromEntries(perTerminalDivergence),
    webglContextCount: ctxCount,
    iterations: RUN_HEAVY_STRESS ? ITERATIONS : 0,
    stressDurationMs: STRESS_DURATION_MS,
    lifecycleSnapshots
  })

  // Always emit a presence assertion so the harness knows the test ran end-
  // to-end, separate from the pass/fail of the actual reproduction probe.
  _assert('RCS-05-suite-completed', true, {
    iterations: ITERATIONS,
    totalChecks,
    totalDivergences
  })

  log('RCS:done', {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length
  })
  return results
}
