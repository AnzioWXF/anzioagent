import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// ⑰ 面板拖拽改宽高 E2E（对齐 VSCode 的 sash：4px 命中区、hover 高亮、双击恢复默认、拖动实时生效）
// 用法: node tools\e2e-resize.mjs
//   自起隔离测试后端（DSH_HOME=<仓库根>\.smoke-home，先跑 tools\dev-testhome.ps1 刷新插件代码）
//   + 无头 Edge/Chrome（CDP，视口显式设 1600×1000）+ **真鼠标拖拽**（Input.dispatchMouseEvent）。
// 验的是：左栏 / 右栏 / 终端三处手柄都能拖、会被最小/最大值夹住、双击恢复默认、结果落 localStorage
//   刷新后仍在；以及一条用户硬要求：**终端只能在中间面板里**（改右栏宽度后终端依旧只在中间列）。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, openSync, closeSync } from 'node:fs'

const PORT = Number(process.env.DSH_E2E_PORT || 3082)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = process.env.DSH_E2E_HOME || `${__TIANGONG_ROOT}\\.smoke-home`
const WS = process.env.DSH_E2E_WS || `${__TIANGONG_ROOT}\\.smoke-wsr`
const CLI = `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js`
const BLOG = `${__TIANGONG_ROOT}\\_e2eresize_backend_` + PORT + '.log'
const CDP_PORT = 9900 + Math.floor(Math.random() * 90)

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
const GEO = `(function(){
  function w(sel){ var e=document.querySelector(sel); return e? Math.round(e.getBoundingClientRect().width):-1 }
  function h(sel){ var e=document.querySelector(sel); return e? Math.round(e.getBoundingClientRect().height):-1 }
  var left=document.querySelector('.dside-leftpanel'), term=document.querySelector('.dside-term'), side=document.querySelector('.dside-side');
  return { leftW: w('.dside-leftpanel'), centerW: w('.dside-centercol'), rightW: w('.dside-side'),
    termW: w('.dside-term'), termH: h('.dside-term'), winW: window.innerWidth, winH: window.innerHeight,
    termRight: term? Math.round(term.getBoundingClientRect().right):-1,
    sideLeft: side? Math.round(side.getBoundingClientRect().left):-1,
    hasLeft: !!left, hasTerm: !!term } })()`
const SASHES = `(function(){ var ss=document.querySelectorAll('.dside-sash'); var a=[];
  for (var i=0;i<ss.length;i++){ var r=ss[i].getBoundingClientRect();
    a.push({ dir: ss[i].getAttribute('data-sash'), w: Math.round(r.width), h: Math.round(r.height),
      cursor: getComputedStyle(ss[i]).cursor }) }
  return a })()`

async function main() {
  rmSync(BLOG, { force: true })
  const fd = openSync(BLOG, 'w')
  const backend = spawn(process.execPath, [CLI, 'web', '--port', String(PORT), '--no-open'], {
    cwd: `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness`, env: cleanEnv(), stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  let backendExit = null
  backend.on('exit', (c) => { backendExit = c })
  let browser = null
  const userDir = `${__TIANGONG_ROOT}\\.edge-e2eresize-tmp-` + process.pid

  try {
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

    rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
    mkdirSync(WS, { recursive: true })
    writeFileSync(WS + '\\_e2eresize.txt', 'x\n')

    try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch (e) { /* Windows 文件锁：临时 profile 删不掉不影响结论 */ }
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
        if (v) return v
        await sleep(250)
      }
      return null
    }

    await cdp('Runtime.enable')
    await cdp('Page.enable')
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 90000)
    check('P1 页面挂载完成（IDE + monaco）', !!ready, await evalJs('document.readyState'))

    // 专用安静工作区（同 e2e-tabs：客户端会按会话 cwd 覆盖，所以要循环设根）
    let wsOk = false
    for (let i = 0; i < 12 && !wsOk; i++) {
      await fetch(APP + '/dsh-ide/active-root', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: WS }),
      })
      wsOk = (await waitFor(`(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node-name');
        for (var i=0;i<ns.length;i++) if (ns[i].textContent==='_e2eresize.txt') return true; return false })()`, 2500)) === true
    }
    check('P2 专用工作区生效（树里看到测试文件）', wsOk === true)

    // 打开终端（⑰ 的手柄有三条：左栏 / 右栏 / 终端）
    await evalJs(OPEN_TERM)
    await waitFor(`!!document.querySelector('.dside-term')`, 12000)
    const sashes0 = await evalJs(SASHES)
    check('P3 三条拖拽手柄都在（左栏 / 右栏 / 终端），光标是 VSCode 的 ew-resize / ns-resize',
      Array.isArray(sashes0) && sashes0.length === 3
        && sashes0.filter((s) => s.dir === 'col').length === 2
        && sashes0.filter((s) => s.dir === 'row').length === 1
        && sashes0.every((s) => s.cursor === (s.dir === 'col' ? 'ew-resize' : 'ns-resize')),
      JSON.stringify(sashes0))

    // ⚠ 手柄必须**压在分界线上**（不是"存在就算过"）：2026-09-21 用户实测"右侧和终端拖不动"，
    // 根因就是那两处面板漏写 position:relative → 绝对定位的手柄跑到窗口左上角，
    // 而旧探针是"先量手柄在哪、再去那儿拖"，照样全绿 → 加了这组几何不变量断言才抓得住。
    const align = await evalJs(`(function(){
      function box(sel){ var e=document.querySelector(sel); if(!e) return null; var r=e.getBoundingClientRect();
        return { l: r.left, r: r.right, t: r.top, b: r.bottom, cx: r.left+r.width/2, cy: r.top+r.height/2 } }
      var cs=document.querySelectorAll('.dside-sash.col'); var rs=document.querySelector('.dside-sash.row');
      var lp=box('.dside-leftpanel'), cc=box('.dside-centercol'), sp=box('.dside-side'), tm=box('.dside-term');
      var sl=cs[0]? box('.dside-leftpanel .dside-sash') : null;
      var sr=cs[1]? box('.dside-side .dside-sash') : null;
      var st=rs? box('.dside-sash.row') : null;
      return { leftDelta: (sl&&lp)? Math.round(Math.abs(sl.cx - lp.r)) : null,
               rightDelta: (sr&&sp)? Math.round(Math.abs(sr.cx - sp.l)) : null,
               termDelta: (st&&tm)? Math.round(Math.abs(st.cy - tm.t)) : null,
               winW: window.innerWidth, winH: window.innerHeight,
               inViewport: !!(sl && sl.cx > 40) } })()`)
    check('P3b 三条手柄都压在各自的分界线上（左栏右边缘 / 右栏左边缘 / 终端上边缘，误差 ≤3px）',
      !!align && align.leftDelta !== null && align.leftDelta <= 3
        && align.rightDelta !== null && align.rightDelta <= 3
        && align.termDelta !== null && align.termDelta <= 3,
      JSON.stringify(align))

    // ── 真鼠标拖拽 ────────────────────────────────────────────────
    // ⚠ 每次拖拽前**必须重新量手柄位置**：手柄会随面板尺寸一起移动（第一版复用了旧坐标，
    // 结果第二次拖拽按在了面板上 = 假 FAIL）
    async function sashPt(which) {
      return evalJs(`(function(){ var cs=document.querySelectorAll('.dside-sash.col'); var rs=document.querySelector('.dside-sash.row');
        var e = ${JSON.stringify(which)} === 'term' ? rs : (${JSON.stringify(which)} === 'left' ? cs[0] : cs[cs.length-1]);
        if (!e) return null; var r=e.getBoundingClientRect();
        return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) } })()`)
    }
    async function dragSash(which, dx, dy) {
      const pt = await sashPt(which)
      if (!pt) throw new Error('no sash: ' + which)
      return drag(pt, dx, dy)
    }
    async function dblSash(which) {
      const pt = await sashPt(which)
      if (!pt) return false
      await dblclick(pt)
      return true
    }

    async function drag(pt, dx, dy) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 1 })
      const mid = []
      const steps = 8
      for (let i = 1; i <= steps; i++) {
        await cdp('Input.dispatchMouseEvent', {
          type: 'mouseMoved', button: 'left', buttons: 1,
          x: pt.x + Math.round((dx * i) / steps), y: pt.y + Math.round((dy * i) / steps),
        })
        await sleep(25)
        if (i === 4) mid.push(await evalJs('document.body.className'))
      }
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x + dx, y: pt.y + dy, button: 'left', clickCount: 1, buttons: 0 })
      await sleep(250)
      return mid[0] || ''
    }

    async function dblclick(pt) {
      for (const n of [1, 2]) {
        await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: n, buttons: 1 })
        await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: n, buttons: 0 })
        await sleep(40)
      }
      await sleep(300)
    }

    const g0 = await evalJs(GEO)
    const midClass = await dragSash('left', 120, 0)
    const g1 = await evalJs(GEO)
    check('P4 拖左栏手柄向右 120px → 左栏变宽 ~120、编辑区相应变窄',
      g1.leftW - g0.leftW >= 110 && g1.leftW - g0.leftW <= 130 && g0.centerW - g1.centerW >= 110,
      `left ${g0.leftW}→${g1.leftW} center ${g0.centerW}→${g1.centerW}`)
    check('P5 拖拽期间 body 挂上 dside-resizing-col（全局禁选 + 光标统一）',
      String(midClass).indexOf('dside-resizing-col') >= 0, String(midClass))

    await dragSash('left', -2000, 0)
    const g2 = await evalJs(GEO)
    check('P6 左栏被最小宽度夹住（170px）', g2.leftW === 170, String(g2.leftW))

    await dragSash('right', -200, 0)
    const g3 = await evalJs(GEO)
    check('P7 拖右栏手柄向左 200px → 右栏变宽 ~200（编辑区变窄）',
      g3.rightW - g2.rightW >= 190 && g3.rightW - g2.rightW <= 215, `right ${g2.rightW}→${g3.rightW}`)
    check('P8 改右栏宽度后，终端仍在中间列里（宽=中间列宽、右边缘不越过 chat 面板）',
      g3.hasTerm === true && Math.abs(g3.termW - g3.centerW) <= 4 && g3.sideLeft - g3.termRight >= -1,
      `termW=${g3.termW} centerW=${g3.centerW} gap=${g3.sideLeft - g3.termRight}`)

    await dragSash('right', 3000, 0)
    const g4 = await evalJs(GEO)
    check('P9 右栏被最小宽度夹住（320px）', Math.abs(g4.rightW - 320) <= 2, String(g4.rightW))

    await dragSash('term', 0, -100)   // 向上拖 = 终端变高
    const g5 = await evalJs(GEO)
    check('P10 拖终端手柄向上 100px → 终端变高 ~100',
      g5.termH - g4.termH >= 90 && g5.termH - g4.termH <= 115, `termH ${g4.termH}→${g5.termH}`)

    await dragSash('term', 0, 2000)
    const g6 = await evalJs(GEO)
    check('P11 终端被最小高度夹住（77px，与 VSCode 的面板最小值一致）', Math.abs(g6.termH - 77) <= 2, String(g6.termH))

    // ⑰ 手柄**不占布局空间**（VSCode 的 sash 是绝对定位叠在分界线上）：三栏宽度之和 = 窗口宽 − 活动栏
    const sum = await evalJs(`(function(){ var a=document.querySelector('.dside-activitybar'), l=document.querySelector('.dside-leftpanel'),
      c=document.querySelector('.dside-centercol'), s=document.querySelector('.dside-side');
      if(!a||!l||!c||!s) return null;
      function w(e){ return Math.round(e.getBoundingClientRect().width) }
      return { total: w(a)+w(l)+w(c)+w(s), win: window.innerWidth } })()`)
    check('P12 手柄不占布局空间（活动栏+左栏+编辑区+右栏 = 窗口宽，没有为手柄留 4px×2）',
      !!sum && Math.abs(sum.total - sum.win) <= 2, JSON.stringify(sum))

    // ── 双击恢复默认 ──────────────────────────────────────────────
    await dblSash('left')
    await dblSash('right')
    await dblSash('term')
    const g7 = await evalJs(GEO)
    check('P13 双击手柄恢复默认尺寸（左 272 / 右 704 / 终端 260）',
      Math.abs(g7.leftW - 272) <= 2 && Math.abs(g7.rightW - 704) <= 2 && Math.abs(g7.termH - 260) <= 2,
      `left=${g7.leftW} right=${g7.rightW} termH=${g7.termH}`)

    // ── 持久化：拖一次 → 刷新页面 → 尺寸还在 ───────────────────────
    await dragSash('left', 96, 0)
    const g8 = await evalJs(GEO)
    await cdp('Page.reload', { ignoreCache: false })
    const back = await waitFor(`!!document.querySelector('.dside-sash') && !!document.querySelector('.dside-leftpanel')`, 60000)
    const g9 = await evalJs(GEO)
    check('P14 尺寸落 localStorage：刷新后左栏宽度保持（' + g8.leftW + 'px）',
      !!back && Math.abs(g9.leftW - g8.leftW) <= 2, `before=${g8.leftW} after=${g9.leftW}`)

    check('P15 全程页面零未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } finally {
    if (browser) killTree(browser.pid)
    killTree(backend.pid)
    await sleep(1500)
    try { rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch { /* 自清 */ }
    try { try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch (e) { /* Windows 文件锁：临时 profile 删不掉不影响结论 */ } } catch { /* 自清 */ }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n== ⑰ 面板拖拽 E2E: ${results.length - failed.length}/${results.length} 通过 ==`)
  if (failed.length) { console.log('FAIL:', failed.map((f) => f.name).join(' | ')); process.exitCode = 1 }
}

main().catch((e) => { console.error('E2E crashed:', (e && e.stack) || e); process.exitCode = 1 })
