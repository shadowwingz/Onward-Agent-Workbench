# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# AppState render-loop regression autotest (CDP smoke test, hang-proof) — Windows.
#
# Locks the Windows idle-CPU fix (terminal cwd ping-ponging 'D:/x' <-> 'D:\x').
# Delegates to check-renderer-idle-churn.mjs which launches the dev build with a
# CDP port, measures idle render churn, asserts it is near zero, and always
# kills the app with hard internal deadlines (cannot hang). Paired with the unit
# tests terminal-cwd-persist-canonical.test.mts and appstate-update-bailout.test.mts.

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
)

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
  $LogFile = Join-Path $RootDir "traces/test-logs/appstate-render-loop.log"
  New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
}

if (-not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin"
  exit 1
}

if (Test-Path $LogFile) { Remove-Item $LogFile -Force }

$Port = if ($env:ONWARD_RENDER_CHURN_PORT) { $env:ONWARD_RENDER_CHURN_PORT } else { "9344" }

Write-Host "Starting appstate render-loop autotest (CDP idle-churn smoke test)..."
Write-Host "  App:  $AppBin"
Write-Host "  Port: $Port"

& node (Join-Path $RootDir "test/autotest/check-renderer-idle-churn.mjs") $AppBin $Port $RootDir *> $LogFile

$logContent = Get-Content $LogFile -Raw -ErrorAction SilentlyContinue

if ($logContent -match "\[AutoTest\] FAIL") {
  Write-Error "AppState render-loop autotest FAILED. Log: $LogFile"
  Get-Content $LogFile -Tail 60
  exit 1
}

if ($logContent -notmatch "appstate-render-loop:complete") {
  Write-Error "AppState render-loop autotest did not complete. Log: $LogFile"
  Get-Content $LogFile -Tail 60
  exit 1
}

Write-Host "AppState render-loop autotest passed. Log: $LogFile"
Get-Content $LogFile
