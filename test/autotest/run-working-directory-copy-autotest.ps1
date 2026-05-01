# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")
$DefaultExe = Resolve-DevAppBin -RootDir $RootDir
$AppExe = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { $DefaultExe }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { "$env:TEMP\onward-working-directory-copy-autotest.log" }

if (-not $AppExe -or -not (Test-Path $AppExe)) {
  Write-Error "App executable not found: $AppExe`nRun a development build first: remove the out and release directories, then run pnpm dist:dev"
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "working-directory-copy"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

& $AppExe *> $LogFile

$content = Get-Content $LogFile -Raw
if ($content -match "\[AutoTest\] FAIL") {
  Get-Content $LogFile -Tail 120 | Write-Host
  Write-Error "Working-directory-copy autotest failed. Log: $LogFile"
}

if ($content -match "totalFailed: [1-9]") {
  Get-Content $LogFile -Tail 120 | Write-Host
  Write-Error "Working-directory-copy autotest reported failed cases in the summary. Log: $LogFile"
}

if ($content -notmatch "WDC-03-git-history-cwd-copy-toast") {
  Get-Content $LogFile -Tail 120 | Write-Host
  Write-Error "Missing WDC-03 result. Log: $LogFile"
}

Write-Host "Working-directory-copy autotest passed. Log: $LogFile"
