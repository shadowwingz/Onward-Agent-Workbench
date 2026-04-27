# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Performance trace autotest runner (Windows).
# For macOS/Linux, use run-performance-trace-autotest.sh.

param(
  [string]$AppBin,
  [string]$LogFile
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

if (-not $LogFile) {
  $LogFile = Join-Path $env:TEMP "onward-performance-trace-autotest.log"
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
  exit 1
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

Write-Host "Starting Performance Trace autotest..."
Write-Host "  Binary:   $AppBin"
Write-Host "  CWD:      $RootDir"
Write-Host "  Platform:  Windows"
Write-Host "  Log:      $LogFile"
Write-Host ""

$env:ONWARD_DEBUG = "1"
$env:ONWARD_PERF_TRACE = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "performance-trace"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

Start-Process -FilePath $AppBin -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -NoNewWindow -Wait | Out-Null
if (Test-Path "$LogFile.err") {
  Get-Content "$LogFile.err" | Add-Content $LogFile
  Remove-Item "$LogFile.err" -Force -ErrorAction SilentlyContinue
}

Remove-Item Env:\ONWARD_DEBUG -ErrorAction SilentlyContinue
Remove-Item Env:\ONWARD_PERF_TRACE -ErrorAction SilentlyContinue
Remove-Item Env:\ONWARD_AUTOTEST -ErrorAction SilentlyContinue
Remove-Item Env:\ONWARD_AUTOTEST_SUITE -ErrorAction SilentlyContinue
Remove-Item Env:\ONWARD_AUTOTEST_CWD -ErrorAction SilentlyContinue
Remove-Item Env:\ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== Test log (last 120 lines) ==="
Get-Content $LogFile -Tail 120
Write-Host ""

$content = Get-Content $LogFile -Raw

if ($content -match "\[AutoTest\] FAIL") {
  Write-Host "Performance Trace autotest FAILED" -ForegroundColor Red
  Write-Host ""
  Write-Host "=== Failure details ==="
  Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
  exit 1
}

if ($content -notmatch "PT-09-no-dropped-events") {
  Write-Host "Missing PT-09 result; the test may not have executed correctly" -ForegroundColor Yellow
  Get-Content $LogFile -Tail 40
  exit 1
}

$traceLine = Select-String -Path $LogFile -Pattern "\[PerfTrace\] Active \(ONWARD_PERF_TRACE=1\): " | Select-Object -Last 1
if (-not $traceLine) {
  Write-Host "Performance trace file path was not logged" -ForegroundColor Red
  exit 1
}

$TraceFile = $traceLine.Line -replace '^.*\[PerfTrace\] Active \(ONWARD_PERF_TRACE=1\): ', ''
if (-not (Test-Path $TraceFile)) {
  Write-Host "Performance trace file was not written: $TraceFile" -ForegroundColor Red
  exit 1
}

node (Join-Path $RootDir "test\autotest\validate-performance-trace-contract.mjs") $TraceFile

Write-Host "Performance Trace autotest PASSED" -ForegroundColor Green
Write-Host "  Log:   $LogFile"
Write-Host "  Trace: $TraceFile"
