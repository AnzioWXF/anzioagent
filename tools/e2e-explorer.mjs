import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// e2e-explorer.mjs — 资源管理器标题栏动作 + 内联新建 E2E（2026-09-21 第二轮）
// 覆盖：标题栏四个动作（新建文件 / 新建文件夹 / 折叠所有文件夹 / 刷新）的**可见性**（VSCode 的
// alwaysShowHeaderActions 默认 false = 悬停才显示）、内联新建行的**目标层级**（文件夹内 / 文件所在目录 /
// 根）、Enter 真的落盘、Esc 不留垃圾文件、折叠全部、刷新、零未捕获异常。
// 用 CDP 真鼠标点击（不是页内 .click()），因为要顺带验"悬停才出现"这条。
// 用法: node tools\e2e-explorer.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, openSync, closeSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const PORT = Number(process.env.DSH_E2E_PORT || 3082)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = process.env.DSH_E2E_HOME || `${__TIANGONG_ROOT}\\.smoke-home`
const WS = process.env.DSH_E2E_WS || `${__TIANGONG_ROOT}\\.smoke-ws-expl`
const CLI = `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js`
const BLOG = `${__TIANGONG_ROOT}\\_e2eexpl_backend_` + PORT + '.log'
const CDP_PORT = 9600 + Math.floor(Math.random() * 90)
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
function killTree(pid) { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ } }

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
  // 临时浏览器 profile 一律落 temp（00devCore §0.5），别落 <仓库根> 根
  const userDir = `${__TIANGONG_ROOT}\\temp\\.edge-e2eexpl-tmp-` + process.pid
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

    rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
    mkdirSync(WS + '\\sub', { recursive: true })
    writeFileSync(WS + '\\root.txt', 'root file\n')
    writeFileSync(WS + '\\sub\\inner.txt', 'inner file\n')

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
      while (Date.now() - t < ms) { const v = await evalJs(expr); if (v) return v; await sleep(200) }
      return null
    }
    // 真鼠标点击（先移动过去 → 触发 hover，再按下抬起）
    async function clickAt(x, y) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await sleep(120)
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(350)
    }
    async function rectOf(sel) {
      return evalJs(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
        var r=e.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), w: Math.round(r.width), h: Math.round(r.height) } })()`)
    }
    // 按标题栏动作的 aria-label 找按钮
    async function actBtn(label) {
      return rectOf(`.dside-pane-actions button[aria-label^="${label}"]`)
    }
    // 点树里的某个节点（真鼠标）
    async function clickNode(name) {
      const r = await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-node-name');
        for (var i=0;i<ns.length;i++){ if (ns[i].textContent.trim()===${JSON.stringify(name)}){ var e=ns[i].parentElement; var b=e.getBoundingClientRect();
          return { x: Math.round(b.left+30), y: Math.round(b.top+b.height/2) } } } return null })()`)
      if (!r) return false
      await clickAt(r.x, r.y)
      return true
    }

    await cdp('Runtime.enable')
    await cdp('Page.enable')
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 90000)
    check('P1 页面挂载完成', !!ready)
    await evalJs(`(function(){ try { localStorage.removeItem('dside.keys.v1') } catch(e){} return 1 })()`)

    // 专用安静工作区（客户端会按会话 cwd 覆盖 active-root，见 §6 69 → 循环设根直到树里出现 fixture）
    let rootOk = false
    for (let i = 0; i < 12 && !rootOk; i++) {
      await fetch(APP + '/dsh-ide/active-root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: WS }) })
      await sleep(700)
      rootOk = await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-node-name'); for (var i=0;i<ns.length;i++){ if (ns[i].textContent.trim()==='root.txt') return true } return false })()`)
    }
    check('P2 工作区根已生效（树里有 fixture）', rootOk)

    // ── 标题栏四个动作按钮 ────────────────────────────────────────────────
    // 顺序照 VSCode 源码 explorerView.ts 的 order：新建文件(10) · 新建文件夹(20) · 刷新(30) · 折叠(40)
    const btns = await evalJs(`(function(){ var bs=document.querySelectorAll('.dside-pane-actions button');
      return Array.prototype.map.call(bs, function(b){ return b.getAttribute('aria-label') }) })()`)
    check('P3 标题栏四个动作，顺序 = 新建文件 · 新建文件夹 · 刷新 · 折叠（VSCode order 10/20/30/40）',
      Array.isArray(btns) && btns.length === 4 && /新建文件/.test(btns[0]) && /新建文件夹/.test(btns[1]) && /刷新/.test(btns[2]) && /折叠/.test(btns[3]),
      JSON.stringify(btns))

    // VSCode 的 alwaysShowHeaderActions 默认 false → 平时透明、悬停才显形
    const opBefore = await evalJs(`(function(){ var a=document.querySelector('.dside-pane-actions'); return a? getComputedStyle(a).opacity : null })()`)
    const titleRect = await rectOf('.dside-explorer-title')
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: titleRect.x, y: titleRect.y })
    await sleep(400)
    const opAfter = await evalJs(`(function(){ var a=document.querySelector('.dside-pane-actions'); return a? getComputedStyle(a).opacity : null })()`)
    check('P4 动作按钮平时隐藏、鼠标移到标题栏才出现（VSCode 默认行为）',
      String(opBefore) === '0' && Number(opAfter) > 0.9, JSON.stringify({ opBefore, opAfter }))

    // ── 新建文件（未选中任何节点 → 落在工作空间根）──────────────────────────
    let b = await actBtn('新建文件')
    await clickAt(b.x, b.y)
    await sleep(500)
    const inline1 = await evalJs(`(function(){ var i=document.querySelector('.dside-node-new .dside-inline-input');
      if(!i) return null; var row=i.closest('.dside-node'); var guides=row? row.querySelectorAll('.dside-guide').length : -1;
      var focused = document.activeElement === i;
      return { has: true, guides: guides, focused: focused } })()`)
    check('P5 点「新建文件」→ 树里出现内联输入行（根层级 = 0 条参考线）且光标已聚焦',
      !!inline1 && inline1.guides === 0 && inline1.focused, JSON.stringify(inline1))

    await cdp('Input.insertText', { text: 'brand-new.txt' })
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(1600)
    const created = existsSync(WS + '\\brand-new.txt')
    const inTree = await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-node-name'); for (var i=0;i<ns.length;i++){ if (ns[i].textContent.trim()==='brand-new.txt') return true } return false })()`)
    const tabOpen = await evalJs(`document.querySelectorAll('.dside-tab').length`)
    check('P6 Enter 真的在根层级落盘 + 树里出现 + 打开成标签', created && inTree && tabOpen >= 1, JSON.stringify({ created, inTree, tabOpen }))

    // ── Esc 不留垃圾文件 ─────────────────────────────────────────────────
    b = await actBtn('新建文件')
    await clickAt(b.x, b.y)
    await sleep(400)
    await cdp('Input.insertText', { text: 'should-not-exist.txt' })
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(800)
    const escGone = await evalJs(`!document.querySelector('.dside-node-new .dside-inline-input')`)
    check('P7 Esc 关掉内联行、什么都不建（VSCode 同款：它也是插内存节点、磁盘上从没有占位文件）',
      escGone && !existsSync(WS + '\\should-not-exist.txt'), JSON.stringify({ escGone, exists: existsSync(WS + '\\should-not-exist.txt') }))

    // ── 点别处（blur）= 确认（VSCode：`done(inputBox.isInputValid(), true)`）──────────
    b = await actBtn('新建文件')
    await clickAt(b.x, b.y)
    await sleep(400)
    await cdp('Input.insertText', { text: 'blur-made.txt' })
    const editorRect = await rectOf('.dside-centercol')
    await clickAt(editorRect.x, Math.min(editorRect.y + 30, 900))    // 点到编辑区 = 让输入框失焦
    await sleep(1500)
    check('P7b 点别处（失焦）= 确认，文件照样建出来（VSCode 同款）',
      existsSync(WS + '\\blur-made.txt'), String(existsSync(WS + '\\blur-made.txt')))

    // ── 目标层级：选中文件夹 → 新建到它里面（真鼠标点树）────────────────────
    await clickNode('sub')
    await sleep(900)
    b = await actBtn('新建文件')
    await clickAt(b.x, b.y)
    await sleep(500)
    const inline2 = await evalJs(`(function(){ var i=document.querySelector('.dside-node-new .dside-inline-input');
      if(!i) return null; var row=i.closest('.dside-node'); return { guides: row? row.querySelectorAll('.dside-guide').length : -1, focused: document.activeElement===i } })()`)
    check('P8 选中文件夹后新建 → 内联行落在该文件夹里（1 条参考线 = 深度 1）',
      !!inline2 && inline2.guides === 1, JSON.stringify(inline2))
    await cdp('Input.insertText', { text: 'inside-sub.txt' })
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(1600)
    check('P9 文件真的建在子目录里（D:\\...\\sub\\inside-sub.txt）', existsSync(WS + '\\sub\\inside-sub.txt'))

    // ── 目标层级：选中文件 → 新建到它所在的目录 ────────────────────────────
    await clickNode('inner.txt')
    await sleep(900)
    b = await actBtn('新建文件夹')
    await clickAt(b.x, b.y)
    await sleep(500)
    const inline3 = await evalJs(`(function(){ var i=document.querySelector('.dside-node-new .dside-inline-input');
      if(!i) return null; var row=i.closest('.dside-node'); return { guides: row? row.querySelectorAll('.dside-guide').length : -1 } })()`)
    await cdp('Input.insertText', { text: 'newdir' })
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(1600)
    check('P10 选中文件后新建文件夹 → 建在该文件所在目录（sub\\newdir）',
      !!inline3 && inline3.guides === 1 && existsSync(WS + '\\sub\\newdir'), JSON.stringify({ inline3, exists: existsSync(WS + '\\sub\\newdir') }))

    // ── 折叠所有文件夹 ───────────────────────────────────────────────────
    // 先确保 sub 是**展开**的（前几步建过东西，可能已经被展开；这里按"树里能不能看到它的子项"判断）
    const hasInner = await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-node-name'); for (var i=0;i<ns.length;i++){ if (ns[i].textContent.trim()==='inner.txt') return true } return false })()`)
    if (!hasInner) { await clickNode('sub'); await sleep(900) }
    const stillNoInner = await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-node-name'); for (var i=0;i<ns.length;i++){ if (ns[i].textContent.trim()==='inner.txt') return false } return true })()`)
    const expandedBefore = await evalJs(`document.querySelectorAll('.dside-node').length`)
    b = await actBtn('折叠')
    await clickAt(b.x, b.y)
    await sleep(700)
    const expandedAfter = await evalJs(`document.querySelectorAll('.dside-node').length`)
    const noInput = await evalJs(`!document.querySelector('.dside-node-new')`)
    check('P11 「折叠所有文件夹」把展开的目录都收起（可见行数变少）',
      !stillNoInner && expandedAfter < expandedBefore && noInput, JSON.stringify({ stillNoInner, expandedBefore, expandedAfter }))

    // ── 刷新 ─────────────────────────────────────────────────────────────
    b = await actBtn('刷新')
    await clickAt(b.x, b.y)
    await sleep(900)
    const stillThere = await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-node-name'); for (var i=0;i<ns.length;i++){ if (ns[i].textContent.trim()==='root.txt') return true } return false })()`)
    check('P12 「刷新」后树仍然正常列出（没崩、没空）', !!stillThere)

    await sleep(1600)   // 等 trace 去抖上报
    let traced = false
    try {
      const log = readFileSync(HOME_DIR + '\\logs\\ide-trace.log', 'utf8')
      traced = log.indexOf('"tree-refresh"') >= 0 && log.indexOf('"tree-new-inline-open"') >= 0 && log.indexOf('"tree-collapse-all"') >= 0
    } catch { /* ignore */ }
    check('P13 三个动作都有埋点（tree-refresh / tree-new-inline-open / tree-collapse-all）', traced)
    check('P14 零未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } catch (e) {
    check('套件执行完成', false, e && e.stack ? e.stack : String(e))
  } finally {
    if (browser) killTree(browser.pid)
    killTree(backend.pid)
    await sleep(600)
    try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch (e) { /* Windows 文件锁：临时 profile 删不掉不影响结论 */ }
    try { rmSync(BLOG, { force: true }) } catch { /* ignore */ }
    rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
    const pass = results.filter((r) => r.ok).length
    console.log('\n===== 资源管理器动作 E2E: ' + pass + '/' + results.length + ' =====')
    const failed = results.filter((r) => !r.ok)
    if (failed.length) console.log('FAILED: ' + failed.map((r) => r.name).join(' | '))
  }
}
main()
