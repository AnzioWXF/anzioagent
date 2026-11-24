# 把天工现打产物打成绿色版 zip（换台机器解压即开，不需要安装器）。
#
# 与 install-app.ps1 的区别：那个是装到固定安装目录；这个只出一个压缩包，
# 解压后双击 天工.exe 即用。首次启动会在 %LOCALAPPDATA%\Tiangong\home 自建家目录并装好插件与装配单。
#
# 不带的东西（带上去只会添乱）：
#   tiangong-home.txt  家目录指针 —— 它写的是本机路径，带过去会把新机器的数据指到 D:\99DSH\app-home
#   version.json       更新基线 —— 属于"已安装"状态，不是发行内容
#   updater.json / updater-state.json / _updates / _staging   本机更新链路的状态与包
#
# 凭证默认不带（那是账号 Key，包里没有它 Agent 发不了消息）。要带就显式加 -WithCredentials：
# 它会被放到包根的 credentials.yaml，天工首次启动时自动拷进家目录（家目录已有凭证则不覆盖）。
#
# 用法：
#   pwsh -File tools\pack-tiangong-zip.ps1
#   pwsh -File tools\pack-tiangong-zip.ps1 -WithCredentials
#   pwsh -File tools\pack-tiangong-zip.ps1 -Source D:\000AnzioAgent -Out D:\temp\tiangong.zip

[CmdletBinding()]
param(
  [string]$Source = '',
  [string]$Out = '',
  [string]$HomeDir = 'D:\99DSH\app-home',
  [switch]$WithCredentials
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ($Source -eq '') {
  $Source = Join-Path $repoRoot 'deepseek-harness-mine\harness\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\win-unpacked'
}
if ($Out -eq '') {
  $Out = Join-Path $repoRoot ('temp\tiangong-portable-' + (Get-Date -Format 'yyyyMMdd') + '.zip')
}

$exe = Join-Path $Source '天工.exe'
if (-not (Test-Path $exe)) { throw "Source 里没有 天工.exe：$Source（先打一次包：pnpm run package -- --dir --unsigned）" }

$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path $tar)) { throw '找不到系统自带 tar.exe，无法打 zip' }

$outDir = Split-Path -Parent $Out
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
if (Test-Path $Out) { Remove-Item $Out -Force }

Write-Host "打包：$Source"
Write-Host "输出：$Out"

# 用系统 tar（bsdtar，支持 zip64，1 GB 目录也稳）；产物里的附带状态文件一律排除
$excludes = @(
  '--exclude=tiangong-home.txt',
  '--exclude=version.json',
  '--exclude=updater.json',
  '--exclude=updater-state.json',
  '--exclude=_updates',
  '--exclude=_staging'
)
& $tar -a -c -f $Out @excludes -C $Source .
if ($LASTEXITCODE -ne 0) { throw "tar 打包失败（退出码 $LASTEXITCODE）" }

if ($WithCredentials) {
  $cred = Join-Path $HomeDir '.credentials.yaml'
  if (-not (Test-Path $cred)) { throw "要带凭证但没找到：$cred" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::Open($Out, 'Update')
  try {
    $entry = $zip.CreateEntry('credentials.yaml', [System.IO.Compression.CompressionLevel]::Optimal)
    $stream = $entry.Open()
    try {
      $bytes = [System.IO.File]::ReadAllBytes($cred)
      $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
  } finally { $zip.Dispose() }
  Write-Host '已把凭证放进包根（credentials.yaml）—— 注意这个包等于带着你的账号 Key，别外传'
}

$size = (Get-Item $Out).Length
$count = (& $tar -tf $Out | Measure-Object).Count
Write-Host ('完成：{0:N0} 个条目，{1:N1} MB' -f $count, ($size / 1MB))
Write-Host ''
Write-Host '换台机器的用法：解压到任意英文目录 -> 双击 天工.exe -> 首次启动自建数据目录并装好界面'
Write-Host '没带凭证的话：把家目录里的 .credentials.yaml 放到 %LOCALAPPDATA%\Tiangong\home\ 再重启'
