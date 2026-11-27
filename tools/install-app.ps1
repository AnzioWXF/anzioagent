# install-app.ps1 — 把 DSH IDE 壳"安装"到固定目录（默认 D:\000AnzioAgent）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File D:\99DSH\tools\install-app.ps1            # 用现有 release\win-unpacked 安装/修复
#   powershell -ExecutionPolicy Bypass -File D:\99DSH\tools\install-app.ps1 -Build     # 先 electron-builder 打包再安装
#
# 做的事：①（可选）打包 ② 停掉正在运行的旧实例 ③ 镜像到安装目录（保留 version.json / updater.json / _updates / _staging）
#         ④ 写 version.json（含逐文件 sha256，作为"已安装基线"，publish-update 靠它算增量）
#         ⑤ 确保 updater.json（更新源=安装目录下 _updates）⑥ 建桌面快捷方式
param(
  [string]$InstallDir = 'D:\000AnzioAgent',
  [string]$ShellDir = 'D:\99DSH\deepseek-harness-mine\shell',
  [string]$BuildDir = '',
  [string]$Version = '',
  [switch]$Build,
  [switch]$ShellFromSource,
  [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
# 安装目录里的 exe 名（2026-09-17 改名天工；安装目录 D:\000AnzioAgent 仍是 ASCII 路径，
# 更新源/基线/脚本全绑这个路径，不随产品名变）
$exeName = '天工.exe'

function Write-Step($msg) { Write-Host ("  " + $msg) }
function Get-Sha256($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }

if (-not $BuildDir) { $BuildDir = Join-Path $ShellDir 'release\win-unpacked' }

# ── ① 需要的话先打包 ──
if ($Build) {
  Write-Host '== 1/6 electron-builder 打包 =='
  $env:LOCALAPPDATA = Join-Path $ShellDir '.local-appdata'
  $env:ELECTRON_BUILDER_CACHE = Join-Path $ShellDir '.builder-cache'
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
  Push-Location $ShellDir
  try { & npx electron-builder --win; if ($LASTEXITCODE -ne 0) { throw "electron-builder 失败 (exit $LASTEXITCODE)" } }
  finally { Pop-Location }
}

# -ShellFromSource：不重打包，直接把源码里的壳文件覆盖进安装目录的 resources\app
# （壳就是 main.js/backend.js/updater.js/preload.js/*.html/assets，纯 JS 不需要过打包器；
#  Electron 运行时只有升级 Electron 版本时才需要 -Build 全量重打）
if ($ShellFromSource) {
  Write-Host '== 1b/6 用源码里的壳文件覆盖安装目录 =='
  $builtApp = Join-Path $BuildDir 'resources\app'
  if (-not (Test-Path -LiteralPath $builtApp)) { throw "找不到 $builtApp（先跑一次 -Build 建立目录结构）" }
  New-Item -ItemType Directory -Force -Path $builtApp | Out-Null
  $shellFiles = @('main.js', 'backend.js', 'updater.js', 'preload.js', 'browser.js', 'browser-preload.js', 'driver.js', 'bridge.js', 'error.html', 'loading.html')
  foreach ($n in $shellFiles) {
    $src = Join-Path $ShellDir $n
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $builtApp $n) -Force; Write-Step "覆盖 $n" }
  }
  $assetsSrc = Join-Path $ShellDir 'assets'
  if (Test-Path -LiteralPath $assetsSrc) {
    # 逐文件按相对路径复制：Copy-Item 目录到已存在目录会嵌套成 assets\assets（踩坑 13）
    foreach ($f in (Get-ChildItem -LiteralPath $assetsSrc -Recurse -File -Force)) {
      $rel = $f.FullName.Substring($assetsSrc.Length + 1)
      $dest = Join-Path (Join-Path $builtApp 'assets') $rel
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
    }
    Write-Step '覆盖 assets/**'
  }
}

if (-not (Test-Path -LiteralPath $BuildDir)) { throw "找不到打包产物: $BuildDir（先跑 -Build）" }

# ── ①c 运行时依赖（生产 dependencies）必须进打包目录 ──
# playwright-core 是壳在跑 Playwright 时 require 的纯库（不带浏览器二进制）；它不在 $shellFiles 里，
# 而下面第 ③ 步是 robocopy /E /PURGE（**以打包目录为准，多出来的文件会被删掉**）——
# 不在这里补一道，一次 -Build/-ShellFromSource 就会把安装目录里的它删掉，应用变成"Agent 操作浏览器起不来"
# 的残废状态（2026-10-08 补的挂账）。electron-builder 通常会把生产依赖放进 resources\app\node_modules，
# 但那取决于它的打包策略，不能赌，这里显式兜住。
$builtApp = Join-Path $BuildDir 'resources\app'
foreach ($m in @('playwright-core')) {
  $modSrc = Join-Path (Join-Path $ShellDir 'node_modules') $m
  if (-not (Test-Path -LiteralPath $modSrc)) { throw "找不到运行时依赖 $m：先在 $ShellDir 里 npm i" }
  $modDst = Join-Path (Join-Path $builtApp 'node_modules') $m
  foreach ($f in (Get-ChildItem -LiteralPath $modSrc -Recurse -File -Force)) {
    $rel = $f.FullName.Substring($modSrc.Length + 1)
    $to = Join-Path $modDst $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
    Copy-Item -LiteralPath $f.FullName -Destination $to -Force
  }
  Write-Step "运行时依赖 $m 已就位"
}

# ── ② 停掉正在跑的旧实例（按 exe 路径匹配，不误杀其它进程）──
Write-Host '== 2/6 停止正在运行的实例 =='
$running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  try { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
}
foreach ($p in $running) {
  Write-Step ("停止 pid={0} {1}" -f $p.Id, $p.ProcessName)
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
if ($running) { Start-Sleep -Seconds 2 }

# ── ③ 镜像到安装目录（保留用户/更新相关文件）──
Write-Host "== 3/6 镜像到 $InstallDir =="
if (-not (Test-Path -LiteralPath $InstallDir)) { New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null }
$rc = robocopy $BuildDir $InstallDir /E /PURGE /NFL /NDL /NJH /NJS /XF version.json updater.json /XD _updates _staging
$code = $LASTEXITCODE
if ($code -ge 8) { throw "robocopy 失败 (exit $code)" }
Write-Step ("robocopy exit={0}" -f $code)

# 统一 exe 名（打包产物叫 <productName>.exe —— 历史上叫过 DSH IDE.exe；安装目录里统一叫 天工.exe）
$exeTarget = Join-Path $InstallDir $exeName
foreach ($cand in @('DSH IDE.exe', '天工.exe')) {
  if ($cand -eq $exeName) { continue }
  $p = Join-Path $InstallDir $cand
  if (Test-Path -LiteralPath $p) {
    Move-Item -LiteralPath $p -Destination $exeTarget -Force
    Write-Step "exe 重命名为 $exeName"
    break
  }
}
if (-not (Test-Path -LiteralPath $exeTarget)) { throw "安装目录里找不到 exe（期望 $exeName）：检查打包产物的 exe 名" }

# ── ③b 应用家目录里的"产品文件"（2026-09-17 起）──
# 目前只有 profiles\ 下的装配单。agent 的常驻工作指令不在这里（2026-11-27 用户定）：
# 人定的规则必须放在人能看见、能同步的地方，统一由 D:\00memory\AGENTS.md 说了算，
# 不许在产品安装目录里另生一份。
# 源 = $ShellDir\home-files\**，目标 = 应用家目录下的同名相对路径。
$appHome = 'D:\99DSH\app-home'
$homeFilesSrc = Join-Path $ShellDir 'home-files'
if (Test-Path -LiteralPath $homeFilesSrc) {
  foreach ($f in (Get-ChildItem -LiteralPath $homeFilesSrc -Recurse -File -Force)) {
    $rel = $f.FullName.Substring($homeFilesSrc.Length + 1)
    $dest = Join-Path $appHome $rel
    # profiles\ 下是用户层配置（默认模式、主题等）：已存在就保留，否则每次装机都把它抹回产品默认。
    if ($rel -like 'profiles\*' -and (Test-Path -LiteralPath $dest)) {
      Write-Step "家目录文件 $rel（已存在，保留）"
      continue
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
    Write-Step "家目录文件 $rel"
  }
}

# ── ④ version.json（已安装基线：逐文件 sha256）──
Write-Host '== 4/6 写 version.json =='
if (-not $Version) {
  # 版本号以"实际装进去的那份壳"为准（打包器写进 resources\app\package.json 的版本），
  # 不用源码 package.json —— 否则源码版本被 publish 提前 bump 过时，会声称装了新版本、其实是旧文件
  $builtPkg = Join-Path $InstallDir 'resources\app\package.json'
  if (Test-Path -LiteralPath $builtPkg) {
    $Version = [string]((Get-Content -Raw -LiteralPath $builtPkg | ConvertFrom-Json).version)
  } else {
    $Version = [string]((Get-Content -Raw -LiteralPath (Join-Path $ShellDir 'package.json') | ConvertFrom-Json).version)
  }
}
$files = @{}
$appDir = Join-Path $InstallDir 'resources\app'
foreach ($f in (Get-ChildItem -LiteralPath $appDir -Recurse -File -Force)) {
  $rel = ($f.FullName.Substring($appDir.Length + 1)) -replace '\\', '/'
  if ($rel -eq 'package.json') { continue }   # 打包器生成的 app package.json：不纳入基线，也不随更新下发
  # 键格式必须与 publish-update.ps1 的候选键一致，否则每次发布都会把老文件当成"已删除"
  $files['shell/resources/app/' + $rel] = Get-Sha256 $f.FullName
}
# 插件也纳入基线（更新包里插件走 ${HOME}，这里记录它在应用家目录的当前位置）
$pluginDir = Join-Path $appHome 'profiles\web\ide\dsh-ide'
if (Test-Path -LiteralPath $pluginDir) {
  foreach ($f in (Get-ChildItem -LiteralPath $pluginDir -Recurse -File -Force)) {
    $rel = $f.FullName.Substring($pluginDir.Length + 1)
    $files['plugin/' + ($rel -replace '\\', '/')] = Get-Sha256 $f.FullName
  }
}
# 家目录产品文件（AGENTS.md 等）：键前缀 home/ 必须与 publish-update.ps1 的候选键一致；
# sha 取**家目录里那份**（用户可能自己改过），不取源文件
if (Test-Path -LiteralPath $homeFilesSrc) {
  foreach ($f in (Get-ChildItem -LiteralPath $homeFilesSrc -Recurse -File -Force)) {
    $rel = $f.FullName.Substring($homeFilesSrc.Length + 1)
    $dest = Join-Path $appHome $rel
    if (Test-Path -LiteralPath $dest) { $files['home/' + ($rel -replace '\\', '/')] = Get-Sha256 $dest }
  }
}
$versionFile = Join-Path $InstallDir 'version.json'
$doc = [ordered]@{
  version     = $Version
  installedAt = (Get-Date).ToUniversalTime().ToString('o')
  source      = 'install-app.ps1'
  files       = $files
}
[System.IO.File]::WriteAllText($versionFile, ($doc | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Write-Step ("version={0}  基线文件 {1} 个" -f $Version, $files.Count)

# ── ⑤ updater.json（更新源）──
Write-Host '== 5/6 确保 updater.json =='
$updaterFile = Join-Path $InstallDir 'updater.json'
if (-not (Test-Path -LiteralPath $updaterFile)) {
  $cfg = [ordered]@{
    feed              = (Join-Path $InstallDir '_updates')
    autoCheck         = $true
    checkIntervalMs   = 1800000
    source            = 'local'
  }
  [System.IO.File]::WriteAllText($updaterFile, ($cfg | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  Write-Step '新建 updater.json'
} else { Write-Step '已存在，保留' }
$feedDir = Join-Path $InstallDir '_updates'
if (-not (Test-Path -LiteralPath $feedDir)) { New-Item -ItemType Directory -Force -Path $feedDir | Out-Null }

# ── ⑥ 桌面快捷方式 ──
Write-Host '== 6/6 桌面快捷方式 =='
if (-not $NoShortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnk = Join-Path $desktop '天工.lnk'
  # 旧名的快捷方式会指向已改名的 exe（双击报找不到）→ 直接清掉
  $oldLnk = Join-Path $desktop 'AnzioAgent.lnk'
  if (Test-Path -LiteralPath $oldLnk) { Remove-Item -LiteralPath $oldLnk -Force; Write-Step '已删除旧快捷方式 AnzioAgent.lnk' }
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = Join-Path $InstallDir $exeName
  $sc.WorkingDirectory = $InstallDir
  # 图标指向安装目录里的 .ico：exe 内嵌图标要重打包才换，而 .ico 随壳文件/更新包一起下发
  # → 以后换 logo 只要重跑 make-logo.ps1 + 安装，不必 electron-builder 全量重打
  $icoPath = Join-Path $InstallDir 'resources\app\assets\icon.ico'
  $sc.IconLocation = if (Test-Path -LiteralPath $icoPath) { $icoPath + ',0' } else { (Join-Path $InstallDir $exeName) + ',0' }
  $sc.Description = '天工（DSH 引擎驱动的自研 IDE）'
  $sc.Save()
  Write-Step "已创建 $lnk"
} else { Write-Step '跳过（-NoShortcut）' }

Write-Host ''
Write-Host ("安装完成: {0}\{1}  (v{2})" -f $InstallDir, $exeName, $Version)
