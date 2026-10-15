// e2e-plugins.mjs — 🧩 插件面板「全量透明」探针（2026-09-22）
//
// 起因（用户原话）："后端那一大批插件也要在这里显示，万一我以后要针对后端插件进行改动呢？
//   其它什么不可见的统统都要显示，这些东西必须对我透明的，我他妈是软件的开发者，隐藏干嘛。"
// 改前：面板只列 `clientModules.graph().entries`（**已启用的前端 51 条**）—— 100+ 条后端插件、
//   以及 31 条 `disabled` 的行（patch 里关掉的，比如 ui-layout）全都看不见。
// 改后：① 插件树 = `ctx.loader.entries()` 全量（含纯后端插件与停用行，带状态/来源组/包说明）
//       ② 前端 bundle（浏览器侧模块表）③ 动态插件；外加过滤条（全部/带前端/纯后端/已停用）。
//
// 用法: node D:\99DSH\tools\e2e-plugins.mjs
//   ⚠ 测试家目录必须先用 dev-testhome.ps1 -TestHome <路径> 生成过（§6 90①），否则插件不挂载。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, openSync, closeSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const PORT = Number(process.env.DSH_E2E_PORT || 3095)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = process.env.DSH_E2E_HOME || 'D:\\99DSH\\.smoke-home-composer'
const CLI = 'D:\\99DSH\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js'
const BLOG = 'D:\\99DSH\\_e2eplugins_backend_' + PORT + '.log'
const SHOT = 'D:\\99DSH\\_e2e-logs\\plugins-' + Date.now() + '.png'
const CDP_PORT = 9700 + Math.floor(Math.random() * 90)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

// 面板快照：标题 + 行数与几个关键行是否存在
const PANEL = `(function(){
  var host = document.querySelector('.dside-explorer');
  if (!host) return { mounted:false };
  var titles = [];
  var ts = host.querySelectorAll('.dside-pane-title');
  for (var i=0;i<ts.length;i++) titles.push((ts[i].textContent||'').trim());
  // ⚠ 分区块数：插件树的行带 data-plugin-row，前端 bundle 的行带 data-client-row
  //   （面板里两块都是 .dside-plugin，混在一起数会把 51 条前端行算进筛选结果）
  var tree = host.querySelectorAll('[data-plugin-row]');
  var client = host.querySelectorAll('[data-client-row]');
  var off = 0, disabledBadge = 0, hostOnly = 0, frontBadge = 0;
  for (var j=0;j<tree.length;j++){
    var r = tree[j];
    if (r.classList.contains('off')) off++;
    if (r.querySelector('.dside-plugin-badge.disabled')) disabledBadge++;
    if (r.querySelector('.dside-plugin-badge.client')) frontBadge++;
    var meta = r.querySelector('.dside-plugin-meta');
    if (meta && (meta.textContent||'').indexOf('纯后端') >= 0) hostOnly++;
  }
  return { mounted:true, titles:titles, rows:tree.length, clientRows:client.length, off:off, disabledBadge:disabledBadge, hostOnly:hostOnly, frontBadge:frontBadge,
    hasSearch: !!host.querySelector('.dside-plugin-search'), modes:[].map.call(host.querySelectorAll('.dside-plugin-mode'), function(b){ return (b.textContent||'').trim() }) };
})()`

const OPEN_PLUGINS = `(function(){
  var bs = document.querySelectorAll('.dside-actbtn');
  for (var i=0;i<bs.length;i++){ if ((bs[i].getAttribute('title')||'').indexOf('插件') === 0) { bs[i].click(); return true } }
  return false })()`

async function main() {
  rmSync(BLOG, { force: true })
  const fd = openSync(BLOG, 'w')
  const backend = spawn(process.execPath, [CLI, 'web', '--port', String(PORT), '--no-open'], {
    cwd: 'D:\\99DSH\\deepseek-harness-mine\\harness', env: cleanEnv(), stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  let backendExit = null
  backend.on('exit', (c) => { backendExit = c })
  let browser = null
  const userDir = 'D:\\99DSH\\.edge-e2eplugins-tmp-' + process.pid
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

    // host 半的数据面先直测（不依赖浏览器）：/init 的 plugins.rows
    let rows = []
    try {
      const r = await (await fetch(APP + '/dsh-ide/init')).json()
      rows = (r && r.plugins && r.plugins.rows) || []
    } catch { /* 交给下面的断言报 */ }
    const hostOnly = rows.filter((x) => x.hasClient !== true)
    const disabled = rows.filter((x) => x.disabled === true)
    const withDesc = rows.filter((x) => typeof x.description === 'string' && x.description !== '')
    check('P1 /init 回全量插件树（>100 条）', rows.length > 100, 'rows=' + rows.length)
    check('P2 含纯后端插件（无前端半）', hostOnly.length > 0, 'hostOnly=' + hostOnly.length)
    check('P3 含已停用的行（不再被藏掉）', disabled.length > 0, 'disabled=' + disabled.length + ' 例:' + disabled.slice(0, 3).map((d) => d.id).join(','))
    check('P4 绝大多数行带 package.json 说明', withDesc.length >= rows.length - 5, 'withDesc=' + withDesc.length + '/' + rows.length)
    check('P5 来源组已清洗成组名（不是 file:// 串）',
      rows.every((x) => x.group === undefined || x.group.indexOf('file://') < 0),
      JSON.stringify((rows.find((x) => x.group && x.group.indexOf('file://') >= 0) || {}).group))
    const ideRow = rows.find((x) => x.name === 'dsh-ide')
    check('P6 天工自己也在清单里（dsh-ide，且有前端半）', !!(ideRow && ideRow.hasClient === true && ideRow.state === 'active'),
      JSON.stringify(ideRow))

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
      while (Date.now() - t < ms) { const v = await evalJs(expr); if (v && !v.__err) return v; await sleep(200) }
      return null
    }
    async function clickAt(x, y) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
      await sleep(60)
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    }

    await cdp('Runtime.enable')
    await cdp('Page.enable')
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    const ready = await waitFor(`!!document.querySelector('.dside-root') && !!document.querySelector('.dside-actbtn')`, 90000)
    check('P7 页面挂载完成（天工 root + 活动栏）', !!ready)
    await cdp('Page.reload', { ignoreCache: false })
    await sleep(2500)
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    await waitFor(`!!document.querySelector('.dside-root') && !!document.querySelector('.dside-actbtn')`, 90000)

    const opened = await evalJs(OPEN_PLUGINS)
    const panel = await waitFor(`(function(){ var p = ${PANEL}; return p.mounted && p.rows > 50 ? p : null })()`, 30000)
    check('P8 点活动栏 🧩 打开插件面板', !!(opened && panel && panel.mounted), JSON.stringify(panel))

    const titleRows = ((panel && panel.titles) || []).find((t) => t.indexOf('插件树') === 0) || ''
    const titleClient = ((panel && panel.titles) || []).find((t) => t.indexOf('前端 bundle') === 0) || ''
    check('P9 面板头是「插件树 · 后端装配」且条数 = /init 全量',
      titleRows.indexOf('(' + rows.length + '/' + rows.length + ')') >= 0, titleRows)
    check('P10 前端 bundle 区块仍在（浏览器侧模块表）',
      titleClient.indexOf('(' + (rows.filter((x) => x.hasClient).length) + '/') >= 0, titleClient)

    check('P11 页面上能看到纯后端插件的行（meta 标"纯后端"）', (panel && panel.hostOnly) > 0, 'hostOnly=' + (panel && panel.hostOnly))
    check('P12 停用的行看得见且带「已停用」badge',
      (panel && panel.disabledBadge) >= disabled.length && (panel && panel.off) >= disabled.length,
      'badge=' + (panel && panel.disabledBadge) + ' off=' + (panel && panel.off) + ' 期望≥' + disabled.length)
    check('P13 带前端半的行在列表里也标了出来', (panel && panel.frontBadge) >= rows.filter((x) => x.hasClient).length,
      'frontBadge=' + (panel && panel.frontBadge))

    // 过滤条：搜 id
    const searchRect = await evalJs(`(function(){ var el=document.querySelector('.dside-plugin-search'); if(!el) return null; var r=el.getBoundingClientRect(); return { x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2) } })()`)
    if (searchRect) {
      await clickAt(searchRect.x, searchRect.y)
      await cdp('Input.insertText', { text: 'tool-bash' })
      await sleep(600)
    }
    const searched = await evalJs(PANEL)
    check('P14 搜索框能筛（搜 tool-bash 后行数骤减且命中）',
      !!(searched && searched.mounted && searched.rows > 0 && searched.rows < 40), JSON.stringify({ rows: searched && searched.rows }))

    // 清空搜索 + 切「已停用」筛选
    await evalJs(`(function(){ var el=document.querySelector('.dside-plugin-search'); if(!el) return false; el.focus(); el.select(); return true })()`)
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await sleep(400)
    const modeClicked = await evalJs(`(function(){ var bs=document.querySelectorAll('.dside-plugin-mode');
      for (var i=0;i<bs.length;i++){ if ((bs[i].textContent||'').indexOf('已停用') >= 0) { bs[i].click(); return (bs[i].textContent||'').trim() } } return null })()`)
    await sleep(500)
    const filtered = await evalJs(PANEL)
    check('P15 「已停用」筛选只留停用行（数量 = ' + disabled.length + '）',
      !!(filtered && filtered.rows === disabled.length && filtered.disabledBadge === disabled.length),
      'mode=' + modeClicked + ' rows=' + (filtered && filtered.rows) + ' badge=' + (filtered && filtered.disabledBadge))

    await sleep(300)
    const shot = await cdp('Page.captureScreenshot', { format: 'png' })
    if (shot && shot.data) { mkdirSync('D:\\99DSH\\_e2e-logs', { recursive: true }); writeFileSync(SHOT, Buffer.from(shot.data, 'base64')); console.log('[SHOT] ' + SHOT) }

    check('P16 页面零未捕获异常', pageErrors.length === 0, pageErrors.join(' | '))
    const pass = results.filter((r) => r.ok).length
    console.log(`\n== e2e-plugins: ${pass}/${results.length} ==`)
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
