import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// DSH IDE ⑥ E2E（CDP 真浏览器）：编辑器 → Agent 上下文注入（Ctrl+I / 右键入口）
// 用法: node tools/e2e6.mjs   （前置：3081 后端已起）
// 自清：fixture _e2e6_demo.ts 建于 dshworkspace2 根，结束即删；不动其它文件（踩坑 21）。
import { spawn } from 'node:child_process'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = `${__TIANGONG_ROOT}\\dshworkspace2`
const FIX = join(ROOT, '_e2e6_demo.ts')
const CDP_PORT = 9300 + Math.floor(Math.random() * 400)
const APP = 'http://127.0.0.1:3081'
const H = 'http://127.0.0.1:' + CDP_PORT
// 应用后端对 shell 页面要 token（dsh web 启动输出里的那串）；插件自己的 /dsh-ide 路由不要。
// 注意：带 token 的首次访问会被认证流程重定向回 "/"，查询串被吃掉 —— 所以先认证，
// 再带 ?file= 二次导航（此时 cookie 已种下，参数能活下来）。
const TOKEN = process.env.DSH_E2E_TOKEN || ''
const AUTH_URL = APP + '/' + (TOKEN ? '?token=' + TOKEN : '')
const FILE_URL = APP + '/?file=' + encodeURIComponent(FIX)

// ── fixture ────────────────────────────────────────────────────
if (existsSync(FIX)) rmSync(FIX)
writeFileSync(FIX, [
  '// e2e6 fixture: 编辑器 -> Agent 上下文注入',
  'const greeting: string = "hello world"',
  'const count: number = "not a number"',
  'function add(a: number, b: number) { return a + b }',
  'console.log(add(1, 2))',
  '',
].join('\n'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' :: ' + String(detail ?? '')}`)
}

// ── 浏览器 / CDP（骨架同 e2e4.mjs）──────────────────────────────
function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]
  for (const c of cands) if (existsSync(c)) return c
  throw new Error('no edge/chrome found')
}
const userDir = join(`${__TIANGONG_ROOT}`, '.edge6-tmp-' + process.pid)
rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
const proc = spawn(findBrowser(), [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDir}`,
  AUTH_URL,
], { stdio: 'ignore' })

let target = null
for (let i = 0; i < 40 && !target; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try {
    const list = await (await fetch(`${H}/json/list`)).json()
    target = (list || []).find((t) => t.type === 'page')
  } catch { /* not up yet */ }
}
if (!target) { console.log('CDP target not found'); proc.kill(); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect error')) })
let msgId = 0
const pending = new Map()
let wsDead = false
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
ws.onclose = () => { wsDead = true; for (const [, fn] of pending) fn({ error: { message: 'ws closed' } }); pending.clear() }
ws.onerror = () => { wsDead = true; for (const [, fn] of pending) fn({ error: { message: 'ws error' } }); pending.clear() }

function cdp(method, params, timeoutMs) {
  if (wsDead) return Promise.reject(new Error('CDP ws dead'))
  return new Promise((resolve, reject) => {
    const id = ++msgId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, timeoutMs || 12000)
    pending.set(id, (m) => { clearTimeout(timer); resolve(m.result || { error: m.error }) })
    try { ws.send(JSON.stringify({ id, method, params: params || {} })) } catch (e) { clearTimeout(timer); reject(e) }
  })
}
async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval threw' }
  return r.result && r.result.value
}
async function waitFor(expr, ms, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await evalJs(expr)
    if (v && !v.__err) return v
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 键入：真实 CDP 键盘（Enter/Escape 非浏览器加速键，安全）
async function pressKey(key, code, vk) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
async function insertText(text) {
  await cdp('Input.insertText', { text })
}
// 真实逐字键入（React 受控输入需要真实 input 事件；insertText 在 headless 下不一定进得去）
async function typeText(text) {
  for (const ch of text) {
    await cdp('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch, key: ch })
  }
}
const VALUE_OF_INPUT = `(function(){ var i=document.querySelector('.dside-ask-input'); return i? i.value : null; })()`

const ED = `window.monaco && window.monaco.editor.getEditors()[0]`
const ASK_OPEN = `(function(){ var c=document.querySelector('.dside-ask'); if(!c) return null;
  return { ctx: (document.querySelector('.dside-ask-ctx')||{}).textContent||'', focused: document.activeElement && String(document.activeElement.className).indexOf('dside-ask-input')>=0 }; })()`

// ── 探针 ───────────────────────────────────────────────────────
try {
  // P0 认证后带 file 深链二次导航（token 已在 cookie 里）
  const booted = await waitFor(`!!(window.monaco && window.monaco.editor)`, 45000, 'shell boot')
  check('P0 应用外壳启动（monaco 全局就绪）', !!booted, 'timeout')
  await cdp('Page.navigate', { url: FILE_URL })
  await sleep(1200)

  // P1 编辑器就绪 + 深链文件已打开
  const ready = await waitFor(
    `(function(){ var ed=${ED}; if(!ed) return null; var m=ed.getModel(); if(!m) return null;
       return m.uri && String(m.uri.path).indexOf('_e2e6_demo.ts')>=0 ? ed.getModel().getLineCount() : null; })()`,
    40000, 'editor+file')
  check('P1 编辑器就绪且深链文件已挂载', !!ready, 'timeout')
  if (!ready) throw new Error('editor not ready')

  // P2 Ctrl+I 动作已注册（monaco 原生 action）
  const act = await evalJs(`(function(){ var ed=${ED}; var a=ed.getAction('dside.askAgent');
    return a ? { label: a.label, kb: (a.keybindings||[]).length } : null; })()`)
  check('P2 dside.askAgent 动作已注册', act && act.label, JSON.stringify(act))

  // P3 空选区时也能打开（上下文=当前文件）
  await evalJs(`(function(){ var ed=${ED}; ed.setSelection(new window.monaco.Selection(1,1,1,1)); ed.trigger('e2e','dside.askAgent',null); return 1; })()`)
  const s1 = await waitFor(ASK_OPEN, 4000, 'ask bar (no selection)')
  check('P3 无选中也能打开输入条（当前文件上下文）', !!(s1 && s1.focused), JSON.stringify(s1))
  await evalJs(`document.dispatchEvent(new KeyboardEvent('x'))`)

  // P4 空输入按 Enter：条内提示、不发送（断言查输入条内的 hint，不查会被 5s 轮询覆盖的状态栏）
  await pressKey('Enter', 'Enter', 13)
  await sleep(250)
  const hint = await evalJs(`(function(){ var e=document.querySelector('.dside-ask-hint'); return e? e.textContent : ''; })()`)
  const stillOpen = await evalJs(`!!document.querySelector('.dside-ask')`)
  check('P4 空输入 Enter → 条内提示且不发送', String(hint).indexOf('写下要让 Agent 做什么') >= 0 && stillOpen, JSON.stringify(hint))

  // P5 Esc 关闭
  await pressKey('Escape', 'Escape', 27)
  await sleep(300)
  check('P5 Esc 关闭输入条', !(await evalJs(`!!document.querySelector('.dside-ask')`)))

  // P6 选中两行 → 打开 → 上下文摘要正确
  await evalJs(`(function(){ var ed=${ED}; ed.setSelection(new window.monaco.Selection(2,1,3,40)); ed.trigger('e2e','dside.askAgent',null); return 1; })()`)
  const s2 = await waitFor(ASK_OPEN, 4000, 'ask bar (selection)')
  const ctxText = s2 ? s2.ctx : ''
  check('P6 上下文摘要显示文件与选中行数',
    ctxText.indexOf('_e2e6_demo.ts') >= 0 && ctxText.indexOf('选中 2 行') >= 0, ctxText)

  // P7 输入文字进 React 状态（真实键入；失败则退一步用 insertText）
  await typeText('只回复 OK')
  await sleep(350)
  let typed = await evalJs(VALUE_OF_INPUT)
  if (typed !== '只回复 OK') {
    await insertText('只回复 OK')
    await sleep(350)
    typed = await evalJs(VALUE_OF_INPUT)
  }
  check('P7 输入条接得住键盘输入', typed === '只回复 OK', String(typed))

  // P8 诊断（TS worker，headless 可能慢 → 只记录不硬失败，见踩坑 24）
  const diag = await waitFor(
    `(function(){ var ed=${ED}; var n=window.monaco.editor.getModelMarkers({resource:ed.getModel().uri}).filter(function(m){return m.severity===8;}).length; return n>0? n : null; })()`,
    20000, 'markers')
  const ctxDiag = await evalJs(`(function(){ var e=document.querySelector('.dside-ask-diag'); return e? e.textContent : ''; })()`)
  check('P8 TS 诊断可见（红线/计数）', !!diag, 'worker 未在 20s 内产出 marker（headless 已知慢）')
  console.log('     └ ask 条诊断计数: ' + JSON.stringify(ctxDiag) + ' / marker 数: ' + JSON.stringify(diag))

  // P9 Enter 发送：状态栏确认 + Agent 面板出现带上下文的用户消息
  await pressKey('Enter', 'Enter', 13)
  await sleep(1500)
  const after = await evalJs(`(function(){
    var s=document.querySelector('.dside-statusbar');
    var msgs=Array.prototype.slice.call(document.querySelectorAll('.dside-msg')).map(function(e){return e.className+'|'+e.textContent.slice(0,40);});
    return { status: s? s.textContent : '', msgs: msgs.slice(-4), askOpen: !!document.querySelector('.dside-ask') }; })()`)
  const sent = String(after.status).indexOf('已发给 Agent') >= 0
  const noSession = String(after.status).indexOf('还没有会话') >= 0
  check('P9 Enter 发送链路走通（有会话）', sent || noSession, JSON.stringify(after.status))
  check('P9b 发送后输入条自动关闭', !after.askOpen, JSON.stringify(after.askOpen))
  if (sent) {
    const injected = await waitFor(
      `(function(){ var t=Array.prototype.map.call(document.querySelectorAll('.dside-msg.user'),function(e){return e.textContent;}).join('\\n'); return t.indexOf('【编辑器上下文】')>=0 ? t.slice(t.indexOf('【编辑器上下文】'), t.indexOf('【编辑器上下文】')+220) : null; })()`,
      8000, 'injected message')
    check('P9c Agent 会话里出现编辑器上下文消息', !!injected, '未在会话流中找到注入文本')
    if (injected) console.log('     └ 注入消息片段: ' + JSON.stringify(injected))
  } else {
    console.log('     └ 无活动会话，发送链路只验到边界（状态栏已提示）')
  }
} catch (e) {
  check('E2E 异常', false, String((e && e.message) || e))
} finally {
  const pass = results.filter((r) => r.ok).length
  console.log(`\n== ${pass}/${results.length} 通过 ==`)
  try { ws.close() } catch { /* ignore */ }
  proc.kill()
  await sleep(400)
  rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
  if (existsSync(FIX)) rmSync(FIX)
}
process.exit(results.every((r) => r.ok) ? 0 : 2)
