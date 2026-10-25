#!/usr/bin/env pwsh
# A/B comparison demo: grade two checkouts of the same subject and compare.
#
# This is the smallest end-to-end exercise of the Comparison layer: same suite,
# same runtime, two subject versions, one injected defect. It proves the metrics
# are real numbers rather than a restated exit code.
#
# The candidate is a copy of PocketFlow with one line changed: Node retries are
# capped at one attempt, ignoring max_retries. Exactly one case should notice.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cli = Join-Path $root 'dist/src/cli.js'
$suiteDir = Join-Path $root 'examples/real-world/pocketflow'
# Subjects live beside the repo: <workspace>/eval-subjects/<repo>.
$subjects = Join-Path (Split-Path -Parent $root) 'eval-subjects'
$baseline = Join-Path $subjects 'pocketflow'
$candidate = Join-Path $subjects 'pocketflow-candidate'
$out = Join-Path ([System.IO.Path]::GetTempPath()) 'craft-eval-ab'

if (-not (Test-Path $baseline)) {
  Write-Error "missing baseline checkout at $baseline"
  exit 2
}

# Build the candidate by copying the baseline and injecting one defect.
if (Test-Path $candidate) { Remove-Item $candidate -Recurse -Force }
Copy-Item $baseline $candidate -Recurse
$source = Join-Path $candidate 'pocketflow/__init__.py'
$text = Get-Content $source -Raw
$text = $text.Replace(
  'for self.cur_retry in range(self.max_retries):',
  'for self.cur_retry in range(1):  # INJECTED DEFECT: ignore max_retries'
)
Set-Content $source -Value $text -NoNewline

$utf8 = New-Object System.Text.UTF8Encoding($false)
$subjectFor = {
  param($repo, $version)
  @{ kind = 'software'; id = 'pocketflow'; version = $version; env = @{ POCKETFLOW_REPO = $repo } } |
    ConvertTo-Json -Depth 4
}
[System.IO.File]::WriteAllText((Join-Path $suiteDir 'subject.json'), (& $subjectFor $baseline 'baseline'), $utf8)
[System.IO.File]::WriteAllText((Join-Path $suiteDir 'subject-candidate.json'), (& $subjectFor $candidate 'candidate'), $utf8)

$runOne = {
  param($subjectFile, $label)
  $raw = & node $cli run (Join-Path $suiteDir 'suite.json') $subjectFile (Join-Path $suiteDir 'runtime.json') `
    --workspace (Join-Path $suiteDir 'workspace') --output $out 2>&1
  $parsed = $raw | ConvertFrom-Json
  # Return one object: mixing a status line into the pipeline would corrupt the
  # run_dir the caller needs.
  [pscustomobject]@{
    Label   = $label
    RunDir  = $parsed.run_dir
    Passed  = $parsed.report.passed
    Failed  = $parsed.report.failed
    Status  = $parsed.report.status
  }
}

$baselineRun = & $runOne (Join-Path $suiteDir 'subject.json') 'baseline'
$candidateRun = & $runOne (Join-Path $suiteDir 'subject-candidate.json') 'candidate'
foreach ($run in @($baselineRun, $candidateRun)) {
  Write-Output ("{0}: passed={1} failed={2} status={3}" -f $run.Label, $run.Passed, $run.Failed, $run.Status)
}

$comparison = (& node $cli compare $baselineRun.RunDir $candidateRun.RunDir 2>&1) | ConvertFrom-Json

Write-Output ''
Write-Output 'comparison:'
$comparison |
  Select-Object status, expected_pairs, measured_pairs, baseline_wins, candidate_wins, ties, one_sided_p,
    independent_task_runs |
  Format-List
Write-Output ("duration_ms: baseline mean={0:N1} (n={1})  candidate mean={2:N1} (n={3})" -f `
    $comparison.duration_ms.baseline.mean, $comparison.duration_ms.baseline.observed, `
    $comparison.duration_ms.candidate.mean, $comparison.duration_ms.candidate.observed)

# The injected defect must show up as a baseline win, not as noise.
if ($comparison.status -ne 'comparable' -or $comparison.baseline_wins -lt 1 -or $comparison.candidate_wins -ne 0) {
  Write-Error 'comparison did not detect the injected defect'
  exit 1
}
Write-Output 'OK: the injected defect was detected'
