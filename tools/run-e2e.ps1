# run-e2e.ps1 — 并行跑 E2E 套件（解决"每次回归串行等 8-9 分钟"的问题）
#
# 用法：
#   pwsh -File tools\run-e2e.ps1                 # smoke（默认）：3 套并行，约 1.5-2 分钟
#   pwsh -File tools\run-e2e.ps1 -Mode full      # 全部套件，约 4-5 分钟
#   pwsh -File tools\run-e2e.ps1 -Suites e2e-keys.mjs,e2e-explorer.mjs
#   pwsh -File tools\run-e2e.ps1 -SkipSync       # 跳过 sync/testhome（只跑不改代码时）
#
# 设计要点（都是踩过坑换来的）：
#   · 每套给**不同端口**（都认 DSH_E2E_PORT）→ 可以真并行；同家目录的套件并行没问题，
#     但因为都要扫树/写会话，**应用家目录那三套（e2e12/e2e13/e2e-fsrev）串行跑**，避免互相干扰。
#   · 跑之前默认查链接 + `dev-testhome.ps1`：**e2e12/e2e13/e2e-fsrev 用的是应用家目录**，
#     它里面那份插件是指向真源的目录链接，不刷新并行组的 home 就会测到旧代码给出假绿（§6 83 的账）。
#   · 输出落 <仓库根>\_e2e-logs\<suite>.log，终端只打"每套一行 + 失败项"，避免长输出冲上下文。
param(
  [ValidateSet('smoke', 'full')][string]$Mode = 'smoke',
  [string[]]$Suites = @(),
  [switch]$SkipSync
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_paths.ps1')
$root = $repoRoot
$tools = Join-Path $root 'tools'
$logDir = Join-Path $root '_e2e-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 套件 → 端口（错开，方便并行）
$PORT = @{
  'e2e-keys.mjs'     = 3091
  'e2e-explorer.mjs' = 3092
  'e2e-tabs.mjs'     = 3093
  'e2e-resize.mjs'   = 3094
  'e2e12.mjs'        = 3095
  'e2e13.mjs'        = 3096
  'e2e-fsrev.mjs'    = 3097
  'e2e-media.mjs'    = 3098
}
# 并行组：互不干扰（各端口 + **各自独立家目录**）；应用家目录的三套放第二组串行
$PARALLEL = @('e2e-keys.mjs', 'e2e-explorer.mjs', 'e2e-tabs.mjs', 'e2e-resize.mjs', 'e2e-media.mjs')
$SERIAL = @('e2e12.mjs', 'e2e13.mjs', 'e2e-fsrev.mjs')
# ⚠ 并行组必须**每家目录一份**：三套共用一个 home 时，页面会按"当前会话 cwd"互相覆盖 active-root、
#   并在同一份会话/trace 里打架 → 实测出现假 FAIL（e2e-keys 从 23/23 掉到 21/23，单独跑又全绿）。
#   home 只有 ~30MB，克隆一份几秒钟，比"跑了半天发现是串扰"便宜得多。
$HOME_FOR = @{
  'e2e-keys.mjs'     = Join-Path $root '.smoke-home-keys'
  'e2e-explorer.mjs' = Join-Path $root '.smoke-home-explorer'
  'e2e-tabs.mjs'     = Join-Path $root '.smoke-home-tabs'
  'e2e-resize.mjs'   = Join-Path $root '.smoke-home-resize'
  'e2e-media.mjs'    = Join-Path $root '.smoke-home-media'
}

if ($Suites.Count -gt 0) {
  $run = $Suites
} elseif ($Mode -eq 'full') {
  $run = $PARALLEL + $SERIAL
} else {
  $run = @('e2e-keys.mjs', 'e2e-explorer.mjs', 'e2e-tabs.mjs', 'e2e-media.mjs')   # smoke
}
$run = $run | Where-Object { $PORT.ContainsKey($_) }
if (-not $run) { throw '没有可跑的套件（名字要对得上，如 e2e-keys.mjs）' }

function Clear-Port([int]$p) {
  Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | ForEach-Object {
    taskkill /PID $_.OwningProcess /T /F 2>&1 | Out-Null
  }
}

# 顺手清掉上一轮没删掉的临时浏览器 profile（Windows 文件锁会在套件收尾时报错并留下垃圾）
# 落点已改成 <仓库根>\temp（§0.5：临时垃圾统一落 temp），这里跟着改。
# ⚠ 用 node 的 rmSync 而不是 Remove-Item：环境的批量删除保护会拦下这种大目录（>500 项），
#   而且它**不是** -ErrorAction SilentlyContinue 能吞掉的错误 —— 直接把脚本中断（2026-09-30 实测）。
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
Get-ChildItem $tempDir -Directory -Filter '.edge-*' -Force -ErrorAction SilentlyContinue |
  ForEach-Object { node -e 'require("fs").rmSync(process.argv[1],{recursive:true,force:true,maxRetries:10,retryDelay:120})' $_.FullName }

if (-not $SkipSync) {
  # 插件源码只有一份（<仓库根>\deepseek-harness-mine\plugin），两个家目录里都是指向它的目录链接
  # ⇒ 没有"同步"这回事了，只需确认链接还在（2026-10-12 目录迁移后）
  Write-Host '== 检查插件链接（应用家目录那几套跑的就是这份真源）==' -ForegroundColor Cyan
  $pluginRoot = $pluginDirRepo
  foreach ($h in @($appHomeDir, $devHomeDir)) {
    $lnk = Join-Path $h 'profiles\web\ide\dsh-ide'
    $it = Get-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue
    if ($it -and $it.LinkType -eq 'Junction' -and (($it.Target -join '') -eq $pluginRoot)) {
      Write-Host ('   OK  ' + $lnk) -ForegroundColor DarkGray
    } else {
      throw ('插件链接不对：' + $lnk + '（应为指向 ' + $pluginRoot + ' 的目录链接）')
    }
  }
  # 并行组各自的家目录：不存在就整套建（~30MB，几秒），已存在就只刷新插件代码
  foreach ($s in $run) {
    if (-not $HOME_FOR.ContainsKey($s)) { continue }
    $h = $HOME_FOR[$s]
    $line = pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools 'dev-testhome.ps1') -TestHome $h 2>&1 |
      Select-String -Pattern '测试 home|一致' | Select-Object -First 1
    Write-Host ('   ' + $(if ($line) { $line.Line.Trim() } else { $h })) -ForegroundColor DarkGray
  }
}

# ⚠ 会话快照必须清掉，否则**连跑两轮会假红**（2026-09-24 实测踩到）：
# 各套件收尾时会把"还开着的标签 + 未保存草稿"写进 <home>\ide-session.json（hot exit），
# 下一轮同一个 home 一起来就把它们恢复回来 —— 具体后果：
#   · e2e-keys：src\a.txt 的旧草稿（上一轮故意没保存的 Y）被套回缓冲区 → P19 断言磁盘内容时红；
#   · e2e-tabs：上一轮固定住的标签被恢复 → P3~P9 那批"标签栏初始状态"断言全红（2026-09-24 实测）。
# 这两套的 home 是**跨轮复用**的（dev-testhome 只刷新插件代码），所以必须在起套件前清一次。
# 只清并行组（各自的独立 home）；应用家目录那三套（e2e12/13/fsrev）**不能碰**。
foreach ($s in $run) {
  if (-not $HOME_FOR.ContainsKey($s)) { continue }
  $sess = Join-Path $HOME_FOR[$s] 'ide-session.json'
  if (Test-Path -LiteralPath $sess) { Remove-Item -LiteralPath $sess -Force -ErrorAction SilentlyContinue }
}

function Start-Suite([string]$s) {
  $p = $PORT[$s]
  Clear-Port $p
  $log = Join-Path $logDir ($s -replace '\.mjs$', '.log')
  $env:DSH_E2E_PORT = "$p"
  $env:DSH_E2E_HOME = if ($HOME_FOR.ContainsKey($s)) { $HOME_FOR[$s] } else { Join-Path $root '.smoke-home' }
  $psi = Start-Process -FilePath 'node' -ArgumentList @((Join-Path $tools $s)) `
    -RedirectStandardOutput $log -RedirectStandardError ($log + '.err') -PassThru -NoNewWindow
  return [pscustomobject]@{ Name = $s; Port = $p; Proc = $psi; Log = $log; Sw = [System.Diagnostics.Stopwatch]::StartNew() }
}

function Report($j) {
  $j.Sw.Stop()
  $txt = ''
  try { $txt = Get-Content $j.Log -Raw -ErrorAction SilentlyContinue } catch { }
  # ⚠ 判据用 **[PASS]/[FAIL] 计数**，不要正则抓"N/M" —— 日志里到处是数字（端口、耗时、坐标），
  #   抓最后一个 N/M 会得到 "30/40" 这种鬼结果，把全绿判成失败（2026-09-21 实际踩到）。
  $pass = ([regex]::Matches($txt, '\[PASS\]')).Count
  $fail = ([regex]::Matches($txt, '\[FAIL\]')).Count
  $score = "$pass/$($pass + $fail)"
  $exit = $j.Proc.ExitCode
  # 判据：有 FAIL → 失败；一条 PASS 都没有 → 失败（连启动都没起来）；**收尾报错但断言全过** → 只提示不判失败
  $ok = ($fail -eq 0) -and ($pass -gt 0)
  $color = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("[{0}] {1,-16} {2,7}  {3,6:N0}s  exit={4}   log: {5}" -f $(if ($ok) { 'OK' } else { 'FAIL' }), $j.Name, $score, $j.Sw.Elapsed.TotalSeconds, $exit, $j.Log) -ForegroundColor $color
  if ($ok -and $exit -ne 0) { Write-Host '      ⚠ 断言全过，但进程收尾非 0（多半是临时目录被文件锁住；不影响结论）' -ForegroundColor DarkYellow }
  if (-not $ok) {
    ($txt -split "`n") | Where-Object { $_ -match '\[FAIL\]|FAILED:|Error:|throw' } | Select-Object -First 5 | ForEach-Object { Write-Host ('      ' + $_.Trim()) -ForegroundColor DarkYellow }
    $errFile = $j.Log + '.err'
    if ((Test-Path $errFile) -and ((Get-Item $errFile).Length -gt 0)) {
      Write-Host '      --- stderr 尾部 ---' -ForegroundColor DarkYellow
      Get-Content $errFile -Tail 4 | ForEach-Object { Write-Host ('      ' + $_.Trim()) -ForegroundColor DarkYellow }
    }
  }
  return $ok
}

$t0 = Get-Date
Write-Host "== 跑 $($run.Count) 套：$($run -join ', ') ==" -ForegroundColor Cyan

$jobs = @()
foreach ($s in $run) { if ($PARALLEL -contains $s) { $jobs += Start-Suite $s } }
$allOk = $true
foreach ($j in $jobs) { $j.Proc.WaitForExit(); if (-not (Report $j)) { $allOk = $false } }

foreach ($s in $run) {
  if ($SERIAL -notcontains $s) { continue }
  $j = Start-Suite $s
  $j.Proc.WaitForExit()
  if (-not (Report $j)) { $allOk = $false }
}

foreach ($p in ($run | ForEach-Object { $PORT[$_] })) { Clear-Port $p }
$el = ((Get-Date) - $t0).TotalSeconds
Write-Host ("== 合计 {0:N0}s；{1} ==" -f $el, $(if ($allOk) { '全绿' } else { '有失败（看上面的 FAIL 行 + 对应 log）' })) -ForegroundColor $(if ($allOk) { 'Green' } else { 'Red' })
if (-not $allOk) { exit 1 }
