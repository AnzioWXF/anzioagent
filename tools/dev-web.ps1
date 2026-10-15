# dev-web.ps1 — 起开发台（3080）
#
# 开发台 = 引擎自带的标准 Web 界面，用来打磨天工应用；跟天工应用（3081）完全隔离：
#   开发台：家目录 D:\99DSH\dev-home，界面是引擎原装的（dsh-ide 插件在开发台是停用的）
#   天工  ：家目录 D:\99DSH\app-home，界面由 dsh-ide 插件接管（左树/中编辑器/右 Agent）
#
# 用法：
#   pwsh -File D:\99DSH\tools\dev-web.ps1
#
# 2026-10-12 补：在此之前开发台没有固定入口，靠手敲命令 + 记 DSH_HOME，搬家后就不认路了。
param(
  [int]$Port = 3080,
  [string]$Harness = 'D:\99DSH\deepseek-harness-mine\harness',
  [string]$DevHome = 'D:\99DSH\dev-home'
)
$ErrorActionPreference = 'Stop'

if (@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).Count -gt 0) {
  Write-Host ("端口 {0} 已经有服务在跑 —— 直接开浏览器 http://127.0.0.1:{0}" -f $Port) -ForegroundColor Yellow
  exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $Harness 'apps\cli\lib\bin.js'))) {
  throw "找不到引擎构建产物：$Harness\apps\cli\lib\bin.js（先在 $Harness 里 pnpm build）"
}

# DSH_HOME 只对这条命令生效；壳（天工应用）只认自己的 ANZIO_* 变量，不会被带偏。
$env:DSH_HOME = $DevHome
# 遥测一律关死（官方 launcher 的同一开关，非空即关）：不设它，官方遥测行按 FEEDBACK_ONLY 默认生效，
# 而开发台界面就是引擎原装的、消息行带 👍/👎 —— 点一下会话日志前缀就外发到 deepseeksvc.com。
$env:DSH_TELEMETRY_DISABLED = '1'
Write-Host ("== 开发台  : http://127.0.0.1:{0}" -f $Port) -ForegroundColor Cyan
Write-Host ("   引擎    : {0}" -f $Harness)
Write-Host ("   家目录  : {0}" -f $DevHome)
Write-Host '   Enter 结束'
Set-Location -LiteralPath $Harness
& node apps/cli/lib/bin.js web --port $Port
