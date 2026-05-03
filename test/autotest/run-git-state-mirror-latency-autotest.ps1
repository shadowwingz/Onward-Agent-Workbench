# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Windows / PowerShell mirror of run-git-state-mirror-latency-autotest.sh.
# Extracts the committed fixture tarballs into a per-run temp dir, launches
# the dev build with autotest env wiring, and surfaces the same pass/fail
# semantics. Only PowerShell 5.1+ / pwsh 7+ is supported (per CLAUDE.md).

$ErrorActionPreference = 'Stop'

$RepoRoot = if ($env:REPO_ROOT) { $env:REPO_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
. (Join-Path $RepoRoot 'test\autotest\Resolve-DevAppBin.ps1')

$AppBin = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { Resolve-DevAppBin -RepoRoot $RepoRoot }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { Join-Path $RepoRoot 'traces\test-logs\git-state-mirror-latency-autotest.log' }

$LogDir = Split-Path -Parent $LogFile
if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Host "ERROR: app binary not found or not executable: $AppBin"
  Write-Host "Run a development build first: rm -rf out release; pnpm dist:dev"
  exit 1
}

$UserDataDir = Join-Path $env:TEMP ("onward-gsm-userdata-" + [guid]::NewGuid())
$FixtureTmp  = Join-Path $env:TEMP ("onward-gsm-fixture-"  + [guid]::NewGuid())
$FixtureSrc  = Join-Path $RepoRoot 'test\autotest\fixtures\git-state-mirror-latency'

New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
New-Item -ItemType Directory -Path $FixtureTmp  -Force | Out-Null

try {
  # Extract every committed fixture tarball into the per-run staging dir.
  Get-ChildItem -Path $FixtureSrc -Filter '*.tar.gz' | ForEach-Object {
    & tar.exe -xzf $_.FullName -C $FixtureTmp
    if ($LASTEXITCODE -ne 0) {
      throw "tar -xzf failed for $($_.Name)"
    }
  }

  if (-not (Test-Path (Join-Path $FixtureTmp 'repo-A'))) {
    Write-Host 'ERROR: fixture extraction failed; expected repo-A directory'
    Get-ChildItem $FixtureSrc | Out-String | Write-Host
    exit 1
  }

  # Inject `tempRoot` into the manifest copy used by the autotest TS.
  $ManifestPath = Join-Path $FixtureTmp 'manifest.json'
  $manifest = Get-Content (Join-Path $FixtureSrc 'manifest.json') | ConvertFrom-Json
  $manifest | Add-Member -NotePropertyName tempRoot -NotePropertyValue $FixtureTmp -Force
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding UTF8

  if (Test-Path $LogFile) { Remove-Item $LogFile -Force }

  Write-Host 'Starting Git State Mirror latency autotest...'
  Write-Host "  Binary:        $AppBin"
  Write-Host "  Fixture src:   $FixtureSrc"
  Write-Host "  Fixture tmp:   $FixtureTmp"
  Write-Host "  Manifest:      $ManifestPath"
  Write-Host "  User data dir: $UserDataDir"
  Write-Host "  Log:           $LogFile"

  $env:ONWARD_DEBUG = '1'
  $env:ONWARD_PERF_TRACE = '1'
  $env:ONWARD_REPO_ROOT = $RepoRoot
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  $env:ONWARD_AUTOTEST = '1'
  $env:ONWARD_AUTOTEST_SUITE = 'git-state-mirror-latency'
  $env:ONWARD_AUTOTEST_CWD = (Join-Path $FixtureTmp 'repo-A')
  $env:ONWARD_AUTOTEST_FIXTURE_EXTRA = $ManifestPath
  $env:ONWARD_AUTOTEST_EXIT = '1'

  & $AppBin *> $LogFile

  Write-Host ''
  Write-Host '=== Test log (last 60 lines) ==='
  Get-Content $LogFile -Tail 60 | Out-Host

  if (Select-String -Path $LogFile -Pattern '\[AutoTest\] FAIL' -Quiet) {
    Write-Host 'Git State Mirror latency autotest failed'
    Write-Host ''
    Write-Host '=== Failure details ==='
    Select-String -Path $LogFile -Pattern '\[AutoTest\] FAIL' | ForEach-Object { Write-Host $_.Line }
    exit 1
  }

  if (-not (Select-String -Path $LogFile -Pattern 'GSM-00-fixture-loaded' -Quiet)) {
    Write-Host 'Missing GSM-00 marker; the test may not have executed correctly'
    Get-Content $LogFile -Tail 40 | Out-Host
    exit 1
  }

  Write-Host 'Git State Mirror latency autotest passed'
  Write-Host "  Log: $LogFile"

} finally {
  if (Test-Path $UserDataDir) { Remove-Item $UserDataDir -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $FixtureTmp)  { Remove-Item $FixtureTmp  -Recurse -Force -ErrorAction SilentlyContinue }
  Get-ChildItem -Path $RepoRoot -Filter '__autotest_*' -Force | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}
