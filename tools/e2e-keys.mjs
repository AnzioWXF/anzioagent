// e2e-keys.mjs — 键位系统 E2E（2026-09-21）
// 用 **CDP 真键盘事件**（Input.dispatchKeyEvent）而不是页内合成 KeyboardEvent：合成事件绕不过
// 浏览器/壳层对按键的原生处理，老套件里"Ctrl+` 打开终端"就是靠合成事件绿的（见 00devCore §6 24/76）。
//
// 覆盖：三个报障键（Ctrl+N / Ctrl+A / Ctrl+`）· 对照组 Ctrl+B · 快捷键设置页（打开/列条目/搜索）
//   · 录键改绑 · 新键位**立刻生效** · 冲突提示 + 仍然设置把对方解绑 · 单条重置 · 全部恢复默认
//   · 编辑器侧键位（改 Ctrl+S）· 关掉设置页后编辑器未卸载 · 零未捕获异常
// 用法: node D:\99DSH\tools\e2e-keys.mjs   （自起隔离测试后端 3082 + 无头 Edge）
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, openSync, closeSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const PORT = Number(process.env.DSH_E2E_PORT || 3082)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = process.env.DSH_E2E_HOME || 'D:\\99DSH\\.smoke-home'
const WS = process.env.DSH_E2E_WS || 'D:\\99DSH\\.smoke-ws-keys'
const CLI = 'D:\\99DSH\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js'
const BLOG = 'D:\\99DSH\\_e2ekeys_backend_' + PORT + '.log'
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
function killTree(pid) { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ } }

const VK = { KeyA: 65, KeyB: 66, KeyH: 72, KeyI: 73, KeyK: 75, KeyN: 78, KeyO: 79, KeyP: 80, KeyR: 82, KeyS: 83, KeyT: 84, KeyW: 87, KeyX: 88, Backquote: 192, Delete: 46, Escape: 27, F12: 123, Numpad0: 96 }

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
  // 临时浏览器 profile 一律落 temp（00devCore §0.5：临时/测试垃圾统一落 D:\99DSH\temp）——
  // 原来直接落在 D:\99DSH 根，正是"根目录堆垃圾、下一轮还被批量删除闸挡住"的来源（2026-09-30 修）
  const userDir = 'D:\\99DSH\\temp\\.edge-e2ekeys-tmp-' + process.pid
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
    mkdirSync(WS + '\\src', { recursive: true })
    writeFileSync(WS + '\\src\\a.txt', 'line one\nline two\nline three\nline four\n')
    writeFileSync(WS + '\\hello.txt', 'hello smoke\n')

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
    // 原生 confirm/alert 会让渲染进程卡在等应答上（CDP 下没人应答 = 整个套件挂死，2026-09-29 实测踩到）
    // → 自动放行，但**记账**：出现意外确认框本身就是问题，收尾要有断言
    const jsDialogs = []
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
      if (m.method === 'Page.javascriptDialogOpening') {
        jsDialogs.push(String((m.params && m.params.message) || '').slice(0, 100))
        cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => { /* 忽略 */ })
        return
      }
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
    // 真键盘
    async function key(code, keyChar, mods) {
      const base = { modifiers: mods || 0, code, key: keyChar, windowsVirtualKeyCode: VK[code] || 0, nativeVirtualKeyCode: VK[code] || 0 }
      await cdp('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base))
      await cdp('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base))
      await sleep(320)
    }
    const CTRL = 2, ALT = 1, SHIFT = 8

    // 打开「设置 → 快捷键」页（幂等：⚠ 点已激活的活动栏图标 = 收起面板，所以不能无脑点）
    async function openKeysView() {
      if (await evalJs(`!!document.querySelector('.dside-keys')`)) return true
      // 那一行的文案是「⌨快捷键…」（client.js 设置页块），别再按老文案「编辑快捷键」找 ——
      // 改回去点不到入口，后面 P9–P15 会连锁假红（2026-10-13 踩过）。
      const clickEntry = () => evalJs(`(function(){ var rows=document.querySelectorAll('.dside-block-row');
        for (var i=0;i<rows.length;i++){ var t=rows[i].textContent||'';
          if (t.indexOf('快捷键')>=0 && t.indexOf('恢复默认')<0 && t.indexOf('改过的')<0) { rows[i].click(); return true } } return false })()`)
      if (!(await clickEntry())) {
        await evalJs(`(function(){ var bs=document.querySelectorAll('.dside-activitybar button');
          for (var i=0;i<bs.length;i++){ if ((bs[i].getAttribute('title')||'').indexOf('设置')>=0) { bs[i].click(); return true } } return false })()`)
        await sleep(700)
        await clickEntry()
      }
      await sleep(700)
      return !!(await evalJs(`!!document.querySelector('.dside-keys')`))
    }
    async function closeKeysView() {
      await evalJs(`(function(){ var bs=document.querySelectorAll('.dside-keys-head button');
        for (var i=0;i<bs.length;i++){ if ((bs[i].textContent||'').indexOf('关闭')>=0){ bs[i].click(); return true } } return false })()`)
      await sleep(450)
    }
    async function clickRowButton(keyId, label) {
      return evalJs(`(function(){ var it=document.querySelector('[data-key-id="${keyId}"]'); if(!it) return false;
        var bs=it.querySelectorAll('button'); for (var i=0;i<bs.length;i++){ if (bs[i].textContent.trim()==='${label}'){ bs[i].click(); return true } } return false })()`)
    }

    await cdp('Runtime.enable')
    await cdp('Page.enable')
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 90000)
    check('P1 页面挂载完成（IDE + monaco）', !!ready)

    // 清掉上一轮遗留的键位改动，保证从默认值开始
    await evalJs(`(function(){ try { localStorage.removeItem('dside.keys.v1') } catch(e){} return 1 })()`)
    await cdp('Page.reload', { ignoreCache: false })
    await sleep(2500)
    await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 90000)
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    await sleep(1200)

    // 专用安静工作区（客户端会按会话 cwd 覆盖 active-root，见 §6 69 → 循环设根直到树里出现 fixture）
    let rootOk = false
    for (let i = 0; i < 12 && !rootOk; i++) {
      await fetch(APP + '/dsh-ide/active-root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: WS }) })
      await sleep(700)
      rootOk = await evalJs(`(function(){ var n=document.querySelectorAll('.dside-node-name'); for (var i=0;i<n.length;i++) if (n[i].textContent.trim()==='src') return true; return false })()`)
    }
    check('P2 工作区根已生效（树里能看到 fixture）', rootOk)

    // 打开 src/a.txt（真点树）
    await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-node-name'); for (var i=0;i<ns.length;i++){ if (ns[i].textContent.trim()==='src'){ var r=ns[i].closest('.dside-node')||ns[i].parentElement; r.click(); return true } } return false })()`)
    await sleep(1200)
    const clicked = await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-node-name'); for (var i=0;i<ns.length;i++){ if (ns[i].textContent.trim()==='a.txt'){ var r=ns[i].closest('.dside-node')||ns[i].parentElement; r.click(); return true } } return false })()`)
    await sleep(1800)
    const modelOk = await waitFor(`(function(){ var e=monaco.editor.getEditors()[0]; return !!(e&&e.getModel()) })()`, 8000)
    check('P3 打开文件后编辑器挂上 model', !!modelOk, 'clicked=' + clicked)

    // 焦点进编辑器（点编辑区）
    const box = await evalJs(`(function(){ var e=document.querySelector('.dside-editor-monaco'); if(!e) return null; var r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+30)} })()`)
    if (box) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await sleep(400)
    }

    // ── 报障键 1：Ctrl+A 必须选中编辑器全文（而不是整页 DOM）────────────────
    const beforeA = await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; e.setSelection(new monaco.Selection(1,1,1,1)); return { sel: e.getModel().getValueInRange(e.getSelection()).length, total: e.getModel().getValueLength() } })()`)
    await key('KeyA', 'a', CTRL)
    const afterA = await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; var m=e.getModel();
      return { sel: m.getValueInRange(e.getSelection()).length, total: m.getValueLength(),
               domSel: String(window.getSelection().toString()).length } })()`)
    check('P4 Ctrl+A 在编辑器里全选（monaco 选区 = 全文，不是整页 DOM）',
      afterA && afterA.sel === afterA.total && afterA.total > 0 && afterA.sel !== beforeA.sel,
      JSON.stringify({ beforeA, afterA }))

    // ── 报障键 2：Ctrl+` 呼出 / 收起终端 ──────────────────────────────────
    await key('Backquote', '`', CTRL)
    const termOn = await evalJs(`!!document.querySelector('.dside-term')`)
    await key('Backquote', '`', CTRL)
    const termOff = await evalJs(`!document.querySelector('.dside-term')`)
    check('P5 Ctrl+` 呼出集成终端', !!termOn)
    check('P6 Ctrl+` 再按一次收起终端', !!termOff)

    // ── 对照组：Ctrl+B 显隐侧栏（证明路由本身是活的）─────────────────────────
    await key('KeyB', 'b', CTRL)
    const bOff = await evalJs(`!document.querySelector('.dside-leftpanel')`)
    await key('KeyB', 'b', CTRL)
    const bOn = await evalJs(`!!document.querySelector('.dside-leftpanel')`)
    check('P7 Ctrl+B 显隐侧边栏（对照组）', !!bOff && !!bOn, JSON.stringify({ bOff, bOn }))

    // ── 报障键 3：Ctrl+N 新建文件（以前压根没实现）──────────────────────────
    // ⚠ headless Chrome 自己吃掉了 Ctrl+N（浏览器级"新建窗口"），页面**根本收不到** ——
    //   所以分两步验：① 读注册表确认 Ctrl+N 确实绑在「新建文件」上；② 用浏览器不拦的 Ctrl+Alt+F
    //   把它改绑一次，真键盘按下去必须弹出对话框（证明命令链路是通的）。
    //   真机上 Electron 没有浏览器 UI，Ctrl+N 会被页面正常收到（见下面"真机"一节）。
    const nBind = await evalJs(`(function(){ return window.__dsideKeys ? window.__dsideKeys.resolved('file.newFile') : 'no-hook' })()`)
    check('P8a 注册表里 Ctrl+N 已绑到「新建文件」', nBind === 'Ctrl+N', String(nBind))

    await openKeysView()
    const recF = await clickRowButton('file.newFile', '改')
    await sleep(300)
    await key('KeyF', 'f', CTRL | ALT)
    await sleep(300)
    const recFChip = await evalJs(`(function(){ var it=document.querySelector('[data-key-id="file.newFile"] .dside-kbd'); return it?it.textContent:null })()`)
    await closeKeysView()
    await key('KeyF', 'f', CTRL | ALT)
    const dlg = await waitFor(`!!document.querySelector('.dside-inline-input, .dside-dialog input')`, 4000)
    const dlgInfo = await evalJs(`(function(){ var i=document.querySelector('.dside-inline-input') || document.querySelector('.dside-dialog input');
      if(!i) return null; return { kind: i.className, placeholder: i.getAttribute('placeholder')||'', focused: document.activeElement === i } })()`)
    check('P8b 「新建文件」命令真的打开新建输入（改绑成 Ctrl+Alt+F 后仍生效）', !!dlg && recF && recFChip === 'Ctrl+Alt+F',
      JSON.stringify({ recF, recFChip, dlgInfo }))
    await key('Escape', 'Escape', 0)
    await sleep(300)
    await evalJs(`(function(){ try { localStorage.removeItem('dside.keys.v1') } catch(e){} return 1 })()`)

    // ── 快捷键设置页：从设置组打开 ─────────────────────────────────────────
    const opened = await openKeysView()
    const keysOpen = await evalJs(`(function(){ var k=document.querySelector('.dside-keys'); if(!k) return null;
      var n=document.querySelectorAll('.dside-keys-item').length; var g=document.querySelectorAll('.dside-keys-group-title').length;
      return { items: n, groups: g, hasSearch: !!document.querySelector('.dside-keys-search') } })()`)
    check('P9 设置组「快捷键」小组能打开中面板的快捷键页', !!opened && !!keysOpen && keysOpen.items >= 25, JSON.stringify(keysOpen))

    // ── 录键：把 view.terminal 改成 Ctrl+Alt+K，并验证**立刻生效** ──────────
    const recClicked = await clickRowButton('view.terminal', '改')
    await sleep(400)
    await key('KeyK', 'k', CTRL | ALT)          // 录键期间全局路由让路
    const recDone = await evalJs(`(function(){ var it=document.querySelector('[data-key-id="view.terminal"]'); if(!it) return null;
      var kb=it.querySelector('.dside-kbd'); var ls=null; try { ls=JSON.parse(localStorage.getItem('dside.keys.v1')||'{}') } catch(e){}
      return { chip: kb?kb.textContent:null, stored: ls && ls['view.terminal'], tag: (it.textContent||'').indexOf('已改')>=0 } })()`)
    check('P10 录键改绑 view.terminal → Ctrl+Alt+K 并落盘', recClicked && recDone && recDone.chip === 'Ctrl+Alt+K' && recDone.stored === 'Ctrl+Alt+K', JSON.stringify(recDone))
    check('P11 改过的行标出「已改」', !!(recDone && recDone.tag))

    // 关掉设置页 → 新键位立刻生效（真键盘）
    await closeKeysView()
    const keysClosed = await evalJs(`!document.querySelector('.dside-keys')`)
    const stillEditor = await evalJs(`!!(window.monaco && monaco.editor.getEditors()[0] && monaco.editor.getEditors()[0].getModel())`)
    check('P12 关闭快捷键页后回到编辑器，且编辑器没被卸载（未保存内容不丢）', !!keysClosed && !!stillEditor)
    await key('KeyK', 'k', CTRL | ALT)
    const termByNew = await evalJs(`!!document.querySelector('.dside-term')`)
    await key('KeyK', 'k', CTRL | ALT)
    const termByNew2 = await evalJs(`!document.querySelector('.dside-term')`)
    check('P13 新键位 Ctrl+Alt+K 立刻生效（开 / 关终端）', !!termByNew && !!termByNew2, JSON.stringify({ termByNew, termByNew2 }))
    await key('Backquote', '`', CTRL)   // 旧键位应该已经没用了
    const oldGone = await evalJs(`!document.querySelector('.dside-term')`)
    check('P14 旧键位 Ctrl+` 已被解绑（不再开终端）', !!oldGone)

    // ── 冲突检测：把 file.newFile 也设成 Ctrl+Alt+K ────────────────────────
    await openKeysView()
    await clickRowButton('file.newFile', '改')
    await sleep(300)
    await key('KeyK', 'k', CTRL | ALT)
    const conflict = await evalJs(`(function(){ var it=document.querySelector('[data-key-id="file.newFile"]'); var w=it.querySelector('.dside-keys-warn');
      return w? w.textContent : null })()`)
    check('P15 撞车给冲突提示（指出被谁占用）', !!conflict && conflict.indexOf('占用') >= 0, String(conflict))
    await evalJs(`(function(){ var it=document.querySelector('[data-key-id="file.newFile"]'); var bs=it.querySelectorAll('.dside-keys-warn button');
      for (var i=0;i<bs.length;i++){ if ((bs[i].textContent||'').indexOf('仍然设置')>=0){ bs[i].click(); return true } } return false })()`)
    await sleep(400)
    const afterForce = await evalJs(`(function(){ var ls=null; try { ls=JSON.parse(localStorage.getItem('dside.keys.v1')||'{}') } catch(e){}
      var term=document.querySelector('[data-key-id="view.terminal"] .dside-kbd'); var nf=document.querySelector('[data-key-id="file.newFile"] .dside-kbd');
      return { term: ls && ls['view.terminal'], newFile: ls && ls['file.newFile'], termChip: term?term.textContent:null, nfChip: nf?nf.textContent:null } })()`)
    check('P16 「仍然设置」= 对方被解绑（view.terminal 变未绑定）',
      afterForce && afterForce.newFile === 'Ctrl+Alt+K' && afterForce.term === '' && afterForce.nfChip === 'Ctrl+Alt+K',
      JSON.stringify(afterForce))

    // ── 单条重置 + 全部恢复默认 ───────────────────────────────────────────
    await clickRowButton('view.terminal', '重置')
    await sleep(400)
    const afterReset = await evalJs(`(function(){ var ls=null; try { ls=JSON.parse(localStorage.getItem('dside.keys.v1')||'{}') } catch(e){}
      var it=document.querySelector('[data-key-id="view.terminal"] .dside-kbd'); return { term: ls? ls['view.terminal'] : 'no-store', chip: it?it.textContent:null } })()`)
    check('P17 单条「重置」把 Ctrl+` 还回来', afterReset && afterReset.chip === 'Ctrl+`' && afterReset.term === undefined, JSON.stringify(afterReset))

    const resetAll = await evalJs(`(function(){ var bs=document.querySelectorAll('.dside-keys-head button');
      for (var i=0;i<bs.length;i++){ if ((bs[i].textContent||'').indexOf('全部恢复默认')>=0){ bs[i].click(); return true } } return false })()`)
    await sleep(400)
    const afterAll = await evalJs(`(function(){ var ls=null; try { ls=JSON.parse(localStorage.getItem('dside.keys.v1')||'{}') } catch(e){}
      var nf=document.querySelector('[data-key-id="file.newFile"] .dside-kbd'); return { stored: ls, nfChip: nf?nf.textContent:null } })()`)
    check('P18 「全部恢复默认」清空改动', resetAll && afterAll && afterAll.nfChip === 'Ctrl+N' && JSON.stringify(afterAll.stored) === '{}', JSON.stringify(afterAll))

    // ── 编辑器侧键位：把「保存」从 Ctrl+S 改到 Ctrl+Alt+S，验证真的走 monaco ──
    await clickRowButton('file.save', '改')
    await sleep(300)
    await key('KeyS', 's', CTRL | ALT)
    await sleep(300)
    await closeKeysView()
    // 弄脏缓冲区 → 用新键位保存 → 断言脏标记消失（真的存了）
    await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; e.getModel().applyEdits([{range:new monaco.Range(1,1,1,1), text:'X'}]);
      e.focus(); return e.getModel().getValue().slice(0,4) })()`)
    await sleep(900)
    const dirtyBefore = await evalJs(`!!document.querySelector('.dside-dot.dirty')`)
    await key('KeyS', 's', CTRL | ALT)
    await sleep(1600)
    const dirtyAfter = await evalJs(`!!document.querySelector('.dside-dot.dirty')`)
    const disk = readFileSync(WS + '\\src\\a.txt', 'utf8')
    check('P19 编辑器侧键位：Ctrl+Alt+S 保存生效（脏标记消失 + 磁盘真的变了）',
      dirtyBefore === true && dirtyAfter === false && disk.indexOf('Xline one') === 0,
      JSON.stringify({ dirtyBefore, dirtyAfter, diskHead: disk.slice(0, 12) }))

    // 旧键位 Ctrl+S 应该已经无效（默认键位被解绑）
    await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; e.getModel().applyEdits([{range:new monaco.Range(1,1,1,1), text:'Y'}]); e.focus(); return 1 })()`)
    await sleep(800)
    await key('KeyS', 's', CTRL)
    await sleep(1200)
    const dirtyAfterOld = await evalJs(`!!document.querySelector('.dside-dot.dirty')`)
    check('P20 旧的 Ctrl+S 已解绑（不会偷偷保存）', dirtyAfterOld === true, String(dirtyAfterOld))
    // 收尾：恢复默认并保存掉脏内容
    await evalJs(`(function(){ try { localStorage.removeItem('dside.keys.v1') } catch(e){} return 1 })()`)

    // ── 「在文件资源管理器中显示」：键位是新登记的（能力早就有 = 壳桥 anzioShell.revealInFolder +
    //    命令 file.revealInExplorer）。只读注册表**不算验证**（2026-09-21 的"界面写着、实际没实现"就是这么来的）
    //    → 必须在浏览器里装一个壳桥桩，证明按键真的走到了壳桥那条路、且参数是当前文件绝对路径。
    await evalJs(`(function(){ window.__revealCalls = []; window.anzioShell = window.anzioShell || {};
      window.anzioShell.revealInFolder = function (p) { window.__revealCalls.push(String(p || '')); return Promise.resolve({ ok: true }) }; return 1 })()`)
    const revealBind = await evalJs(`(function(){ var k = window.__dsideKeys; if (!k) return null;
      return { main: k.resolved('file.revealInExplorer'), folder: k.resolved('file.openFolder') } })()`)
    check('P21 注册表：Alt+Shift+R =「在文件资源管理器中显示」· Ctrl+K O =「打开文件夹」（VSCode 口径）',
      !!revealBind && revealBind.main === 'Shift+Alt+R' && revealBind.folder === 'Ctrl+K O', JSON.stringify(revealBind))

    await key('KeyR', 'r', ALT | SHIFT)
    const reveal1 = await evalJs(`window.__revealCalls.slice()`)
    check('P22 真键盘 Alt+Shift+R → 调到壳桥，参数 = 当前文件绝对路径',
      !!reveal1 && reveal1.length === 1 && /a\.txt$/i.test(String(reveal1[0])), JSON.stringify(reveal1))

    await key('KeyK', 'k', CTRL)
    await key('KeyR', 'r', CTRL)
    const reveal2 = await evalJs(`window.__revealCalls.slice()`)
    check('P23 和弦 Ctrl+K R（第二步带 Ctrl）同样调到壳桥',
      !!reveal2 && reveal2.length === 2 && /a\.txt$/i.test(String(reveal2[1])), JSON.stringify(reveal2))

    // ── 用户报障场景（2026-09-29）：树里选中**文件夹**后按 Shift+Alt+R ──────────────
    // VSCode 的判据 = 资源管理器列表是焦点所在就用它选中的资源（files.ts:117-152）⇒ 必须定位到那个文件夹，
    // 而不是当前打开的标签（旧实现只读 activePath，于是跑去定位了桌面上的文件 —— 用户报障）。
    // ⚠ 两个坑（第一版就是这么假红的）：
    //   ① 左栏这时还停在「设置」面板（上面在快捷键页里操作过）→ 树根本没挂载、找不到节点 ⇒ 先切回资源管理器；
    //   ② 必须用 **CDP 真鼠标**：JS 合成的 `element.click()` 只派发事件、**不转移 DOM 焦点**
    //      （焦点还留在 monaco ⇒ 判据认为"焦点在编辑器" ⇒ 定位当前标签）。
    if (!(await evalJs(`document.querySelectorAll('.dside-node-name').length > 0`))) {
      await evalJs(`(function(){ var bs=document.querySelectorAll('.dside-activitybar button');
        for (var i=0;i<bs.length;i++){ if ((bs[i].getAttribute('title')||'').indexOf('资源管理器')>=0){ bs[i].click(); return true } } return false })()`)
      await sleep(1200)
    }
    const srcBox = await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-node-name');
      for (var i=0;i<ns.length;i++){ if (ns[i].textContent.trim()==='src'){ var r=(ns[i].closest('.dside-node')||ns[i]).getBoundingClientRect();
        return { x: Math.round(r.left + Math.min(60, (r.width||60)/2)), y: Math.round(r.top + r.height/2) } } } return null })()`)
    if (srcBox) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: srcBox.x, y: srcBox.y, button: 'left', clickCount: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: srcBox.x, y: srcBox.y, button: 'left', clickCount: 1 })
    }
    await sleep(900)
    await key('KeyR', 'r', ALT | SHIFT)
    const reveal3 = await evalJs(`window.__revealCalls.slice()`)
    const focusAfter = await evalJs(`(function(){ var a=document.activeElement; return a? (a.tagName+'.'+String(a.className||'').split(' ')[0]) : null })()`)
    check('P24 树里选中文件夹后按 Alt+Shift+R → 定位到那个文件夹（不是当前标签）',
      !!reveal3 && reveal3.length === 3 && /[\\/]src$/i.test(String(reveal3[2])),
      JSON.stringify({ calls: reveal3, focusAfter, srcBox }))

    // ── 本轮新加的三条键位（2026-09-29）：打开文件 / 另存为 / 新建终端 ─────────────
    // 原始 keydown 记录器：唯一用途是分清「键没到页面」和「到了没匹配」（轨迹日志只记带 Ctrl/Alt 的失败键）
    await evalJs(`(function(){ window.__keyLog = [];
      window.addEventListener('keydown', function(e){ window.__keyLog.push(String(e.code)+'|'+String(e.key)+'|m'+(e.ctrlKey?1:0)+(e.altKey?1:0)+(e.shiftKey?1:0)) }, true); return 1 })()`)
    async function rawKeys() { return await evalJs(`window.__keyLog.slice()`) }
    const tabNamesFn = `(function(){ var o=[]; document.querySelectorAll('.dside-tab-name').forEach(function(n){ o.push(n.textContent.trim()) }); return o })()`
    const countTrace = (needle) => {
      try { return readFileSync(HOME_DIR + '\\logs\\ide-trace.log', 'utf8').split(needle).length - 1 } catch { return 0 }
    }

    const newBinds = await evalJs(`(function(){ var k=window.__dsideKeys; if(!k) return null;
      return { open: k.resolved('file.openFile'), saveAs: k.resolved('file.saveAs'), termNew: k.resolved('term.new') } })()`)
    check('P25 注册表：Ctrl+O = 打开文件 · Ctrl+Shift+S = 另存为 · Ctrl+Shift+` = 新建终端（VSCode 口径）',
      !!newBinds && newBinds.open === 'Ctrl+O' && newBinds.saveAs === 'Ctrl+Shift+S'
        && newBinds.termNew === 'Ctrl+Shift+' + '`', JSON.stringify(newBinds))

    // ⚠⚠ 不要为了"验一下默认键位"去按 Ctrl+Shift+S / Ctrl+Shift+`：headless Chrome 把这些当**浏览器级加速键**
    //   吞掉（同 Ctrl+N 先例），而且**吞完之后渲染进程连着一起丢掉按键焦点 —— 后面所有键都不再送达**
    //   （2026-09-29 实测：那一按之后 Ctrl+Alt+W / Ctrl+Alt+O / Ctrl+Alt+T 全部收不到）。所以真键盘那一环
    //   统一走 P8b 的老办法：在快捷键设置页改绑成浏览器不拦的 Ctrl+Alt+*，验「键位 → 命令 → 壳桥」整条链路；
    //   默认键位是不是 VSCode 口径，由 P25 的注册表断言负责。
    await evalJs(`(function(){ window.anzioShell = window.anzioShell || {};
      window.anzioShell.pickSavePath = function () { return Promise.resolve({ ok: true, path: ${JSON.stringify(WS + '\\saved-as.txt')} }) };
      window.anzioShell.pickFile = function () { return Promise.resolve({ ok: true, path: ${JSON.stringify(WS + '\\hello.txt')} }) };
      window.__keyLog.length = 0; return 1 })()`)
    // ⚠ 这里**不要**再调 Emulation.setFocusEmulationEnabled：真鼠标点过树之后再调它，页面会卡住、
    //   连 Runtime.evaluate 都不回（2026-09-29 实测，CDP timeout）
    await openKeysView()
    await clickRowButton('file.saveAs', '改'); await sleep(250); await key('KeyW', 'w', CTRL | ALT); await sleep(250)
    await clickRowButton('file.openFile', '改'); await sleep(250); await key('KeyO', 'o', CTRL | ALT); await sleep(250)
    await clickRowButton('term.new', '改'); await sleep(250); await key('KeyT', 't', CTRL | ALT); await sleep(250)
    const rebinds = await evalJs(`(function(){ var o={}; ['file.saveAs','file.openFile','term.new'].forEach(function(id){
      var it=document.querySelector('[data-key-id="'+id+'"]'); var kb=it&&it.querySelector('.dside-kbd'); o[id]=kb?kb.textContent:null }); return o })()`)
    await closeKeysView()
    const keysClosed2 = await evalJs(`!document.querySelector('.dside-keys')`)

    // 另存为：正文写到新路径 + 新标签打开 + 原标签关闭（原文件磁盘内容不动）
    await key('KeyW', 'w', CTRL | ALT)
    await sleep(1800)
    const rawW = await rawKeys()
    const tabNames = await evalJs(tabNamesFn)
    let savedDisk = ''
    try { savedDisk = readFileSync(WS + '\\saved-as.txt', 'utf8') } catch { /* 没写成 */ }
    check('P26 另存为：正文写到新路径 + 新标签打开 + 原标签关闭（原文件不动）',
      savedDisk.indexOf('Y') === 0 && Array.isArray(tabNames)
        && tabNames.indexOf('saved-as.txt') >= 0 && tabNames.indexOf('a.txt') < 0,
      JSON.stringify({ head: savedDisk.slice(0, 12), tabNames, rebinds, rawW, keysClosed2 }))

    // 打开文件：壳对话框返回的路径被开成标签
    await key('KeyO', 'o', CTRL | ALT)
    await sleep(1600)
    const tabNames2 = await evalJs(tabNamesFn)
    check('P27 打开文件：壳对话框返回的路径被开成标签',
      Array.isArray(tabNames2) && tabNames2.indexOf('hello.txt') >= 0,
      JSON.stringify({ rebinds, tabNames2 }))

    // 新建终端：单终端模型 → 第二次按键是"已开状态下重建"，终端**不该消失**（若误做成 toggle 就会关掉）
    const tnBefore = countTrace('terminal-new')
    await key('KeyT', 't', CTRL | ALT)
    await sleep(1500)
    const termNew1 = await evalJs(`!!document.querySelector('.dside-term')`)
    await key('KeyT', 't', CTRL | ALT)
    await sleep(1500)
    const termNew2 = await evalJs(`!!document.querySelector('.dside-term')`)
    const tnDelta = countTrace('terminal-new') - tnBefore   // ⚠ 轨迹日志跨轮累积，必须看**增量**，不能看总数
    check('P28 新建终端：打开终端；已开状态下再按是重建而不是收起',
      termNew1 === true && termNew2 === true && tnDelta >= 2,
      JSON.stringify({ termNew1, termNew2, tnDelta, rebinds }))

    // 终端头部：**标签栏之外**只该剩「关闭终端」一颗按钮（2026-09-30：自造的「重新适配尺寸」点了没效果，已删；
    // VSCode 那颗 order:1 是"最大化面板"，天工没这个能力 —— 用**数量 + title**判，不靠肉眼）。
    // ⚠ 2026-10-08 起头部还有**面板内标签栏**（终端 | ⌨ 键盘，第三期），标签本身也是 button ⇒
    //   判据必须限定在标签栏之外，否则每次加标签都会误报"多出一颗按钮"。
    const termHead = await evalJs(`(function(){ var h=document.querySelector('.dside-term-head'); if(!h) return null;
      var bs=h.querySelectorAll(':scope > button');
      var tabs=h.querySelectorAll('.dside-term-tab');
      return { n: bs.length, titles: Array.prototype.map.call(bs, function(b){ return String(b.getAttribute('title')||'') }),
               tabs: tabs.length, tabText: Array.prototype.map.call(tabs, function(t){ return String(t.textContent||'') }) } })()`)
    check('P28b 终端头部：标签栏之外只剩「关闭终端」一颗按钮',
      !!termHead && termHead.n === 1 && String(termHead.titles.join('|')).indexOf('关闭终端') >= 0, JSON.stringify(termHead))
    check('P28c 终端头部有面板内标签栏（终端 | ⌨ 键盘）',
      !!termHead && termHead.tabs === 2 && String(termHead.tabText.join('|')).indexOf('键盘') >= 0, JSON.stringify(termHead))

    // ── Shift+Delete = 删除行（2026-09-30 用户要求）────────────────────────────────
    // ⚠ 判据的关键：**"删除行"和"剪切"在界面上长得一模一样**（那行都消失）→ 只能看剪贴板。
    //   而且必须先做**反向对照**：Ctrl+X 要真的写进剪贴板，否则"剪贴板没变"也可能只是剪贴板这条路不通。
    //   （VSCode 里 Shift+Delete 是"剪切"的次级键，clipboard.ts:49；我们故意与它不同。）
    await cdp('Browser.grantPermissions', { origin: APP, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })
    const ebox = await evalJs(`(function(){ var e=document.querySelector('.dside-editor-monaco'); if(!e) return null;
      var r=e.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+30) } })()`)
    if (ebox) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: ebox.x, y: ebox.y, button: 'left', clickCount: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ebox.x, y: ebox.y, button: 'left', clickCount: 1 })
      await sleep(400)
    }
    const prevText = await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; return e&&e.getModel()?e.getModel().getValue():null })()`)
    await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; e.getModel().setValue('l1\\nl2\\nl3\\n'); e.focus(); return 1 })()`)
    await sleep(300)
    // 反向对照：选中 'l1' → Ctrl+X → 剪贴板必须变成 l1
    await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; e.setSelection(new monaco.Selection(1,1,1,3)); e.focus(); return 1 })()`)
    await sleep(200)
    await key('KeyX', 'x', CTRL)
    await sleep(700)
    const clipAfterCut = await evalJs(`navigator.clipboard.readText()`)
    // 目标：光标停在第 2 行（无选区）→ Shift+Delete
    await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; e.setPosition({ lineNumber: 2, column: 2 }); e.focus(); return 1 })()`)
    await sleep(200)
    // 诊断：把"动作本身能不能干活"与"键有没有到达动作"分开（两者混淆过一次，别再猜）
    const diag = await evalJs(`(function(){ var e=monaco.editor.getEditors()[0];
      var a = e.getAction('editor.action.deleteLines');
      var k = window.__dsideKeys;
      return { hasBuiltin: !!a, reg: k ? k.resolved('editor.deleteLines') : null } })()`)
    // P32a：直接调 monaco 的内建动作 → 必须能删行（否则是"动作本身有问题"，与键位无关）
    await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; e.getModel().setValue('x1\\nx2\\nx3\\n');
      e.setPosition({ lineNumber: 2, column: 1 }); e.focus(); return 1 })()`)
    await sleep(250)
    await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; var a=e.getAction('editor.action.deleteLines'); if (a) a.run(); return 1 })()`)
    await sleep(500)
    const textByAction = await evalJs(`monaco.editor.getEditors()[0].getModel().getValue()`)
    check('P32a monaco 内建「删除行」动作用得了（直接 run 时删掉光标所在行）',
      textByAction === 'x1\nx3\n', JSON.stringify({ textByAction, diag }))

    // P32b：真键盘 Shift+Delete → 行消失且**剪贴板不变**（= 走的是我们的命令，不是原生剪切）
    // ⚠ 正文可能被应用自己（fsRev 刷新 / 冲突检测）重置 → 按下前后各读一次，用**前后对比**判，别假设起始值
    const before = await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; e.getModel().setValue('l1\\nl2\\nl3\\n');
      e.setPosition({ lineNumber: 2, column: 2 }); e.focus(); return e.getModel().getValue() })()`)
    await sleep(250)
    await key('Delete', 'Delete', SHIFT)
    await sleep(700)
    const textAfterDel = await evalJs(`monaco.editor.getEditors()[0].getModel().getValue()`)
    const clipAfterDel = await evalJs(`navigator.clipboard.readText()`)
    check('P32b Shift+Delete = 删除行（行消失且**不进剪贴板**；反向对照 Ctrl+X 确实写了剪贴板）',
      before === 'l1\nl2\nl3\n' && textAfterDel === 'l1\nl3\n' && clipAfterCut === 'l1' && clipAfterDel === 'l1',
      JSON.stringify({ before, textAfterDel, clipAfterCut, clipAfterDel, diag }))
    // 收尾：正文恢复原样（别留脏内容给下一轮 —— 2026-09-24 hot exit 假红的教训）
    if (typeof prevText === 'string') {
      await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; e.getModel().setValue(${JSON.stringify(prevText)}); return 1 })()`)
    }

    const stat = await evalJs(`window.__dshTraceStat || null`)
    check('P29 快捷键埋点有上报（kind=shortcut）',
      await (async () => {
        await sleep(1500)
        try {
          const log = readFileSync(HOME_DIR + '\\logs\\ide-trace.log', 'utf8')
          return log.indexOf('"shortcut"') >= 0 && log.indexOf('"keybinding-set"') >= 0
        } catch { return false }
      })(), JSON.stringify(stat))
    check('P30 零未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
    check('P31 全程没有意外的原生确认框', jsDialogs.length === 0, jsDialogs.join(' | '))
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
    console.log('\n===== 键位系统 E2E: ' + pass + '/' + results.length + ' =====')
    const failed = results.filter((r) => !r.ok)
    if (failed.length) console.log('FAILED: ' + failed.map((r) => r.name).join(' | '))
  }
}
main()
