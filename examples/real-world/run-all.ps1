#!/usr/bin/env pwsh
# Run every real-world suite against its checked-out subject and print a table.
# Subjects live outside the repo (eval-subjects/) because they are third-party
# checkouts; this script only orchestrates craft-eval over them.
$ErrorActionPreference = 'Stop'
# PSScriptRoot is examples/real-world; the repo root is two levels up.
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cli = Join-Path $root 'dist/src/cli.js'
$out = Join-Path ([System.IO.Path]::GetTempPath()) 'craft-eval-realworld'

# `workspace` is the --workspace root. mcp-filesystem points at the suite
# directory itself because each of its cases selects workspaces/<case>/.
$suites = @(
  @{ name = 'mcp-filesystem'; workspace = '.' },
  @{ name = 'claude-seo';     workspace = 'workspace' },
  @{ name = 'pocketflow';     workspace = 'workspace' },
  @{ name = 'craft-eval';     workspace = 'workspace' }
)

$rows = foreach ($suite in $suites) {
  $dir = Join-Path $root "examples/real-world/$($suite.name)"
  $suiteFile = Join-Path $dir 'suite.json'
  $cases = (Get-Content $suiteFile -Raw | ConvertFrom-Json).cases.Count
  $raw = & node $cli run $suiteFile (Join-Path $dir 'subject.json') (Join-Path $dir 'runtime.json') `
      --workspace (Join-Path $dir $suite.workspace) --output (Join-Path $out $suite.name) --keep-traces 2>&1
  $report = ($raw | ConvertFrom-Json).report
  [pscustomobject]@{
    Suite    = $suite.name
    Cases    = $cases
    Status   = $report.status
    Passed   = $report.passed
    Failed   = $report.failed
  }
}

$rows | Format-Table -AutoSize
$totalCases = ($rows | Measure-Object -Property Cases -Sum).Sum
$totalPassed = ($rows | Measure-Object -Property Passed -Sum).Sum
Write-Output "total: $totalPassed/$totalCases cases passed"
if (($rows | Where-Object { $_.Status -ne 'complete' -or $_.Failed -gt 0 }).Count -gt 0) {
  exit 1
}
