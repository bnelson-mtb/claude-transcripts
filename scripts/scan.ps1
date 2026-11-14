# Lists every Claude Code / Cowork session transcript on this machine as JSON.
# Read-only: it never changes a file.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$errors = New-Object System.Collections.Generic.List[string]
$claude = Join-Path $env:USERPROFILE '.claude'
$projects = Join-Path $claude 'projects'

function To-Ms([datetime]$t) { [DateTimeOffset]::new($t.ToUniversalTime()).ToUnixTimeMilliseconds() }
function Read-Json([string]$path) {
  try { return ([IO.File]::ReadAllText($path) | ConvertFrom-Json) }
  catch { $errors.Add("could not read ${path}: $($_.Exception.Message)"); return $null }
}
function Dir-Bytes([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return [int64]0 }
  $s = (Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  if ($s) { return [int64]$s } else { return [int64]0 }
}
function Dir-Newest([string]$path) {
  $f = Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($f) { return (To-Ms $f.LastWriteTime) } else { return (To-Ms (Get-Item -LiteralPath $path -Force).LastWriteTime) }
}
function Unescape([string]$s) { try { return [regex]::Unescape($s) } catch { return $s } }
$jsonStr = '((?:[^"\\]|\\.)*)'
$reEntry = [regex]'"entrypoint":"([^"]+)"'
$reCwd = [regex]('"cwd":"' + $jsonStr + '"')
$reCustom = New-Object regex ('"customTitle":"' + $jsonStr + '"'), 'RightToLeft'
$reAi = New-Object regex ('"aiTitle":"' + $jsonStr + '"'), 'RightToLeft'
$reLastPrompt = New-Object regex ('"lastPrompt":"' + $jsonStr + '"'), 'RightToLeft'
$reTime = [regex]'"timestamp":"([^"]+)"'

# --- sessions running right now (never deleted) ---
$live = @{}
$sessDir = Join-Path $claude 'sessions'
if (Test-Path -LiteralPath $sessDir) {
  foreach ($f in Get-ChildItem -LiteralPath $sessDir -Filter '*.json' -File) {
    $s = Read-Json $f.FullName
    if ($s -and $s.sessionId -and $s.pid -and (Get-Process -Id $s.pid -ErrorAction SilentlyContinue)) { $live[[string]$s.sessionId] = $true }
  }
}

# --- desktop app data folders ---
$dataRoots = @()
$cd = Join-Path $env:LOCALAPPDATA 'Claude-Data'
if (Test-Path -LiteralPath $cd) { $dataRoots += @(Get-ChildItem -LiteralPath $cd -Directory | ForEach-Object { $_.FullName }) }
$legacy = Join-Path $env:APPDATA 'Claude'
if (Test-Path -LiteralPath (Join-Path $legacy 'claude-code-sessions')) { $dataRoots += $legacy }

$desktopRunning = [bool](Get-Process -Name 'claude' -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -and ($_.Path -like '*\WindowsApps\Claude_*' -or $_.Path -like '*\AnthropicClaude\*')
})

# --- desktop sidebar records (Code tab) ---
$records = @()
foreach ($root in $dataRoots) {
  $base = Join-Path $root 'claude-code-sessions'
  if (-not (Test-Path -LiteralPath $base)) { continue }
  foreach ($f in Get-ChildItem -LiteralPath $base -Recurse -Depth 2 -Filter 'local_*.json' -File) {
    if ($f.Name -notmatch '^local_(.+)\.json$') { continue }
    $r = Read-Json $f.FullName
    if (-not $r) { continue }
    $ids = @(@($r.cliSessionId, $r.lastAssistantCliSessionId) | Where-Object { $_ } | Select-Object -Unique)
    $records += [pscustomobject]@{
      json = $f.FullName; uuid = $Matches[1]; title = [string]$r.title; isArchived = [bool]$r.isArchived
      createdMs = [int64]($r.createdAt); lastMs = [int64]($r.lastActivityAt); cwd = [string]$r.cwd; ids = $ids
    }
  }
}
$recordsById = @{}
foreach ($r in $records) { foreach ($id in $r.ids) { if (-not $recordsById[$id]) { $recordsById[$id] = @() }; $recordsById[$id] += $r } }

# --- Code transcripts (desktop, CLI, VS Code, SDK...) ---
$tx = @{}
if (Test-Path -LiteralPath $projects) {
  foreach ($proj in Get-ChildItem -LiteralPath $projects -Directory) {
    foreach ($f in Get-ChildItem -LiteralPath $proj.FullName -Filter '*.jsonl' -File) {
      $id = $f.BaseName
      $text = ''
      try { $text = [IO.File]::ReadAllText($f.FullName) } catch { $errors.Add("could not read $($f.FullName)") }
      $m = $reEntry.Match($text); $entry = if ($m.Success) { $m.Groups[1].Value } else { '' }
      $m = $reCwd.Match($text); $cwd = if ($m.Success) { Unescape $m.Groups[1].Value } else { '' }
      $title = ''
      foreach ($re in @($reCustom, $reAi, $reLastPrompt)) {
        $m = $re.Match($text)
        if ($m.Success -and $m.Groups[1].Value) { $title = Unescape $m.Groups[1].Value; break }
      }
      $m = $reTime.Match($text)
      $created = To-Ms $f.CreationTime
      if ($m.Success) { try { $created = [DateTimeOffset]::Parse($m.Groups[1].Value).ToUnixTimeMilliseconds() } catch {} }
      $side = Join-Path $proj.FullName $id
      $paths = @($f.FullName)
      $bytes = [int64]$f.Length
      if (Test-Path -LiteralPath $side) { $paths += $side; $bytes += Dir-Bytes $side }
      foreach ($extra in @((Join-Path $claude "file-history\$id"), (Join-Path $claude "session-env\$id"))) {
        if (Test-Path -LiteralPath $extra) { $paths += $extra }
      }
      $tx[$id] = [pscustomobject]@{
        id = $id; entry = $entry; cwd = $cwd; title = $title; created = $created
        mtime = (To-Ms $f.LastWriteTime); bytes = $bytes; paths = $paths; project = $proj.Name
      }
    }
    # Leftovers: a session folder (subagents, tool results) whose transcript is gone.
    foreach ($d in Get-ChildItem -LiteralPath $proj.FullName -Directory) {
      if ($d.Name -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { continue }
      if (Test-Path -LiteralPath (Join-Path $proj.FullName "$($d.Name).jsonl")) { continue }
      $tx["leftover:$($proj.Name)/$($d.Name)"] = [pscustomobject]@{
        id = $d.Name; entry = '#leftover'; cwd = ''; title = "Leftover files of a deleted session ($($proj.Name))"
        created = (To-Ms $d.CreationTime); mtime = (Dir-Newest $d.FullName); bytes = (Dir-Bytes $d.FullName)
        paths = @($d.FullName); project = $proj.Name
      }
    }
  }
}

function Group-Of([string]$entry) {
  switch ($entry) { 'claude-desktop' { 'desktop' } 'cli' { 'cli' } 'claude-vscode' { 'vscode' } default { 'other' } }
}

$rows = New-Object System.Collections.Generic.List[object]
$used = @{}
$usedRecords = @{}

# A sidebar record and every transcript it links make one row, so deleting it removes all of them.
foreach ($r in $records) {
  if ($usedRecords[$r.json]) { continue }
  $have = @($r.ids | Where-Object { $tx.ContainsKey($_) -and -not $used[$_] })
  $recs = @($r)
  foreach ($id in $have) { foreach ($o in @($recordsById[$id])) { if ($o -and $recs -notcontains $o) { $recs += $o } } }
  foreach ($o in $recs) { $usedRecords[$o.json] = $true }
  $items = @($have | ForEach-Object { $tx[$_] })
  foreach ($id in $have) { $used[$id] = $true }
  $isLive = [bool]($r.ids | Where-Object { $live[$_] })
  if ($items.Count -eq 0) {
    $rows.Add([pscustomobject]@{
      key = "rec:$($r.uuid)"; group = 'desktop'; kind = 'sidebar-only'; title = $(if ($r.title) { $r.title } else { '(untitled)' })
      ids = @($r.ids); cwd = $r.cwd; bytes = [int64]0; mtimeMs = $r.lastMs; createdMs = $r.createdMs
      isLive = $isLive; inSidebar = $true; isArchived = $r.isArchived; isProtected = $false
      paths = @(); records = @($recs | ForEach-Object { [pscustomobject]@{ json = $_.json; uuid = $_.uuid } })
    })
    continue
  }
  $first = $items[0]
  $rows.Add([pscustomobject]@{
    key = "tx:$($first.id)"; group = (Group-Of $first.entry); kind = 'code'
    title = $(if ($r.title) { $r.title } elseif ($first.title) { $first.title } else { '(untitled)' })
    ids = @($items | ForEach-Object { $_.id }); cwd = $(if ($first.cwd) { $first.cwd } else { $r.cwd })
    bytes = [int64](($items | Measure-Object bytes -Sum).Sum); mtimeMs = [int64](($items | Measure-Object mtime -Maximum).Maximum)
    createdMs = [int64](($items | Measure-Object created -Minimum).Minimum)
    isLive = ($isLive -or [bool]($items | Where-Object { $live[$_.id] })); inSidebar = $true
    isArchived = [bool]($recs | Where-Object { $_.isArchived }); isProtected = $false
    paths = @($items | ForEach-Object { $_.paths }); records = @($recs | ForEach-Object { [pscustomobject]@{ json = $_.json; uuid = $_.uuid } })
  })
}

foreach ($k in $tx.Keys) {
  if ($used[$k]) { continue }
  $t = $tx[$k]
  $isLeftover = $t.entry -eq '#leftover'
  $rows.Add([pscustomobject]@{
    key = $(if ($isLeftover) { "left:$($t.project)/$($t.id)" } else { "tx:$($t.id)" })
    group = $(if ($isLeftover) { 'other' } else { Group-Of $t.entry }); kind = $(if ($isLeftover) { 'leftover' } else { 'code' })
    title = $(if ($t.title) { $t.title } else { '(untitled)' }); ids = @($t.id); cwd = $t.cwd
    bytes = $t.bytes; mtimeMs = $t.mtime; createdMs = $t.created
    isLive = [bool]$live[$t.id]; inSidebar = $false; isArchived = $false; isProtected = $false
    paths = @($t.paths); records = @()
  })
}

# --- Cowork local sessions ---
foreach ($root in $dataRoots) {
  $base = Join-Path $root 'local-agent-mode-sessions'
  if (-not (Test-Path -LiteralPath $base)) { continue }
  foreach ($f in Get-ChildItem -LiteralPath $base -Recurse -Depth 3 -Filter 'local_*.json' -File) {
    if ($f.Name -notmatch '^local_(.+)\.json$') { continue }
    $uuid = $Matches[1]
    $r = Read-Json $f.FullName
    if (-not $r) { continue }
    $folder = Join-Path $f.DirectoryName ($f.BaseName)
    $paths = @()
    $bytes = [int64]$f.Length
    if (Test-Path -LiteralPath $folder) { $paths += $folder; $bytes += Dir-Bytes $folder }
    $title = if ($r.title) { [string]$r.title } elseif ($r.initialMessage) { [string]$r.initialMessage } else { '(untitled)' }
    $isAgentHome = $uuid -like 'ditto_*'
    if ($isAgentHome) { $title = "Cowork agent home: $title" }
    $rows.Add([pscustomobject]@{
      key = "cw:$uuid"; group = 'cowork'; kind = 'cowork'; title = $title
      ids = @([string]$r.cliSessionId); cwd = $(if ($r.userSelectedFolders) { [string](@($r.userSelectedFolders)[0]) } else { [string]$r.cwd })
      bytes = $bytes; mtimeMs = [int64][Math]::Max([int64]$r.lastActivityAt, (To-Ms $f.LastWriteTime)); createdMs = [int64]$r.createdAt
      isLive = $false; inSidebar = $true; isArchived = [bool]$r.isArchived; isProtected = $isAgentHome
      paths = $paths; records = @([pscustomobject]@{ json = $f.FullName; uuid = $uuid })
    })
  }
}

$out = [pscustomobject]@{
  scannedAt = (To-Ms (Get-Date)); desktopRunning = $desktopRunning
  rows = @($rows.ToArray()); errors = @($errors.ToArray())
}
[Console]::Out.Write((ConvertTo-Json -InputObject $out -Depth 6 -Compress))
