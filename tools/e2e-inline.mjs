import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// ⑭-② 内联建议（ghost text）E2E —— 真浏览器 + 真模型调用（一次 ~160 token）
// 用法: node tools\e2e-inline.mjs
// 验的是：显式触发（Alt+\ / 命令面板 / 编辑器动作）→ host 用应用配置的模型做一次性调用 →
//   ghost text 出现 → Tab 接受后**模型内容真的变了**（端到端，不只看接口返回）。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.DSH_E2E_PORT || 3082)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = `${__TIANGONG_ROOT}\\app-home`
const CLI = `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js`
const BLOG = `${__TIANGONG_ROOT}\\_e2e_inline_backend_` + PORT + '.log'
const TRACE = join(HOME_DIR, 'logs', 'ide-trace.log')
const FIX = '_e2e_inline'
const CDP_PORT = 9960 + Math.floor(Math.random() * 35)

const DEMO = `export function sum(a: number, b: number) {
  return a + b
}

const total = sum(1, 2)
// 下面这个函数把数组里的数字全部加起来
export function sumAll(nums: number[]) {
  
}
`

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

const MODEL_TEXT = `(function(){ var ms=window.monaco.editor.getModels();
  for (var i=0;i<ms.length;i++){ if (String(ms[i].uri.path).indexOf('demo.ts')>=0) return ms[i].getValue() } return null })()`
// 把光标放到 sumAll 函数体里（第 8 行，缩进之后）
const PLACE_CURSOR = `(function(){ var e=window.monaco.editor.getEditors()[0]; if(!e) return 'no-editor';
  e.setPosition({lineNumber:8, column:3}); e.focus(); return 'ok' })()`
const GHOST = `(function(){ var els=document.querySelectorAll('.monaco-editor [class*="ghost"], .monaco-editor .inline-suggest');
  return els.length ? els.length : 0 })()`
const TRIGGER = `(async function(){ var e=window.monaco.editor.getEditors()[0]; if(!e) return 'no-editor';
  var a=e.getAction('dside.inlineSuggest'); if(!a) return 'no-action'; await a.run(); return 'triggered' })()`

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
    if (backendExit !== null) throw new Error('backend exited early (' + backendExit + ')')
    let txt = ''
    try { txt = readFileSync(BLOG, 'utf8') } catch { /* not yet */ }
    const m = txt.match(/\?token=([A-Za-z0-9._-]+)/)
    if (m) { token = m[1]; break }
  }
  if (!token) throw new Error('no token')

  const ROOT = (await (await fetch(APP + '/dsh-ide/init')).json()).root
  globalThis.__ROOT = ROOT
  const dir = join(ROOT, FIX)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'demo.ts'), DEMO)

  const userDir = join(`${__TIANGONG_ROOT}`, '.edge-inline-tmp-' + process.pid)
  rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
  const browser = spawn(findBrowser(), [
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
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, timeoutMs || 30000)
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
      last = v
      if (v && !v.__err) return v
      await sleep(400)
    }
    return last
  }
  const traceFrom = Date.now() - 1000
  async function traceHas(msg, waitMs) {
    const t = Date.now()
    while (Date.now() - t < waitMs) {
      let txt = ''
      try { txt = readFileSync(TRACE, 'utf8') } catch { /* ignore */ }
      const lines = txt.split('\n')
      for (let i = lines.length - 1; i >= 0 && i > lines.length - 300; i--) {
        if (!lines[i] || lines[i].indexOf(msg) < 0) continue
        try { const o = JSON.parse(lines[i]); if (Date.parse(o.ts) >= traceFrom) return o } catch { /* ignore */ }
      }
      await sleep(700)
    }
    return null
  }

  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco && !!window.monaco.editor`, 90000)
  check('P1 页面挂载完成', !!ready, await evalJs('document.readyState'))

  // ── P2 直接用接口试一次（先把"模型通路"和"UI"分开验）────────────
  const api = await evalJs(`(async function(){
    var r = await (await fetch('/dsh-ide/inline-suggest', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ path:'demo.ts', language:'typescript',
        prefix:'export function sumAll(nums: number[]) {\\n  ',
        suffix:'\\n}' }) })).json();
    return JSON.stringify({ ok: r.ok, err: r.error || null, detail: r.detail || null, model: r.model || null, chars: (r.text||'').length, head: String(r.text||'').slice(0,60) }) })()`)
  const apiObj = (() => { try { return JSON.parse(api) } catch { return {} } })()
  check('P2 host 能完成一次性模型调用（/inline-suggest 返回文本）',
    apiObj.ok === true && apiObj.chars > 0, String(api))

  // ── 打开 fixture 文件并触发 UI 路径 ─────────────────────────────
  await cdp('Page.navigate', { url: APP + '/?file=' + encodeURIComponent(join(dir, 'demo.ts')) })
  const opened = await waitFor(`(function(){ var ts=document.querySelectorAll('.dside-tab-name');
    for (var i=0;i<ts.length;i++){ if(ts[i].textContent==='demo.ts') return true } return false })()`, 60000)
  check('P3 fixture 文件已在编辑器打开', opened === true)

  const hasAction = await evalJs(`(function(){ var e=window.monaco.editor.getEditors()[0];
    return e && e.getAction('dside.inlineSuggest') ? true : false })()`)
  check('P4 编辑器注册了 dside.inlineSuggest（Alt+\\ + 右键）', hasAction === true, String(hasAction))

  await evalJs(PLACE_CURSOR)
  await sleep(300)
  const before = await evalJs(MODEL_TEXT)
  const triggered = await evalJs(TRIGGER)
  check('P5 触发内联建议动作', triggered === 'triggered', String(triggered))

  const ghost = await waitFor(`(function(){ var n=${GHOST}; return n > 0 ? n : null })()`, 30000)
  const okTrace = await traceHas('inline-suggest-ok', 12000)
  check('P6 出现 ghost text（monaco 内联建议 DOM）', ghost !== null, `ghostEls=${ghost} trace=${okTrace ? JSON.stringify(okTrace.meta) : 'none'}`)
  check('P7 客户端埋点 inline-suggest-ok（含耗时与字符数）', !!okTrace, String(okTrace && JSON.stringify(okTrace.meta)))

  // ── P8 Tab 接受 → 模型内容真的变了（端到端）────────────────────
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  await sleep(1200)
  const after = await evalJs(MODEL_TEXT)
  check('P8 Tab 接受后编辑器内容真的变了（端到端）',
    typeof after === 'string' && typeof before === 'string' && after.length > before.length,
    `beforeLen=${before && before.length} afterLen=${after && after.length}`)

  check('P9 页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))

  const pass = results.filter((x) => x.ok).length
  console.log(`\n[e2e-inline] ${pass}/${results.length} passed`)
  return { ok: pass === results.length, browser, backend }
}

let handles = null
try {
  handles = await main()
} catch (e) {
  console.log('[e2e-inline] ABORT: ' + (e && e.stack ? e.stack : e))
} finally {
  try { if (handles && handles.browser) killTree(handles.browser.pid) } catch { /* ignore */ }
  try { if (handles && handles.backend) killTree(handles.backend.pid) } catch { /* ignore */ }
  await sleep(1500)
  try { rmSync(join(`${__TIANGONG_ROOT}`, '.edge-inline-tmp-' + process.pid), { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(join(globalThis.__ROOT || `${__TIANGONG_ROOT}\\dshworkspace2`, FIX), { recursive: true, force: true }) } catch { /* ignore */ }
  console.log('[e2e-inline] cleanup done')
}
process.exit(handles && handles.ok ? 0 : 1)
