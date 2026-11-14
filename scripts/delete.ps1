# Deletes the transcripts, folders and desktop sidebar records named on stdin:
#   { "paths": ["..."], "records": [{ "json": "...local_<uuid>.json", "uuid": "<uuid>" }] }
# Guards: every path must sit inside one of Claude's own data folders, links are
# never followed, and anything belonging to a session that is running now is skipped.
# A sidebar record is removed the way the desktop app removes one: a deleted_<uuid>
# tombstone (holding the time in ms) is written beside it, then the record goes.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$claude = Join-Path $env:USERPROFILE '.claude'

$roots = @(
  (Join-Path $claude 'projects'), (Join-Path $claude 'file-history'), (Join-Path $claude 'session-env')
)
$dataRoots = @()
$cd = Join-Path $env:LOCALAPPDATA 'Claude-Data'
if (Test-Path -LiteralPath $cd) { $dataRoots += @(Get-ChildItem -LiteralPath $cd -Directory | ForEach-Object { $_.FullName }) }
$dataRoots += (Join-Path $env:APPDATA 'Claude')
foreach ($d in $dataRoots) { $roots += (Join-Path $d 'claude-code-sessions'); $roots += (Join-Path $d 'local-agent-mode-sessions') }
$roots = @($roots | ForEach-Object { ([IO.Path]::GetFullPath($_)).TrimEnd('\').ToLowerInvariant() + '\' })

$live = @()
$sessDir = Join-Path $claude 'sessions'
if (Test-Path -LiteralPath $sessDir) {
  foreach ($f in Get-ChildItem -LiteralPath $sessDir -Filter '*.json' -File) {
    try {
      $s = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json
      if ($s.sessionId -and $s.pid -and (Get-Process -Id $s.pid -ErrorAction SilentlyContinue)) { $live += [string]$s.sessionId }
    } catch {}
  }
}

$deleted = New-Object System.Collections.Generic.List[string]
$skipped = New-Object System.Collections.Generic.List[object]
$tombstoned = 0
$freed = [int64]0

function Skip([string]$path, [string]$reason) { $skipped.Add([pscustomobject]@{ path = $path; reason = $reason }) }
function Inside([string]$path) {
  try { $full = [IO.Path]::GetFullPath($path) } catch { return $null }
  $low = $full.ToLowerInvariant()
  foreach ($r in $roots) { if ($low.StartsWith($r) -and $low.Length -gt $r.Length) { return $full } }
  return $null
}
function Live-Id([string]$path) { foreach ($id in $live) { if ($path -like "*$id*") { return $id } }; return $null }
function Size([string]$path) {
  if (Test-Path -LiteralPath $path -PathType Leaf) { return [int64](Get-Item -LiteralPath $path -Force).Length }
  $s = (Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  if ($s) { return [int64]$s } else { return [int64]0 }
}

foreach ($p in @($request.paths)) {
  if (-not $p) { continue }
  $full = Inside $p
  if (-not $full) { Skip $p 'outside Claude''s data folders'; continue }
  if (-not (Test-Path -LiteralPath $full)) { continue }
  $id = Live-Id $full
  if ($id) { Skip $full "session $id is running"; continue }
  $item = Get-Item -LiteralPath $full -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Skip $full 'is a link'; continue }
  try {
    $size = Size $full
    # .NET removes a link inside a folder without following it.
    if ($item.PSIsContainer) { [IO.Directory]::Delete($full, $true) } else { [IO.File]::Delete($full) }
    $deleted.Add($full); $freed += $size
  } catch { Skip $full $_.Exception.Message }
}

foreach ($r in @($request.records)) {
  if (-not $r -or -not $r.json -or -not $r.uuid) { continue }
  $full = Inside $r.json
  if (-not $full) { Skip $r.json 'outside Claude''s data folders'; continue }
  if ((Split-Path -Leaf $full) -ne "local_$($r.uuid).json") { Skip $full 'record name does not match its id'; continue }
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
  try {
    $rec = [IO.File]::ReadAllText($full) | ConvertFrom-Json
    $running = @(@($rec.cliSessionId, $rec.lastAssistantCliSessionId) | Where-Object { $_ -and ($live -contains $_) })
    if ($running.Count -gt 0) { Skip $full "session $($running[0]) is running"; continue }
  } catch {}
  try {
    $dir = Split-Path -Parent $full
    $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    [IO.File]::WriteAllText((Join-Path $dir "deleted_$($r.uuid)"), [string]$ms)
    $tombstoned++
    $size = (Get-Item -LiteralPath $full -Force).Length
    [IO.File]::Delete($full)
    $tmp = "$full.tmp"
    if (Test-Path -LiteralPath $tmp -PathType Leaf) { [IO.File]::Delete($tmp) }
    $deleted.Add($full); $freed += $size
  } catch { Skip $full $_.Exception.Message }
}

$out = [pscustomobject]@{ deleted = @($deleted.ToArray()); skipped = @($skipped.ToArray()); tombstoned = $tombstoned; freedBytes = $freed }
[Console]::Out.Write((ConvertTo-Json -InputObject $out -Depth 4 -Compress))
