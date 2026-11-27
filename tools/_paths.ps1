# _paths.ps1 — 工具脚本共用的路径推导。各脚本 dot-source 它，别再各写各的默认值。
#
# 仓库根 = 本文件所在目录（tools）的上一级 ⇒ 换机器、换盘符、换目录名都不用改任何脚本。
# 只有产品安装目录推导不出来（本体不在仓库里），走"环境变量 > 既有安装 > 用户级默认"。

$repoRoot      = if ($env:TIANGONG_ROOT) { $env:TIANGONG_ROOT } else { Split-Path -Parent $PSScriptRoot }
$shellDirRepo  = Join-Path $repoRoot 'deepseek-harness-mine\shell'
$pluginDirRepo = Join-Path $repoRoot 'deepseek-harness-mine\plugin'
$harnessDir    = Join-Path $repoRoot 'deepseek-harness-mine\harness'
$appHomeDir    = Join-Path $repoRoot 'app-home'
$devHomeDir    = Join-Path $repoRoot 'dev-home'
$tempDir       = Join-Path $repoRoot 'temp'

# 开发机那套安装位置的兼容判断靠 exe 存在与否，不在 D 盘就自动落到用户级目录。
$installDirDefault = if ($env:TIANGONG_INSTALL_DIR) {
  $env:TIANGONG_INSTALL_DIR
} elseif (Test-Path -LiteralPath 'D:\000AnzioAgent\天工.exe') {
  'D:\000AnzioAgent'
} else {
  Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Tiangong'
}
