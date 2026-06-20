# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Windows / PowerShell mirror of run-repo-prewarm-autotest.sh.
# Proves the prewarm-on-cwd-switch wiring (decisions ⑥/⑦):
#   TerminalGitInfoBridge.attachMirror -> RepoPrewarmCoordinator.prewarm ->
#   `main:git.prewarm.repo-triggered` perf-trace event.
# The event fires the instant the bridge resolves a cwd (BEFORE any git spawn),
# so this verifies the wiring independent of how slow the host's EDR-taxed git
# is — unlike the click-latency suite, whose 8s cold-getDiff budget is
# unmeetable when a single `git rev-parse` takes multiple seconds.
# Only PowerShell 5.1+ / pwsh 7+ is supported (per CLAUDE.md).

$ErrorActionPreference = 'Stop'

$RepoRoot = if ($env:REPO_ROOT) { $env:REPO_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
. (Join-Path $RepoRoot 'test\autotest\Resolve-DevAppBin.ps1')

$AppBin = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { Resolve-DevAppBin -RootDir $RepoRoot }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { Join-Path $RepoRoot 'traces\test-logs\repo-prewarm-autotest.log' }

$LogDir = Split-Path -Parent $LogFile
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Host "ERROR: app binary not found: $AppBin"
  Write-Host "Run a development build first: rm -rf out release; pnpm dist:dev"
  exit 1
}

$DwellSec = if ($env:REPO_PREWARM_DWELL_SEC) { [int]$env:REPO_PREWARM_DWELL_SEC } else { 40 }
$PrewarmEvent = 'main:git.prewarm.repo-triggered'
$UserDataDir = Join-Path $env:TEMP ('onward-prewarm-userdata-' + [guid]::NewGuid())
$ErrFile = "$LogFile.err"
New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
if (Test-Path $LogFile) { Remove-Item $LogFile -Force }

try {
  Write-Host 'Starting repo prewarm wiring autotest...'
  Write-Host "  Binary:        $AppBin"
  Write-Host "  Repo (cwd):    $RepoRoot"
  Write-Host "  User data dir: $UserDataDir"
  Write-Host "  Dwell:         ${DwellSec}s (killed after dwell; expected)"
  Write-Host "  Event:         $PrewarmEvent"
  Write-Host "  Log:           $LogFile"
  Write-Host ''

  # Launch in autotest mode with perf tracing. No suite + no ONWARD_AUTOTEST_EXIT:
  # the default terminal attaches to the repo root (a git repo) -> the bridge
  # fires the prewarm coordinator -> the trigger event lands in the trace.
  $env:ONWARD_DEBUG = '1'
  $env:ONWARD_PERF_TRACE = '1'
  $env:ONWARD_REPO_ROOT = $RepoRoot
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  $env:ONWARD_AUTOTEST = '1'
  $env:ONWARD_AUTOTEST_SUITE = 'repo-prewarm-wiring'
  Remove-Item Env:\ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue

  $proc = Start-Process -FilePath $AppBin -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile
  $exited = $proc.WaitForExit($DwellSec * 1000)
  if (-not $exited) {
    # Expected: the dwell elapsed, the prewarm has long since fired. Kill it.
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Write-Host "App ran for the full ${DwellSec}s dwell and was killed (expected)."
  } else {
    Write-Host "App exited on its own with code $($proc.ExitCode)."
    if ($proc.ExitCode -ne 0) {
      Write-Host "Repo prewarm autotest: app exited abnormally with code $($proc.ExitCode)"
      Get-Content $LogFile -Tail 40 -ErrorAction SilentlyContinue | Out-Host
      exit $proc.ExitCode
    }
  }

  # Locate the newest perf trace chunk.
  $TraceDir = Join-Path $RepoRoot 'traces\perf'
  $LatestTrace = $null
  $pointer = Join-Path $TraceDir 'latest.txt'
  if (Test-Path $pointer) {
    $candidate = (Get-Content $pointer -Raw).Trim()
    if ($candidate -and (Test-Path $candidate)) { $LatestTrace = $candidate }
  }
  if (-not $LatestTrace) {
    $LatestTrace = Get-ChildItem -Path $TraceDir -Filter 'perf-*.jsonl' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $LatestTrace -or -not (Test-Path $LatestTrace)) {
    Write-Host "ERROR: cannot locate perf trace file under $TraceDir"
    exit 1
  }

  Write-Host "Trace file: $LatestTrace"
  # Shared assertion (parity with the .sh runner): P3 wiring (repo-triggered) +
  # A2 aggregation (history-done with commitsWarmed > 0 == N commit-diffs warmed
  # in ONE `git log --raw --numstat` spawn). EDR-independent signals.
  & node (Join-Path $RepoRoot 'test\autotest\check-prewarm-aggregation.mjs') $LatestTrace
  if ($LASTEXITCODE -eq 0) {
    Write-Host 'Repo prewarm + git-op-aggregation autotest PASS'
    Write-Host '  PASS P3 wiring: coordinator fired on a real terminal attach (repo-triggered)'
    Write-Host '  PASS A1+A2 aggregation code launched cleanly; A2 history-batch end-to-end status in the SIGNALS JSON above (unit-pinned regardless)'
    exit 0
  }

  Write-Host 'ERROR: prewarm / aggregation regression - required signals missing (see JSON above)'
  Write-Host "  trace file: $LatestTrace"
  exit 1
}
finally {
  # Exact process-name match (per CLAUDE.md: never wildcard/partial when killing).
  $ProcName = [System.IO.Path]::GetFileNameWithoutExtension($AppBin)
  Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $AppBin } | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $UserDataDir -ErrorAction SilentlyContinue
  Remove-Item -Force $ErrFile -ErrorAction SilentlyContinue
}
