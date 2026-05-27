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

$UserDataRoot = Join-Path $env:TEMP ("onward-gsm-userdata-" + [guid]::NewGuid())
$FixtureTmp  = Join-Path $env:TEMP ("onward-gsm-fixture-"  + [guid]::NewGuid())
$FixtureSrc  = Join-Path $RepoRoot 'test\autotest\fixtures\git-state-mirror-latency'

New-Item -ItemType Directory -Path $UserDataRoot -Force | Out-Null
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

  @(
    'Starting Git State Mirror latency autotest...'
    "  Binary:         $AppBin"
    "  Fixture src:    $FixtureSrc"
    "  Fixture tmp:    $FixtureTmp"
    "  Manifest:       $ManifestPath"
    "  User data root: $UserDataRoot"
    "  Log:            $LogFile"
    ''
  ) | Add-Content -Path $LogFile

  function Invoke-GsmPass {
    param(
      [string]$Label,
      [string]$FailureEnvName = ''
    )
    $UserDataDir = Join-Path $UserDataRoot $Label
    New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null

    Add-Content -Path $LogFile -Value ''
    Add-Content -Path $LogFile -Value "=== Git State Mirror latency pass: $Label ==="

    $env:ONWARD_DEBUG = '1'
    $env:ONWARD_PERF_TRACE = '1'
    $env:ONWARD_REPO_ROOT = $RepoRoot
    $env:ONWARD_USER_DATA_DIR = $UserDataDir
    $env:ONWARD_AUTOTEST = '1'
    $env:ONWARD_AUTOTEST_SUITE = 'git-state-mirror-latency'
    $env:ONWARD_AUTOTEST_CWD = (Join-Path $FixtureTmp 'repo-A')
    $env:ONWARD_AUTOTEST_FIXTURE_EXTRA = $ManifestPath
    $env:ONWARD_AUTOTEST_EXIT = '1'
    Remove-Item Env:\ONWARD_AUTOTEST_GSM_WATCHER_FAIL_SUBSCRIBE_ONCE -ErrorAction SilentlyContinue
    Remove-Item Env:\ONWARD_AUTOTEST_GSM_WATCHER_FAIL_CALLBACK_ONCE -ErrorAction SilentlyContinue
    if ($FailureEnvName) {
      Set-Item -Path "Env:\$FailureEnvName" -Value '1'
    }

    & $AppBin *>> $LogFile
  }

  Invoke-GsmPass -Label 'baseline'
  Invoke-GsmPass -Label 'subscribe-failure' -FailureEnvName 'ONWARD_AUTOTEST_GSM_WATCHER_FAIL_SUBSCRIBE_ONCE'
  Invoke-GsmPass -Label 'callback-failure' -FailureEnvName 'ONWARD_AUTOTEST_GSM_WATCHER_FAIL_CALLBACK_ONCE'

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

  if (-not (Select-String -Path $LogFile -Pattern 'GSM-13-trace-marker-mirror-events-expected' -Quiet)) {
    Write-Host 'Missing GSM-13 marker; the mirror trace coverage test did not run to completion'
    Get-Content $LogFile -Tail 40 | Out-Host
    exit 1
  }

  if (-not (Select-String -Path $LogFile -Pattern 'GSM-14-force-refresh-bumps-generation' -Quiet)) {
    Write-Host 'Missing GSM-14 marker; the generation refresh test did not run to completion'
    Get-Content $LogFile -Tail 40 | Out-Host
    exit 1
  }

  if (-not (Select-String -Path $LogFile -Pattern 'GSM-17-two-tasks-same-repo-consistent-status-cycles' -Quiet)) {
    Write-Host 'Missing GSM-17 marker; the two-Task same-repo status consistency test did not run to completion'
    Get-Content $LogFile -Tail 40 | Out-Host
    exit 1
  }

  if (-not (Select-String -Path $LogFile -Pattern 'GSM-15-watcher-subscribe-failure-recovers' -Quiet)) {
    Write-Host 'Missing GSM-15 marker; the subscribe failure recovery test did not run to completion'
    Get-Content $LogFile -Tail 40 | Out-Host
    exit 1
  }

  if (-not (Select-String -Path $LogFile -Pattern 'GSM-16-watcher-callback-failure-recovers' -Quiet)) {
    Write-Host 'Missing GSM-16 marker; the callback failure recovery test did not run to completion'
    Get-Content $LogFile -Tail 40 | Out-Host
    exit 1
  }

  if (-not (Select-String -Path $LogFile -Pattern 'autotest watcher failure injection active' -Quiet)) {
    Write-Host 'Missing watcher failure injection log marker'
    Get-Content $LogFile -Tail 40 | Out-Host
    exit 1
  }

  if (-not (Select-String -Path $LogFile -Pattern 'git-state-mirror-latency:done' -Quiet)) {
    Write-Host 'Missing git-state-mirror-latency:done marker; the suite did not finish cleanly'
    Get-Content $LogFile -Tail 40 | Out-Host
    exit 1
  }

  Write-Host 'Git State Mirror latency autotest passed'
  Write-Host "  Log: $LogFile"

} finally {
  if (Test-Path $UserDataRoot) { Remove-Item $UserDataRoot -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $FixtureTmp)  { Remove-Item $FixtureTmp  -Recurse -Force -ErrorAction SilentlyContinue }
  Get-ChildItem -Path $RepoRoot -Filter '__autotest_*' -Force | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}
