# publish-update.ps1 — 发布一个更新包到安装目录的更新源（默认 <安装目录>\_updates）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\publish-update.ps1 -Notes "改了 xxx"
#   ... -Version 1.3.5          # 指定版本（默认：已安装版本 +1 patch）
#   ... -Full                   # 全量包（含 Electron 运行时/exe，Electron 升级时才用）
#   ... -SkipPlugin / -SkipShell
#
# 做的事：① 汇总"壳 + IDE 插件"的当前文件（全量时再加上整份 win-unpacked）
#         ② 与已安装基线（安装目录 version.json 的 files）逐文件 sha256 对比 → 只发变化的文件
#         ③ 写 <feed>\v<版本>\files\** + <feed>\latest.json
#         ④ 同步把 deepseek-harness-mine\shell\package.json 的版本号改成新版本（下次全量打包带上）
# 应用侧：启动时自动读 latest.json → 弹「检测到新版本」→ 下载校验 → 重启并安装
param(
  [string]$Version = '',
  [string]$Notes = '',
  [string]$InstallDir = '',
  [string]$ShellDir = '',
  [string]$DevPlugin = '',
  [string]$AppHome = '',
  [switch]$Full,
  [switch]$SkipShell,
  [switch]$SkipPlugin,
  [switch]$Force,
  [switch]$DryRun,
  [switch]$SkipSource
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_paths.ps1')
if (-not $InstallDir) { $InstallDir = $installDirDefault }
if (-not $ShellDir) { $ShellDir = $shellDirRepo }
if (-not $DevPlugin) { $DevPlugin = Join-Path $devHomeDir 'profiles\web\ide\dsh-ide' }
if (-not $AppHome) { $AppHome = $appHomeDir }

$exeName = '天工.exe'   # 安装目录里的 exe 名（2026-09-17 改名天工）
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
  # ⚠ 默认版本必须同时看"已安装"和"更新源里已发布的最高版"：只按"已安装 +1"算，
  # 会在用户还没装上一版时**与上一版撞号**（2026-09-20 实测：v1.5.14 被发了两次，
  # 第二次把第一次的包覆盖了，而站点那边拒发同版本源码 → 两边对不上）。
  $baseline = $installed
  $feedLatest = Join-Path (Join-Path $InstallDir '_updates') 'latest.json'   # ⚠ $feedDir 在这之后才定义，这里自己拼
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
  $patch = [int]$parts[2] + 1
  $Version = '{0}.{1}.{2}' -f $parts[0], $parts[1], $patch
  if ($baseline -ne $installed) { Write-Host ("  （更新源已有 v{0} 未安装 → 从它往上递增，避免撞号）" -f $baseline) -ForegroundColor Yellow }
}
Write-Host ("发布版本: v{0}   (已安装 v{1}, 基线文件 {2} 个)" -f $Version, $installed, $base.Count)

# ── 汇总候选文件：key(基线里的相对键) -> @{ src; dest; scope } ──
$cand = [ordered]@{}

if ($Full) {
  $buildDir = Join-Path $ShellDir 'release\win-unpacked'
  if (-not (Test-Path -LiteralPath $buildDir)) { throw "全量发布需要打包产物: $buildDir" }
  foreach ($f in (Get-ChildItem -LiteralPath $buildDir -Recurse -File -Force)) {
    $rel = Rel $buildDir $f.FullName
    $destRel = if ($rel -eq 'DSH IDE.exe' -or $rel -eq '天工.exe') { $exeName } else { $rel }
    $cand['shell/' + $rel] = @{ src = $f.FullName; dest = ('${INSTALL}\' + ($destRel -replace '/', '\')); scope = 'shell' }
  }
} elseif (-not $SkipShell) {
  $shellFiles = @('main.js', 'backend.js', 'updater.js', 'preload.js', 'browser.js', 'browser-preload.js', 'driver.js', 'bridge.js', 'error.html', 'loading.html')
  foreach ($n in $shellFiles) {
    $p = Join-Path $ShellDir $n
    if (Test-Path -LiteralPath $p) { $cand['shell/resources/app/' + $n] = @{ src = $p; dest = ('${INSTALL}\resources\app\' + $n); scope = 'shell' } }
  }
  $assets = Join-Path $ShellDir 'assets'
  if (Test-Path -LiteralPath $assets) {
    foreach ($f in (Get-ChildItem -LiteralPath $assets -Recurse -File -Force)) {
      $rel = Rel $assets $f.FullName
      $cand['shell/resources/app/assets/' + $rel] = @{ src = $f.FullName; dest = ('${INSTALL}\resources\app\assets\' + ($rel -replace '/', '\')); scope = 'shell' }
    }
  }
  # 运行时依赖（生产 dependencies）也要跟着壳走：playwright-core 缺了，"Agent 亲手操作内置浏览器"
  # 直接起不来（2026-10-08 补的挂账：之前增量包根本带不上 node_modules）。
  # 键前缀与 --Full 路径一致（shell/resources/app/node_modules/...）⇒ 基线能对上，增量只发改动过的文件；
  # 13MB 只在第一次发布时进包。
  foreach ($m in @('playwright-core')) {
    $modDir = Join-Path (Join-Path $ShellDir 'node_modules') $m
    if (-not (Test-Path -LiteralPath $modDir)) { throw "找不到运行时依赖 $m（先在 $ShellDir 里 npm i）" }
    foreach ($f in (Get-ChildItem -LiteralPath $modDir -Recurse -File -Force)) {
      $rel = Rel $modDir $f.FullName
      $cand['shell/resources/app/node_modules/' + $m + '/' + $rel] = @{
        src = $f.FullName
        dest = ('${INSTALL}\resources\app\node_modules\' + $m + '\' + ($rel -replace '/', '\'))
        scope = 'shell'
      }
    }
  }
}

# 应用家目录里的"产品文件"（2026-09-17 起）：源 = deepseek-harness-mine\shell\home-files\**，dest 走 ${HOME}
# 2026-11-27 起只剩 profiles\ 装配单 —— agent 的常驻指令统一走 D:\00memory\AGENTS.md，不从安装目录下发。
$homeFiles = Join-Path $ShellDir 'home-files'
if ((Test-Path -LiteralPath $homeFiles) -and (-not $SkipShell)) {
  foreach ($f in (Get-ChildItem -LiteralPath $homeFiles -Recurse -File -Force)) {
    $rel = Rel $homeFiles $f.FullName
    # profiles/ 下是用户层配置：不进更新包，否则安装端会把用户的默认模式、主题等抹回默认。
    if ($rel -like 'profiles/*') { continue }
    $cand['home/' + $rel] = @{ src = $f.FullName; dest = ('${HOME}\' + ($rel -replace '/', '\')); scope = 'home' }
  }
}

if (-not $SkipPlugin) {
  if (-not (Test-Path -LiteralPath $DevPlugin)) { throw "找不到插件源码: $DevPlugin" }
  foreach ($f in (Get-ChildItem -LiteralPath $DevPlugin -Recurse -File -Force | Where-Object { $_.FullName -notmatch '\\node_modules\\' })) {
    $rel = Rel $DevPlugin $f.FullName
    $cand['plugin/' + $rel] = @{ src = $f.FullName; dest = ('${HOME}\profiles\web\ide\dsh-ide\' + ($rel -replace '/', '\')); scope = 'plugin' }
  }
}

# ── 增量比对 ──
$feedDir = Join-Path $InstallDir '_updates'
$target = Join-Path $feedDir ('v' + $Version)
# 载荷直接放在 v<版本>\ 下，路径 = manifest 里的 src（updater.js 按 <feed>\v<版本>\<src> 取文件）
$payloadRoot = $target
$files = New-Object System.Collections.ArrayList
$total = 0
foreach ($k in $cand.Keys) {
  $c = $cand[$k]
  $h = Get-Sha256 $c.src
  if ($base.ContainsKey($k) -and $base[$k] -eq $h) { continue }   # 没变 → 不进包
  $size = (Get-Item -LiteralPath $c.src).Length
  $total += $size
  [void]$files.Add([ordered]@{ src = $k; dest = $c.dest; sha256 = $h; size = $size; _local = $c.src })
}
$deletions = @()
# 只在"本次发布的范围内"算删除：没发插件就别删插件文件（键前缀 = shell/ 或 plugin/）
$delScopes = @()
if ($Full -or (-not $SkipShell)) { $delScopes += 'shell/'; $delScopes += 'home/' }
if (-not $SkipPlugin) { $delScopes += 'plugin/' }
foreach ($k in $base.Keys) {
  # 用户层配置永不进删除清单（更新包里本来也不再带它们）
  if ($k -like 'home/profiles/*') { continue }
  $inScope = $false
  foreach ($s in $delScopes) { if ($k.StartsWith($s)) { $inScope = $true; break } }
  if ($inScope -and -not $cand.Contains($k)) { $deletions += $k }
}

Write-Host ("需要下发: {0} 个文件, {1:N2} MB；删除 {2} 个" -f $files.Count, ($total / 1MB), $deletions.Count)
foreach ($f in $files) { Write-Host ("   " + $f.src) }
if ($deletions.Count) { foreach ($d in $deletions) { Write-Host ("   [删除] " + $d) } }

if ($DryRun) { Write-Host '（-DryRun：只报告，不写更新源）'; exit 0 }
if ($files.Count -eq 0 -and $deletions.Count -eq 0 -and -not $Force) { Write-Host '没有变化，不发布（-Force 可强制发空包，用于验证更新链路）'; exit 0 }

# ── 写更新源 ──
New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null
$outFiles = New-Object System.Collections.ArrayList
foreach ($f in $files) {
  $destFile = Join-Path $payloadRoot ($f.src -replace '/', '\')
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

# 下次全量打包带上新版本号
# ⚠ 必须用 [System.IO.File]::ReadAllText 显式按 UTF-8 读：PS 5.1 的 Get-Content -Raw 对
#   "无 BOM 的 UTF-8" 会按 ANSI 解码 → 中文被解成乱码再写回，**读改写三步就把文件毁了**
#   （2026-09-17 实测：package.json 里的 productName「天工」被写成「澶╁伐」）。
$pkgFile = Join-Path $ShellDir 'package.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$pkg = [System.IO.File]::ReadAllText($pkgFile, $utf8) | ConvertFrom-Json
if ($pkg.version -ne $Version) {
  $pkg.version = $Version
  [System.IO.File]::WriteAllText($pkgFile, ($pkg | ConvertTo-Json -Depth 8), $utf8)
  Write-Host ("已更新 deepseek-harness-mine\shell\package.json 版本 → {0}" -f $Version)
}

Write-Host ''
Write-Host ("发布完成: {0}" -f $latestFile)
Write-Host ("应用侧：打开 天工 会自动提示（或点标题栏版本号 / Ctrl+Shift+U）")

# ── 顺手把这一版的源码也发到静态站点（每版一份、永不覆盖）──────────────
# 位置由 publish-source.ps1 的 -PublicBase 决定（见 tools\publish-source.local.ps1）。
# 失败**只告警不中断**：应用更新是主线，源码存档是附带产物。
if (-not $SkipSource -and -not $DryRun) {
  Write-Host ''
  Write-Host '== 同步发布源码包到个人网站 ==' -ForegroundColor Cyan
  try {
    & (Join-Path $PSScriptRoot 'publish-source.ps1') -Version $Version -Notes $Notes
  } catch {
    Write-Host ("⚠ 源码发布失败（更新包已发出，不受影响）：{0}" -f $_.Exception.Message) -ForegroundColor Yellow
    Write-Host ("  单独重发：powershell -ExecutionPolicy Bypass -File {0} -Version {1} -Notes '...'" -f (Join-Path $PSScriptRoot 'publish-source.ps1'), $Version)
  }
}
