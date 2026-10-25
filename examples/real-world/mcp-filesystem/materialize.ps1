#!/usr/bin/env pwsh
# Materialize one workspace per probe case.
#
# Each case gets its own directory under workspaces/<case-id>/ containing the
# files that case needs plus the shared probe.mjs driver and its probe.json.
# The suite points --workspace at that directory, so cases cannot leak state
# into each other (a file written by one case is invisible to the next).
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$driver = Join-Path $here 'probe.mjs'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Text([string]$path, [string]$text) {
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, $utf8)
}

$seeds = @{
  'write-then-read'       = @{ 'a.txt' = 'hello-craft' }
  'read-missing-file'     = @{}
  'create-directory'      = @{}
  'list-directory'        = @{ 'one.txt' = '1'; 'two.txt' = '2' }
  'list-with-sizes'       = @{ 'one.txt' = '1'; 'two.txt' = '22' }
  'directory-tree'        = @{ 'sub/inner.txt' = 'x' }
  'get-file-info'         = @{ 'target.txt' = 'info' }
  'allowed-directories'   = @{}
  'protocol-initializes'  = @{}
  'tools-listed'          = @{}
  'move-file'             = @{ 'mv-src.txt' = 'movable' }
  'edit-file'             = @{ 'edit.txt' = 'AAA and more' }
  'search-files'          = @{ 'hit.txt' = 'h'; 'skip.md' = 's' }
  'read-multiple'         = @{ 'm1.txt' = 'first'; 'm2.txt' = 'second' }
  'path-traversal-dotdot' = @{}
  'path-traversal-abs'    = @{}
  'write-outside-root'    = @{}
  'read-media-file'       = @{}
  'move-missing-source'   = @{}
  'list-missing-dir'      = @{}
  'create-dir-traversal'  = @{}
  'edit-no-match'         = @{ 'nomatch.txt' = 'nothing here' }
  'read-file-head'        = @{ 'long.txt' = "line1`nline2`nline3`nline4" }
  'search-no-match'       = @{ 'plain.txt' = 'p' }
}

$cases = Get-ChildItem (Join-Path $here 'probes') -Directory
foreach ($case in $cases) {
  $dest = Join-Path $here "workspaces/$($case.Name)"
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item $driver (Join-Path $dest 'probe.mjs')
  Copy-Item (Join-Path $case.FullName 'probe.json') (Join-Path $dest 'probe.json')
  Copy-Item (Join-Path $here 'check-tools.py') (Join-Path $dest 'check-tools.py')
  Copy-Item (Join-Path $here 'contains.py') (Join-Path $dest 'contains.py')
  $seed = $seeds[$case.Name]
  if ($null -ne $seed) {
    foreach ($name in $seed.Keys) { Write-Text (Join-Path $dest $name) $seed[$name] }
  }
}
Write-Output "materialized $($cases.Count) case workspaces"
