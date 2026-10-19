'use strict'

const { app, BrowserWindow, Menu, ipcMain, dialog, nativeTheme, shell, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { execSync } = require('child_process')
const { BackendManager } = require('./backend.js')
const { Updater } = require('./updater.js')
const { installBrowserHost } = require('./browser.js')
const { createDriver } = require('./driver.js')
const { startBridge } = require('./bridge.js')

// 应用数据目录钉死为 %APPDATA%\dsh-ide-desktop（历史目录名）：
// 它默认跟着产品名走，改名会让应用换一个空目录（丢窗口状态/backend.log）。
// 2026-09-17 改名天工时显式钉住，用户数据（D:\99DSH\app-home）本来就不受影响。
app.setPath('userData', path.join(app.getPath('appData'), 'dsh-ide-desktop'))

// ---- 配置（环境变量可覆盖）----
// 注意：**应用只认自己的 ANZIO_* 变量**，不读 DSH_* —— 否则从别的 DSH 会话里启动
// （比如开发台终端里 Start-Process）会继承 DSH_HOME=D:\99DSH\dev-home，把应用后端指到开发台
// 的 profile 上（表现为"打开是标准 Web 界面、dsh-ide 插件不挂载"，2026-09-16 踩到）。
const DSH_URL = process.env.ANZIO_DSH_URL || 'http://127.0.0.1:3081'
const DSH_DIR = process.env.ANZIO_DSH_DIR || 'D:\\99DSH\\deepseek-harness-mine\\harness'
// 默认跑 tsdown 构建产物（apps/cli/lib/bin.js，冷启动 ~2s；tsx 源码模式冷启
// 动 ~38s，2026-09-02 启动优化）。开发调试可用 ANZIO_DSH_LAUNCH 覆盖回 tsx 模式。
// --no-open：壳自己开窗口，别再抢系统默认浏览器（踩坑：后端把浏览器也拉起来过）。
const DSH_LAUNCH = process.env.ANZIO_DSH_LAUNCH || 'node apps/cli/lib/bin.js web --no-open'
const DSH_HOME = process.env.ANZIO_DSH_HOME || 'D:\\99DSH\\app-home'
// 安装目录 = exe 所在目录（固定路径 D:\000AnzioAgent，2026-09-16 起）。
// resources/app/main.js → 上两级就是安装根；环境变量可覆盖（开发/调试用）。
const INSTALL_DIR = process.env.ANZIO_INSTALL_DIR || (app.isPackaged ? path.resolve(__dirname, '..', '..') : __dirname)
// 显示名 = 天工（2026-09-17 用户拍板改名）。窗口标题 / 启动画面 / 对话框 / 任务栏都用它；
// 目录名、包名、插件 id 这类"中文不友好"的标识仍保留 ASCII，见 INSTALL_DIR / package.json。
const APP_TITLE = '天工'

// 启动自动更新的"逃生闸"（改动启动流程的东西必须留后路）：
//   · 启动参数 --no-update     → 本次不自动更新
//   · 环境变量 ANZIO_NO_UPDATE=1 → 同上（脚本/调试用）
const SKIP_UPDATE = process.argv.includes('--no-update') || process.env.ANZIO_NO_UPDATE === '1'

const ERROR_HTML = path.join(__dirname, 'error.html')
const LOADING_HTML = path.join(__dirname, 'loading.html')

// ── 内置浏览器的 Agent 驱动：CDP 调试端口（第二期）────────────────────────────
// Playwright 要一个 CDP 端点才连得上；正路（照抄 VSCode）是自己实现浏览器级协议代理、在进程内接
// `webContents.debugger`（一个端口都不开）。那条路是第二版。
// ⚠ **这是本期唯一被接受的技术债**：调试端口无鉴权（只绑 127.0.0.1，但本机任何进程都能连上来
//   操作页面）。第二版必须收掉它（设计定稿 §4.3）。
// 自己带过 --remote-debugging-port 的（调试/自动化）不重复加，并以传进来的端口为准 ——
// 否则两个端口并存，驱动层会连错。
const ARGV_DEBUG = process.argv.find((a) => String(a).startsWith('--remote-debugging-port'))
const WANT_PORT = ARGV_DEBUG
  ? Number(String(ARGV_DEBUG).split('=')[1])
  : Number(process.env.ANZIO_BROWSER_DEBUG_PORT || 9333)

// ── 端口被占就自动换一个（2026-10-16）─────────────────────────────────────────
// 病根：端口是 Chromium **启动那一刻**绑的，壳只交开关、从不看结果 ⇒ 一旦被占，Chromium 静默
// 放弃，天工看起来一切正常、只有浏览器驱动是死的。占它的往往**不是活着的天工进程**：上一个
// 实例退出时把监听 socket 的句柄留住了（2026-10-16 实测：LISTENING 记的 PID 在进程表里已经
// 查不到），所以重启天工甩不掉它 —— 只能自己先探、被占就换。
// 探法用 netstat（同步、零依赖、Windows 自带）：只认 LISTENING，别的状态（TIME_WAIT 等）
// 不影响绑定，不算占用。⚠ 探测本身绝不能拦住启动：查不出来就当没占用（退回改动前的行为）。
const PORT_SPAN = 20                                  // 被占时往后找多少个端口
function usedTcpPorts() {
  const used = new Set()
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    for (const line of String(out).split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 4 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue
      const port = Number(cols[1].slice(cols[1].lastIndexOf(':') + 1))
      if (port > 0) used.add(port)
    }
  } catch { /* 查不到就当作没有占用 */ }
  return used
}
const PORT_PICK = (() => {
  if (ARGV_DEBUG) return { port: WANT_PORT, reason: '命令行指定，壳不改' }
  const used = usedTcpPorts()
  if (!used.has(WANT_PORT)) return { port: WANT_PORT, reason: null }
  for (let p = WANT_PORT + 1; p <= WANT_PORT + PORT_SPAN; p++) {
    if (!used.has(p)) return { port: p, reason: '首选 ' + WANT_PORT + ' 被占（多是被上一个实例留下的无主监听端口占着）' }
  }
  return { port: WANT_PORT, reason: WANT_PORT + ' 起连续 ' + PORT_SPAN + ' 个端口都被占，只能用首选' }
})()
const BROWSER_DEBUG_PORT = PORT_PICK.port
if (!ARGV_DEBUG) app.commandLine.appendSwitch('remote-debugging-port', String(BROWSER_DEBUG_PORT))

// 壳的启动痕迹落盘：app-home\logs\shell-boot.log。
// 为什么不用 console.log：装好之后天工是双击快捷方式起的，stdout 没人接，控制台里那些话全丢。
function noteBoot(line) {
  try {
    const dir = path.join(DSH_HOME, 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'shell-boot.log'),
      '[' + new Date().toISOString() + '] pid=' + process.pid + ' ' + line + '\n')
  } catch { /* 写不进去也不能拦住启动 */ }
}
// 日志只在出事时写（2026-10-16 精简）：正常启动写两行只是把自己的日志刷成噪音，真出事时反倒难找。
if (PORT_PICK.reason !== null) noteBoot('浏览器调试端口 = ' + BROWSER_DEBUG_PORT + '（' + PORT_PICK.reason + '）')

// ── 壳侧结构化日志：app-home\logs\shell.log（JSONL，2026-10-19）─────────────
// 为什么不并进插件的 ide-trace.log：那份由后端进程写、自己管切分，两个进程抢 rename 会互相咬。
// 为什么必须落盘：装好后是双击快捷方式起的，主进程 console 没人接 —— 后端掉线、更新失败、
// 渲染进程崩溃这些最容易报"软件自己坏了"的事，以前一行证据都不留。格式与插件那份同时间轴，按 ts 对齐。
const SHELL_LOG_MAX_BYTES = 8 * 1024 * 1024
const SHELL_LOG_KEEP = 3
let shellLogBytes = null
function noteLog(level, kind, msg, meta) {
  try {
    const dir = path.join(DSH_HOME, 'logs')
    const file = path.join(dir, 'shell.log')
    fs.mkdirSync(dir, { recursive: true })
    if (shellLogBytes === null) { try { shellLogBytes = fs.statSync(file).size } catch { shellLogBytes = 0 } }
    const head = { ts: new Date().toISOString(), src: 'shell', level: level || 'info', kind: kind || 'shell', msg: String(msg || '').slice(0, 2000) }
    const line = JSON.stringify(meta ? Object.assign(head, { meta: meta }) : head) + '\n'
    if (shellLogBytes + Buffer.byteLength(line) > SHELL_LOG_MAX_BYTES) {
      for (let i = SHELL_LOG_KEEP; i >= 1; i--) {
        const from = i === 1 ? file : file + '.' + (i - 1)
        const to = file + '.' + i
        try { fs.rmSync(to, { force: true }) } catch { /* 目标不存在 */ }
        try { fs.renameSync(from, to) } catch { /* 这一份不存在 */ }
      }
      shellLogBytes = 0
    }
    fs.appendFileSync(file, line)
    shellLogBytes += Buffer.byteLength(line)
  } catch { /* 日志失败不拦业务 */ }
}
// 同一句话反复出现时合并（渲染层报错常常每次重渲染都刷一遍）
const shellLogGates = new Map()
function noteLogThrottled(key, windowMs, level, kind, msg, meta) {
  const now = Date.now()
  const prev = shellLogGates.get(key)
  if (prev && now - prev.at < windowMs) { prev.n += 1; return }
  const m = Object.assign({}, meta || {})
  if (prev && prev.n) m.suppressed = prev.n
  if (shellLogGates.size > 300) shellLogGates.clear()
  shellLogGates.set(key, { at: now, n: 0 })
  noteLog(level, kind, msg, m)
}
// 主进程自己崩了也要留证（Electron 默认弹窗 + 退出，日志里什么都没有）
// uncaughtException 仍然按 Node 的默认语义**致命处理**：只加记录，不改变"崩了就是崩了"，
// 否则会变成"看起来还活着、实际半死"——比直接退出更难查。
process.on('uncaughtException', (e) => {
  noteLog('error', 'main-crash', 'uncaughtException（进程即将退出）', { error: (e && e.stack) || String(e) })
  console.error('[anzio] uncaughtException:', e)
  process.exit(1)
})
// 未处理的 Promise 拒绝不致命（多数是网络/时序问题），只留证不退出
process.on('unhandledRejection', (e) => {
  noteLog('warn', 'main-crash', 'unhandledRejection', { error: (e && e.stack) || String(e) })
  console.error('[anzio] unhandledRejection:', e)
})

// 起后自检（同一天加的）：把"静默失败"变成日志里有痕 —— 端口上有监听却没人应答（就是上面说的
// 无主端口）时，Chromium 不会报任何错，只有驱动连不上。自检失败不影响启动，纯留证。
setTimeout(() => {
  const req = http.get({ host: '127.0.0.1', port: BROWSER_DEBUG_PORT, path: '/json/version', timeout: 3000 }, (res) => {
    try { res.resume() } catch { /* 忽略 */ }
    if (res.statusCode !== 200) noteBoot('⚠ CDP 自检异常：HTTP ' + res.statusCode + '（端口 ' + BROWSER_DEBUG_PORT + '）—— 浏览器驱动会不可用')
  })
  req.on('timeout', () => {
    try { req.destroy() } catch { /* 忽略 */ }
    noteBoot('⚠ CDP 自检超时：端口 ' + BROWSER_DEBUG_PORT + ' 有监听但没人应答 —— 浏览器驱动会不可用')
  })
  req.on('error', (e) => {
    noteBoot('⚠ CDP 自检失败：' + ((e && e.message) || e) + '（端口 ' + BROWSER_DEBUG_PORT + '）—— 浏览器驱动会不可用')
  })
}, 3000)

let mainWindow = null
let backend = null
let updater = null
// 内置浏览器内核（原生 WebContentsView 宿主）：窗口建好后装上，见 shell/browser.js
let browserHost = null
// 动作用 Playwright 的那一层 + 它跟后端之间的壳桥（见 shell/driver.js / bridge.js）
let browserDriver = null
let browserBridge = null

function appVersion() {
  if (updater) return updater.installedVersion()
  try {
    return String(JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'version.json'), 'utf8')).version)
  } catch { return String(app.getVersion() || '') }
}

function titleOf() {
  const v = appVersion()
  return v ? APP_TITLE + ' v' + v : APP_TITLE
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0D0D0F',
    title: titleOf(),
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // 标题栏自绘（2026-09-17 用户要求"顶部标题栏跟主题色协调"）：
    // 原生标题栏的颜色由 Windows/DWM 决定（Electron 改不了）→ 隐藏它，改用 titleBarOverlay
    // 让系统按钮（最小化/最大化/关闭）以我们的主题色绘制。窗口拖动改由页面侧
    // .dside-titlebar 的 -webkit-app-region:drag 接管（见 dsh-ide client.js）。
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0D0D0F', symbolColor: '#D6D6D6', height: 44 },
    // 立即显示：先呈现"启动中"画面，后端就绪后再加载应用页面
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // 保持窗口标题为应用名（不被页面标题覆盖）
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow.setTitle(titleOf())
  })

  let failCount = 0
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDesc) => {
    failCount += 1
    if (failCount <= 2) {
      console.error('[dsh-ide] load failed:', errorCode, errorDesc)
      noteLog('error', 'page-load-failed', '主窗口加载失败', { errorCode: errorCode, errorDesc: errorDesc, url: DSH_URL })
      mainWindow.loadFile(ERROR_HTML, { query: { url: DSH_URL, reason: 'load-failed' } })
    }
  })
  mainWindow.webContents.on('did-finish-load', () => {
    failCount = 0
  })

  // ── 渲染层事故留证（2026-10-19）：以前这些全被"没有控制台"吃掉 ──────────
  // 页面 console.error：只收 error 档（info/warn 太吵），同一句话 60s 合并一次
  mainWindow.webContents.on('console-message', (...args) => {
    // 新旧 Electron 签名兼容：新版 (event, details)，旧版 (event, level, message, line, sourceId)
    const details = args[1] && typeof args[1] === 'object' ? args[1] : null
    const level = details ? details.level : args[1]
    const message = details ? details.message : args[2]
    const source = details ? details.sourceId : args[4]
    const line = details ? details.lineNumber : args[3]
    if (level !== 'error' && level !== 3) return
    if (!message) return
    noteLogThrottled('renderer-console|' + String(message).slice(0, 200), 60000, 'error', 'renderer-console',
      String(message).slice(0, 1000), { source: source, line: line })
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    noteLog('error', 'render-gone', '渲染进程退出（界面会白屏/关闭）', details)
  })
  mainWindow.webContents.on('unresponsive', () => {
    noteLog('warn', 'render-unresponsive', '界面无响应（超过系统判定阈值）')
  })
  mainWindow.webContents.on('responsive', () => {
    noteLog('info', 'render-responsive', '界面恢复响应')
  })

  // 启动画面：后端就绪前先显示本地页面（带明确的启动反馈）
  mainWindow.loadFile(LOADING_HTML)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function boot() {
  backend = new BackendManager({
    url: DSH_URL,
    dir: DSH_DIR,
    command: DSH_LAUNCH,
    dshHome: DSH_HOME,
    logFile: path.join(app.getPath('userData'), 'backend.log'),
    // 壳桥交给后端的只有地址与口令（内存里生成，进程间用环境变量传，不落盘）
    bridge: browserBridge ? { url: browserBridge.url, token: browserBridge.token } : null,
    onExit: (code, signal, intentional, wasOwned) => {
      console.error('[dsh-ide] backend exited:', code, signal, intentional ? '(主动停止)' : '(掉线)')
      noteLog(intentional ? 'info' : 'error', 'backend-exit',
        intentional ? '后端被主动停止' : '后端掉线',
        { code: code, signal: signal, owned: !!wasOwned })
      // 主动停止（关软件 / Ctrl+Shift+R 重启后端）不拉起；**掉线**才拉（见 reviveBackend）。
      if (intentional) return
      if (!wasOwned) return          // 复用的外部后端掉了：不是我们该管的事（别去抢别人的端口）
      void reviveBackend()
    },
  })

  const result = await backend.ensure()
  if (!result.started && result.reason) {
    console.error('[dsh-ide] backend start failed:', result.reason)
    noteLog('error', 'backend-start-failed', '后端启动失败', { reason: result.reason, dir: DSH_DIR, home: DSH_HOME })
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadFile(ERROR_HTML, { query: { url: DSH_URL, reason: result.reason } })
    }
    return
  }
  // 后端就绪：切换到应用页面。
  // 带 token 的启动 URL 优先（DSH 的 shell 页面要认证：直接开 / 会 401 空白页；
  // 带 ?token= 的首访会种下签名 cookie 并 303 到干净的 /，之后就一直有效）。
  const target = await resolveAppUrl()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(target)
  }
}

// 决定窗口要打开哪个 URL：
//   ① 自己起的后端 → 等它的 token URL（"dsh web: http://…/?token=…" 这行是在
//      Loader 挂载完之后才打印的，**端口可连 ≠ 已经打印**，所以必须等，别抢跑 —— 
//      抢跑就会去开不带 token 的 /，直接吃 401 空白页，2026-09-16 实测踩到）
//   ② 后端已在跑（不是我们起的）→ 探一下 /：200 就用（cookie 还在），401 就明确报错
async function resolveAppUrl() {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (backend && backend.readyUrl) return backend.readyUrl
    if (backend && !backend.isOwned()) break   // 不是自己起的，等也没用
    await new Promise((r) => setTimeout(r, 200))
  }
  try {
    const res = await fetch(DSH_URL + '/', { method: 'GET', redirect: 'manual' })
    if (res.status === 401) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadFile(ERROR_HTML, {
          query: { url: DSH_URL, reason: '端口 3081 上已有一个需要授权的 DSH 实例（可能是另一个 AnzioAgent 或测试后端）。请先关掉它，再启动本应用。' },
        })
      }
      return DSH_URL
    }
  } catch { /* 探测失败就照常加载 */ }
  return DSH_URL
}

function reloadDSH() {
  if (!mainWindow) return
  // 有 token URL 就用它（重放一次会重新种 cookie，最稳）
  mainWindow.loadURL((backend && backend.readyUrl) || DSH_URL)
}

// ── 内置更新器（2026-09-16）────────────────────────────────────────
// 壳只负责"检测 / 下载 / 退出后安装"；版本号与清单来自安装目录 version.json + 更新源 latest.json。
// 渲染层通过 preload 暴露的 window.anzioUpdater 读状态（IDE 插件在标题栏显示版本/更新按钮）。
function pushState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('anzio-updater:state', state) } catch { /* 页面未就绪 */ }
  }
}

// ── 启动画面状态（2026-09-20：自动更新要能让用户看见"在更新"）──────────────
// 用 executeJavaScript 直接改 loading.html 里的文本/进度条：启动画面没有 preload，
// 而这段是"主进程 → 页面"的单向显示更新，不值得为它加一条 IPC 通道。
// ⚠ 任何失败都只能吞掉：启动画面刷不出来绝不能影响启动本身。
function splashSet(p) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) return
  const setIf = (id, v) => (typeof v === 'string' ? `set(${JSON.stringify(id)}, ${JSON.stringify(v)});` : '')
  const js = '(function(){'
    + 'function set(id,txt){var e=document.getElementById(id); if(e) e.textContent=txt;}'
    + 'var bar=document.getElementById("st-bar"), fill=document.getElementById("st-fill");'
    + setIf('st-title', p.title)
    + setIf('st-sub', p.sub)
    + setIf('st-steps', p.steps)
    + (p.indeterminate ? 'if(bar) bar.classList.add("indet"); if(fill) fill.style.width="";' : '')
    + (typeof p.progress === 'number'
        ? 'if(bar) bar.classList.remove("indet"); if(fill) fill.style.width=' + Math.round(p.progress) + '+"%";'
        : '')
    + '})()'
  try { mainWindow.webContents.executeJavaScript(js, true).catch(() => {}) } catch { /* 忽略 */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// 更新器状态：推给渲染层（标题栏徽标）+ 自动更新时顺带刷启动画面进度
let splashProgressOn = false
let splashLastPct = -1
function onUpdaterState(state) {
  pushState(state)
  if (!splashProgressOn) return
  // ⚠ 只有"下载中"才写进度行：check 阶段也会推一次 state（progress=0），
  // 早期版本把它误写成"正在下载… 0%"——启动画面上显示"检查中却在下载"。
  if (state.phase !== 'downloading') return
  const pct = Math.round((state.progress || 0) * 100)
  if (pct === splashLastPct) return
  splashLastPct = pct
  splashSet({ progress: (state.progress || 0) * 100, steps: '正在下载并校验更新包… ' + pct + '%' })
}

// ── 启动前自动更新（2026-09-20 用户要求）─────────────────────────────────
// 用户原话："启动的时候先检查更新，有更新了，先更新，再打开软件，就像现在市面上那些常见的软件一样"。
// 顺序：启动画面 → 检查 → 有新版就下载校验（画面显示进度）→ 自重启安装 → 再自重启 → 新版本接管。
// 三条硬规矩（这块弄不好会让应用打不开，所以每条都必须成立）：
//   ① **绝不阻塞启动**：检查/下载任何失败、异常、超时 → 记日志、照常 boot()。
//   ② **可跳过**：启动参数 --no-update 或环境变量 ANZIO_NO_UPDATE=1 整个跳过；
//      启动画面上按 Esc 跳过本次（包已下好，标题栏仍可手动装）。
//   ③ **不重复踩坑**：某版本下载失败会被记住（6 小时内不再自动重试，见 updater.markFailed），
//      手动"检查更新"不受影响。
async function autoUpdatePhase() {
  if (SKIP_UPDATE) { console.log('[anzio] 自动更新已跳过（--no-update / ANZIO_NO_UPDATE）'); noteLog('info', 'update', '自动更新已跳过（启动参数/环境变量）'); return }
  if (!updater) return
  const cfg = updater.config()
  if (cfg.autoApply === false) { console.log('[anzio] 自动更新已关闭（updater.json: autoApply=false）'); noteLog('info', 'update', '自动更新已关闭（配置项 autoApply=false）'); return }
  const started = Date.now()
  const deadline = started + (cfg.autoApplyTimeoutMs || 120000)
  let esc = false
  const onInput = (_e, input) => {
    if (input && input.type === 'keyDown' && input.key === 'Escape') esc = true
  }
  try { if (mainWindow && mainWindow.webContents) mainWindow.webContents.on('before-input-event', onInput) } catch { /* 忽略 */ }
  splashProgressOn = true
  splashLastPct = -1
  try {
    splashSet({ title: APP_TITLE + ' 正在检查更新…', sub: '启动前先看看有没有新版本', steps: '按 Esc 可跳过本次更新（不影响使用）', indeterminate: true })
    const chk = await updater.check()
    if (!chk.ok) {
      console.log('[anzio] 更新检查失败，照常启动：' + chk.error)
      noteLog('warn', 'update', '检查更新失败，照常启动', { error: chk.error })
      splashSet({ title: APP_TITLE + ' 正在启动…', sub: '检查更新失败（离线也能用），正在启动', indeterminate: true })
      return
    }
    if (!chk.available) {
      console.log('[anzio] 已是最新版本 v' + chk.installed)
      noteLog('info', 'update', '已是最新版本', { version: chk.installed })
      splashSet({ title: APP_TITLE + ' 正在启动…', sub: '已是最新版本 v' + chk.installed, indeterminate: true })
      return
    }
    const target = String((chk.latest && chk.latest.version) || '')
    if (updater.failedRecently(target)) {
      console.log('[anzio] v' + target + ' 之前更新失败过，本次不自动重试（标题栏可手动更新）')
      noteLog('warn', 'update', '该版本此前更新失败，本次不自动重试', { version: target })
      splashSet({ title: APP_TITLE + ' 正在启动…', sub: 'v' + target + ' 上次更新失败，已跳过（标题栏可手动更新）', indeterminate: true })
      return
    }
    console.log('[anzio] 发现新版本 v' + target + '（当前 v' + chk.installed + '），开始自动更新')
    noteLog('info', 'update', '发现新版本，开始自动更新', { from: chk.installed, to: target })
    splashSet({
      title: '正在更新到 v' + target + '…',
      sub: '下载并校验更新包，完成后会自动重启到新版本',
      steps: '正在下载并校验更新包… 0%',
      progress: 0,
    })
    const res = await updater.install()
    if (!res.ok) {
      updater.markFailed(target, res.error)
      console.error('[anzio] 自动更新下载失败，照常启动：' + res.error)
      noteLog('error', 'update', '自动更新下载/校验失败，照常启动', { version: target, error: res.error })
      splashSet({ title: APP_TITLE + ' 正在启动…', sub: '更新失败，先照常启动（标题栏可重试）', indeterminate: true })
      return
    }
    if (res.upToDate) {
      splashSet({ title: APP_TITLE + ' 正在启动…', sub: '已是最新版本', indeterminate: true })
      return
    }
    // 到这里：包已下好、校验通过、pending 标记已写 —— 剩下的只是"什么时候重启装上"
    if (esc) {
      console.log('[anzio] 用户按 Esc 跳过本次安装（更新包已就绪，可稍后重启安装）')
      noteLog('info', 'update', '用户按 Esc 跳过本次安装（包已就绪）', { version: target })
      splashSet({ title: APP_TITLE + ' 正在启动…', sub: '已跳过本次更新（包已就绪，标题栏可重启安装）', indeterminate: true })
      return
    }
    if (Date.now() > deadline) {
      console.log('[anzio] 自动更新超时，先照常启动（包已就绪）')
      noteLog('warn', 'update', '自动更新超时，先照常启动（包已就绪）', { version: target, ms: Date.now() - started })
      splashSet({ title: APP_TITLE + ' 正在启动…', sub: '更新耗时过长，先照常启动（包已就绪）', indeterminate: true })
      return
    }
    splashSet({ title: '正在安装 v' + target + '…', sub: '马上自动重启到新版本', steps: '安装中…', progress: 100 })
    await sleep(700)   // 让用户看到这一帧，别一闪而过
    console.log('[anzio] 自动更新就绪，重启安装 v' + target)
    noteLog('info', 'update', '更新包就绪，重启安装', { version: target })
    updater.applyAndRestart()
  } catch (e) {
    console.error('[anzio] 自动更新异常（照常启动）：' + ((e && e.message) || e))
    noteLog('error', 'update', '自动更新流程异常，照常启动', { error: (e && e.stack) || String(e) })
  } finally {
    splashProgressOn = false
    try { if (mainWindow && mainWindow.webContents) mainWindow.webContents.removeListener('before-input-event', onInput) } catch { /* 忽略 */ }
  }
}

function setupUpdater() {
  // 实例在启动早期就建好（自动更新阶段要用同一个实例，见 whenReady）
  if (!updater) {
    updater = new Updater({
      installDir: INSTALL_DIR,
      homeDir: DSH_HOME,
      exePath: process.execPath,
      onState: onUpdaterState,
    })
  }
  ipcMain.handle('anzio-updater:state', () => updater.state)
  ipcMain.handle('anzio-updater:check', async () => {
    const r = await updater.check()
    if (r.ok && r.available && mainWindow) mainWindow.setTitle(titleOf())
    return r
  })
  ipcMain.handle('anzio-updater:install', async () => updater.install())
  ipcMain.handle('anzio-updater:apply', () => updater.applyAndRestart())

  // 打开文件 / 另存为（2026-09-29）：VSCode 的 openFile(Ctrl+O) 与 saveAs(Ctrl+Shift+S) 用的都是
  // **系统原生对话框**；平台侧只提供 pickDirectory（没有选文件/保存的能力），所以由天工壳补。
  // ⚠ 壳 JS 不吃 HMR：改完要重启天工才生效（下发走更新包的 shell 文件，见 00devCore §0.2）。
  ipcMain.handle('anzio-shell:pick-file', async () => {
    try {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: '打开文件', properties: ['openFile', 'dontAddToRecent'],
      })
      if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, code: 'canceled' }
      return { ok: true, path: r.filePaths[0] }
    } catch (e) {
      return { ok: false, code: 'error', message: String((e && e.message) || e) }
    }
  })
  // 另存为：defaultPath 传当前文件路径 → 原生对话框默认落回原目录/原名。
  // showOverwriteConfirmation = 目标已存在时由系统问一次（我们自己不做覆盖确认，VSCode 同样交给系统）
  ipcMain.handle('anzio-shell:pick-save', async (_e, defaultPath) => {
    try {
      const opts = { title: '另存为', properties: ['showOverwriteConfirmation', 'dontAddToRecent'] }
      if (typeof defaultPath === 'string' && defaultPath) opts.defaultPath = defaultPath
      const r = await dialog.showSaveDialog(mainWindow, opts)
      if (r.canceled || !r.filePath) return { ok: false, code: 'canceled' }
      return { ok: true, path: r.filePath }
    } catch (e) {
      return { ok: false, code: 'error', message: String((e && e.message) || e) }
    }
  })

  // 标签右键菜单的「在文件资源管理器中显示」：Windows 资源管理器里选中该文件。
  // 浏览器里打开 3081 时没有这个桥（window.anzioShell 不存在），插件会自己隐藏该条目。
  ipcMain.handle('anzio-shell:reveal', (_e, target) => {
    try {
      if (typeof target !== 'string' || !target) return { ok: false, code: 'bad-arg' }
      if (!fs.existsSync(target)) return { ok: false, code: 'not-found' }
      shell.showItemInFolder(target)
      return { ok: true }
    } catch (e) {
      return { ok: false, code: 'error', message: String((e && e.message) || e) }
    }
  })

  const cfg = updater.config()
  if (!cfg.autoCheck) return
  if (cfg.autoApply !== false) {
    // 自动更新开着：启动那一段（autoUpdatePhase）已经做了"检查→下载→装上"，
    // 这里**不再弹模态框**（弹了就是重复打扰）；只静默刷一下状态，让标题栏徽标有数。
    setTimeout(() => { updater.check().catch(() => {}) }, 1500)
  } else {
    // 关掉自动更新时保留老行为：启动后查一次，弹原生提示问用户
    // （用户点过「稍后」的版本不再重复弹；标题栏徽标仍然提示，随时可手动更）
    setTimeout(async () => {
      const r = await updater.check()
      if (!r.ok || !r.available) return
      const latest = updater.state.latest || {}
      if (updater.skippedVersion() === String(latest.version)) return
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '检测到新版本',
        message: APP_TITLE + ' 有新版本 v' + latest.version + '（当前 v' + r.installed + '）',
        detail: (latest.notes ? latest.notes + '\n\n' : '')
          + '文件 ' + (latest.fileCount || 0) + ' 个 · ' + fmtBytes(latest.totalBytes || 0)
          + '\n可以现在下载安装，也可以稍后在标题栏点版本号更新。',
        buttons: ['下载并安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (choice.response !== 0) {
        updater.skipVersion(latest.version)
        return
      }
      await runInstallFlow(true)
    }, 3000)
  }

  // 周期性复查（默认 30 分钟）
  setInterval(() => { updater.check().catch(() => {}) }, cfg.checkIntervalMs)
}

function fmtBytes(n) {
  if (!n) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

// 下载 + 校验 → 问是否立即重启安装
async function runInstallFlow(fromDialog) {
  if (!updater) return { ok: false, error: 'updater 未初始化' }
  const r = await updater.install()
  if (!r.ok) {
    dialog.showMessageBox(mainWindow, {
      type: 'error', title: '更新失败', message: '下载更新失败', detail: String(r.error || ''), buttons: ['好'], noLink: true,
    })
    return r
  }
  if (r.upToDate) {
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: '已是最新版本', message: APP_TITLE + ' 已是最新版本 v' + updater.installedVersion(), buttons: ['好'], noLink: true,
    })
    return r
  }
  const latest = updater.state.latest || {}
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '更新已就绪',
    message: 'v' + r.version + ' 已下载完成（' + r.files + ' 个文件）',
    detail: '点「重启并安装」会关闭当前窗口，替换文件后自动重新打开。',
    buttons: ['重启并安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (choice.response !== 0) return r
  updater.applyAndRestart()
  return r
}

// 手动检查更新（Ctrl+Shift+U）
async function checkUpdatesInteractive() {
  if (!updater) return
  const r = await updater.check()
  if (!r.ok) {
    dialog.showMessageBox(mainWindow, {
      type: 'error', title: '检查更新失败', message: '读不到更新源', detail: String(r.error || ''), buttons: ['好'], noLink: true,
    })
    return
  }
  if (!r.available) {
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: '已是最新版本', message: APP_TITLE + ' 已是最新版本 v' + r.installed, buttons: ['好'], noLink: true,
    })
    return
  }
  const latest = r.latest || {}
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '检测到新版本',
    message: '有新版本 v' + latest.version + '（当前 v' + r.installed + '）',
    detail: (latest.notes ? latest.notes + '\n\n' : '') + '文件 ' + (latest.fileCount || 0) + ' 个 · ' + fmtBytes(latest.totalBytes || 0),
    buttons: ['下载并安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (choice.response === 0) await runInstallFlow(true)
}

async function restartBackend() {
  if (!backend) return
  backend.stop()
  const result = await backend.ensure()
  if (!result.started && result.reason) {
    mainWindow.loadFile(ERROR_HTML, { query: { url: DSH_URL, reason: result.reason } })
    return
  }
  reloadDSH()
}

// ── 后端掉线自动拉起（2026-10-14 真机事故）────────────────────────────────────
// 事故原样：Agent 跑 `Get-Process node | Stop-Process -Force`（它以为在清自己的测试进程），
// 把天工后端（就是 node.exe）一起打死 ⇒ 界面还活着、点什么都只回 `Failed to fetch`，
// 用户只能关软件重开。壳这一侧原来什么都不做（那个 if 分支是空的），这里补上兜底：
// 后端一掉就把它拉回来 + 重载页面；连续拉不起来就换成错误页，至少让用户知道出了什么事。
// ⚠ 只有"我们自己起的后端"才拉：复用别人后端（端口上已有服务）时不自作主张。
// ⚠ 限流用**时间窗**（60 秒内最多 3 次），别用"成功一次就清零"——不然环境性崩溃会无限重启。
const backendRevives = []
function reviveAllowed() {
  const now = Date.now()
  while (backendRevives.length > 0 && now - backendRevives[0] > 60000) backendRevives.shift()
  if (backendRevives.length >= 3) return false
  backendRevives.push(now)
  return true
}
let reviving = false
async function reviveBackend() {
  if (reviving) return                       // 掉线事件可能来两次（stdout 关闭 + exit），去重
  if (!backend) return
  if (!reviveAllowed()) {
    console.error('[dsh-ide] backend revive skipped: too many restarts in a minute')
    noteLog('error', 'backend-revive', '后端 1 分钟内退出 3 次，已停止自动重启')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadFile(ERROR_HTML, {
        query: { url: DSH_URL, reason: '后端反复退出（1 分钟内 3 次），已停止自动重启。请检查是否有东西在杀 node 进程。' },
      })
    }
    return
  }
  reviving = true
  try {
    console.error('[dsh-ide] backend lost, reviving…')
    noteLog('warn', 'backend-revive', '后端掉线，开始自动重拉')
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile(LOADING_HTML)
    await new Promise((r) => setTimeout(r, 1200))     // 等端口彻底松开再拉，避免"地址已被占用"
    const result = await backend.ensure()
    if (!result.started && result.reason) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadFile(ERROR_HTML, { query: { url: DSH_URL, reason: result.reason } })
      }
      return
    }
    const target = await resolveAppUrl()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(target)
    console.error('[dsh-ide] backend revived')
    noteLog('info', 'backend-revive', '后端已重新拉起')
  } catch (err) {
    console.error('[dsh-ide] backend revive failed:', err)
    noteLog('error', 'backend-revive', '重拉失败', { error: (err && err.stack) || String(err) })
  } finally {
    reviving = false
  }
}

// 顶部菜单栏已移除（界面干净）；调试快捷键在下面手动注册，与原来菜单项行为一致：
//   Ctrl+R          重载 DSH 页面        Ctrl+Shift+R  重启后端
//   F5              重载 DSH 页面        F12/Ctrl+Shift+I 开发者工具
//   F11             全屏切换              Ctrl+=/-/0   缩放
//   ⚠ Ctrl+Shift+U  检查更新
//   ⚠ 编辑类键（Ctrl+A/C/V/X/Z/Y）**故意不在这里拦** —— 见下面的注释（2026-09-21 修 Ctrl+A 失效）
// ── 天工快捷键最高优先（2026-09-22 用户钉死的铁律）────────────────────────────
// 规则：**天工自己的快捷键是最高级别的 —— 其它应用跟我们冲突，一律以天工为准。**
// 背景（为什么要动 globalShortcut 这种重手段）：这台机器上 Ctrl+` 会被输入法的底层键盘钩子
// 吞掉 —— 页面里只收到 Control、收不到反引号（实测同一手法发 Ctrl+[ / Ctrl+1 / Ctrl+B / Alt+`
// / Ctrl+Shift+` 全正常，只有 Ctrl+` 消失；换 Edge 也一样，与本应用无关；RegisterHotKey 检测
// 说明没有别的程序占用它 → 钩子级吞键）。**但系统热键层能收到它** → 这条路能把键抢回来。
// 做法：页面把"当前生效的键位表"送上来 → 壳**只在窗口有焦点时**注册成全局快捷键 →
// 触发后把键位串送回页面，由页面走它自己那套路由分发（键位可被用户改，壳不写死任何键）。
// 失焦立刻全部注销：**绝不在别的程序里抢这些键**（有焦点才叫"冲突时臣服"）。
// 注册失败（被系统/别的程序硬占）不影响功能：那条键照旧走页面原生监听。
function installHotkeyForwarding(win) {
  const DEFAULT_ACC = 'Control+`'                 // 页面把键位表送上来之前的保底（就是被吞的那个）
  const DEFAULT_CHORD = 'Ctrl+`'
  let pageChords = []                             // 页面送上来的键位（单步，已归一）
  const registered = new Set()

  const fire = (chord) => {
    try { win.webContents.send('anzio-shell:hotkey', chord) } catch { /* 窗口没了 */ }
  }
  const registerOne = (acc, chord) => {
    if (!acc) return
    try {
      if (globalShortcut.isRegistered(acc)) return
      if (globalShortcut.register(acc, () => fire(chord))) registered.add(acc)
      else { console.warn('[anzio] 快捷键被系统占用，注册失败：' + acc); noteLog('warn', 'hotkey', '全局快捷键注册失败（被系统/其它程序占用）', { acc: acc }) }
    } catch (e) { console.warn('[anzio] 快捷键注册异常 ' + acc + ': ' + ((e && e.message) || e)); noteLog('error', 'hotkey', '全局快捷键注册异常', { acc: acc, error: (e && e.message) || String(e) }) }
  }
  const registerAll = () => {
    registerOne(DEFAULT_ACC, DEFAULT_CHORD)
    for (const chord of pageChords) registerOne(chord, chord)   // 归一后的键位串本身就是 Electron 加速度
  }
  const unregisterAll = () => {
    try { globalShortcut.unregisterAll() } catch { /* 忽略 */ }
    registered.clear()
  }

  // 页面送键位表上来：记下来（焦点在就问立刻生效，不在焦点就等下次 focus）
  ipcMain.handle('anzio-shell:hotkeys', (_e, list) => {
    pageChords = (Array.isArray(list) ? list : []).filter((c) => typeof c === 'string' && c.indexOf(' ') < 0).slice(0, 80)
    if (win.isFocused()) { unregisterAll(); registerAll() }
    return { ok: true, count: pageChords.length }
  })

  win.on('focus', () => { unregisterAll(); registerAll() })
  win.on('blur', unregisterAll)
  win.on('closed', unregisterAll)
  if (win.isFocused()) registerAll()
}

function installShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const ctrl = input.control || input.meta
    const shift = input.shift
    const alt = input.alt
    const key = String(input.key || '').toLowerCase()
    const wc = win.webContents
    if (ctrl && shift && key === 'r') { event.preventDefault(); restartBackend(); return }
    if (ctrl && shift && key === 'u') { event.preventDefault(); checkUpdatesInteractive(); return }
    if (ctrl && key === 'r' || input.key === 'F5') { event.preventDefault(); reloadDSH(); return }
    if ((ctrl && shift && key === 'i') || input.key === 'F12') { event.preventDefault(); wc.toggleDevTools(); return }
    if (input.key === 'F11') { event.preventDefault(); win.setFullScreen(!win.isFullScreen()); return }
    // ⚠ 2026-09-21：**不再拦截 Ctrl+A / C / V / X / Z / Y**。
    // before-input-event 里 preventDefault() = 按键**根本到不了页面**，而 wc.selectAll()/copy()/cut()/paste()/undo()
    // 是"整页 DOM"级的编辑命令，不是编辑器级的：monaco 的多光标、语法高亮复制、撤销分组全部失效，
    // Ctrl+A 更是变成"选中整个页面的文字"而不是"选中编辑器里的代码"
    // （用户 2026-09-21 实测报障："中间面板 Ctrl+A 全选无效"）。
    // Windows 上 Chromium 自带标准编辑键处理，删掉菜单也不影响（macOS 才必须靠菜单项）；
    // 所以这里让这些键原样进页面，交给 monaco / 输入框自己处理。
    if (ctrl && !shift && !alt) {
      if (key === '=' || key === '+') { event.preventDefault(); wc.setZoomLevel(wc.getZoomLevel() + 0.5); return }
      if (key === '-') { event.preventDefault(); wc.setZoomLevel(wc.getZoomLevel() - 0.5); return }
      if (key === '0') { event.preventDefault(); wc.setZoomLevel(0); return }
    }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // 应用只有深色模式：让**系统窗口标题栏**也跟着变深（2026-09-17 用户要求 —— 之前标题栏
    // 是白的，跟深色界面不搭）。nativeTheme 是 Electron 官方开关（Windows 走 DWM 深色标题栏），
    // 同时会把页面里的 prefers-color-scheme 变成 dark。
    try { nativeTheme.themeSource = 'dark' } catch (e) { /* 老版本 Electron 忽略 */ }
    // 每次启动留一条锚点：版本/家目录/端口 —— 排障先确认"出事的是哪个版本、数据在哪"
    noteLog('info', 'boot', '壳启动', {
      version: appVersion(), pid: process.pid, home: DSH_HOME,
      install: INSTALL_DIR, cdpPort: BROWSER_DEBUG_PORT, packaged: app.isPackaged === true,
    })
    // 更新器实例要在启动早期就建好：下面两步（应用待装更新 / 启动前自动更新）都要用它
    try {
      updater = new Updater({
        installDir: INSTALL_DIR, homeDir: DSH_HOME, exePath: process.execPath, onState: onUpdaterState,
      })
    } catch (e) {
      console.error('[anzio] updater init failed:', (e && e.message) || e)
      noteLog('error', 'updater', '更新器初始化失败', { error: (e && e.message) || String(e) })
    }
    // ── ① 上次下载好、待安装的更新：在窗口/后端之前先替换文件（此时没有旧实例占用），再自重启一次 ──
    try {
      if (updater) {
        const res = updater.applyPending()
        if (res && res.applied) {
          console.log('[anzio] update v' + res.version + ' applied, relaunching')
          noteLog('info', 'update', '待装更新已应用，准备自重启', { version: res.version })
          app.relaunch({ args: process.argv.slice(1) })
          app.exit(0)
          return
        }
        if (res && res.failures && res.failures.length) {
          console.error('[anzio] update apply failed:', res.failures.join(' | '))
          noteLog('error', 'update', '待装更新应用失败', { failures: res.failures })
        }
      }
    } catch (e) {
      console.error('[anzio] applyPending failed:', (e && e.message) || e)
      noteLog('error', 'update', '应用待装更新时异常', { error: (e && e.stack) || String(e) })
    }
    // 移除顶部菜单栏（快捷键由 installShortcuts 注册，见上）
    Menu.setApplicationMenu(null)
    // 立即显示窗口（启动画面），随后异步准备后端
    createWindow()
    installShortcuts(mainWindow)
    installHotkeyForwarding(mainWindow)
    // 内置浏览器内核：必须在 boot() 之前装，页面加载后马上会来要视图
    try { browserHost = installBrowserHost(mainWindow) } catch (e) { console.error('[anzio] browser host failed:', (e && e.message) || e); noteLog('error', 'browser-host', '内置浏览器宿主安装失败', { error: (e && e.message) || String(e) }) }
    // 内置浏览器第二期：Playwright 驱动层 + 壳桥。也必须在 boot() 之前起好 —— 后端子进程要用
    // 壳桥的地址与口令（经环境变量交下去），起了后端才起桥的话，第一个会话就指挥不动浏览器。
    try {
      browserDriver = createDriver({
        port: BROWSER_DEBUG_PORT,
        onLog: (msg, meta) => {
          console.log('[anzio][driver] ' + msg + (meta ? ' ' + JSON.stringify(meta) : ''))
          noteLog(/fail|error|disconnect/i.test(msg) ? 'warn' : 'info', 'browser-driver', msg, meta)
        },
        // 「Agent幻影」（第三期）：驱动层只管"指针该去哪"，时长由壳算（browser.js 的 pointerMs），
        // 指令再转给对应视图的页面去演 —— 幻影与真实动作是两条独立通道，幻影坏了不影响操作。
        phantom: {
          enabled: () => !!(browserHost && browserHost.phantom && browserHost.phantom().on),
          send: (id, cmd) => (browserHost && browserHost.sendToView ? browserHost.sendToView(id, cmd) : 0),
        },
        // 键盘记账（第三期）：驱动层记下"按了什么键"，壳转给天工页面里的键盘映射面板
        onAction: (record) => { if (browserHost && browserHost.sendAction) browserHost.sendAction(record) },
      })
      browserBridge = await startBridge({
        driver: browserDriver, host: browserHost, win: mainWindow,
        // 成功的 bridge-call 不打控制台（太吵），但**必须落盘**：这是 Agent 指挥浏览器的唯一咽喉，
        // 以前这里被过滤掉 ⇒ 生产包里"Agent 到底点了什么"零证据（2026-10-19 修）
        log: (msg, meta) => {
          if (msg !== 'bridge-call') console.log('[anzio][bridge] ' + msg + (meta ? ' ' + JSON.stringify(meta) : ''))
          noteLog(msg === 'bridge-call-failed' ? 'error' : 'info', 'browser-action', msg, meta)
        },
      })
      console.log('[anzio][bridge] listening ' + browserBridge.url)
      noteLog('info', 'browser-bridge', '壳桥已监听', { url: browserBridge.url })
    } catch (e) {
      console.error('[anzio] browser bridge failed:', (e && e.message) || e)
      noteLog('error', 'browser-bridge', '壳桥启动失败（Agent 将无法操作内置浏览器）', { error: (e && e.stack) || String(e) })
    }
    try { setupUpdater() } catch (e) { console.error('[anzio] updater setup failed:', e && e.message); noteLog('error', 'updater', '更新器初始化失败', { error: (e && e.message) || String(e) }) }
    // ── ② 启动前自动更新（2026-09-20 用户要求："先更新，再打开软件"）──
    // 跑在 boot() 之前：有新版就下载+重启装上，用户看到的是"启动 → 更新 → 新版本打开"。
    // 任何失败/超时/Esc 都只是照常启动（见 autoUpdatePhase 里的三条硬规矩）。
    await autoUpdatePhase()
    boot()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
        boot()
      }
    })
  })
}

// 退出时停掉自启的后端与内置浏览器驱动/壳桥
app.on('before-quit', () => {
  if (backend) backend.stop()
  try { if (browserDriver) browserDriver.disconnect() } catch { /* 忽略 */ }
  try { if (browserBridge) browserBridge.close() } catch { /* 忽略 */ }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
