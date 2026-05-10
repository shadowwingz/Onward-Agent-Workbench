# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Windows counterpart of run-unittest-suite-autotest.sh. The Full
# Regression orchestrator drives Windows runs through Git Bash, so
# this PowerShell script exists primarily for direct local invocation.
# See run-unittest-suite-autotest.sh for design rationale.
#
# Usage:
#   pwsh test/autotest/run-unittest-suite-autotest.ps1 [-AppBin <path>] [-LogFile <path>]

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = if ($env:REPO_ROOT) { $env:REPO_ROOT } else { Resolve-Path (Join-Path $PSScriptRoot "..\..") }
if (-not $LogFile) {
  $LogFile = Join-Path $RepoRoot "traces\test-logs\unittest-suite-autotest.log"
}

$LogDir = Split-Path -Parent $LogFile
if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

# Defence-in-depth: sweep __autotest_* leftovers in the repo root on exit.
$cleanup = {
  Get-ChildItem -Path $RepoRoot -Filter "__autotest_*" -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.PSIsContainer -or $_.PSChildName.StartsWith("__autotest_") } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action $cleanup | Out-Null

Push-Location $RepoRoot
try {
  & node "test/autotest/run-unittest-suite.mjs" 2>&1 | Tee-Object -FilePath $LogFile
  exit $LASTEXITCODE
} finally {
  Pop-Location
  & $cleanup
}
