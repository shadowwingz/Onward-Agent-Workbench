# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
)

# <repo>/test/autotest/run-*.ps1 → three Split-Path -Parent calls climb to <repo>.
$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$AppDir = Join-Path $RootDir "release\win-unpacked"

if (-not $AppBin) {
  $Candidates = Get-ChildItem -Path $AppDir -Filter "*.exe" -ErrorAction SilentlyContinue | Sort-Object Name
  if (-not $Candidates -or $Candidates.Count -eq 0) {
    Write-Error "No packaged .exe was found. Run: rm -rf out release && pnpm dist:dev"
    exit 1
  }
  $AppBin = $Candidates[0].FullName
}

if (-not $LogFile) {
  $LogFile = Join-Path $RootDir "traces/test-logs/onward-prompt-editor-context-menu-autotest.log"
  New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
}

if (-not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin"
  exit 1
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

# Sweep any leftover __autotest_* fixtures in the repo root before / after the
# run. Defence-in-depth — orchestrator does the same on POSIX, this is the
# Windows mirror.
function Invoke-AutotestFixtureSweep {
  Get-ChildItem -Path $RootDir -Filter '__autotest_*' -Force -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}
Invoke-AutotestFixtureSweep

Write-Host "Starting prompt editor context-menu autotest..."

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "prompt-editor-context-menu"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

try {
  & $AppBin *> $LogFile
} catch {
}

Invoke-AutotestFixtureSweep

$logContent = Get-Content $LogFile -Raw -ErrorAction SilentlyContinue

if ($logContent -match "\[AutoTest\] FAIL") {
  Write-Error "Prompt editor context-menu autotest failed. Log: $LogFile"
  Get-Content $LogFile -Tail 200
  exit 1
}

if ($logContent -notmatch "PECM-34-context-send-to-task-transform") {
  Write-Error "Prompt editor context-menu autotest did not complete. Log: $LogFile"
  Get-Content $LogFile -Tail 200
  exit 1
}

Write-Host "Prompt editor context-menu autotest passed. Log: $LogFile"
