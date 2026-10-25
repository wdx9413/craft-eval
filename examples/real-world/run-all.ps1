#!/usr/bin/env pwsh
# Run every real-world suite against its checked-out subject and print a table.
# Subjects live outside the repo (eval-subjects/) because they are third-party
# checkouts; this script only orchestrates craft-eval over them.
$ErrorActionPreference = 'Stop'
# PSScriptRoot is examples/real-world; the repo root is two levels up.
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cli = Join-Path $root 'dist/src/cli.js'
$out = Join-Path ([System.IO.Path]::GetTempPath()) 'craft-eval-realworld'

$suites = @(
  @{ name = 'mcp-filesystem'; dir = 'mcp-filesystem'; workspace = 'workspace' },
  @{ name = 'claude-seo';     dir = 'claude-seo';     workspace = 'workspace' },
  @{ name = 'pocketflow';     dir = 'pocketflow';     workspace = 'workspace' },
  @{ name = 'craft-eval';     dir = 'craft-eval';     workspace = 'workspace' }
)

$rows = foreach ($suite in $suites) {
  $dir = Join-Path $root "examples/real-world/$($suite.dir)"
  $raw = & node $cli run (Join-Path $dir 'suite.json') (Join-Path $dir 'subject.json') (Join-Path $dir 'runtime.json') `
      --workspace (Join-Path $dir $suite.workspace) --output (Join-Path $out $suite.name) 2>&1
  $report = ($raw | ConvertFrom-Json).report
  [pscustomobject]@{
    Suite    = $suite.name
    Status   = $report.status
    Passed   = $report.passed
    Failed   = $report.failed
  }
}

$rows | Format-Table -AutoSize
if (($rows | Where-Object { $_.Status -ne 'complete' -or $_.Failed -gt 0 }).Count -gt 0) {
  exit 1
}
