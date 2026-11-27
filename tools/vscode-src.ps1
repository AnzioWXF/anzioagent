# vscode-src.ps1 — 在**本地 VSCode 源码副本**里查东西（复刻 VSCode 行为时的第一站）
#
# 为什么有它：00devCore §6 71/58 的教训 —— "照 VSCode 做"必须先拿源码级规格；而**上网搜可能过时/出错**。
# 本地副本 + 这个脚本 = 一条命令拿到权威答案（示例见 00devCore §7「规格优先本地副本」）。
#
# 用法：
#   pwsh -File tools\vscode-src.ps1 "explorer.newFile"                 # 全库搜，最多 40 条
#   pwsh -File tools\vscode-src.ps1 "alwaysShowHeaderActions" -Max 10
#   pwsh -File tools\vscode-src.ps1 "MenuId.ViewTitle" -Path src\vs\workbench\contrib\files
#   pwsh -File tools\vscode-src.ps1 "new-folder" -Files                # 只列命中文件
#   pwsh -File tools\vscode-src.ps1 "Sash" -Path src\vs\base\browser\ui\sash -Max 20
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Pattern,
  [string]$Path = '',
  [int]$Max = 40,
  [switch]$Files,
  [string]$Src = ''
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_paths.ps1')
# 源码副本不是仓库的一部分（解压后 1GB+）：环境变量 > 既有副本 > 仓库 temp 下
if (-not $Src) {
  $Src = if ($env:TIANGONG_VSCODE_SRC) { $env:TIANGONG_VSCODE_SRC }
  elseif (Test-Path -LiteralPath 'D:\04other\vscode-src\package.json') { 'D:\04other\vscode-src' }
  else { Join-Path $tempDir 'vscode-src' }
}
if (-not (Test-Path (Join-Path $Src 'package.json'))) {
  Write-Host "本地源码副本不存在：$Src" -ForegroundColor Red
  Write-Host "先跑：node tools\fetch-vscode-src.mjs   （或加 --version x.y.z 指定版本）" -ForegroundColor Yellow
  exit 2
}
$verLine = ''
try { $verLine = (Get-Content (Join-Path $Src '.vscode-version.txt') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^version:' }) } catch { }
$target = if ($Path) { Join-Path $Src $Path } else { $Src }
if (-not (Test-Path $target)) { Write-Host "路径不存在：$target" -ForegroundColor Red; exit 2 }

# 优先用检出目录里自带的 ripgrep（比 Select-String 快几十倍），找不到再退回 Select-String
$rg = $null
$cand = Get-ChildItem (Join-Path $harnessDir 'node_modules\.pnpm') -Directory -Filter '@vscode+ripgrep-win32-x64*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cand) {
  $p = Join-Path $cand.FullName 'node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe'
  if (Test-Path $p) { $rg = $p }
}

Write-Host ("== 本地 VSCode 源码 {0}  ({1})" -f ($verLine -replace 'version:\s*', ''), $(if ($rg) { 'ripgrep' } else { 'Select-String' })) -ForegroundColor Cyan
Write-Host ("   搜 [{0}]  于 {1}" -f $Pattern, $target.Replace($Src + '\', '')) -ForegroundColor DarkGray

if ($rg) {
  $common = @('--no-heading', '--line-number', '--color', 'never', '--max-columns', '200', '--max-columns-preview',
    '-g', '!**/node_modules/**', '-g', '!**/*.min.js', '-g', '!**/*.map')
  if ($Files) {
    & $rg @common '--files-with-matches' $Pattern $target 2>$null | Select-Object -First $Max | ForEach-Object { $_.Replace($Src + '\', '') }
  } else {
    & $rg @common '--max-count' '2' $Pattern $target 2>$null | Select-Object -First $Max | ForEach-Object { $_.Replace($Src + '\', '') }
  }
} else {
  $files = Get-ChildItem -LiteralPath $target -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.Extension -match '^\.(ts|tsx|js|mjs|cjs|json|css|html|md|yml|yaml)$' }
  if ($Files) {
    $files | Select-String -Pattern $Pattern -List -ErrorAction SilentlyContinue | Select-Object -First $Max |
      ForEach-Object { $_.Path.Replace($Src + '\', '') }
  } else {
    $files | Select-String -Pattern $Pattern -ErrorAction SilentlyContinue | Select-Object -First $Max | ForEach-Object {
      $l = $_.Line.Trim(); if ($l.Length -gt 160) { $l = $l.Substring(0, 160) + '…' }
      "{0}:{1}: {2}" -f $_.Path.Replace($Src + '\', ''), $_.LineNumber, $l
    }
  }
}
Write-Host "(最多 $Max 条；-Max N 要更多 · -Files 只看文件 · -Path <相对路径> 收窄)" -ForegroundColor DarkGray
