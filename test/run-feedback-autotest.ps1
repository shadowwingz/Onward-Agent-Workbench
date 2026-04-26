# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin = "",
  [string]$LogFile = "",
  [string]$UserDataDir = ""
)

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $RootDir "test\Resolve-DevAppBin.ps1")

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found. Run: rm -rf out release && pnpm dist:dev"
  exit 1
}

if (-not $LogFile) {
  $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$LogFile = Join-Path $RepoRoot "traces/test-logs/onward-feedback-autotest.log"
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
}

# Track whether this script created the user-data dir, so cleanup only removes
# self-created directories and never a caller-supplied path that may hold real data.
$TmpRootOwned = $false

if (-not $UserDataDir) {
  $UserDataDir = Join-Path $env:TEMP ("onward-autotest-feedback-" + [guid]::NewGuid().ToString())
  $TmpRootOwned = $true
}

New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

Write-Host "Starting feedback autotest..."
Write-Host "[autotest] tmp dir: $UserDataDir"

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "feedback"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"
$env:ONWARD_USER_DATA_DIR = $UserDataDir

try {
  try {
    & $AppBin *> $LogFile
  } catch {
  }

  if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Write-Error "Feedback autotest failed. Log: $LogFile"
    Get-Content $LogFile -Tail 160
    exit 1
  }

  if (-not (Select-String -Path $LogFile -Pattern "FBU-11-remove-local-record" -Quiet)) {
    Write-Error "Feedback autotest did not complete. Log: $LogFile"
    Get-Content $LogFile -Tail 160
    exit 1
  }

  Write-Host "Feedback autotest passed. Log: $LogFile"
} finally {
  if ($TmpRootOwned -and (Test-Path $UserDataDir)) {
    if ($env:ONWARD_AUTOTEST_KEEP_TMP -eq '1') {
      Write-Host "[autotest] retained tmp for debugging: $UserDataDir"
    } else {
      Remove-Item -Recurse -Force $UserDataDir
    }
  }
}
