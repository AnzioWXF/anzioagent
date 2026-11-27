# publish-source.ps1 — 把「天工」的源码按版本发布到个人网站（每版一个新文件，永不覆盖）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\publish-source.ps1 -Version 1.5.12 -Notes "改了啥"
#   ... -SkipUpload        # 只在本地打包 + 生成页面（不上传）
#   ... -Force             # 该版本已发布过时，强行重发（覆盖同版本那份 zip）
#
# 做的事：
#   ① 收集源码（壳工程 + IDE 插件 + 工具脚本），排除第三方静态资源与一切凭证/会话/日志
#   ② 敏感信息扫描（key/token/password 形态）—— 命中就中止，绝不把密钥发上公网
#   ③ 打 zip：<staging>\tiangong-src-v<版本>.zip
#   ④ 生成页面 index.html + 机器清单 versions.json（这两个是"索引"，每次重写；zip 永不覆盖）
#   ⑤ scp 上传到 <服务器>:<远端目录>/（source/ 下按版本堆叠）
#   ⑥ 公网核对：下载 HEAD 200 + 字节数一致 + 页面里能看到这一版
#
# 上传目标是任意静态站点（自有服务器 / 对象存储都行），四个位置都靠参数给：
#   -Server <user@host> · -KeyPath <私钥> · -RemoteDir <站点下的目录> · -PublicBase <对外地址>
# 平时把它们写进 tools\publish-source.local.ps1（不进仓，见文件末尾说明），就不必每次传。
# 站点根下新建目录即可成为一个独立页面（nginx `location / { root …; try_files $uri $uri/ /index.html; }` 时），
# 不需要改 nginx、不碰主站。
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = '',
  [string]$ShellDir = '',
  [string]$DevPlugin = '',
  [string]$ToolsDir = '',
  [string]$FeedDir = '',
  [string]$WorkDir = '',
  [string]$Server = '',
  [string]$KeyPath = '',
  [string]$RemoteDir = '',
  [string]$PublicBase = '',
  [switch]$SkipUpload,
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_paths.ps1')
if (-not $ShellDir) { $ShellDir = $shellDirRepo }
if (-not $DevPlugin) { $DevPlugin = Join-Path $devHomeDir 'profiles\web\ide\dsh-ide' }
if (-not $ToolsDir) { $ToolsDir = $PSScriptRoot }
if (-not $FeedDir) { $FeedDir = Join-Path $installDirDefault '_updates' }
if (-not $WorkDir) { $WorkDir = Join-Path $repoRoot '.publish-src' }

# 本机私有配置（不进仓，.gitignore 挡着）：服务器/密钥/远端目录/对外地址写在这里，不必每次传参
$localCfg = Join-Path $PSScriptRoot 'publish-source.local.ps1'
if (Test-Path -LiteralPath $localCfg) { . $localCfg }
if (-not $SkipUpload) {
  if (-not $Server) { throw '缺少 -Server：形如 root@<服务器地址>（或写进 tools\publish-source.local.ps1）' }
  if (-not $KeyPath) { throw '缺少 -KeyPath：SSH 私钥路径' }
  if (-not $RemoteDir) { throw '缺少 -RemoteDir：服务器上的目标目录' }
  if (-not $PublicBase) { throw '缺少 -PublicBase：对外访问地址' }
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm')

function Write-Utf8NoBom($path, $text) { [System.IO.File]::WriteAllText($path, $text, $utf8) }
# 打包：自己写条目名（PS 5.1 的 Compress-Archive 会把路径存成反斜杠，Linux 上解压出乱名）
Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
function New-ZipFromDir($dir, $zipPath) {
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  $fs = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::CreateNew)
  try {
    $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      $base = (Resolve-Path -LiteralPath $dir).Path.TrimEnd('\') + '\'
      foreach ($f in Get-ChildItem -LiteralPath $dir -Recurse -File -Force) {
        $rel = $f.FullName.Substring($base.Length).Replace('\', '/')
        $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
        $es = $entry.Open()
        try {
          $src = [System.IO.File]::OpenRead($f.FullName)
          try { $src.CopyTo($es) } finally { $src.Dispose() }
        } finally { $es.Dispose() }
      }
    } finally { $zip.Dispose() }
  } finally { $fs.Dispose() }
}
function Escape-Html($s) {
  if ($null -eq $s) { return '' }
  return ([string]$s).Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}
# 复制整棵树，跳过排除项（目录名/文件通配）
function Copy-Tree($src, $dst, [string[]]$skipDirs, [string[]]$skipFiles) {
  if (-not (Test-Path -LiteralPath $src)) { return 0 }
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  $n = 0
  foreach ($e in Get-ChildItem -LiteralPath $src -Force -ErrorAction SilentlyContinue) {
    if ($e.PSIsContainer) {
      if ($skipDirs -contains $e.Name) { continue }
      $n += Copy-Tree $e.FullName (Join-Path $dst $e.Name) $skipDirs $skipFiles
    } else {
      $skip = $false
      foreach ($p in $skipFiles) { if ($e.Name -like $p) { $skip = $true; break } }
      if ($skip) { continue }
      Copy-Item -LiteralPath $e.FullName -Destination (Join-Path $dst $e.Name) -Force
      $n++
    }
  }
  return $n
}

$stage = Join-Path $WorkDir ("tiangong-src-v" + $Version)
$zipName = "tiangong-src-v$Version.zip"
$zipPath = Join-Path $WorkDir $zipName
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host "== 打包天工源码 v$Version ==" -ForegroundColor Cyan

# ── ① 收集源码（**白名单**：源码目录里混着 Electron 缓存/打包产物，绝不整目录拷）──
$skipDirsCommon = @('node_modules', '.git', 'release', 'dist', 'out', 'build', '.cache',
  '.builder-cache', '.electron-cache', '.local-appdata', '.tmp-userdata', 'logs', 'snapshots',
  '.smoke-home', '.publish-src', 'monaco', '.edge-shot', '.edge-tree', '.edge-snap',
  '.tmp-vscoderef', '.snap-fix', '.snapfix-ui')
$skipFilesCommon = @('*.log', '.credentials.yaml', '*.tmp', '*.bak', '*.bak.*', 'latest.json')

# 壳：逐个点名（main/backend/updater/preload + 两个本地页面 + 依赖清单 + 图标 + 常驻指令）
$shellFiles = @('main.js', 'backend.js', 'updater.js', 'preload.js', 'error.html', 'loading.html',
  'test-backend.js', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md')
$shellDirs = @('assets', 'home-files')
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'shell') | Out-Null
$nShell = 0
foreach ($f in $shellFiles) {
  $src = Join-Path $ShellDir $f
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $stage 'shell') -Force; $nShell++ }
  else { Write-Host ("  ⚠ 壳工程里没找到 {0}（继续，但请确认是不是改名了）" -f $f) -ForegroundColor Yellow }
}
foreach ($d in $shellDirs) {
  $src = Join-Path $ShellDir $d
  if (Test-Path -LiteralPath $src) { $nShell += Copy-Tree $src (Join-Path $stage ("shell\" + $d)) @() @('*.log', '*.tmp') }
}
# 插件：整棵拷（排除 static/monaco 这个 23MB 第三方静态资源，见 skipDirsCommon）
$nPlugin = Copy-Tree $DevPlugin (Join-Path $stage 'plugin') $skipDirsCommon $skipFilesCommon
# 工具脚本只取顶层（.ps1 / .mjs）：子目录里有测试家目录、临时产物
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'tools') | Out-Null
$nTools = 0
foreach ($f in Get-ChildItem -LiteralPath $ToolsDir -File -Force -ErrorAction SilentlyContinue) {
  if ($f.Extension -in @('.ps1', '.mjs')) { Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $stage 'tools') -Force; $nTools++ }
}
Write-Host ("  壳 {0} 个文件 · 插件 {1} 个 · 工具 {2} 个" -f $nShell, $nPlugin, $nTools)

# 核心文件必须在包里（少一个说明收集规则坏了 —— 宁可在这里炸，也别发出残缺的包）
foreach ($must in 'shell\main.js', 'shell\backend.js', 'shell\updater.js', 'plugin\lib\index.js', 'plugin\lib\client.js', 'tools\publish-update.ps1') {
  if (-not (Test-Path -LiteralPath (Join-Path $stage $must))) { throw ("源码包缺核心文件：{0}（收集规则有问题？）" -f $must) }
}

# 本版改动文件（直接取更新包的清单，省得再算一遍）
$changed = @()
$feedLatest = Join-Path $FeedDir 'latest.json'
if (Test-Path -LiteralPath $feedLatest) {
  try {
    $feed = [System.IO.File]::ReadAllText($feedLatest, $utf8) | ConvertFrom-Json
    if ($feed.version -eq $Version -and $feed.files) {
      foreach ($f in $feed.files) { $changed += [string]$f.src }
    }
  } catch { }
}

# ── ② 敏感信息扫描（发上公网前的最后一道闸）────────────────────
$patterns = @(
  @{ name = 'API Key 形态'; re = 'sk-[A-Za-z0-9_\-]{16,}' },
  @{ name = 'api_key 赋值'; re = '(?i)api[_-]?key\s*[:=]\s*[''"][^''"]{8,}' },
  @{ name = 'password 赋值'; re = '(?i)password\s*[:=]\s*[''"][^''"]{4,}' },
  @{ name = 'DEEPSEEK_API_KEY'; re = 'DEEPSEEK_API_KEY\s*[:=]\s*\S' },
  @{ name = '裸 token 串'; re = '(?i)(x-token|access[_-]?token|secret)\s*[:=]\s*[''"][A-Za-z0-9_\-]{16,}' }
)
$hits = @()
foreach ($f in Get-ChildItem -LiteralPath $stage -Recurse -File -Force) {
  if ($f.Length -gt 2MB) { continue }
  $txt = ''
  try { $txt = [System.IO.File]::ReadAllText($f.FullName, $utf8) } catch { continue }
  foreach ($p in $patterns) {
    $m = [regex]::Match($txt, $p.re)
    if ($m.Success) { $hits += ("{0} ← {1}: {2}" -f $p.name, $f.FullName.Substring($stage.Length + 1), $m.Value.Substring(0, [Math]::Min(40, $m.Value.Length))) }
  }
}
if ($hits.Count -gt 0) {
  Write-Host "  ✗ 敏感信息扫描命中，已中止（逐条核对后再发；确认无害可加 -Force）：" -ForegroundColor Red
  $hits | ForEach-Object { Write-Host ("      " + $_) -ForegroundColor Red }
  if (-not $Force) { throw '敏感信息扫描未通过' }
  Write-Host '  （-Force：仍然继续）' -ForegroundColor Yellow
} else {
  Write-Host "  敏感信息扫描：未命中（key/token/password 形态）" -ForegroundColor Green
}

# ── ③ 版本说明 + 打包 ────────────────────────────────────────
$notesText = if ($Notes) { $Notes } else { '（本版未填写说明）' }
$readme = @"
# 天工 · 源码包 v$Version

- 打包时间：$stamp
- 本版说明：$notesText

## 这一版改动的文件

$(if ($changed.Count -gt 0) { ($changed | ForEach-Object { "- " + $_ }) -join "`r`n" } else { '- （未取到增量清单，可能是全量包或首次发布）' })

## 目录

- `shell/`   — Electron 壳工程（窗口 / 后端管理 / 更新器 / 常驻指令）
- `plugin/`  — 天工 IDE 插件（host 半 = 文件与终端 API，client 半 = 整个界面）
- `tools/`   — 发布 / 安装 / 同步 / 端到端测试脚本

## 怎么把它跑起来

1. 需要 Node.js 24+（本机开发用的是 Node 24）与 pnpm。
2. 装依赖：在 `shell/` 下 `pnpm install`（Electron 走镜像更快，见 tools 里的打包脚本注释）。
3. 本源码包**不含第三方静态资源**：`plugin/static/monaco`（monaco-editor@0.56.0 的 min/vs，约 23MB）
   与 `plugin/static/xterm` 里的 xterm.js 需要自己取：
   `npm pack monaco-editor@0.56.0` → 解包后把 `min/vs` 放进 `plugin/static/monaco/min/vs`；
   `npm pack @xterm/xterm@5.5.0 @xterm/addon-fit@0.10.0` → 解包放进 `plugin/static/xterm/`。
4. 插件要装进 DSH 家目录才能被天工加载：放到 `<DSH_HOME>\profiles\web\ide\dsh-ide\`，
   并在 `profiles\web\cordis.patch.yml` 里加上 `- id: dsh-ide` 一行（详见 tools 里的安装脚本）。
5. 壳与插件的完整安装/更新流程见 `tools/install-app.ps1`、`tools/publish-update.ps1`。

> 本包由 `tools/publish-source.ps1` 自动生成，请勿手改；源码不随更新包分发，只在这里按版本存档。
"@
Write-Utf8NoBom (Join-Path $stage 'README-源码说明.md') $readme

if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
New-ZipFromDir $stage $zipPath
$zipBytes = (Get-Item -LiteralPath $zipPath).Length
$zipSha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
$fileCount = (Get-ChildItem -LiteralPath $stage -Recurse -File -Force | Measure-Object).Count
Write-Host ("  zip: {0} （{1} 个文件 · {2} KB · sha256 {3}）" -f $zipName, $fileCount, [math]::Round($zipBytes / 1KB, 1), $zipSha.Substring(0, 12))

# ── ④ 生成页面（拉服务器上已有的清单 → 追加本版 → 重写页面）────
$versionsUrl = "$PublicBase/versions.json"
$list = @()
if (-not $SkipUpload) {
  try {
    # ⚠ 必须"下载到文件 + 显式按 UTF-8 读"：nginx 给 .json 的 Content-Type 是
    # `application/json`（**没有 charset**），PS 5.1 的 Invoke-WebRequest 于是按 Latin-1
    # 解码 → 中文说明变乱码 → 再写回去就**把旧版本的说明一层层毁掉**（2026-09-20 实测：
    # v1.5.12/13/14 的说明被毁了两层）。走文件是唯一稳的路子。
    $tmpManifest = Join-Path $WorkDir 'remote-versions.json'
    Invoke-WebRequest -Uri $versionsUrl -OutFile $tmpManifest -UseBasicParsing -TimeoutSec 20
    $old = [System.IO.File]::ReadAllText($tmpManifest, $utf8) | ConvertFrom-Json
    if ($old.items) { $list = @($old.items) }
    Write-Host ("  远端已有 {0} 个版本记录" -f $list.Count)
  } catch {
    Write-Host "  远端还没有清单（首次发布）" -ForegroundColor Yellow
  }
} else {
  $localList = Join-Path $WorkDir 'versions.json'
  if (Test-Path -LiteralPath $localList) {
    $old = [System.IO.File]::ReadAllText($localList, $utf8) | ConvertFrom-Json
    if ($old.items) { $list = @($old.items) }
  }
}
$exist = $list | Where-Object { $_.version -eq $Version }
# 判重只在"真发布"时生效：-SkipUpload 是本地预览，不该被自己上一轮的预览产物挡住
if ($exist -and -not $Force -and -not ($SkipUpload -or $DryRun)) {
  throw ("v$Version 已经发布过了（远端清单里有）。要重发同版本请加 -Force；正常迭代请用新版本号。")
}
$list = @($list | Where-Object { $_.version -ne $Version })
$entry = [ordered]@{
  version = $Version
  builtAt = (Get-Date).ToString('yyyy-MM-dd HH:mm')
  notes = $notesText
  zip = "source/$zipName"
  bytes = $zipBytes
  sha256 = $zipSha
  fileCount = $fileCount
  changedFiles = $changed.Count
  changed = $changed
}
$list = @($entry) + $list   # 新的在前
$manifest = [ordered]@{ product = '天工'; updatedAt = $stamp; count = $list.Count; items = $list }
Write-Utf8NoBom (Join-Path $WorkDir 'versions.json') ($manifest | ConvertTo-Json -Depth 8)

# 页面：与天工同一套深色配色（内容区 #141416 / 四周 #0D0D0F / 强调 #0078D4）
$rows = ''
foreach ($it in $list) {
  $kb = [math]::Round([double]$it.bytes / 1KB, 1)
  $rows += @"
    <article class="v">
      <header>
        <h2>v$(Escape-Html $it.version)</h2>
        <time>$(Escape-Html $it.builtAt)</time>
        <span class="meta">$(Escape-Html $it.fileCount) 个文件 · $kb KB · 本版改动 $(Escape-Html $it.changedFiles) 个文件</span>
        <a class="dl" href="$(Escape-Html $it.zip)">下载源码包</a>
      </header>
      <p class="notes">$(Escape-Html $it.notes)</p>
      $(if ($it.changed -and $it.changed.Count -gt 0) { '<details><summary>本版改动的文件</summary><ul>' + (($it.changed | ForEach-Object { '<li><code>' + (Escape-Html $_) + '</code></li>' }) -join '') + '</ul></details>' } else { '' })
    </article>
"@
}
$html = @"
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>天工 · 源码发布</title>
<style>
  :root{--bg:#0D0D0F;--content:#141416;--ctrl:#1C1C20;--line:#242428;--line2:#2E2E33;
        --fg:#D6D6D6;--fg2:#9A9AA0;--fg3:#7C7C84;--accent:#0078D4;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
  .wrap{max-width:920px;margin:0 auto;padding:40px 20px 64px}
  h1{font-size:22px;margin:0 0 6px}
  .sub{color:var(--fg2);margin:0 0 26px}
  .card{background:var(--content);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:0 0 22px}
  .card h3{margin:0 0 10px;font-size:14px;color:var(--fg)}
  .card p,.card li{color:var(--fg2)}
  code{font-family:ui-monospace,Consolas,monospace;background:var(--ctrl);border:1px solid var(--line);border-radius:4px;padding:1px 5px;color:var(--fg)}
  .v{background:var(--content);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:0 0 14px}
  .v header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  .v h2{margin:0;font-size:16px;color:var(--fg)}
  .v time{color:var(--fg3);font-size:12px}
  .v .meta{color:var(--fg3);font-size:12px}
  .dl{margin-left:auto;background:var(--accent);color:#fff;text-decoration:none;padding:5px 14px;border-radius:6px;font-size:13px}
  .dl:hover{filter:brightness(1.1)}
  .notes{color:var(--fg2);margin:10px 0 0;white-space:pre-wrap}
  details{margin-top:10px}
  summary{cursor:pointer;color:var(--fg3);font-size:12px}
  details ul{margin:8px 0 0;padding-left:20px;columns:2}
  footer{color:var(--fg3);font-size:12px;margin-top:30px;border-top:1px solid var(--line);padding-top:14px}
</style>
</head>
<body>
<div class="wrap">
  <h1>天工 · 源码发布</h1>
  <p class="sub">每个版本一份独立源码包，<b>旧版永久保留、不覆盖</b>。最新在最上面。共 $(Escape-Html $list.Count) 个版本。</p>

  <div class="card">
    <h3>这个包是什么</h3>
    <p>天工（原名 AnzioAgent / DSH IDE）是一个自己完全拥有的桌面 IDE：外形按 VSCode 的手感做，内核由完整 DSH 引擎直接驱动，内置 Agent 取代 VSCode 的 Copilot Chat。</p>
    <p>包里是<b>自己写的源码</b>：Electron 壳工程 + 天工 IDE 插件（后端 API 与整个界面）+ 发布/安装/测试脚本。
       <b>不含</b>第三方静态资源（monaco 编辑器、xterm.js）、依赖目录、以及任何凭证/会话/日志。</p>
    <p>怎么装依赖、怎么跑起来：见包内 <code>README-源码说明.md</code>。</p>
  </div>

  <div class="card">
    <h3>版本列表</h3>
    <p>下载的是 zip；每个版本的源码包发布后不再改动，便于对照与回溯。</p>
  </div>

$rows
  <footer>页面由 <code>tools/publish-source.ps1</code> 自动生成于 $stamp · 别手改，改脚本</footer>
</div>
</body>
</html>
"@
Write-Utf8NoBom (Join-Path $WorkDir 'index.html') $html
Write-Host ("  页面已生成：{0}（版本列表 {1} 条）" -f (Join-Path $WorkDir 'index.html'), $list.Count)

if ($SkipUpload -or $DryRun) {
  Write-Host ''
  Write-Host "（-SkipUpload/-DryRun：本地产物已就绪，未上传）" -ForegroundColor Yellow
  Write-Host ("  zip    : {0}" -f $zipPath)
  Write-Host ("  页面   : {0}" -f (Join-Path $WorkDir 'index.html'))
  Write-Host ("  清单   : {0}" -f (Join-Path $WorkDir 'versions.json'))
  exit 0
}

# ── ⑤ 上传 ───────────────────────────────────────────────────
Write-Host '== 上传 ==' -ForegroundColor Cyan
$sshOpts = @('-i', $KeyPath, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new')
& ssh @sshOpts $Server "mkdir -p $RemoteDir/source"
if ($LASTEXITCODE -ne 0) { throw "ssh 建目录失败（exit $LASTEXITCODE）" }
& scp @sshOpts $zipPath "$Server`:$RemoteDir/source/"
if ($LASTEXITCODE -ne 0) { throw "scp 上传 zip 失败（exit $LASTEXITCODE）" }
& scp @sshOpts (Join-Path $WorkDir 'index.html') (Join-Path $WorkDir 'versions.json') "$Server`:$RemoteDir/"
if ($LASTEXITCODE -ne 0) { throw "scp 上传页面失败（exit $LASTEXITCODE）" }
Write-Host '  上传完成'

# ── ⑥ 公网核对（不看服务器本地，直接看外面拿到的字节）────────────
Write-Host '== 公网核对 ==' -ForegroundColor Cyan
Start-Sleep -Seconds 2
$zipUrl = "$PublicBase/source/$zipName"
$head = Invoke-WebRequest -Uri $zipUrl -Method Head -UseBasicParsing -TimeoutSec 30
if ($head.StatusCode -ne 200) { throw "公网下载返回 $($head.StatusCode)" }
$remoteLen = 0
try { $remoteLen = [int64]$head.Headers['Content-Length'] } catch { $remoteLen = 0 }
if ($remoteLen -gt 0 -and $remoteLen -ne $zipBytes) { throw ("公网字节数对不上：本地 {0} / 远端 {1}" -f $zipBytes, $remoteLen) }
if ($remoteLen -gt 0) {
  Write-Host ("  zip 可下载：200 · {0} 字节（与本地一致）" -f $remoteLen) -ForegroundColor Green
} else {
  Write-Host "  zip 可下载：200（服务端未给 Content-Length，跳过字节数比对）" -ForegroundColor Yellow
}
$page = Invoke-WebRequest -Uri "$PublicBase/" -UseBasicParsing -TimeoutSec 30
if ($page.Content -notmatch [regex]::Escape("v$Version")) { throw "页面里没找到 v$Version" }
Write-Host ("  页面已含 v{0}：{1}" -f $Version, "$PublicBase/") -ForegroundColor Green
Write-Host ("  校验 sha256（远端）：ssh {0} `"sha256sum {1}/source/{2}`"" -f $Server, $RemoteDir, $zipName) -ForegroundColor DarkGray
Write-Host ''
Write-Host ("发布完成：{0}/  （新版本 v{1}，历史版本未改动）" -f $PublicBase, $Version) -ForegroundColor Cyan
