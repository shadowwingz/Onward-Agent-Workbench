#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PROMPT_THRESHOLDS = {
  output2P95Ms: 80,
  output5P95Ms: 120,
  output5GitP95Ms: 120,
  output5SearchP95Ms: 120,
  maxMs: 250,
  output5DeltaVsIdleMs: 35,
  p95RegressionToleranceMs: 10
}

const PROMPT_LONGTAIL_THRESHOLDS = {
  p99Ms: 160,
  p999Ms: 300,
  maxMs: 600,
  stddevMs: 60,
  over250Ms: 3,
  over500Ms: 0,
  mainEventLoopMaxDriftMs: 1000,
  mainEventLoopOver1000Ms: 0,
  mainEventLoopOver3000Ms: 0,
  mainEventLoopOver6000Ms: 0,
  p99RegressionToleranceMs: 25,
  maxRegressionToleranceMs: 100,
  stddevRegressionToleranceMs: 15
}

const TERMINAL_THRESHOLDS = {
  criticalP50Ms: 50,
  minAvgFps: 28,
  hiddenGitMaxIpcMsgPerSec: 10,
  hiddenRendererBufferedMB: 1,
  p95RegressionToleranceMs: 15,
  fpsRegressionTolerance: 3
}

const TERMINAL_OPTIMIZATION_TARGETS = [
  {
    scenarioId: 'hidden-output-5-git-diff',
    metric: 'perf.avgIpcMsgPerSec',
    label: 'hidden output + git diff IPC/s',
    minImprovementPct: 80
  }
]

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      continue
    }

    const key = arg.slice(2)
    if (key === 'report-only' || key === 'json' || key === 'help' || key === 'h') {
      args[key] = true
      continue
    }

    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    args[key] = value
    index += 1
  }
  return args
}

function usage(exitCode) {
  const stream = exitCode === 0 ? process.stdout : process.stderr
  stream.write(`Usage:
  node test/compare-performance-baseline.mjs --before <baseline.json> --after <candidate.json> [--suite <suite>] [--profile optimization|regression] [--report-only] [--json]

Profiles:
  optimization  Validate that a candidate still preserves the expected improvement over a pre-optimization baseline.
  regression    Validate that a candidate does not regress meaningfully against an optimized reference baseline.
`)
  process.exit(exitCode)
}

function readJson(filePath) {
  const text = readFileSync(resolve(filePath), 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

function scenarioMap(report) {
  return new Map((report.scenarios ?? []).map(scenario => [scenario.id, scenario]))
}

function getPath(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object)
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return 'n/a'
  return Number(value).toFixed(1).replace(/\.0$/, '')
}

function improvementPct(before, after, lowerIsBetter = true) {
  if (!Number.isFinite(before) || before === 0 || !Number.isFinite(after)) {
    return null
  }
  const change = lowerIsBetter
    ? ((before - after) / before) * 100
    : ((after - before) / before) * 100
  return Number(change.toFixed(1))
}

function passGate(gates, label, ok, actual, expected) {
  gates.push({
    label,
    ok: Boolean(ok),
    actual: numberOrNull(actual) ?? actual,
    expected
  })
}

function addComparison(rows, beforeScenarios, afterScenarios, scenarioId, metric, options = {}) {
  const before = getPath(beforeScenarios.get(scenarioId), metric)
  const after = getPath(afterScenarios.get(scenarioId), metric)
  const lowerIsBetter = options.lowerIsBetter ?? true
  rows.push({
    scenarioId,
    metric,
    label: options.label ?? `${scenarioId} ${metric}`,
    before: numberOrNull(before),
    after: numberOrNull(after),
    improvementPct: improvementPct(before, after, lowerIsBetter),
    lowerIsBetter
  })
}

function comparePrompt(beforeReport, afterReport, profile) {
  const beforeScenarios = scenarioMap(beforeReport)
  const afterScenarios = scenarioMap(afterReport)
  const rows = []
  const gates = []
  for (const scenarioId of [
    'idle-prompt-input',
    'visible-output-2-prompt-input',
    'visible-output-5-prompt-input',
    'visible-output-5-git-diff-prompt-input',
    'visible-output-5-search-prompt-input'
  ]) {
    addComparison(rows, beforeScenarios, afterScenarios, scenarioId, 'promptInput.inputLatency.p95Ms')
    addComparison(rows, beforeScenarios, afterScenarios, scenarioId, 'promptInput.inputLatency.maxMs')
    addComparison(rows, beforeScenarios, afterScenarios, scenarioId, 'promptInput.eventLoopDelay.p95Ms')
    addComparison(rows, beforeScenarios, afterScenarios, scenarioId, 'perf.avgIpcMsgPerSec')
  }

  const output2 = afterScenarios.get('visible-output-2-prompt-input')
  const output5 = afterScenarios.get('visible-output-5-prompt-input')
  const output5Git = afterScenarios.get('visible-output-5-git-diff-prompt-input')
  const output5Search = afterScenarios.get('visible-output-5-search-prompt-input')
  const allAfter = [...afterScenarios.values()]
  passGate(
    gates,
    'prompt output2 p95 acceptance',
    getPath(output2, 'promptInput.inputLatency.p95Ms') <= PROMPT_THRESHOLDS.output2P95Ms,
    getPath(output2, 'promptInput.inputLatency.p95Ms'),
    `<= ${PROMPT_THRESHOLDS.output2P95Ms}ms`
  )
  passGate(
    gates,
    'prompt output5 p95 acceptance',
    getPath(output5, 'promptInput.inputLatency.p95Ms') <= PROMPT_THRESHOLDS.output5P95Ms,
    getPath(output5, 'promptInput.inputLatency.p95Ms'),
    `<= ${PROMPT_THRESHOLDS.output5P95Ms}ms`
  )
  if (output5Git) {
    passGate(
      gates,
      'prompt output5 + git diff p95 acceptance',
      getPath(output5Git, 'promptInput.inputLatency.p95Ms') <= PROMPT_THRESHOLDS.output5GitP95Ms,
      getPath(output5Git, 'promptInput.inputLatency.p95Ms'),
      `<= ${PROMPT_THRESHOLDS.output5GitP95Ms}ms`
    )
  }
  if (output5Search) {
    passGate(
      gates,
      'prompt output5 + search p95 acceptance',
      getPath(output5Search, 'promptInput.inputLatency.p95Ms') <= PROMPT_THRESHOLDS.output5SearchP95Ms,
      getPath(output5Search, 'promptInput.inputLatency.p95Ms'),
      `<= ${PROMPT_THRESHOLDS.output5SearchP95Ms}ms`
    )
  }
  const maxPromptLatency = Math.max(...allAfter.map(scenario => getPath(scenario, 'promptInput.inputLatency.maxMs') ?? Number.POSITIVE_INFINITY))
  passGate(gates, 'prompt max latency acceptance', maxPromptLatency <= PROMPT_THRESHOLDS.maxMs, maxPromptLatency, `<= ${PROMPT_THRESHOLDS.maxMs}ms`)
  const mismatches = allAfter.reduce((sum, scenario) => sum + (getPath(scenario, 'promptInput.mismatches') ?? 0), 0)
  passGate(gates, 'prompt input mismatch acceptance', mismatches === 0, mismatches, '= 0')
  passGate(
    gates,
    'prompt output5 delta vs idle',
    (afterReport.derived?.output5P95DeltaVsIdleMs ?? Number.POSITIVE_INFINITY) <= PROMPT_THRESHOLDS.output5DeltaVsIdleMs,
    afterReport.derived?.output5P95DeltaVsIdleMs,
    `<= ${PROMPT_THRESHOLDS.output5DeltaVsIdleMs}ms`
  )

  const promptRegressionScenarios = ['visible-output-2-prompt-input', 'visible-output-5-prompt-input']
  for (const scenarioId of promptRegressionScenarios) {
    const before = getPath(beforeScenarios.get(scenarioId), 'promptInput.inputLatency.p95Ms')
    const after = getPath(afterScenarios.get(scenarioId), 'promptInput.inputLatency.p95Ms')
    const tolerance = PROMPT_THRESHOLDS.p95RegressionToleranceMs
    passGate(
      gates,
      `${scenarioId} p95 regression tolerance`,
      Number.isFinite(before) && Number.isFinite(after) && after <= before + tolerance,
      after,
      `<= baseline + ${tolerance}ms (${formatNumber(before + tolerance)}ms)`
    )
  }

  if (profile === 'optimization') {
    passGate(gates, 'prompt profile', true, 'stable under output pressure', 'no p95 regression under terminal output')
  }

  return { rows, gates }
}

function comparePromptLongtail(beforeReport, afterReport, profile) {
  const beforeScenarios = scenarioMap(beforeReport)
  const afterScenarios = scenarioMap(afterReport)
  const rows = []
  const gates = []
  const scenarioId = 'visible-output-6-git-status-prompt-longtail'

  for (const metric of [
    'promptInput.inputLatency.avgMs',
    'promptInput.inputLatency.stddevMs',
    'promptInput.inputLatency.p95Ms',
    'promptInput.inputLatency.p99Ms',
    'promptInput.inputLatency.p999Ms',
    'promptInput.inputLatency.maxMs',
    'promptInput.over100Ms',
    'promptInput.over250Ms',
    'promptInput.over500Ms',
    'perf.avgFps',
    'perf.maxLongestFrameMs',
    'perf.avgIpcMsgPerSec',
    'mainEventLoop.maxDriftMs',
    'mainEventLoop.over1000Ms',
    'mainEventLoop.over3000Ms',
    'mainEventLoop.over6000Ms',
    'gitRuntime.delta.scheduler.totalScheduled',
    'gitRuntime.delta.scheduler.dedupHits',
    'gitRuntime.delta.kinds.gitScheduled',
    'gitRuntime.delta.kinds.gitCompleted',
    'gitRuntime.delta.latencies.titleRefreshCount'
  ]) {
    addComparison(rows, beforeScenarios, afterScenarios, scenarioId, metric, {
      lowerIsBetter: metric !== 'perf.avgFps' && metric !== 'gitRuntime.delta.scheduler.dedupHits'
    })
  }

  const after = afterScenarios.get(scenarioId)
  passGate(
    gates,
    'prompt longtail p99 acceptance',
    getPath(after, 'promptInput.inputLatency.p99Ms') <= PROMPT_LONGTAIL_THRESHOLDS.p99Ms,
    getPath(after, 'promptInput.inputLatency.p99Ms'),
    `<= ${PROMPT_LONGTAIL_THRESHOLDS.p99Ms}ms`
  )
  passGate(
    gates,
    'prompt longtail p999 acceptance',
    getPath(after, 'promptInput.inputLatency.p999Ms') <= PROMPT_LONGTAIL_THRESHOLDS.p999Ms,
    getPath(after, 'promptInput.inputLatency.p999Ms'),
    `<= ${PROMPT_LONGTAIL_THRESHOLDS.p999Ms}ms`
  )
  passGate(
    gates,
    'prompt longtail max acceptance',
    getPath(after, 'promptInput.inputLatency.maxMs') <= PROMPT_LONGTAIL_THRESHOLDS.maxMs,
    getPath(after, 'promptInput.inputLatency.maxMs'),
    `<= ${PROMPT_LONGTAIL_THRESHOLDS.maxMs}ms`
  )
  passGate(
    gates,
    'prompt longtail stddev acceptance',
    getPath(after, 'promptInput.inputLatency.stddevMs') <= PROMPT_LONGTAIL_THRESHOLDS.stddevMs,
    getPath(after, 'promptInput.inputLatency.stddevMs'),
    `<= ${PROMPT_LONGTAIL_THRESHOLDS.stddevMs}ms`
  )
  passGate(
    gates,
    'prompt longtail over250 acceptance',
    getPath(after, 'promptInput.over250Ms') <= PROMPT_LONGTAIL_THRESHOLDS.over250Ms,
    getPath(after, 'promptInput.over250Ms'),
    `<= ${PROMPT_LONGTAIL_THRESHOLDS.over250Ms}`
  )
  passGate(
    gates,
    'prompt longtail over500 acceptance',
    getPath(after, 'promptInput.over500Ms') === PROMPT_LONGTAIL_THRESHOLDS.over500Ms,
    getPath(after, 'promptInput.over500Ms'),
    `= ${PROMPT_LONGTAIL_THRESHOLDS.over500Ms}`
  )
  passGate(
    gates,
    'prompt longtail mismatch acceptance',
    getPath(after, 'promptInput.mismatches') === 0,
    getPath(after, 'promptInput.mismatches'),
    '= 0'
  )
  passGate(
    gates,
    'main event-loop max drift acceptance',
    getPath(after, 'mainEventLoop.maxDriftMs') <= PROMPT_LONGTAIL_THRESHOLDS.mainEventLoopMaxDriftMs,
    getPath(after, 'mainEventLoop.maxDriftMs'),
    `<= ${PROMPT_LONGTAIL_THRESHOLDS.mainEventLoopMaxDriftMs}ms`
  )
  passGate(
    gates,
    'main event-loop >1000ms stall acceptance',
    getPath(after, 'mainEventLoop.over1000Ms') === PROMPT_LONGTAIL_THRESHOLDS.mainEventLoopOver1000Ms,
    getPath(after, 'mainEventLoop.over1000Ms'),
    `= ${PROMPT_LONGTAIL_THRESHOLDS.mainEventLoopOver1000Ms}`
  )
  passGate(
    gates,
    'main event-loop >3000ms stall acceptance',
    getPath(after, 'mainEventLoop.over3000Ms') === PROMPT_LONGTAIL_THRESHOLDS.mainEventLoopOver3000Ms,
    getPath(after, 'mainEventLoop.over3000Ms'),
    `= ${PROMPT_LONGTAIL_THRESHOLDS.mainEventLoopOver3000Ms}`
  )
  passGate(
    gates,
    'main event-loop >6000ms stall acceptance',
    getPath(after, 'mainEventLoop.over6000Ms') === PROMPT_LONGTAIL_THRESHOLDS.mainEventLoopOver6000Ms,
    getPath(after, 'mainEventLoop.over6000Ms'),
    `= ${PROMPT_LONGTAIL_THRESHOLDS.mainEventLoopOver6000Ms}`
  )

  if (profile === 'regression') {
    for (const [metric, tolerance] of [
      ['promptInput.inputLatency.p99Ms', PROMPT_LONGTAIL_THRESHOLDS.p99RegressionToleranceMs],
      ['promptInput.inputLatency.maxMs', PROMPT_LONGTAIL_THRESHOLDS.maxRegressionToleranceMs],
      ['promptInput.inputLatency.stddevMs', PROMPT_LONGTAIL_THRESHOLDS.stddevRegressionToleranceMs]
    ]) {
      const before = getPath(beforeScenarios.get(scenarioId), metric)
      const candidate = getPath(afterScenarios.get(scenarioId), metric)
      passGate(
        gates,
        `${scenarioId} ${metric} regression tolerance`,
        Number.isFinite(before) && Number.isFinite(candidate) && candidate <= before + tolerance,
        candidate,
        `<= baseline + ${tolerance} (${formatNumber(before + tolerance)})`
      )
    }
  } else {
    passGate(gates, 'prompt longtail profile', true, 'absolute long-tail gates', 'no periodic renderer stalls')
  }

  return { rows, gates }
}

function compareTerminal(beforeReport, afterReport, profile) {
  const beforeScenarios = scenarioMap(beforeReport)
  const afterScenarios = scenarioMap(afterReport)
  const rows = []
  const gates = []
  for (const scenarioId of [
    'idle-input',
    'visible-output-5',
    'visible-output-5-git-diff',
    'hidden-output-5-git-diff',
    'visible-output-5-search'
  ]) {
    addComparison(rows, beforeScenarios, afterScenarios, scenarioId, 'inputLatency.p95Ms')
    addComparison(rows, beforeScenarios, afterScenarios, scenarioId, 'inputLatency.maxMs')
    addComparison(rows, beforeScenarios, afterScenarios, scenarioId, 'perf.avgFps', { lowerIsBetter: false })
    addComparison(rows, beforeScenarios, afterScenarios, scenarioId, 'perf.avgIpcMsgPerSec')
    addComparison(rows, beforeScenarios, afterScenarios, scenarioId, 'perf.avgXtermWritesPerSec')
    addComparison(rows, beforeScenarios, afterScenarios, scenarioId, 'perf.totalHiddenMB')
  }

  const visibleOutput = afterScenarios.get('visible-output-5')
  const visibleGit = afterScenarios.get('visible-output-5-git-diff')
  const hiddenGit = afterScenarios.get('hidden-output-5-git-diff')
  const visibleSearch = afterScenarios.get('visible-output-5-search')
  const criticalScenarios = [visibleOutput, visibleGit, hiddenGit, visibleSearch].filter(Boolean)

  const maxCriticalP50 = Math.max(...criticalScenarios.map(scenario => getPath(scenario, 'inputLatency.p50Ms') ?? Number.POSITIVE_INFINITY))
  passGate(gates, 'terminal echo median diagnostic acceptance', maxCriticalP50 <= TERMINAL_THRESHOLDS.criticalP50Ms, maxCriticalP50, `<= ${TERMINAL_THRESHOLDS.criticalP50Ms}ms`)
  const minFps = Math.min(...criticalScenarios.map(scenario => getPath(scenario, 'perf.avgFps') ?? 0))
  passGate(gates, 'critical FPS acceptance', minFps >= TERMINAL_THRESHOLDS.minAvgFps, minFps, `>= ${TERMINAL_THRESHOLDS.minAvgFps}`)
  passGate(
    gates,
    'hidden git IPC acceptance',
    getPath(hiddenGit, 'perf.avgIpcMsgPerSec') <= TERMINAL_THRESHOLDS.hiddenGitMaxIpcMsgPerSec,
    getPath(hiddenGit, 'perf.avgIpcMsgPerSec'),
    `<= ${TERMINAL_THRESHOLDS.hiddenGitMaxIpcMsgPerSec}/s`
  )
  passGate(
    gates,
    'hidden renderer buffer acceptance',
    getPath(hiddenGit, 'perf.totalHiddenMB') <= TERMINAL_THRESHOLDS.hiddenRendererBufferedMB,
    getPath(hiddenGit, 'perf.totalHiddenMB'),
    `<= ${TERMINAL_THRESHOLDS.hiddenRendererBufferedMB}MB`
  )

  if (profile === 'optimization') {
    for (const target of TERMINAL_OPTIMIZATION_TARGETS) {
      const before = getPath(beforeScenarios.get(target.scenarioId), target.metric)
      const after = getPath(afterScenarios.get(target.scenarioId), target.metric)
      const improvement = improvementPct(before, after, true)
      passGate(
        gates,
        `${target.label} optimization floor`,
        Number.isFinite(improvement) && improvement >= target.minImprovementPct,
        `${formatNumber(improvement)}%`,
        `>= ${target.minImprovementPct}% improvement`
      )
    }
  } else {
    for (const scenarioId of ['visible-output-5', 'visible-output-5-git-diff', 'hidden-output-5-git-diff', 'visible-output-5-search']) {
      const before = getPath(beforeScenarios.get(scenarioId), 'inputLatency.p95Ms')
      const after = getPath(afterScenarios.get(scenarioId), 'inputLatency.p95Ms')
      const tolerance = TERMINAL_THRESHOLDS.p95RegressionToleranceMs
      passGate(
        gates,
        `${scenarioId} p95 regression tolerance`,
        Number.isFinite(before) && Number.isFinite(after) && after <= before + tolerance,
        after,
        `<= baseline + ${tolerance}ms (${formatNumber(before + tolerance)}ms)`
      )
      const beforeFps = getPath(beforeScenarios.get(scenarioId), 'perf.avgFps')
      const afterFps = getPath(afterScenarios.get(scenarioId), 'perf.avgFps')
      passGate(
        gates,
        `${scenarioId} FPS regression tolerance`,
        Number.isFinite(beforeFps) && Number.isFinite(afterFps) && afterFps >= beforeFps - TERMINAL_THRESHOLDS.fpsRegressionTolerance,
        afterFps,
        `>= baseline - ${TERMINAL_THRESHOLDS.fpsRegressionTolerance} (${formatNumber(beforeFps - TERMINAL_THRESHOLDS.fpsRegressionTolerance)})`
      )
    }
  }

  return { rows, gates }
}

function printReport(summary) {
  process.stdout.write(`Performance comparison: ${summary.suite} (${summary.profile})\n`)
  process.stdout.write(`  before: ${summary.beforePath}\n`)
  process.stdout.write(`  after:  ${summary.afterPath}\n\n`)
  process.stdout.write('Metrics:\n')
  for (const row of summary.rows) {
    const direction = row.lowerIsBetter ? 'lower' : 'higher'
    const change = row.improvementPct === null
      ? 'n/a'
      : `${row.improvementPct >= 0 ? '+' : ''}${row.improvementPct}%`
    process.stdout.write(`  ${row.label}: ${formatNumber(row.before)} -> ${formatNumber(row.after)} (${change}, ${direction} is better)\n`)
  }
  process.stdout.write('\nGates:\n')
  for (const gate of summary.gates) {
    process.stdout.write(`  ${gate.ok ? 'PASS' : 'FAIL'} ${gate.label}: actual=${gate.actual} expected=${gate.expected}\n`)
  }
  process.stdout.write(`\nResult: ${summary.ok ? 'PASS' : 'FAIL'}\n`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) usage(0)
  if (!args.before || !args.after) usage(2)

  const profile = args.profile ?? 'optimization'
  if (!['optimization', 'regression'].includes(profile)) {
    throw new Error(`Unsupported --profile ${profile}`)
  }

  const before = readJson(args.before)
  const after = readJson(args.after)
  const suite = args.suite ?? after.suite ?? before.suite
  if (!suite) {
    throw new Error('Unable to infer suite. Pass --suite explicitly.')
  }
  if (before.suite && before.suite !== suite) {
    throw new Error(`Before file suite mismatch: expected ${suite}, got ${before.suite}`)
  }
  if (after.suite && after.suite !== suite) {
    throw new Error(`After file suite mismatch: expected ${suite}, got ${after.suite}`)
  }

  let comparison
  if (suite === 'prompt-input-latency') {
    comparison = comparePrompt(before, after, profile)
  } else if (suite === 'prompt-input-longtail') {
    comparison = comparePromptLongtail(before, after, profile)
  } else if (suite === 'terminal-architecture-baseline') {
    comparison = compareTerminal(before, after, profile)
  } else {
    throw new Error(`Unsupported suite: ${suite}`)
  }

  const summary = {
    suite,
    profile,
    beforePath: args.before,
    afterPath: args.after,
    rows: comparison.rows,
    gates: comparison.gates,
    ok: comparison.gates.every(gate => gate.ok)
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else {
    printReport(summary)
  }

  if (!summary.ok && !args['report-only']) {
    process.exit(1)
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
