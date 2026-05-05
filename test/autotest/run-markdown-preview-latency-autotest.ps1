# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$AppBin = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { '' }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { Join-Path $env:TEMP 'onward-markdown-preview-latency-autotest.log' }
$ExplicitFixtureRoot = ($args.Count -ge 3 -and $args[2]) -as [bool]
$FixtureRoot = if ($ExplicitFixtureRoot) {
  $args[2]
} else {
  Join-Path $env:TEMP ("onward-md-latency-{0}" -f ([System.IO.Path]::GetRandomFileName()))
}

if (-not $AppBin) {
  $Resolver = Join-Path $RepoRoot 'test/autotest/resolve-dev-app-bin.sh'
  if (Get-Command bash -ErrorAction SilentlyContinue) {
    $AppBin = & bash $Resolver $RepoRoot
  }
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found or not executable: $AppBin. Run: rm -rf out release && pnpm dist:dev"
}

if (-not (Test-Path $FixtureRoot -PathType Container)) {
  if ($ExplicitFixtureRoot) {
    Write-Error "Fixture root not found: $FixtureRoot"
  }
  New-Item -ItemType Directory -Path $FixtureRoot -Force | Out-Null
}

# Copy committed fixtures into the per-run cwd so the autotest can read
# them via project.readFile relative to rootPath.
$FixtureSubdir = Join-Path $FixtureRoot 'test/autotest/fixtures/markdown-preview-latency'
New-Item -ItemType Directory -Path $FixtureSubdir -Force | Out-Null
Copy-Item (Join-Path $RepoRoot 'test/autotest/fixtures/markdown-preview-latency/*.md') $FixtureSubdir -Force

Remove-Item -Path $LogFile -Force -ErrorAction SilentlyContinue

Write-Host 'Starting Markdown preview latency autotest...'
Write-Host "  Binary:      $AppBin"
Write-Host "  Fixture CWD: $FixtureRoot"
Write-Host "  Log:         $LogFile"

$env:ONWARD_DEBUG = '1'
$env:ONWARD_AUTOTEST = '1'
$env:ONWARD_AUTOTEST_SUITE = 'markdown-preview-latency'
$env:ONWARD_AUTOTEST_CWD = $FixtureRoot
$env:ONWARD_AUTOTEST_EXIT = '1'

try {
  & $AppBin *> $LogFile
} finally {
  # Sweep __autotest_* leftovers and remove the per-run cwd if we own it.
  if (Test-Path $FixtureRoot -PathType Container) {
    Get-ChildItem -Path $FixtureRoot -Filter '__autotest_*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    if (-not $ExplicitFixtureRoot) {
      Remove-Item -Path $FixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host ''
Write-Host '=== Test log (last 120 lines) ==='
Get-Content $LogFile -Tail 120
Write-Host ''

$content = Get-Content $LogFile -Raw
if ($content -match '\[AutoTest\] FAIL') {
  Write-Error "Markdown preview latency autotest failed. Log: $LogFile"
}
if ($content -match 'totalFailed: [1-9]') {
  Write-Error "Markdown preview latency autotest reported failed cases. Log: $LogFile"
}
if ($content -notmatch 'MPL-large-cache-hit-fast-path') {
  Write-Error "Missing MPL-large-cache-hit-fast-path assertion; the test may not have completed all 3 fixtures. Log: $LogFile"
}

Write-Host 'Markdown preview latency autotest passed'
Write-Host "  Log: $LogFile"
