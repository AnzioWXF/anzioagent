# dev-testhome.ps1 — 建/刷新一个**隔离的测试家目录**，用来在不动用户正在跑的应用的前提下
# 验证 IDE 插件的改动（含 host 半）。
#
# 用法：
#   pwsh -File tools\dev-testhome.ps1              # 首次建 or 只刷新插件代码
#   pwsh -File tools\dev-testhome.ps1 -Rebuild     # 连家目录一起重建（会话数据重新拷）
#   pwsh -File tools\dev-testhome.ps1 -Clean       # 收工清理（先摘 junction 再删）
#
# 起后端（另开一条，放后台）：
#   $env:DSH_HOME='<仓库根>\.smoke-home'; node deepseek-harness-mine\harness\apps\cli\lib\bin.js web --port 3082 --no-open
#
# 踩过的坑（见 00devCore §6 49）：
#   · 别整目录 robocopy 家目录：pnpm 符号链接 + 被应用占用的文件会让它卡死（默认 /R=1000000）
#   · 必须补 junction profiles\web\node_modules\dsh-ide，否则 boot 报 Cannot find package 'dsh-ide'
#   · 删临时 home 前**先摘掉 junction**（PS 的 Remove-Item -Recurse 会跟进链接删到目标）
param(
  [switch]$Rebuild,
  [switch]$Clean,
  [string]$TestHome = '',
  [string]$AppHome = '',
  # 插件真源（家目录里那两份都是指向它的目录链接，2026-10-12 目录迁移后）
  [string]$DevPlugin = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_paths.ps1')
if (-not $TestHome) { $TestHome = Join-Path $repoRoot '.smoke-home' }
if (-not $AppHome) { $AppHome = $appHomeDir }
if (-not $DevPlugin) { $DevPlugin = $pluginDirRepo }

function Remove-TestHome($dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return }
  $n = 0
  Get-ChildItem -LiteralPath $dir -Recurse -Force -EA 0 |
    Where-Object { $_.LinkType -and $_.PSIsContainer } |
    ForEach-Object { [System.IO.Directory]::Delete($_.FullName); $n++ }
  Remove-Item -LiteralPath $dir -Recurse -Force -EA SilentlyContinue
  Write-Host ("  已删 $dir（摘掉链接 $n 个）")
}

if ($Clean) { Remove-TestHome $TestHome; exit 0 }

$fresh = $Rebuild -or (-not (Test-Path -LiteralPath "$TestHome\profiles\web\ide"))
if ($fresh) {
  Write-Host '== 重建测试家目录 =='
  Remove-TestHome $TestHome
  New-Item -ItemType Directory -Force -Path "$TestHome\profiles\web\ide" | Out-Null
  foreach ($f in '.credentials.yaml', '.anonymous-user-id', 'settings.yaml', 'AGENTS.md') {
    if (Test-Path -LiteralPath "$AppHome\$f") { Copy-Item -LiteralPath "$AppHome\$f" -Destination "$TestHome\$f" -Force }
  }
  foreach ($d in 'sessions', 'storages') {
    if (Test-Path -LiteralPath "$AppHome\$d") {
      robocopy "$AppHome\$d" "$TestHome\$d" /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
    }
  }
  foreach ($f in 'cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml') {
    if (Test-Path -LiteralPath "$AppHome\profiles\web\$f") { Copy-Item -LiteralPath "$AppHome\profiles\web\$f" -Destination "$TestHome\profiles\web\$f" -Force }
  }
}

Write-Host '== 刷新插件代码（插件真源 → 测试家目录）=='
robocopy $DevPlugin "$TestHome\profiles\web\ide\dsh-ide" /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null

# 插件是按**包名**从 profiles\web 解析的 → 必须有这个 junction（否则 boot 直接失败）
$nm = "$TestHome\profiles\web\node_modules"
New-Item -ItemType Directory -Force -Path $nm | Out-Null
$link = "$nm\dsh-ide"
if (Test-Path -LiteralPath $link) { [System.IO.Directory]::Delete($link) }
New-Item -ItemType Junction -Path $link -Target "$TestHome\profiles\web\ide\dsh-ide" | Out-Null

$h1 = (Get-FileHash "$DevPlugin\lib\client.js" -Algorithm SHA256).Hash.Substring(0, 12)
$h2 = (Get-FileHash "$TestHome\profiles\web\ide\dsh-ide\lib\client.js" -Algorithm SHA256).Hash.Substring(0, 12)
$h3 = (Get-FileHash "$DevPlugin\lib\index.js" -Algorithm SHA256).Hash.Substring(0, 12)
$h4 = (Get-FileHash "$TestHome\profiles\web\ide\dsh-ide\lib\index.js" -Algorithm SHA256).Hash.Substring(0, 12)
$sess = (Get-ChildItem "$TestHome\sessions" -Recurse -File -EA 0 | Measure-Object).Count
Write-Host ("  测试 home : {0}   （client {1} / index {2}  一致={3}）  会话文件 {4} 个" -f `
  $TestHome, $h2, $h4, (($h1 -eq $h2) -and ($h3 -eq $h4)), $sess)
Write-Host ("  起后端 : `$env:DSH_HOME='{0}'; node `"{1}`" web --port 3082 --no-open" -f $TestHome, (Join-Path $harnessDir 'apps\cli\lib\bin.js'))
