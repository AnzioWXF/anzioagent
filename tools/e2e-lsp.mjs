import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// e2e-lsp.mjs — 「Agent 拿到代码导航（lsp 工具）」端到端验证（2026-09-22）
//
// 验的是三件事，缺一不算过：
//   ① 装配生效：profile 里的 lsp / lsp-stdio / tool-lsp 三行真的挂上了（没挂 = 工具不存在）；
//   ② 工具到得了 Agent 手上：真实一轮里出现 `lsp` 的 tool/call（不是我们替它调用）；
//   ③ 查询真的答对：工具返回里出现目标文件与行号（语言服务器进程真的起来了）。
// 判据取**会话日志**（tool/call 的 data.name、tool/result 的文本），不看界面文案。
//
// 用法: node tools\e2e-lsp.mjs   （自起隔离测试后端 + 无头 Edge）
//   ⚠ 测试 home 必须已 dev-testhome.ps1 -TestHome 生成过；会真调一次模型（一个很小的提示）。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, openSync, closeSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import path from 'node:path'

const PORT = Number(process.env.DSH_E2E_PORT || 3094)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = process.env.DSH_E2E_HOME || `${__TIANGONG_ROOT}\\.smoke-home-composer`
const WS = process.env.DSH_E2E_WS || `${__TIANGONG_ROOT}\\.smoke-ws-lsp`
const CLI = `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js`
const BLOG = `${__TIANGONG_ROOT}\\_e2elsp_backend_` + PORT + '.log'
const CDP_PORT = 9700 + Math.floor(Math.random() * 90)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const A = 'lsp-nav-alpha.ts'
const B = 'lsp-nav-beta.ts'
const A_SRC = 'export function addNumbers(a: number, b: number): number {\n  return a + b\n}\n'
const B_SRC = "import { addNumbers } from './lsp-nav-alpha'\n\nconst total = addNumbers(1, 2)\nconsole.log(total)\n"
// Python fixture：证明"没人写死过的语言"也能装好并答对（pyright 由安装器从 bin 推断入口）
const PA = 'nav_alpha.py'
const PB = 'nav_beta.py'
const PA_SRC = 'def add_numbers(a, b):\n    return a + b\n'
const PB_SRC = 'from nav_alpha import add_numbers\n\n\ndef main():\n    return add_numbers(1, 2)\n'
// ⚠ 必须有 tsconfig：没有它 tsserver 会把两个文件当**两个独立项目**，
//   跨文件的定义/引用都解析不出来（第一版就栽在这 —— 真实项目里这个文件本来就有）。
const TS_CONFIG = JSON.stringify({
  compilerOptions: { target: 'es2020', module: 'esnext', moduleResolution: 'bundler', strict: true },
  include: ['*.ts'],
}, null, 2) + '\n'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' :: ' + String(detail ?? '')}`)
}
function cleanEnv() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('DSH_')) env[k] = v
  env.DSH_HOME = HOME_DIR
  return env
}
function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]
  for (const c of cands) if (existsSync(c)) return c
  throw new Error('no edge/chrome found')
}

/** 会话日志是多帧 zstd：按 magic 切帧逐帧解（同 dsh-ide 的 searchSessionLogs 做法）。 */
function readSessionLog(file) {
  const buf = readFileSync(file)
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  const frames = []
  let start = 0
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      if (i > start) frames.push(buf.subarray(start, i))
      start = i
    }
  }
  frames.push(buf.subarray(start))
  let text = ''
  for (const f of frames) { try { text += zstdDecompressSync(f).toString('utf8') } catch { /* 非帧数据 */ } }
  return text
}

/** 最新被写过的会话日志（SND 之后产生的那一份）。 */
function newestSessionFile(sinceMs) {
  const root = path.join(HOME_DIR, 'sessions')
  let best = null
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.jsonl.zstd')) continue
      const st = statSync(p)
      if (st.mtimeMs < sinceMs) continue
      if (best === null || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs }
    }
  }
  walk(root)
  return best === null ? null : best.path
}

/** 从解开的 JSONL 里抽出 lsp 的调用与返回。 */
function extractLsp(logText) {
  const calls = []
  const resultsById = new Map()
  for (const line of logText.split('\n')) {
    if (line.trim() === '') continue
    let ev = null
    try { ev = JSON.parse(line) } catch { continue }
    const data = ev.data || ev
    if (ev.type === 'tool/call' && data && data.name === 'lsp') {
      let args = data.arguments
      try { args = JSON.parse(String(args)) } catch { /* 原样 */ }
      calls.push({ callId: data.callId, args, turn: data.turn })
    }
    if (ev.type === 'tool/result' && data && data.message) {
      const callId = data.message.source && data.message.source.callId
      // 真实形状是嵌套的：data.message.content[] = [{ type:'tool-result', content:[{type:'text',text}] }]
      // —— 第一版只读了一层，抓到空字符串（假 FAIL 的由来）。
      const texts = []
      const walk = (node, depth) => {
        if (node === null || node === undefined || depth > 6) return
        if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return }
        if (typeof node === 'object') {
          if (typeof node.text === 'string') { texts.push(node.text); return }
          for (const key of ['content', 'message', 'blocks']) if (node[key] !== undefined) walk(node[key], depth + 1)
          return
        }
        if (typeof node === 'string') texts.push(node)
      }
      walk(data.message.content, 0)
      if (callId) resultsById.set(callId, texts.join(''))
    }
  }
  return { calls, resultsById }
}

// 平台原生 composer 是 contenteditable（不是 textarea）—— 配方照 probe-question-ui.mjs：
// 点进去聚焦 → Input.insertText → Enter。
const FOCUS_EDITOR = `(function(){
  var ed = document.querySelector('.dside-agent-platform [contenteditable="true"]');
  if (!ed) return 'no-editor';
  ed.focus();
  var sel = window.getSelection(); var r = document.createRange();
  r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  return 'focused';
})()`
const EDITOR_TEXT = `(function(){ var e=document.querySelector('.dside-agent-platform [contenteditable="true"]'); return e ? (e.innerText||'').slice(0,80) : null })()`

const NEW_CHAT = `(function(){ var bs=document.querySelectorAll('.dside-side-actions button');
  for (var i=0;i<bs.length;i++){ if ((bs[i].textContent||'').indexOf('新对话')>=0) { bs[i].click(); return true } } return false })()`

async function main() {
  // ⚠ 安全闸：这个探针会清掉家目录里的会话与工作空间索引（为了拿到确定的会话 cwd），
  //   只允许在 <仓库根>\ 下的测试家目录上跑 —— 绝不许碰到应用真实家目录。
  if (!HOME_DIR.toLowerCase().startsWith(__TIANGONG_ROOT.toLowerCase())) throw new Error('拒绝在非测试家目录上运行: ' + HOME_DIR)
  rmSync(path.join(HOME_DIR, 'sessions'), { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
  rmSync(path.join(HOME_DIR, 'storages', 'workspace.json'), { force: true })
  rmSync(BLOG, { force: true })
  // fixture 目录先建好：后端**以它为工作目录**启动 —— 没有工作空间/会话时，框架新会话的 cwd
  // 兜底就是进程 cwd，于是会话必然落在专用目录里（lsp 的 workspaceRoot = 会话 cwd）。
  rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
  mkdirSync(WS, { recursive: true })
  // 测试 home 的装配单改成指向**测试 home 自己的** tools 目录（应用那份指向应用家目录），
  // 这样才能验"缺师傅 → 现场装 → 立刻可用"这条链，而不是吃应用家目录已有的那份。
  const patchPath = path.join(HOME_DIR, 'profiles', 'web', 'cordis.patch.yml')
  const appPatch = readFileSync(`${__TIANGONG_ROOT}\\app-home\\profiles\\web\\cordis.patch.yml`, 'utf8')
  writeFileSync(patchPath, appPatch.split(`${__TIANGONG_ROOT}\\app-home\\tools\\lsp`).join(path.join(HOME_DIR, 'tools', 'lsp')))
  rmSync(path.join(HOME_DIR, 'tools'), { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
  const fd = openSync(BLOG, 'w')
  const backend = spawn(process.execPath, [CLI, 'web', '--port', String(PORT), '--no-open'], {
    cwd: WS, env: cleanEnv(), stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  let backendExit = null
  backend.on('exit', (c) => { backendExit = c })
  let browser = null
  const userDir = `${__TIANGONG_ROOT}\\.edge-e2elsp-tmp-` + process.pid
  try {
    let token = ''
    const t0 = Date.now()
    while (Date.now() - t0 < 120000) {
      await sleep(500)
      if (backendExit !== null) throw new Error('backend exited early (' + backendExit + ') — 端口 ' + PORT + ' 被占用？')
      let txt = ''
      try { txt = readFileSync(BLOG, 'utf8') } catch { /* not yet */ }
      const m = txt.match(/\?token=([A-Za-z0-9._-]+)/)
      if (m) { token = m[1]; break }
    }
    if (!token) throw new Error('no token in backend log')

    // ── 数据面：装语言（**没有任何语言清单**，装什么完全由调用方给）────────────
    const toolsRoot = path.join(HOME_DIR, 'tools', 'lsp')
    const patchFile = path.join(HOME_DIR, 'profiles', 'web', 'cordis.patch.yml')
    let status = null
    try { status = await (await fetch(APP + '/dsh-ide/tools-status')).json() } catch { /* 断言里报 */ }
    check('P1a 全新环境：状态接口如实报"还没装任何组件"',
      !!(status && status.ok && Array.isArray(status.entries) && status.entries.length === 0), JSON.stringify(status))
    check('P1b 安装位置就是装配单里写的那个目录（都在数据目录下）',
      !!(status && status.root && status.root.toLowerCase() === toolsRoot.toLowerCase()), 'root=' + (status && status.root))

    const postJson = async (action, body) => {
      const r = await fetch(APP + '/dsh-ide' + action, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      return await r.json()
    }
    // ① TS/JS：显式给入口（等价于"调用方知道装什么"），并把入口指到**测试 home 自己的** tools 目录
    const tsCli = path.join(toolsRoot, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs')
    const tsInstall = await postJson('/nav-install', {
      language: 'typescript',
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
      packages: [{ name: 'typescript-language-server', version: '5.3.0' }, { name: 'typescript', version: '6.0.3' }],
      args: [tsCli, '--stdio'],
    })
    check('P1c 装 TS/JS（两个包都下齐、来源与许可证有记录）',
      !!(tsInstall && tsInstall.ok && tsInstall.packages && tsInstall.packages.length === 2
        && tsInstall.packages.every((p) => p.source && p.license && p.packedBytes > 0)),
      JSON.stringify(tsInstall))
    // ② Python：**不给入口** —— 由安装器从包自带 bin 推断（证明"不写死清单也能装"）
    const pyInstall = await postJson('/nav-install', { language: 'python', extensions: ['.py'], packages: [{ name: 'pyright' }] })
    check('P1d 装 Python（pyright，不给入口，靠包自带 bin 推断）',
      !!(pyInstall && pyInstall.ok && pyInstall.args && pyInstall.args.length >= 2
        && String(pyInstall.args[0]).toLowerCase().indexOf('langserver') >= 0),
      JSON.stringify(pyInstall))
    const patchText = readFileSync(patchFile, 'utf8')
    check('P1e 装配单里真的多了一行 python（锚点自动追加）',
      /^\s{10}python:$/m.test(patchText) && patchText.indexOf('python:') >= 0,
      '含 python 行=' + /^\s{10}python:$/m.test(patchText))
    const manifest = path.join(toolsRoot, 'manifest.json')
    check('P1f 落下文件 + 留安装记录（manifest.json 带哈希与来源）',
      existsSync(path.join(toolsRoot, 'node_modules', 'pyright')) && existsSync(manifest) && readFileSync(manifest, 'utf8').indexOf('sha512-') >= 0)
    let after = null
    try { after = await (await fetch(APP + '/dsh-ide/tools-status')).json() } catch { /* 断言里报 */ }
    check('P1g 状态接口列出已装的三个组件',
      !!(after && after.ok && after.entries && after.entries.length === 3), JSON.stringify(after && after.entries && after.entries.map((e) => e.name)))
    const backendLog0 = (() => { try { return readFileSync(BLOG, 'utf8') } catch { return '' } })()
    const traceLog = (() => { try { return readFileSync(path.join(HOME_DIR, 'logs', 'ide-trace.log'), 'utf8') } catch { return '' } })()
    check('P1h Agent 侧工具已注册（插件埋点 code-nav-tool-ready）',
      traceLog.indexOf('code-nav-tool-ready') >= 0, 'trace 日志里没有这行 —— 动态 import defineTool 失败？')

    try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch { /* Windows 文件锁 */ }
    browser = spawn(findBrowser(), [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDir,
      APP + '/?token=' + token,
    ], { stdio: 'ignore' })

    let target = null
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(500)
      try {
        const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
        target = (list || []).find((t) => t.type === 'page')
      } catch { /* not up */ }
    }
    if (!target) throw new Error('CDP target not found')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect error')) })
    let msgId = 0
    const pending = new Map()
    let wsDead = false
    const pageErrors = []
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails
        pageErrors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 160))
      }
    }
    ws.onclose = () => { wsDead = true; for (const [, f] of pending) f({ error: { message: 'ws closed' } }); pending.clear() }
    function cdp(method, params, timeoutMs) {
      if (wsDead) return Promise.reject(new Error('CDP ws dead'))
      return new Promise((resolve, reject) => {
        const id = ++msgId
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, timeoutMs || 20000)
        pending.set(id, (m) => { clearTimeout(timer); resolve(m.result || { error: m.error }) })
        try { ws.send(JSON.stringify({ id, method, params: params || {} })) } catch (e) { clearTimeout(timer); reject(e) }
      })
    }
    async function evalJs(expr) {
      const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval threw' }
      return r.result && r.result.value
    }
    async function waitFor(expr, ms) {
      const t = Date.now()
      while (Date.now() - t < ms) { const v = await evalJs(expr); if (v && !v.__err) return v; await sleep(250) }
      return null
    }

    await cdp('Runtime.enable')
    await cdp('Page.enable')
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    const ready = await waitFor(`!!document.querySelector('.dside-root') && !!window.monaco`, 90000)
    check('P1 页面挂载完成（天工 root + monaco）', !!ready)
    await cdp('Page.reload', { ignoreCache: false })
    await sleep(2500)
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    await waitFor(`!!document.querySelector('.dside-root') && !!window.monaco`, 90000)

    // 设置面板里那一格（用户点"安装…"的地方）：能看到、如实显示状态、有按钮
    const openedSettings = await evalJs(`(function(){ var bs=document.querySelectorAll('.dside-actbtn');
      for (var i=0;i<bs.length;i++){ if ((bs[i].getAttribute('title')||'').indexOf('设置')===0) { bs[i].click(); return true } } return false })()`)
    await sleep(700)
    const panel = await evalJs(`(function(){ var e=document.querySelector('.dside-explorer'); if(!e) return null;
      var t=(e.textContent||'');
      var btn = Array.prototype.slice.call(e.querySelectorAll('button')).map(function(b){ return (b.textContent||'').trim() });
      return { hasTitle: t.indexOf('代码导航')>=0, hasRoot: t.indexOf('安装位置')>=0,
        listsPyright: t.indexOf('pyright')>=0, listsTs: t.indexOf('typescript-language-server')>=0,
        buttons: btn, hasInstallButton: btn.some(function(b){ return b.indexOf('安装')>=0 }) }; })()`)
    check('P1i 设置面板：列出已装组件 + 写明装到哪，且**没有**写死的"安装"按钮（语言清单已删除）',
      !!(openedSettings && panel && panel.hasTitle && panel.hasRoot && panel.listsPyright && panel.listsTs
        && !panel.hasInstallButton),
      JSON.stringify(panel))

    // 把工作区指到专用目录，并开一个"新对话"（会话 cwd = 这个目录，lsp 的 workspaceRoot 就是它）
    let root = null
    for (let i = 0; i < 8; i++) {
      await fetch(APP + '/dsh-ide/active-root', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: WS }),
      })
      await evalJs(NEW_CHAT)
      await sleep(1800)
      try {
        const j = await (await fetch(APP + '/dsh-ide/init')).json()
        root = j && j.root
      } catch { root = null }
      if (root && root.toLowerCase().startsWith((__TIANGONG_ROOT + '\\').toLowerCase())) break
    }
    check('P2 会话工作区 = 专用 fixture 目录（lsp 只查工作区内文件）',
      !!(root && root.toLowerCase().startsWith((__TIANGONG_ROOT + '\\').toLowerCase())), 'root=' + root)
    if (!root || !root.toLowerCase().startsWith((__TIANGONG_ROOT + '\\').toLowerCase())) throw new Error('workspace root not usable: ' + root)
    writeFileSync(path.join(root, A), A_SRC)
    writeFileSync(path.join(root, B), B_SRC)
    writeFileSync(path.join(root, 'tsconfig.json'), TS_CONFIG)
    writeFileSync(path.join(root, PA), PA_SRC)
    writeFileSync(path.join(root, PB), PB_SRC)
    const composerReady = await waitFor(`!!document.querySelector('.dside-agent-platform [contenteditable="true"]')`, 60000)
    check('P3 Agent 输入框可用（平台 composer 已就绪）', !!composerReady)

    // 真调模型一轮：TS 问最多三次、Python 问两次（冷启动第一次可能只给本文件的位置，所以重复问）
    const prompt = '请用 lsp 工具做这些调用，并把每次返回的原文按顺序贴出来（不要用别的工具、不要读文件）：'
      + '① operation=goToDefinition, file_path=' + B + ', line=3, character=15 —— 如果返回的是同一个文件里的位置，就**原样再问一次**（最多问三次），直到返回另一个文件；'
      + '② operation=goToDefinition, file_path=' + PB + ', line=5, character=18 —— 同样，不够就原样再问一次（最多两次）。'
    const sentAt = Date.now()
    const focused = await evalJs(FOCUS_EDITOR)
    await cdp('Input.insertText', { text: prompt })
    await sleep(700)
    const typed = await evalJs(EDITOR_TEXT)
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    }
    check('P4 提示已真正输入并发送（Enter）',
      focused === 'focused' && typeof typed === 'string' && typed.indexOf('lsp') >= 0, JSON.stringify(typed))

    // 等会话日志里出现 lsp 的调用与返回（问几次由模型自己定；数量稳定 20s 即认为这轮结束）
    let calls = []
    const resultByCall = []
    let sessionFile = null
    let lastCount = -1
    let lastChange = Date.now()
    const t1 = Date.now()
    while (Date.now() - t1 < 300000) {
      await sleep(3000)
      const file = newestSessionFile(sentAt - 5000)
      if (file === null) continue
      sessionFile = file
      const extracted = extractLsp(readSessionLog(file))
      if (extracted.calls.length !== lastCount) { lastCount = extracted.calls.length; lastChange = Date.now() }
      if (extracted.calls.length > 0 && extracted.calls.every((c) => extracted.resultsById.has(c.callId))) {
        calls = extracted.calls
        resultByCall.length = 0
        for (const c of calls) resultByCall.push({ args: c.args, text: extracted.resultsById.get(c.callId) || '' })
        if (Date.now() - lastChange > 20000) break
      }
    }
    // 会话 cwd 必须是专用目录：lsp 的 workspaceRoot 就是会话 cwd
    check('P5 本轮的会话工作区就是专用目录（会话目录名里带 smoke-ws-lsp）',
      !!(sessionFile && sessionFile.indexOf('smoke-ws-lsp') >= 0), 'session=' + sessionFile)
    check('P6 Agent 真的调用了 lsp 工具（会话日志里有 tool/call name=lsp）', calls.length >= 1,
      '拿到 ' + calls.length + ' 次 —— 装配没生效或模型没走这条路')
    const defs = resultByCall.filter((r) => r.args && r.args.operation === 'goToDefinition')
    const tsDefs = defs.filter((r) => String(r.args.file_path || '').indexOf('.ts') >= 0)
    const pyDefs = defs.filter((r) => String(r.args.file_path || '').indexOf('.py') >= 0)
    check('P7 两种语言的查询参数都对（TS 与 Python 各至少一次；重问几次由它自己判断）',
      tsDefs.length >= 1 && pyDefs.length >= 1,
      JSON.stringify(resultByCall.map((r) => r.args)))
    const locShape = /\.(ts|py):\d+:\d+/
    const lastTs = tsDefs.length > 0 ? tsDefs[tsDefs.length - 1] : null
    check('P8 TS 转到定义**跨文件**回到定义处（返回里出现定义文件）',
      !!(lastTs && locShape.test(lastTs.text) && lastTs.text.indexOf(A) >= 0),
      '返回=' + JSON.stringify(lastTs ? lastTs.text.slice(0, 200) : ''))
    // 最强的一条：**没人写死过的语言**（Python）装完后也能跨文件答对
    const lastPy = pyDefs.length > 0 ? pyDefs[pyDefs.length - 1] : null
    check('P9 Python 转到定义**跨文件**命中（证明"不写死语言清单"这条路是通的）',
      !!(lastPy && locShape.test(lastPy.text) && lastPy.text.indexOf(PA) >= 0),
      '返回=' + JSON.stringify(lastPy ? lastPy.text.slice(0, 300) : ''))
    const allText = resultByCall.map((r) => r.text).join('\n')
    const fatal = /LSP_UNAVAILABLE|LSP_UNSUPPORTED_OPERATION|LSP_MALFORMED_RESPONSE|no language server|spawn .*ENOENT|could not be read/i.test(allText)
    check('P10 返回里没有"不可用/不支持/读不到源文件"这类错误', !fatal, allText.slice(0, 300))
    for (const r of resultByCall) {
      console.log('[NOTE] ' + JSON.stringify(r.args) + ' → ' + r.text.slice(0, 300).replace(/\s+/g, ' '))
    }
    const backendLog = (() => { try { return readFileSync(BLOG, 'utf8') } catch { return '' } })()
    const lspLines = backendLog.split('\n').filter((l) => /lsp/i.test(l)).slice(-6).join(' | ')
    if (lspLines !== '') console.log('[NOTE] 后端日志里的 lsp 行：' + lspLines.slice(0, 400))
    check('P11 页面零未捕获异常', pageErrors.length === 0, pageErrors.join(' | '))

    // ── 第二轮：让 Agent 自己撞上"这门语言没导航"，按指令先问用户 ──────────────
    const YAML = 'nav_x.yaml'
    writeFileSync(path.join(root, YAML), 'name: hello\nversion: 1\n')
    const manifestBefore = readFileSync(manifest, 'utf8')
    const patchBefore = readFileSync(patchFile, 'utf8')
    const round2At = Date.now()
    await evalJs(FOCUS_EDITOR)
    await cdp('Input.insertText', {
      text: '请用 lsp 工具对 ' + YAML + ' 第 1 行第 1 列做一次 hover（operation=hover, file_path=' + YAML + ', line=1, character=1）。'
        + '如果这门语言还没有导航，就按你的常驻指令处理（该问的问我）。',
    })
    await sleep(700)
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    }
    // 等提问卡片接管：用平台提问卡自己的控件文案「跳过本题」当判据（别的文本会误中）
    let card = null
    for (let i = 0; i < 60 && card === null; i++) {
      await sleep(3000)
      const snap = await evalJs(`(function(){
        var host=document.querySelector('.dside-agent-platform'); if(!host) return null;
        var t=(host.innerText||'').replace(/\\s+/g,' ');
        var btns=[].slice.call(host.querySelectorAll('button')).map(function(b){ return (b.innerText||b.getAttribute('aria-label')||'').trim() }).filter(Boolean);
        return { text: t.slice(-900), buttons: btns.slice(-12), isCard: /跳过本题/.test(t) }; })()`)
      if (snap && snap.isCard) card = snap
    }
    const cardText = card ? card.text : ''
    check('P12 Agent 自己发现这门语言没导航，并弹卡问用户（卡片里提到装/来源）',
      !!(card && /(装|安装|install|npm|语言服务器)/i.test(cardText)), JSON.stringify(card))
    // 卡片要点清"装什么/从哪来"：至少出现一个包名或 npm 源字样
    check('P13 卡片写清了装什么 / 从哪来', !!(card && /(npm|registry|包|package|server|server\b)/i.test(cardText)),
      '卡片原文=' + cardText.slice(0, 300))
    // 点"同意"那一项，再点"继续/提交"
    // 提问卡的选项是 role=radio/checkbox + aria-label（见 ui-user-questions/QuestionComposer.tsx）
    const clicked = await evalJs(`(function(){
      var dump=[]; var nodes=document.querySelectorAll('[role="radio"],[role="checkbox"]');
      for (var i=0;i<nodes.length;i++){
        var t=(nodes[i].innerText||'').replace(/\\s+/g,' ').trim();
        var a=nodes[i].getAttribute('aria-label')||'';
        dump.push((a||t).slice(0,40));
        if (/不装|先不|暂时|以后|拒绝|取消|跳过/.test(a+t)) continue;
        if (/(装|安装|同意|继续|是的|要)/.test(a+t)) { nodes[i].click(); return 'clicked-option:' + (a||t).slice(0,30) + ' | 选项=' + dump.join(' / '); }
      }
      return 'no-yes-option | 选项=' + dump.join(' / ');
    })()`)
    await sleep(900)
    // 提交按钮的文案是「下一题」/「跳过本题」（见 ui-user-questions/locales.ts 的 action.next / action.skip）
    const submitted = await evalJs(`(function(){
      var bs=document.querySelectorAll('button');
      for (var i=0;i<bs.length;i++){
        var t=((bs[i].innerText||'')+' '+(bs[i].getAttribute('aria-label')||'')).replace(/\\s+/g,' ').trim();
        if (bs[i].disabled === true) continue;
        if (/跳过本题|Skip this question/.test(t)) continue;
        if (/^(下一题|Next|提交|提交答案)$/.test(t) || /下一题|提交答案/.test(t)) { bs[i].click(); return 'submitted:' + t.slice(0,20) }
      }
      return 'no-submit-button';
    })()`)
    console.log('[NOTE] 提问卡交互：' + clicked + ' · ' + submitted)
    // 等 Agent 调 code_nav_install（会话日志）
    let installCalls = []
    let yamlInstalled = false
    let yamlRow = false
    const t2 = Date.now()
    while (Date.now() - t2 < 300000) {
      await sleep(4000)
      const f2 = newestSessionFile(round2At - 5000)
      if (f2 !== null) {
        const text = readSessionLog(f2)
        installCalls = []
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue
          let ev = null
          try { ev = JSON.parse(line) } catch { continue }
          const d = ev.data || ev
          if (ev.type === 'tool/call' && d && d.name === 'code_nav_install') installCalls.push(d.arguments)
        }
      }
      try { yamlInstalled = existsSync(path.join(toolsRoot, 'node_modules', 'yaml-language-server')) } catch { yamlInstalled = false }
      try { yamlRow = /^\s{10}yaml:/m.test(readFileSync(patchFile, 'utf8')) } catch { yamlRow = false }
      if (installCalls.length > 0 || yamlInstalled || yamlRow) break
    }
    check('P14 用户点头后 Agent 真的调用了 code_nav_install（会话日志里 tool/call name=code_nav_install）',
      installCalls.length > 0, '点了=' + clicked + ' 等 300s 没等到安装工具调用' + ' 卡片=' + cardText.slice(0, 200))
    check('P15 装完装配单里多了一行 yaml（端到端：发现→问→装→追加 provider）', yamlRow,
      'yaml-language-server 在磁盘=' + yamlInstalled + ' 调用参数=' + JSON.stringify(installCalls[0] || null).slice(0, 300))
    const manifestAfter = readFileSync(manifest, 'utf8')
    check('P16 安装记录里多了这个包（来源/哈希/许可都在）',
      manifestAfter.length > manifestBefore.length && manifestAfter.indexOf('yaml-language-server') >= 0,
      'manifest 变化=' + (manifestAfter.length > manifestBefore.length))
    console.log('[NOTE] 第二轮卡片原文：' + cardText.slice(0, 400))
    console.log('[NOTE] 第二轮点击：' + clicked + ' · code_nav_install 调用：' + JSON.stringify(installCalls[0] || null).slice(0, 300))
    console.log('[NOTE] 装配单是否变化=' + (readFileSync(patchFile, 'utf8') !== patchBefore))

    const pass = results.filter((r) => r.ok).length
    console.log(`\n== e2e-lsp: ${pass}/${results.length} ==`)
    if (pass !== results.length) process.exitCode = 1
  } finally {
    try { if (browser) browser.kill() } catch { /* ignore */ }
    try { spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    setTimeout(() => {
      try { rmSync(userDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch { /* Windows 文件锁 */ }
      process.exit(process.exitCode || 0)
    }, 1200)
  }
}
main().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(1) })
