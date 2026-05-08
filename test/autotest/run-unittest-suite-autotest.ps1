# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DefaultLogFile = Join-Path $RootDir "traces\test-logs\unittest-suite.log"
$FirstArgLooksLikeApp = $args.Count -ge 1 -and $args[0] -and
  (Test-Path $args[0] -PathType Leaf) -and
  ([System.IO.Path]::GetExtension($args[0]) -ieq ".exe")
if ($FirstArgLooksLikeApp) {
  $LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { $DefaultLogFile }
} else {
  $LogFile = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { $DefaultLogFile }
}
$WatchdogSec = if ($env:UNITTEST_WATCHDOG_SEC) { [int]$env:UNITTEST_WATCHDOG_SEC } else { 180 }
$LogDir = Split-Path -Parent $LogFile
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

try {
  if (Test-Path $LogFile) {
    Remove-Item $LogFile -Force
  }
  & node (Join-Path $RootDir "test\autotest\run-with-timeout.mjs") $WatchdogSec node (Join-Path $RootDir "test\unittest\run-unittest-suite.mjs") *> $LogFile
  $ExitCode = $LASTEXITCODE
  if ($ExitCode -eq 124) {
    Get-Content $LogFile -Tail 160 | Write-Host
    Write-Error "Unit test suite exceeded ${WatchdogSec}s watchdog. Log: $LogFile"
  }
  if ($ExitCode -ne 0) {
    Get-Content $LogFile -Tail 160 | Write-Host
    Write-Error "Unit test suite failed with exit code $ExitCode. Log: $LogFile"
  }
  Get-Content $LogFile -Tail 120 | Write-Host
  Write-Host "Unit test suite PASS. Log: $LogFile"
} catch {
  if (Test-Path $LogFile) {
    Get-Content $LogFile -Tail 160 | Write-Host
  }
  Write-Error "Unit test suite FAIL. Log: $LogFile"
} finally {
  Get-ChildItem -Path $RootDir -Filter "__autotest_*" -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
