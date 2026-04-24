# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Terminal architecture baseline autotest runner (Windows)
# For macOS/Linux, use run-terminal-architecture-baseline-autotest.sh

param(
  [string]$AppBin,
  [string]$LogFile,
  [string]$ResultFile,
  [string]$CompareBaselineFile,
  [string]$CompareProfile
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
. (Join-Path $RootDir "test\Resolve-DevAppBin.ps1")

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

$ResultDir = Join-Path $RootDir "test\results\terminal-architecture-baseline"
New-Item -ItemType Directory -Force $ResultDir | Out-Null

if (-not $LogFile) {
  $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$LogFile = Join-Path $RepoRoot "traces/test-logs/onward-terminal-architecture-baseline-autotest.log"
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
    $LogFile = Join-Path $env:TEMP "onward-terminal-architecture-baseline-autotest-$fallbackStamp.log"
  }
}

Write-Host "Preparing terminal architecture baseline fixture..."
$prepareScript = Join-Path $RootDir "test\prepare-terminal-architecture-baseline-fixture.mjs"
$fixtureSummary = node $prepareScript | Out-String
Write-Host $fixtureSummary

$WorkDir = Join-Path $RootDir "test\fixtures\terminal-architecture-baseline\workdir"
$UserDataDir = Join-Path $RootDir "test\fixtures\terminal-architecture-baseline\user-data"
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

Write-Host "Starting Terminal Architecture Baseline autotest..."
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
$env:ONWARD_AUTOTEST_SUITE = "terminal-architecture-baseline"
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
$marker = "[TerminalArchitectureBaseline:RESULT]"
$match = Select-String -Path $LogFile -Pattern ([Regex]::Escape($marker)) | Select-Object -Last 1
$parsed = $null
if ($match) {
  $line = $match.Line
  $json = $line.Substring($line.IndexOf($marker) + $marker.Length).Trim()
  $parsed = $json | ConvertFrom-Json
  $parsed | ConvertTo-Json -Depth 50 | Set-Content -Path $ResultFile -Encoding UTF8
}

if ($content -match "\[AutoTest\] FAIL") {
  Write-Host "Terminal Architecture Baseline autotest FAILED" -ForegroundColor Red
  if ($parsed) {
    Write-Host "  Result: $ResultFile"
  }
  Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
  exit 1
}

if (-not $parsed) {
  Write-Host "Missing terminal architecture baseline result marker." -ForegroundColor Red
  exit 1
}

Write-Host "Terminal Architecture Baseline autotest PASSED" -ForegroundColor Green
Write-Host "  Log:    $LogFile"
Write-Host "  Result: $ResultFile"
Write-Host ""
Write-Host "=== Baseline summary ==="
foreach ($scenario in $parsed.scenarios) {
  Write-Host ("  {0}: input p95={1}ms max={2}ms avgFps={3} ipc/s={4}" -f `
    $scenario.id, `
    $scenario.inputLatency.p95Ms, `
    $scenario.inputLatency.maxMs, `
    $scenario.perf.avgFps, `
    $scenario.perf.avgIpcMsgPerSec)
}
Write-Host ("  visible output p95 delta vs idle: {0}ms" -f $parsed.derived.visibleOutputP95DeltaVsIdleMs)
Write-Host ("  git pressure p95 delta vs output: {0}ms" -f $parsed.derived.visibleGitP95DeltaVsOutputMs)
Write-Host ("  hidden git p95 delta vs visible git: {0}ms" -f $parsed.derived.hiddenGitP95DeltaVsVisibleGitMs)
Write-Host ("  search pressure p95 delta vs output: {0}ms" -f $parsed.derived.visibleSearchP95DeltaVsOutputMs)

if ($CompareBaselineFile) {
  Write-Host ""
  Write-Host "=== Performance comparison gate ==="
  node (Join-Path $RootDir "test\compare-performance-baseline.mjs") `
    --suite terminal-architecture-baseline `
    --profile $CompareProfile `
    --before $CompareBaselineFile `
    --after $ResultFile
}
