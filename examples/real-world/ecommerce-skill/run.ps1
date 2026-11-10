#!/usr/bin/env pwsh
# Run the ecommerce-visual-copywriting business-skill evaluation.
#
# This suite drives a real Codex host (see subject.json) and grades the model's
# output against the skill's own test-prompts.json rules. It is intentionally
# separate from run-all.ps1: it needs a logged-in Codex CLI, network access, and
# several minutes per case, while the other real-world suites are deterministic
# local checks.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$cli = Join-Path $root 'dist/src/cli.js'
$out = Join-Path ([System.IO.Path]::GetTempPath()) 'craft-eval-ecommerce-skill'

$raw = & node $cli run (Join-Path $PSScriptRoot 'suite.json') (Join-Path $PSScriptRoot 'subject.json') `
    (Join-Path $PSScriptRoot 'runtime.json') --workspace (Join-Path $PSScriptRoot 'workspace') `
    --output $out --keep-traces 2>&1
$result = $raw | ConvertFrom-Json
$report = $result.report

[pscustomobject]@{
  Suite  = 'ecommerce-skill'
  Cases  = $report.expected
  Status = $report.status
  Passed = $report.passed
  Failed = $report.failed
} | Format-Table -AutoSize
Write-Output "run_dir: $($result.run_dir)"

if ($report.status -ne 'complete' -or $report.failed -gt 0) {
  exit 1
}
