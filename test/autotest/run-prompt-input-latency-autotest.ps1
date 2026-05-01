# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Prompt input latency autotest runner (Windows)
# For macOS/Linux, use run-prompt-input-latency-autotest.sh

param(
  [string]$AppBin,
  [string]$LogFile,
  [string]$ResultFile,
  [string]$CompareBaselineFile,
  [string]$CompareProfile
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

$ResultDir = Join-Path $RootDir "test\autotest\results\prompt-input-latency"
New-Item -ItemType Directory -Force $ResultDir | Out-Null

if (-not $LogFile) {
  $RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$LogFile = Join-Path $RepoRoot "traces/test-logs/onward-prompt-input-latency-autotest.log"
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
}

if (-not $ResultFile) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $ResultFile = Join-Path $ResultDir "baseline-$stamp.json"
}

if (-not $CompareBaselineFile -and $env:ONWARD_PERF_COMPARE_BASELINE) {
  $CompareBaselineFile = $env:ONWARD_PERF_COMPARE_BASELINE
}

if (-not $CompareProfile) {
  $CompareProfile = if ($env:ONWARD_PERF_COMPARE_PROFILE) { $env:ONWARD_PERF_COMPARE_PROFILE } else { "optimization" }
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
  exit 1
}

if (Test-Path $LogFile) {
  try {
    Remove-Item -LiteralPath $LogFile -Force -ErrorAction Stop
  } catch {
    $fallbackStamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $LogFile = Join-Path $env:TEMP "onward-prompt-input-latency-autotest-$fallbackStamp.log"
  }
}

Write-Host "Preparing prompt input latency fixture..."
$prepareScript = Join-Path $RootDir "test\autotest\prepare-prompt-input-latency-fixture.mjs"
$fixtureSummary = node $prepareScript | Out-String
Write-Host $fixtureSummary

$WorkDir = Join-Path $RootDir "test\autotest\fixtures\prompt-input-latency\workdir"
$UserDataDir = Join-Path $RootDir "test\autotest\fixtures\prompt-input-latency\user-data"
$rootFullPath = [System.IO.Path]::GetFullPath($RootDir).TrimEnd('\')
$userDataFullPath = [System.IO.Path]::GetFullPath($UserDataDir)
$rootPrefix = "$rootFullPath\"
if (-not $userDataFullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to delete userData outside repo: $userDataFullPath"
}
if (Test-Path -LiteralPath $userDataFullPath) {
  Remove-Item -LiteralPath $userDataFullPath -Recurse -Force
}
New-Item -ItemType Directory -Force $userDataFullPath | Out-Null
$UserDataDir = $userDataFullPath

Write-Host "Starting Prompt Input Latency autotest..."
Write-Host "  Binary:   $AppBin"
Write-Host "  CWD:      $WorkDir"
Write-Host "  UserData: $UserDataDir"
Write-Host "  Platform: Windows"
Write-Host "  Log:      $LogFile"
Write-Host "  Result:   $ResultFile"
Write-Host ""

$ProcessName = [System.IO.Path]::GetFileNameWithoutExtension($AppBin)
$existing = Get-Process | Where-Object { $_.ProcessName -eq $ProcessName }
if ($existing) {
  $existing | Stop-Process -Force
  Start-Sleep -Milliseconds 500
}

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "prompt-input-latency"
$env:ONWARD_AUTOTEST_CWD = $WorkDir
$env:ONWARD_AUTOTEST_EXIT = "1"
$env:ONWARD_USER_DATA_DIR = $UserDataDir

try {
  $proc = Start-Process -FilePath $AppBin -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -NoNewWindow -Wait
  if (Test-Path "$LogFile.err") {
    Get-Content "$LogFile.err" | Add-Content $LogFile
    Remove-Item "$LogFile.err" -Force -ErrorAction SilentlyContinue
  }
} finally {
  Remove-Item Env:\ONWARD_DEBUG -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_SUITE -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_USER_DATA_DIR -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=== Test log (last 160 lines) ==="
Get-Content $LogFile -Tail 160
Write-Host ""

$content = Get-Content $LogFile -Raw

if ($content -match "\[AutoTest\] FAIL") {
  Write-Host "Prompt Input Latency autotest FAILED" -ForegroundColor Red
  Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
  exit 1
}

$marker = "[PromptInputLatency:RESULT]"
$match = Select-String -Path $LogFile -Pattern ([Regex]::Escape($marker)) | Select-Object -Last 1
if (-not $match) {
  Write-Host "Missing prompt input latency result marker." -ForegroundColor Red
  exit 1
}

$line = $match.Line
$json = $line.Substring($line.IndexOf($marker) + $marker.Length).Trim()
$parsed = $json | ConvertFrom-Json
$parsed | ConvertTo-Json -Depth 50 | Set-Content -Path $ResultFile -Encoding UTF8

Write-Host "Prompt Input Latency autotest PASSED" -ForegroundColor Green
Write-Host "  Log:    $LogFile"
Write-Host "  Result: $ResultFile"
Write-Host ""
Write-Host "=== Baseline summary ==="
foreach ($scenario in $parsed.scenarios) {
  Write-Host ("  {0}: prompt p95={1}ms max={2}ms eventLoopP95={3}ms paintP95={4}ms avgFps={5} ipc/s={6}" -f `
    $scenario.id, `
    $scenario.promptInput.inputLatency.p95Ms, `
    $scenario.promptInput.inputLatency.maxMs, `
    $scenario.promptInput.eventLoopDelay.p95Ms, `
    $scenario.promptInput.paintDelay.p95Ms, `
    $scenario.perf.avgFps, `
    $scenario.perf.avgIpcMsgPerSec)
}
Write-Host ("  output2 p95 delta vs idle: {0}ms" -f $parsed.derived.output2P95DeltaVsIdleMs)
Write-Host ("  output5 p95 delta vs idle: {0}ms" -f $parsed.derived.output5P95DeltaVsIdleMs)
Write-Host ("  output5 p95 delta vs output2: {0}ms" -f $parsed.derived.output5P95DeltaVsOutput2Ms)
Write-Host ("  output2 event-loop p95 delta vs idle: {0}ms" -f $parsed.derived.output2EventLoopP95DeltaVsIdleMs)
Write-Host ("  output5 event-loop p95 delta vs idle: {0}ms" -f $parsed.derived.output5EventLoopP95DeltaVsIdleMs)

if ($CompareBaselineFile) {
  Write-Host ""
  Write-Host "=== Performance comparison gate ==="
  node (Join-Path $RootDir "test\autotest\compare-performance-baseline.mjs") `
    --suite prompt-input-latency `
    --profile $CompareProfile `
    --before $CompareBaselineFile `
    --after $ResultFile
}
