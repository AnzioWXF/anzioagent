# publish-tiangong-update.ps1 — 发布新壳（官方 desktop 壳 + 天工接入）的增量更新包
#
# 与旧的 publish-update.ps1 的区别：目标路径全变了（旧壳是 resources\app 散文件，新壳是
# resources\tiangong-shell + 家目录里的插件）。**官方内核（Electron / app.asar / dsh 运行时）
# 不在增量链路里** —— 它换版本才动，走整包重装。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\publish-tiangong-update.ps1 -Notes "改了 xxx"
#   ... -Version 1.6.1        # 指定版本（默认：已安装 +1 patch）
#   ... -Full                 # 全量（基线为空时自动等价于全量）
#   ... -SkipPlugin / -SkipShell
#   ... -DryRun               # 只报告要发哪些，不写更新源
#
# 应用侧：启动 3 秒后查 latest.json → 弹「检测到新版本」→ 下载校验 → 重启并装。
param(
  [string]$Version = '',
  [string]$Notes = '',
  [string]$InstallDir = '',
  [string]$ShellDir = '',
  [string]$PluginDir = '',
  [string]$HomeDir = '',
  [string]$ProfileName = 'desktop',
  [switch]$Full,
  [switch]$SkipShell,
  [switch]$SkipPlugin,
  [switch]$Force,
  [switch]$DryRun,
  [switch]$InitBaseline
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_paths.ps1')
if (-not $InstallDir) { $InstallDir = $installDirDefault }
if (-not $ShellDir) { $ShellDir = $shellDirRepo }
if (-not $PluginDir) { $PluginDir = $pluginDirRepo }
if (-not $HomeDir) { $HomeDir = $appHomeDir }

$exeName = '天工.exe'

function Get-Sha256($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function Rel($base, $full) { $full.Substring($base.Length + 1) -replace '\\', '/' }

# ── 已安装版本 + 基线 ──
$versionFile = Join-Path $InstallDir 'version.json'
$installed = '0.0.0'
$base = @{}
if (Test-Path -LiteralPath $versionFile) {
  $v = Get-Content -Raw -LiteralPath $versionFile | ConvertFrom-Json
  $installed = [string]$v.version
  if ($v.files) { foreach ($p in $v.files.PSObject.Properties) { $base[$p.Name] = [string]$p.Value } }
}

if (-not $Version) {
  # 版本号必须同时看"已安装"与"更新源里已发布的最高版"，否则会与未装的那一版撞号。
  $baseline = $installed
  $feedLatest = Join-Path (Join-Path $InstallDir '_updates') 'latest.json'
  if (Test-Path -LiteralPath $feedLatest) {
    try {
      $lf = [System.IO.File]::ReadAllText($feedLatest, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
      if ($lf.version) {
        $a = @($installed.Split('.') | ForEach-Object { [int]$_ })
        $b = @(([string]$lf.version).Split('.') | ForEach-Object { [int]$_ })
        while ($a.Count -lt 3) { $a += 0 }
        while ($b.Count -lt 3) { $b += 0 }
        $cmp = 0
        for ($i = 0; $i -lt 3; $i++) { if ($a[$i] -ne $b[$i]) { $cmp = $a[$i] - $b[$i]; break } }
        if ($cmp -lt 0) { $baseline = [string]$lf.version }
      }
    } catch { }
  }
  $parts = $baseline.Split('.')
  while ($parts.Count -lt 3) { $parts += '0' }
  $Version = '{0}.{1}.{2}' -f $parts[0], $parts[1], ([int]$parts[2] + 1)
}
Write-Host ("发布版本: v{0}   (已安装 v{1}, 基线文件 {2} 个)" -f $Version, $installed, $base.Count)

# ── 汇总候选：key = 基线里的相对键 → @{ src; dest } ──
$cand = [ordered]@{}

if (-not $SkipShell) {
  $shellNames = @('browser.js', 'browser-ext.js', 'browser-preload.js', 'bridge.js', 'driver.js', 'updater.js')
  foreach ($n in $shellNames) {
    $p = Join-Path $ShellDir $n
    if (-not (Test-Path -LiteralPath $p)) { throw "找不到壳半文件: $p" }
    $cand['shell/' + $n] = @{ src = $p; dest = ('${INSTALL}\resources\tiangong-shell\' + $n) }
  }
  # 家目录级产品文件（AGENTS.md 这类常驻指令）；profiles\ 是用户配置，永不进包
  $homeFiles = Join-Path $ShellDir 'home-files'
  if (Test-Path -LiteralPath $homeFiles) {
    foreach ($f in (Get-ChildItem -LiteralPath $homeFiles -Recurse -File -Force)) {
      $rel = Rel $homeFiles $f.FullName
      if ($rel -like 'profiles/*') { continue }
      $cand['home/' + $rel] = @{ src = $f.FullName; dest = ('${HOME}\' + ($rel -replace '/', '\')) }
    }
  }
}

if (-not $SkipPlugin) {
  if (-not (Test-Path -LiteralPath $PluginDir)) { throw "找不到插件源码: $PluginDir" }
  $pluginRoot = Join-Path (Join-Path (Join-Path $HomeDir 'profiles') $ProfileName) 'node_modules\dsh-ide'
  foreach ($f in (Get-ChildItem -LiteralPath $PluginDir -Recurse -File -Force | Where-Object { $_.FullName -notmatch '\\node_modules\\' })) {
    $rel = Rel $PluginDir $f.FullName
    $cand['plugin/' + $rel] = @{ src = $f.FullName; dest = (('${HOME}\profiles\' + $ProfileName + '\node_modules\dsh-ide\') + ($rel -replace '/', '\')) }
  }
}

# ── 初始化基线（装完第一次跑：把当前文件的哈希记成 version.json，之后发布才是真增量）──
if ($InitBaseline) {
  $map = [ordered]@{}
  foreach ($k in $cand.Keys) { $map[$k] = Get-Sha256 $cand[$k].src }
  $doc = [ordered]@{
    version     = $Version
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    previous    = $null
    source      = 'baseline-init'
    notes       = $Notes
    files       = $map
  }
  [System.IO.File]::WriteAllText($versionFile, ($doc | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ("基线已写入: {0}  (v{1}, {2} 个文件)" -f $versionFile, $Version, $map.Count)
  exit 0
}

# ── 增量比对 ──
$feedDir = Join-Path $InstallDir '_updates'
$target = Join-Path $feedDir ('v' + $Version)
$files = New-Object System.Collections.ArrayList
$total = 0
foreach ($k in $cand.Keys) {
  $c = $cand[$k]
  $h = Get-Sha256 $c.src
  if ($base.ContainsKey($k) -and $base[$k] -eq $h) { continue }
  $size = (Get-Item -LiteralPath $c.src).Length
  $total += $size
  [void]$files.Add([ordered]@{ src = $k; dest = $c.dest; sha256 = $h; size = $size; _local = $c.src })
}

# 删除只在本次发布范围内算；home/profiles 永不删
$deletions = @()
$delScopes = @()
if (-not $SkipShell) { $delScopes += 'shell/'; $delScopes += 'home/' }
if (-not $SkipPlugin) { $delScopes += 'plugin/' }
foreach ($k in $base.Keys) {
  if ($k -like 'home/profiles/*') { continue }
  foreach ($s in $delScopes) {
    if ($k.StartsWith($s) -and -not $cand.Contains($k)) { $deletions += $k; break }
  }
}

Write-Host ("需要下发: {0} 个文件, {1:N2} MB；删除 {2} 个" -f $files.Count, ($total / 1MB), $deletions.Count)
foreach ($f in $files) { Write-Host ("   " + $f.src) }
foreach ($d in $deletions) { Write-Host ("   [删除] " + $d) }

if ($DryRun) { Write-Host '（-DryRun：只报告）'; exit 0 }
if ($files.Count -eq 0 -and $deletions.Count -eq 0) { Write-Host '没有变化，不发布（-Force 可强制发空包用于验证链路）'; if (-not $Force) { exit 0 } }

# ── 写更新源 ──
New-Item -ItemType Directory -Force -Path $target | Out-Null
$outFiles = New-Object System.Collections.ArrayList
foreach ($f in $files) {
  $destFile = Join-Path $target ($f.src -replace '/', '\')
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destFile) | Out-Null
  Copy-Item -LiteralPath $f._local -Destination $destFile -Force
  [void]$outFiles.Add([ordered]@{ src = $f.src; dest = $f.dest; sha256 = $f.sha256; size = $f.size })
}
$latest = [ordered]@{
  version    = $Version
  builtAt    = (Get-Date).ToUniversalTime().ToString('o')
  notes      = $Notes
  kind       = if ($Full) { 'full' } else { 'incremental' }
  previous   = $installed
  fileCount  = $outFiles.Count
  totalBytes = $total
  files      = $outFiles
  deletions  = $deletions
}
$latestFile = Join-Path $feedDir 'latest.json'
[System.IO.File]::WriteAllText($latestFile, ($latest | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ''
Write-Host ("发布完成: {0}" -f $latestFile)
Write-Host ("应用侧：打开 {0} 会在启动几秒后提示" -f $exeName)
