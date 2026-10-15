// DSH IDE 资源管理器自动刷新 E2E（CDP 真浏览器 + 真实磁盘改动）
// 用法: node D:\99DSH\tools\e2e-fsrev.mjs
//   （自起测试后端，默认 3082；DSH_HOME=D:\99DSH\app-home；fixture 自建自清 —— 踩坑 21）
// 验的是：磁盘变了（Agent / 外部编辑器 / git 建改删文件）资源管理器**不用手点 ⟳**
//   就跟着变；展开的子目录也刷新；忽略表目录（node_modules）不触发刷新；
//   以及原有交互（展开 / 点文件开标签 / 手动刷新 / Ctrl+B）没被改坏。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.DSH_E2E_PORT || 3082)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = 'D:\\99DSH\\app-home'
const CLI = 'D:\\99DSH\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js'
const BLOG = 'D:\\99DSH\\_e2e_fsrev_backend_' + PORT + '.log'
const TRACE = join(HOME_DIR, 'logs', 'ide-trace.log')
const FIX = '_e2e_fsrev'
const CDP_PORT = 9700 + Math.floor(Math.random() * 400)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' :: ' + String(detail ?? '')}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
function killTree(pid) {
  try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
}

// ── 页内取数表达式 ────────────────────────────────────────────────
const NODE_NAMES = `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node-name'); var a=[];
  for (var i=0;i<ns.length;i++) a.push(ns[i].textContent); return a; })()`
const HAS_NODE = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node-name');
  for (var i=0;i<ns.length;i++){ if (ns[i].textContent===${JSON.stringify(name)}) return true } return false })()`
const CLICK_NODE = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node');
  for (var i=0;i<ns.length;i++){ var t=ns[i].querySelector('.dside-node-name');
    if (t && t.textContent===${JSON.stringify(name)}){ ns[i].click(); return true } } return false })()`
const TABS = `(function(){ var ts=document.querySelectorAll('.dside-tab-name'); var a=[];
  for (var i=0;i<ts.length;i++) a.push(ts[i].textContent); return a; })()`
const FS_REV = `fetch('/dsh-ide/fs-rev').then(function(r){ return r.json() }).then(function(j){ return j })`
const KEY_B = `window.dispatchEvent(new KeyboardEvent('keydown',{ key:'b', code:'KeyB', ctrlKey:true, bubbles:true, cancelable:true }))`
// ⑮ 起：标题栏那个 ⟳ 按钮在 v1.5.17 已按用户要求删掉（删按钮 ≠ 砍功能），
// 刷新工作空间现在的入口 = 命令面板的「刷新工作空间」（view.refresh）
const KEY_COMMANDS = `window.dispatchEvent(new KeyboardEvent('keydown',{ key:'P', code:'KeyP', ctrlKey:true, shiftKey:true, bubbles:true, cancelable:true }))`
const CLICK_REFRESH_CMD = `(function(){ var its=document.querySelectorAll('.dside-palette-item'); var a=[];
  for (var i=0;i<its.length;i++) a.push(String(its[i].textContent));
  for (var j=0;j<its.length;j++){ if (String(its[j].textContent).indexOf('刷新工作空间')>=0){ its[j].click(); return JSON.stringify(a) } }
  return 'not-found:' + JSON.stringify(a) })()`

let ROOT_SEEN = null
let backend = null
let browser = null
let backendExit = null

async function main() {
  // ── 1) 起测试后端（token 在 stdout 里，累积缓冲再匹配 —— 踩坑 30）──
  rmSync(BLOG, { force: true })
  const fd = openSync(BLOG, 'w')
  backend = spawn(process.execPath, [CLI, 'web', '--port', String(PORT), '--no-open'], {
    cwd: 'D:\\99DSH\\deepseek-harness-mine\\harness', env: cleanEnv(), stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  backend.on('exit', (code) => { backendExit = code })

  let token = ''
  const t0 = Date.now()
  while (Date.now() - t0 < 120000) {
    await sleep(500)
    if (backendExit !== null) throw new Error('backend exited early (code ' + backendExit + ') — 端口 ' + PORT + ' 可能被占用')
    let txt = ''
    try { txt = readFileSync(BLOG, 'utf8') } catch { /* not yet */ }
    const m = txt.match(/\?token=([A-Za-z0-9._-]+)/)
    if (m) { token = m[1]; break }
  }
  if (!token) throw new Error('no token in backend log: ' + BLOG)
  console.log('[info] backend up on ' + PORT)

  // ── 2) 起无头浏览器 → CDP ──────────────────────────────────────
  const userDir = join('D:\\99DSH', '.edge-fsrev-tmp-' + process.pid)
  try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch (e) { /* Windows 文件锁：临时 profile 删不掉不影响结论 */ }
  browser = spawn(findBrowser(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDir}`,
    APP + '/?token=' + token,
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      target = (list || []).find((t) => t.type === 'page')
    } catch { /* not up yet */ }
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
      pageErrors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 200))
    }
  }
  ws.onclose = () => { wsDead = true; for (const [, fn] of pending) fn({ error: { message: 'ws closed' } }); pending.clear() }
  ws.onerror = () => { wsDead = true; for (const [, fn] of pending) fn({ error: { message: 'ws error' } }); pending.clear() }

  function cdp(method, params, timeoutMs) {
    if (wsDead) return Promise.reject(new Error('CDP ws dead'))
    return new Promise((resolve, reject) => {
      const id = ++msgId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, timeoutMs || 15000)
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
    let last = null
    while (Date.now() - t < ms) {
      const v = await evalJs(expr)
      if (v && !v.__err) return v
      last = v
      await sleep(300)
    }
    return last === true ? true : null
  }

  await cdp('Runtime.enable')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })   // 踩坑 27：轮询要看 document.hidden

  const traceFrom = Date.now() - 1000
  async function traceHas(msg, waitMs) {
    const t = Date.now()
    while (Date.now() - t < waitMs) {
      let txt = ''
      try { txt = readFileSync(TRACE, 'utf8') } catch { /* ignore */ }
      const lines = txt.split('\n')
      for (let i = lines.length - 1; i >= 0 && i > lines.length - 400; i--) {
        if (!lines[i] || lines[i].indexOf(msg) < 0) continue
        try { const o = JSON.parse(lines[i]); if (Date.parse(o.ts) >= traceFrom) return true } catch { /* ignore */ }
      }
      await sleep(700)
    }
    return false
  }

  // ── 3) 探针 ────────────────────────────────────────────────────
  const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco && !!window.monaco.editor`, 90000)
  check('P1 页面挂载完成（IDE 布局 + monaco 就绪）', !!ready, await evalJs('document.readyState'))

  const hidden = await evalJs('document.hidden')
  check('P2 页面被认成可见（document.hidden 必须是 false，否则轮询被跳过 = 假 PASS）', hidden === false, hidden)

  const ROOT0 = await evalJs(`fetch('/dsh-ide/init').then(function(r){return r.json()}).then(function(j){return j.root||null})`)
  check('P3 工作空间根可解析', typeof ROOT0 === 'string' && ROOT0.length > 2, JSON.stringify(ROOT0))

  // ⑮ 起：把活动根指到**专用安静工作区**再测。这个家目录当前会话的 cwd 可能是整盘 `D:\`
  // —— 那样 fs.watch 每秒几十次变更、树不停重列，本套件会出假 FAIL（2026-09-21 实测 2 项）。
  // ⚠ 必须在页面就绪之后 POST：客户端加载时会按"当前会话 cwd"上报一次 active-root，早了会被它覆盖。
  const WS = process.env.DSH_E2E_WS || 'D:\\99DSH\\.smoke-wsfs'
  rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
  mkdirSync(WS, { recursive: true })
  writeFileSync(join(WS, 'root-marker.txt'), 'root\n')   // 用来确认"树真的切到新根了"
  await fetch(APP + '/dsh-ide/active-root', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: WS }),
  })
  const ROOT = WS
  ROOT_SEEN = WS

  const rev1 = await evalJs(FS_REV)
  check('P4 /fs-rev 可用且 watching=true（host 观察句柄已建立）',
    rev1 && typeof rev1.rev === 'number' && rev1.watching === true, JSON.stringify(rev1))

  const names0 = await waitFor(HAS_NODE('root-marker.txt'), 12000)
  check('P5 资源管理器已列出（新根的）内容', names0 === true && (await evalJs(NODE_NAMES)).indexOf(FIX) < 0,
    JSON.stringify(await evalJs(NODE_NAMES)))

  // 主修复：磁盘新建 → 树自动出现（不点任何东西）
  mkdirSync(join(ROOT, FIX), { recursive: true })
  writeFileSync(join(ROOT, FIX, 'a.txt'), 'hello fsrev\n')
  const tA = Date.now()
  const seenDir = await waitFor(HAS_NODE(FIX), 9000)
  const dtA = Date.now() - tA
  check(`P6 磁盘新建目录/文件 → 资源管理器 ${dtA}ms 内自动出现（无需手点 ⟳）`, seenDir === true, 'tree=' + JSON.stringify(await evalJs(NODE_NAMES)))

  await sleep(500)
  const rev2 = await evalJs(FS_REV)
  check('P7 变更计数递增', rev2 && rev2.rev > rev1.rev, `${rev1 && rev1.rev} → ${rev2 && rev2.rev}`)

  // 展开目录 → 子文件
  await evalJs(CLICK_NODE(FIX))
  const sawA = await waitFor(HAS_NODE('a.txt'), 6000)
  check('P8 展开目录显示子文件 a.txt（展开链路未改坏）', sawA === true)

  // 已展开目录内的新文件（FileNode 级刷新）
  writeFileSync(join(ROOT, FIX, 'b.txt'), 'world fsrev\n')
  const tB = Date.now()
  const sawB = await waitFor(HAS_NODE('b.txt'), 9000)
  check(`P9 已展开目录里新增文件 ${Date.now() - tB}ms 内出现（子节点跟着刷新）`, sawB === true,
    'tree=' + JSON.stringify(await evalJs(NODE_NAMES)))

  // 回归：点树里的文件 → 开标签
  await evalJs(CLICK_NODE('b.txt'))
  const tabs = await waitFor(`(function(){ var ts=document.querySelectorAll('.dside-tab-name'); var a=[];
    for (var i=0;i<ts.length;i++) a.push(ts[i].textContent); return a.indexOf('b.txt')>=0 ? a : null })()`, 8000)
  check('P10 点资源管理器里的文件仍能打开标签（回归）', Array.isArray(tabs) && tabs.indexOf('b.txt') >= 0, JSON.stringify(tabs))

  // 忽略表：node_modules 里的写入不算变化
  const revBefore = (await evalJs(FS_REV)).rev
  mkdirSync(join(ROOT, FIX, 'node_modules'), { recursive: true })
  writeFileSync(join(ROOT, FIX, 'node_modules', 'x.js'), 'x\n')
  await sleep(1800)
  const revAfter = (await evalJs(FS_REV)).rev
  check('P11 node_modules 里的写入不触发刷新（忽略表过滤生效）', revAfter === revBefore, `${revBefore} → ${revAfter}`)

  // 删除也要感知
  rmSync(join(ROOT, FIX), { recursive: true, force: true })
  const gone = await waitFor(`!(` + HAS_NODE(FIX) + `)`, 9000)
  check('P12 磁盘删除后资源管理器里也消失', gone === true, 'tree=' + JSON.stringify(await evalJs(NODE_NAMES)))

  // 回归：手动刷新仍可用（走命令面板的 view.refresh，标题栏那个按钮 v1.5.17 已删）
  await evalJs(KEY_COMMANDS)
  await sleep(800)
  const clicked = await evalJs(CLICK_REFRESH_CMD)
  await sleep(900)
  const namesAfter = await evalJs(NODE_NAMES)
  check('P13 手动刷新仍可用（命令面板「刷新工作空间」→ 树重列）',
    typeof clicked === 'string' && clicked.indexOf('not-found') < 0 && Array.isArray(namesAfter) && namesAfter.length > 0,
    String(clicked) + ' tree=' + JSON.stringify(namesAfter))

  // 回归：Ctrl+B 显隐文件树
  await evalJs(KEY_B)
  await sleep(400)
  const hiddenTree = await evalJs(`!document.querySelector('.dside-explorer')`)
  await evalJs(KEY_B)
  await sleep(400)
  const shownTree = await evalJs(`!!document.querySelector('.dside-explorer')`)
  check('P14 Ctrl+B 显隐文件树仍可用（回归）', hiddenTree === true && shownTree === true, `hide=${hiddenTree} show=${shownTree}`)

  // 埋点（800ms 去抖 + 落地，踩坑 29）
  const hasTrace = await traceHas('fs-change-refresh', 10000)
  check('P15 轨迹里有 fs-change-refresh 埋点（可自证"树刷新过"）', hasTrace === true, TRACE)

  check('P16 页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400))

  const pass = results.filter((r) => r.ok).length
  console.log(`\n[e2e-fsrev] ${pass}/${results.length} passed`)
  return pass === results.length
}

let ok = false
try {
  ok = await main()
} catch (e) {
  console.log('[e2e-fsrev] ABORT: ' + (e && e.stack ? e.stack : e))
} finally {
  try { if (browser) killTree(browser.pid) } catch { /* ignore */ }
  try { if (backend) killTree(backend.pid) } catch { /* ignore */ }
  await sleep(1500)
  try { rmSync(join('D:\\99DSH', '.edge-fsrev-tmp-' + process.pid), { recursive: true, force: true }) } catch { /* ignore */ }
  // 自清 fixture（无论成败；后端可能已被杀 → 用探针里记下的根兜底）
  const fixRoot = ROOT_SEEN || 'D:\\99DSH\\dshworkspace2'
  try { rmSync(join(fixRoot, FIX), { recursive: true, force: true }) } catch { /* ignore */ }
  if (process.env.DSH_E2E_WS || ROOT_SEEN === 'D:\\99DSH\\.smoke-wsfs') {
    try { rmSync(fixRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  console.log('[e2e-fsrev] cleanup done (fixture removed, backend/browser killed)')
}
process.exit(ok ? 0 : 1)
