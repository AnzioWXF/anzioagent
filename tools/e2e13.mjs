import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// ⑬ 集成终端 E2E（真 PTY + 真浏览器 + CDP 真实键盘输入）
// 用法: node tools\e2e13.mjs
//   （自起测试后端，默认 3082；DSH_HOME=<仓库根>\app-home）
// 验的是：Ctrl+` 开面板 → xterm 渲染 → host 起真 PTY → 键盘输入真的进 shell →
//   输出回显（含 **ANSI 原始转义序列**，这是平台件做不到的）→ resize → 关闭时回收会话。
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.DSH_E2E_PORT || 3082)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = `${__TIANGONG_ROOT}\\app-home`
const CLI = `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js`
const BLOG = `${__TIANGONG_ROOT}\\_e2e13_backend_` + PORT + '.log'
const CDP_PORT = 9900 + Math.floor(Math.random() * 90)
const MARK = 'TERM_E2E_MARK_9137'

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
function killTree(pid) { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ } }

const OPEN_TERM = `(function(){ window.dispatchEvent(new KeyboardEvent('keydown',
  {key:'\`',code:'Backquote',ctrlKey:true,bubbles:true,cancelable:true})); return true })()`
const TERM_PRESENT = `!!document.querySelector('.dside-term')`
const XTERM_ROWS = `(function(){ var r=document.querySelector('.dside-term .xterm-rows'); return r? String(r.textContent) : null })()`
const CLICK_TERM = `(function(){ var b=document.querySelector('.dside-term-body'); if(!b) return false; b.click(); return true })()`
const CLICK_CLOSE = `(function(){ var hs=document.querySelectorAll('.dside-term-head button');
  for (var i=0;i<hs.length;i++){ if (String(hs[i].textContent).indexOf('✕')>=0){ hs[i].click(); return true } } return false })()`

async function main() {
  rmSync(BLOG, { force: true })
  const fd = openSync(BLOG, 'w')
  const backend = spawn(process.execPath, [CLI, 'web', '--port', String(PORT), '--no-open'], {
    cwd: `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness`, env: cleanEnv(), stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  let backendExit = null
  backend.on('exit', (c) => { backendExit = c })

  let token = ''
  const t0 = Date.now()
  while (Date.now() - t0 < 120000) {
    await sleep(500)
    if (backendExit !== null) throw new Error('backend exited early (' + backendExit + ') — 端口 ' + PORT + ' 可能被占用')
    let txt = ''
    try { txt = readFileSync(BLOG, 'utf8') } catch { /* not yet */ }
    const m = txt.match(/\?token=([A-Za-z0-9._-]+)/)
    if (m) { token = m[1]; break }
  }
  if (!token) throw new Error('no token in backend log')

  const userDir = join(`${__TIANGONG_ROOT}`, '.edge-e2e13-tmp-' + process.pid)
  try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch (e) { /* Windows 文件锁：临时 profile 删不掉不影响结论 */ }
  const browser = spawn(findBrowser(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // ⑯ 起：必须给一个真实窗口尺寸 —— 默认 800×600 时左栏 272 + 右栏 704 会把中间列挤成 0 宽，
    // 终端只有 ~20 列（用户那边 1200 宽的窗口也是这个现象），尺寸断言就失去意义
    '--window-size=1600,1000',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDir}`,
    APP + '/?token=' + token,
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
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
      pageErrors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 200))
    }
  }
  ws.onclose = () => { wsDead = true; for (const [, f] of pending) f({ error: { message: 'ws closed' } }); pending.clear() }
  ws.onerror = () => { wsDead = true; for (const [, f] of pending) f({ error: { message: 'ws error' } }); pending.clear() }

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
    while (Date.now() - t < ms) {
      const v = await evalJs(expr)
      if (v && !v.__err) return v
      await sleep(250)
    }
    return null
  }
  async function termList() {
    const r = await (await fetch(APP + '/dsh-ide/term-list')).json()
    return r
  }

  await cdp('Runtime.enable')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  // ⑯ 起：headless 的 --window-size 不管用，视口固定 800×600 → 左栏 272 + 右栏 704 会把中间列
  // 挤成 0 宽（终端只剩 ~20 列）。这里显式设一个真实视口，几何类断言才有意义。
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 90000)
  check('P1 页面挂载完成', !!ready, await evalJs('document.readyState'))

  const list0 = await termList()
  check('P2 host 侧 node-pty 可用（/term-list pty=true）', list0 && list0.pty === true, JSON.stringify(list0))

  await evalJs(OPEN_TERM)
  const panel = await waitFor(TERM_PRESENT, 15000)
  check('P3 Ctrl+` 打开终端面板', panel === true, await evalJs(`document.body.className`))

  const xtermReady = await waitFor(`!!document.querySelector('.dside-term .xterm') && !!document.querySelector('.dside-term .xterm-rows')`, 25000)
  check('P4 xterm.js 已加载并渲染（.xterm + .xterm-rows）', xtermReady === true, await evalJs(XTERM_ROWS))

  const created = await waitFor(`(async function(){ var r = await (await fetch('/dsh-ide/term-list')).json(); return (r && r.terminals && r.terminals.length) ? r.terminals[0].id : null })()`, 20000)
  check('P5 host 起了真 PTY 会话', typeof created === 'string' && created.indexOf('term-') === 0, String(created))

  // ── 真实键盘输入（CDP 发原生键盘事件，不 stub 产品逻辑）──────────
  await evalJs(CLICK_TERM)
  await sleep(400)
  const line = 'echo ' + MARK
  for (const ch of line) {
    await cdp('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch })
  }
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })

  const echoed = await waitFor(`(async function(){
    var r = await (await fetch('/dsh-ide/term-read?id=' + encodeURIComponent(${JSON.stringify(created)}) + '&since=0')).json();
    return (r && r.data && r.data.indexOf(${JSON.stringify(MARK)}) >= 0) ? r.data.length : null })()`, 25000)
  check('P6 键盘输入真的进了 shell 并回显（host 侧输出含标记）', echoed !== null, String(echoed))

  const onScreen = await waitFor(`(function(){ var t=${XTERM_ROWS}; return (t && t.indexOf(${JSON.stringify(MARK)})>=0) ? t.length : null })()`, 15000)
  check('P7 输出也渲染到了 xterm 屏上（DOM 渲染器有文本）', onScreen !== null, String(onScreen))

  // ── ANSI 原始转义序列透传（平台件会消毒掉，这是自建 PTY 的意义）──
  const ansiCmd = 'echo "$([char]27)[31mANSI_OK$([char]27)[0m"'
  for (const ch of ansiCmd) {
    await cdp('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch })
  }
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  // 断言"原始字节透传"本身：PTY 流出的是**含 ANSI 控制序列**的原始数据
  // （PSReadLine 的语法高亮 \u001b[36m/\u001b[93m、光标定位 \u001b[8;18H、光标显隐 \u001b[?25h）
  // —— 平台的 terminal seam 会经行消毒器投影，这些全会被剥掉，所以这是我自建 PTY 的核心价值证据。
  const ansi = await waitFor(`(async function(){
    var r = await (await fetch('/dsh-ide/term-read?id=' + encodeURIComponent(${JSON.stringify(created)}) + '&since=0')).json();
    var d = (r && r.data) || '';
    if (!d) return null;
    var m = d.match(/\\u001b\\[[0-9;?]*[A-Za-z]/g) || [];
    if (m.length >= 3 && d.indexOf('ANSI_OK') >= 0) return m.length + ' seqs';
    return null })()`, 25000)
  const ansiTail = await evalJs(`(async function(){
    var r = await (await fetch('/dsh-ide/term-read?id=' + encodeURIComponent(${JSON.stringify(created)}) + '&since=0')).json();
    var d = (r && r.data) || '';
    var m = d.match(/\\u001b\\[[0-9;?]*[A-Za-z]/g) || [];
    return 'escSeqs=' + m.length + ' sample=' + JSON.stringify(d.slice(-120)) })()`)
  check('P8 PTY 流出原始 ANSI 控制序列（行消毒器会剥掉；≥3 种序列 + 命令回显在位）',
    typeof ansi === 'string', String(ansiTail))

  // ── resize ────────────────────────────────────────────────────
  const rs = await (await fetch(APP + '/dsh-ide/term-resize', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: created, cols: 132, rows: 40 }),
  })).json()
  const list1 = await termList()
  const t1 = (list1.terminals || [])[0] || {}
  check('P9 resize 生效（132x40 被会话接受）', rs && rs.ok === true && t1.cols === 132 && t1.rows === 40, JSON.stringify({ rs, t1 }))

  // ── 关闭 → 会话回收 ───────────────────────────────────────────
  await evalJs(CLICK_CLOSE)
  await sleep(1500)
  const list2 = await termList()
  check('P10 关闭面板后 host 侧会话被回收（/term-list 为空）',
    (list2.terminals || []).length === 0, JSON.stringify(list2))
  check('P11 面板已从界面移除', (await evalJs(TERM_PRESENT)) === false, String(await evalJs(TERM_PRESENT)))

  // ── ⑯ 用户报障复现（2026-09-21）：① 焦点在聊天输入框里时，**真键盘** Ctrl+` 还能不能呼出
  //    ② 状态栏那个可见的「⌨ 终端」开关能不能呼出（原来只有快捷键/操作组，用户找不到）──
  const focusInfo = await evalJs(`(function(){
    var ed=document.querySelector('.dside-agent-platform [contenteditable="true"]');
    if(!ed) return 'no-composer';
    ed.focus();
    return (document.activeElement===ed ? 'focused' : 'not-focused') })()`)
  async function ctrlBackquote() {
    const base = { modifiers: 2, key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, nativeVirtualKeyCode: 192 }
    await cdp('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base))
    await cdp('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base))
  }
  await ctrlBackquote()
  const panelByKey = await waitFor(TERM_PRESENT, 9000)
  check('P13 焦点在聊天输入框里时，真键盘 Ctrl+` 仍能呼出终端', panelByKey === true, 'composer=' + focusInfo)
  if (panelByKey) {   // 收起来，给下一条用干净状态
    await evalJs(CLICK_CLOSE)
    await waitFor(`!document.querySelector('.dside-term')`, 8000)
  }

  const statusBtn = await evalJs(`(function(){ var ss=document.querySelectorAll('.dside-statusbar span');
    for (var i=0;i<ss.length;i++){ if (String(ss[i].textContent).indexOf('终端')>=0){ ss[i].click(); return String(ss[i].textContent) } }
    return 'not-found' })()`)
  const panelByBtn = await waitFor(TERM_PRESENT, 9000)
  check('P14 状态栏「⌨ 终端」开关也能呼出终端（可见入口，不用记快捷键）',
    panelByBtn === true && String(statusBtn).indexOf('终端') >= 0, 'btn=' + statusBtn)
  await sleep(1200)   // 让 xterm 的首帧刷新跑完再关（别用"毫秒级开→关"制造库自身的 dispose 竞态）

  // 新会话起来后 PTY 的尺寸要正常（实测出现过 20×14 的极小尺寸 → shell 疯狂换行，看着像坏了）
  const sizeOk = await waitFor(`(async function(){ var r = await (await fetch('/dsh-ide/term-list')).json();
    var t = r && r.terminals && r.terminals[0]; if (!t) return null;
    return (t.cols >= 60 && t.rows >= 10) ? (t.cols + 'x' + t.rows) : null })()`, 12000)
  const sizeRaw = await evalJs(`(async function(){ var r = await (await fetch('/dsh-ide/term-list')).json();
    var t = r && r.terminals && r.terminals[0]; if (!t) return 'none';
    var ed=document.querySelector('.dside-term-body'); var w=ed?Math.round(ed.getBoundingClientRect().width):-1;
    return 'pty=' + t.cols + 'x' + t.rows + ' domW=' + w + ' win=' + window.innerWidth })()`)
  check('P15 终端尺寸正常（补 fit 生效：列数 ≥ 60，不是 20×14 那种极小尺寸）', sizeOk !== null, String(sizeRaw))

  // ⑯ 终端**必须只在中间面板里**（用户 2026-09-21 明确要求："不要跑去 chat 面板，只能在中间面板"）
  // —— 我先前自作主张让它横跨"编辑区 + 右侧栏"，被用户当场否掉，这条断言把它钉死。
  const spanInfo = await evalJs(`(function(){
    var t=document.querySelector('.dside-term'); var c=document.querySelector('.dside-centercol'); var s=document.querySelector('.dside-side');
    if(!t||!c||!s) return null;
    var tr=t.getBoundingClientRect(), cr=c.getBoundingClientRect(), sr=s.getBoundingClientRect();
    return { termW: Math.round(tr.width), centerW: Math.round(cr.width), sideW: Math.round(sr.width),
      gapToSide: Math.round(sr.left - tr.right), win: window.innerWidth } })()`)
  check('P16 终端只在中间面板里（宽度=中间列宽度，右边缘不许越过 chat 面板左边界）',
    !!spanInfo && Math.abs(spanInfo.termW - spanInfo.centerW) <= 4 && spanInfo.gapToSide >= -1, JSON.stringify(spanInfo))
  await evalJs(CLICK_CLOSE)
  await waitFor(`!document.querySelector('.dside-term')`, 8000)

  check('P12 页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))

  const pass = results.filter((x) => x.ok).length
  console.log(`\n[e2e13] ${pass}/${results.length} passed`)
  return { ok: pass === results.length, browser, backend }
}

let handles = null
try {
  handles = await main()
} catch (e) {
  console.log('[e2e13] ABORT: ' + (e && e.stack ? e.stack : e))
} finally {
  try { if (handles && handles.browser) killTree(handles.browser.pid) } catch { /* ignore */ }
  try { if (handles && handles.backend) killTree(handles.backend.pid) } catch { /* ignore */ }
  await sleep(1500)
  try { rmSync(join(`${__TIANGONG_ROOT}`, '.edge-e2e13-tmp-' + process.pid), { recursive: true, force: true }) } catch { /* ignore */ }
  console.log('[e2e13] cleanup done')
}
process.exit(handles && handles.ok ? 0 : 1)
