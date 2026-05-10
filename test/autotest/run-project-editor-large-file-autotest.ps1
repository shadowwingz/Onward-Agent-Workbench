# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
. (Join-Path $RootDir "test/autotest/Resolve-DevAppBin.ps1")

$AppBin = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { Resolve-DevAppBin $RootDir }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { Join-Path $RootDir "traces/test-logs/project-editor-large-file-autotest.log" }
$ScratchDir = Join-Path $RootDir "test/autotest/results/project-editor-large-file"
$LargeGifFixture = Join-Path $ScratchDir "large-preview.gif"

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found or not executable: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
}

$LogDir = Split-Path -Parent $LogFile
if ($LogDir -and -not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}
if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

& node (Join-Path $RootDir "test/autotest/create-large-gif-fixture.mjs") $LargeGifFixture (12 * 1024 * 1024) | Out-Null

try {
  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = "project-editor-large-file"
  $env:ONWARD_AUTOTEST_CWD = $RootDir
  $env:ONWARD_AUTOTEST_EXIT = "1"

  & $AppBin *> $LogFile

  if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Write-Error "ProjectEditor large-file autotest failed. Log: $LogFile"
  }

  if (-not (Select-String -Path $LogFile -Pattern "PLF-20-large-gif-preview-uses-file-url" -Quiet)) {
    Write-Error "Missing PLF-20-large-gif-preview-uses-file-url result. Log: $LogFile"
  }

  Write-Output "ProjectEditor large-file autotest passed. Log: $LogFile"
} finally {
  if (Test-Path $ScratchDir) {
    Remove-Item -Recurse -Force $ScratchDir
  }
  Get-ChildItem -Path $RootDir -Filter "__autotest_*" -Force | Remove-Item -Recurse -Force
}
