# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent (Split-Path -Parent $ScriptDir)
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")

$DefaultExe = Resolve-DevAppBin -RootDir $RootDir
$AppExe = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { $DefaultExe }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { Join-Path $RootDir "traces\test-logs\git-diff-click-latency-autotest.log" }
$LogDir = Split-Path -Parent $LogFile
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$SuiteName = "git-diff-click-latency"
if ($env:GDCL_CAP) {
  $SuiteName = "$SuiteName;cap=$($env:GDCL_CAP)"
}
$WatchdogSec = if ($env:GDCL_WATCHDOG_SEC) { [int]$env:GDCL_WATCHDOG_SEC } else { 180 }

if (-not $AppExe -or -not (Test-Path $AppExe)) {
  Write-Error "App executable not found: $AppExe`nRun a development build first: remove the out and release directories, then run pnpm dist:dev"
}

$UserDataDir = Join-Path $env:TEMP ("onward-gdcl-userdata-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
$FixtureRoot = $null

try {
  if (Test-Path $LogFile) {
    Remove-Item $LogFile -Force
  }

  $fixtureJson = & node (Join-Path $RootDir "test\autotest\create-git-diff-click-latency-fixture.mjs")
  $fixture = $fixtureJson | ConvertFrom-Json
  $FixtureRoot = [string]$fixture.root
  if (-not $FixtureRoot -or -not (Test-Path (Join-Path $FixtureRoot ".git"))) {
    Write-Error "Failed to create isolated Git Diff click-latency fixture. Fixture JSON: $fixtureJson"
  }

  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_PERF_TRACE = "1"
  $env:ONWARD_REPO_ROOT = $RootDir
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = $SuiteName
  $env:ONWARD_AUTOTEST_CWD = $FixtureRoot
  $env:ONWARD_AUTOTEST_EXIT = "1"

  Write-Host "Starting Git Diff click latency autotest..."
  Write-Host "  Binary:       $AppExe"
  Write-Host "  Repo:         $RootDir"
  Write-Host "  Fixture repo: $FixtureRoot"
  Write-Host "  User data:    $UserDataDir"
  Write-Host "  Suite:        $SuiteName"
  Write-Host "  Watchdog:     ${WatchdogSec}s"
  Write-Host "  Log:          $LogFile"

  & node (Join-Path $RootDir "test\autotest\run-with-timeout.mjs") $WatchdogSec $AppExe *> $LogFile
  $AppExit = $LASTEXITCODE
  if ($AppExit -eq 124) {
    Get-Content $LogFile -Tail 120 | Write-Host
    Write-Error "Git Diff click latency autotest exceeded ${WatchdogSec}s watchdog. Log: $LogFile"
  }
  if ($AppExit -ne 0) {
    Get-Content $LogFile -Tail 120 | Write-Host
    Write-Error "Git Diff click latency autotest app exited with code $AppExit. Log: $LogFile"
  }

  $content = Get-Content $LogFile -Raw
  if ($content -notmatch "\[AutoTest\] === Autotest Completed ===") {
    Get-Content $LogFile -Tail 120 | Write-Host
    Write-Error "Git Diff click latency autotest did not reach the completion marker. Log: $LogFile"
  }
  if (
    $content -match "\[AutoTest\] FAIL" -or
    $content -match "totalFailed: [1-9][0-9]*" -or
    $content -match "runtime-errors-detected" -or
    $content -match "FAIL gdcl-"
  ) {
    Get-Content $LogFile -Tail 120 | Write-Host
    Write-Error "Git Diff click latency autotest failed. Log: $LogFile"
  }

  $TraceDir = Join-Path $RootDir "traces\perf"
  $LatestPointer = Join-Path $TraceDir "latest.txt"
  $LatestTracePath = $null
  if (Test-Path $LatestPointer) {
    $LatestTracePath = (Get-Content $LatestPointer -Raw).Trim()
  }
  # Robustness (mirrors the .sh): the pointer may be missing, stale, or — when a
  # prior run was killed mid-flush — hold the trace DIRECTORY path instead of a
  # chunk file. In any of those cases fall back to the newest perf chunk by mtime.
  # Perf chunks are ndjson-chunked perf-*.jsonl (older runs may have *.json).
  if (-not $LatestTracePath -or -not (Test-Path $LatestTracePath -PathType Leaf)) {
    $LatestTracePath = Get-ChildItem -Path $TraceDir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "perf-*.jsonl" -or $_.Extension -eq ".json" } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1 |
      ForEach-Object { $_.FullName }
  }
  if (-not $LatestTracePath -or -not (Test-Path $LatestTracePath -PathType Leaf)) {
    Write-Error "Cannot locate perf trace file under $TraceDir"
  }

  $trace = Get-Content $LatestTracePath -Raw
  $phaseEvents = @(
    "renderer:git-diff.click-phase.ipc",
    "renderer:git-diff.click-phase.state-set",
    "renderer:git-diff.click-phase.model-bind",
    "renderer:git-diff.click-phase.mount",
    "renderer:git-diff.click-phase.diff-compute",
    "renderer:git-diff.click-phase.dom-commit",
    "renderer:git-diff.click-phase.paint",
    "renderer:git-diff.click-phase.tokenize-settle",
    "renderer:git-diff.click-phase.total",
    "renderer:git-diff.cache-invalidation"
  )
  $missing = @($phaseEvents | Where-Object { $trace -notmatch [regex]::Escape($_) })
  if ($missing.Count -gt 0) {
    Write-Error ("Phase chain regression; missing events: " + ($missing -join ", "))
  }

  Write-Host "Git Diff click latency autotest passed. Log: $LogFile"
} finally {
  Get-ChildItem -Path $RootDir -Filter "__autotest_*" -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $UserDataDir) {
    Remove-Item $UserDataDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($FixtureRoot -and (Test-Path $FixtureRoot)) {
    Remove-Item $FixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
