// probe-keys.mjs — 键位诊断探针：用 **CDP 真键盘事件**（Input.dispatchKeyEvent）打真机路径，
// 而不是页内合成 KeyboardEvent（合成事件绕不过 Electron 壳的 before-input-event，也绕不过浏览器原生行为，
// 所以老套件里"Ctrl+` 打开终端"这类断言是假绿 —— 见 00devCore §6 24）。
//
// 用法: node D:\99DSH\tools\probe-keys.mjs
//   自起隔离测试后端（DSH_HOME=D:\99DSH\.smoke-home）+ 无头 Edge。
//   输出每个键的：页面收到的 key/code、是否被应用消费（defaultPrevented）、以及可观察效果。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, openSync, closeSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const PORT = Number(process.env.DSH_E2E_PORT || 3082)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = process.env.DSH_E2E_HOME || 'D:\\99DSH\\.smoke-home'
const WS = process.env.DSH_E2E_WS || 'D:\\99DSH\\.smoke-ws-keys'
const CLI = 'D:\\99DSH\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js'
const BLOG = 'D:\\99DSH\\_probe_keys_backend_' + PORT + '.log'
const CDP_PORT = 9800 + Math.floor(Math.random() * 90)
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

// 页内记录器：记下窗口 capture 阶段看到的原始按键（在应用自己的监听器之后注册，
// 所以 defaultPrevented=true 说明应用消费了它）
const RECORDER = `(function(){
  if (!window.__kprobe) {
    window.__kprobe = [];
    window.addEventListener('keydown', function(e){
      window.__kprobe.push({ key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey,
        prevented: e.defaultPrevented, composing: e.isComposing, repeat: e.repeat,
        target: (e.target && (e.target.className || e.target.tagName)) ? String(e.target.className || e.target.tagName).slice(0,40) : '' });
    }, true);
    window.__kprobeClear = function(){ window.__kprobe.length = 0 };
  }
  return true })()`

const STATE = `(function(){
  var ed = window.monaco && monaco.editor.getEditors ? monaco.editor.getEditors()[0] : null;
  var sel = ed && ed.getSelection ? ed.getSelection() : null;
  var model = ed && ed.getModel ? ed.getModel() : null;
  var term = document.querySelector('.dside-term');
  var st = document.querySelector('.dside-statusbar');
  var domSel = String(window.getSelection ? window.getSelection().toString() : '');
  return {
    hasEditor: !!ed,
    editorSelLen: (sel && model) ? model.getValueInRange(sel).length : -1,
    editorSelText: (sel && model) ? model.getValueInRange(sel).slice(0, 30) : '',
    domSelLen: domSel.length,
    hasTerm: !!term,
    statusbar: st ? st.textContent.slice(0, 60) : '',
    activity: window.__dsideActivity || '',
  } })()`

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
  const userDir = 'D:\\99DSH\\.edge-keys-tmp-' + process.pid
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

    mkdirSync(WS, { recursive: true })
    if (!existsSync(WS + '\\src\\a.txt')) { mkdirSync(WS + '\\src', { recursive: true }); writeFileSync(WS + '\\src\\a.txt', 'line one\nline two\nline three\n') }

    rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
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
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
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
      while (Date.now() - t < ms) { const v = await evalJs(expr); if (v) return v; await sleep(250) }
      return null
    }

    await cdp('Runtime.enable')
    await cdp('Page.enable')
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 90000)
    // 专用安静工作区（客户端会按会话 cwd 覆盖 active-root，见 §6 69）
    let rootOk = false
    for (let i = 0; i < 12 && !rootOk; i++) {
      await fetch(APP + '/dsh-ide/active-root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: WS }) })
      await sleep(700)
      rootOk = await evalJs(`(function(){ var n=document.querySelectorAll('.dside-node-name'); for (var i=0;i<n.length;i++) if (n[i].textContent==='src') return true; return false })()`)
    }
    console.log('workspace in tree:', rootOk)

    // 真键盘派发
    const VK = { KeyA: 65, KeyB: 66, KeyN: 78, KeyP: 80, KeyS: 83, KeyW: 87, Backquote: 192, KeyF: 70, KeyZ: 90, KeyC: 67 }
    async function key(code, keyChar, mods) {
      const base = { modifiers: mods || 0, code, key: keyChar, windowsVirtualKeyCode: VK[code] || 0, nativeVirtualKeyCode: VK[code] || 0 }
      await cdp('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base))
      await cdp('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base))
      await sleep(400)
    }
    async function press(label, code, keyChar, mods) {
      await evalJs(`window.__kprobeClear && window.__kprobeClear()`)
      const before = await evalJs(STATE)
      await key(code, keyChar, mods)
      const after = await evalJs(STATE)
      const seen = await evalJs('window.__kprobe ? window.__kprobe.slice(-2) : null')
      console.log('\n=== ' + label + ' ===')
      console.log('  page saw   :', JSON.stringify(seen))
      console.log('  before     : hasTerm=' + before.hasTerm + ' selLen=' + before.editorSelLen + ' domSel=' + before.domSelLen)
      console.log('  after      : hasTerm=' + after.hasTerm + ' selLen=' + after.editorSelLen + ' domSel=' + after.domSelLen)
    }

    await evalJs(RECORDER)
    // 打开文件 → 焦点进编辑器
    await evalJs(`(function(){ var n=document.querySelectorAll('.dside-node'); for (var i=0;i<n.length;i++){ if (/a\\.txt/.test(n[i].textContent)) { n[i].click(); return true } } return false })()`)
    await sleep(1500)
    // 展开 src 再点
    const opened = await evalJs(`(function(){ var n=document.querySelectorAll('.dside-node'); for (var i=0;i<n.length;i++){ var t=n[i].textContent||''; if (t.indexOf('src')===0||t==='src') { n[i].click(); } } return 1 })()`)
    await sleep(1200)
    await evalJs(`(function(){ var n=document.querySelectorAll('.dside-node'); for (var i=0;i<n.length;i++){ if ((n[i].textContent||'').indexOf('a.txt')>=0) { n[i].click(); return true } } return false })()`)
    await sleep(1800)
    const st0 = await evalJs(STATE)
    console.log('editor open:', JSON.stringify(st0))
    // 让编辑器拿到焦点（点编辑器中间）
    const box = await evalJs(`(function(){ var e=document.querySelector('.dside-editor-monaco'); if(!e) return null; var r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+40)} })()`)
    if (box) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await sleep(500)
    }
    console.log('focus after click:', await evalJs(`(function(){ var a=document.activeElement; return a? (a.className||a.tagName)+'' : 'none' })()`))

    await press('Ctrl+A（编辑器内全选）', 'KeyA', 'a', 2)
    await press('Ctrl+B（对照组：显隐左栏）', 'KeyB', 'b', 2)
    await press('Ctrl+`（呼出终端）', 'Backquote', '`', 2)
    await press('Ctrl+`（再按一次，应关闭）', 'Backquote', '`', 2)
    await press('Ctrl+N（新建文件：预期未实现）', 'KeyN', 'n', 2)

    console.log('\nfinal state:', JSON.stringify(await evalJs(STATE)))
  } catch (e) {
    console.log('PROBE ERROR: ' + (e && e.stack ? e.stack : e))
  } finally {
    if (browser) killTree(browser.pid)
    killTree(backend.pid)
    await sleep(600)
    rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
    try { rmSync(BLOG, { force: true }) } catch { /* ignore */ }
  }
}
main()
