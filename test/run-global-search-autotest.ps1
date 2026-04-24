# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
. (Join-Path $RootDir "test\Resolve-DevAppBin.ps1")

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

if (-not $LogFile) {
  $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$LogFile = Join-Path $RepoRoot "traces/test-logs/onward-global-search-autotest.log"
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
}

if (-not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
  exit 1
}

if (Test-Path $LogFile) {
  try {
    Remove-Item -LiteralPath $LogFile -Force -ErrorAction Stop
  } catch {
    $fallbackStamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $LogFile = Join-Path $env:TEMP "onward-global-search-autotest-$fallbackStamp.log"
  }
}

$FixtureRoot = Join-Path $RootDir "test\fixtures\global-search"
$WorkDir = Join-Path $FixtureRoot "workdir"
$UserDataDir = Join-Path $FixtureRoot "user-data"
New-Item -ItemType Directory -Force $WorkDir | Out-Null

# Seed the workdir with a placeholder file so the ProjectEditor file tree is
# non-empty. The autotest useEffect in ProjectEditor.tsx is gated on
# `tree.length > 0`; an empty workdir would leave the autotest waiting forever
# and produce a silent 5-minute timeout.
$SeedPath = Join-Path $WorkDir "seed.md"
if (-not (Test-Path -LiteralPath $SeedPath)) {
  Set-Content -LiteralPath $SeedPath -Value "global-search autotest seed file" -NoNewline
}

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

Write-Host "Starting global search autotest..."
Write-Host "  Binary:   $AppBin"
Write-Host "  CWD:      $WorkDir"
Write-Host "  UserData: $UserDataDir"
Write-Host "  Log:      $LogFile"

$ProcessName = [System.IO.Path]::GetFileNameWithoutExtension($AppBin)
$existing = Get-Process | Where-Object { $_.ProcessName -eq $ProcessName }
if ($existing) {
  $existing | Stop-Process -Force
  Start-Sleep -Milliseconds 500
}

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "global-search"
$env:ONWARD_AUTOTEST_CWD = $WorkDir
$env:ONWARD_AUTOTEST_EXIT = "1"
$env:ONWARD_AUTOTEST_SKIP_CONSENT = "1"
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

if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
  Write-Error "Global search autotest failed. Log: $LogFile"
  Get-Content $LogFile -Tail 120
  exit 1
}

if (-not (Select-String -Path $LogFile -Pattern "GS-11-search-cancel" -Quiet)) {
  Write-Error "Global search autotest did not complete. Log: $LogFile"
  Get-Content $LogFile -Tail 120
  exit 1
}

Write-Host "Global search autotest passed. Log: $LogFile"
