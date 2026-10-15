// DSH IDE ⑥ 第一刀 E2E（CDP 真浏览器）：外部改动侦测 → 差异审阅 → 接受/回滚
// 用法: node tools/e2e6b.mjs   （前置：3081 后端已起，DSH_E2E_TOKEN 由调用方给）
// 自清：fixture _e2e6b_demo.ts 建于 dshworkspace2 根，结束即删；不动其它文件（踩坑 21）。
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:\\99DSH\\dshworkspace2'
const FIX = join(ROOT, '_e2e6b_demo.ts')
const TRACE = 'D:\\99DSH\\app-home\\logs\\ide-trace.log'
const CDP_PORT = 9700 + Math.floor(Math.random() * 400)
const APP = 'http://127.0.0.1:3081'
const H = 'http://127.0.0.1:' + CDP_PORT
const TOKEN = process.env.DSH_E2E_TOKEN || ''
const AUTH_URL = APP + '/' + (TOKEN ? '?token=' + TOKEN : '')
const FILE_URL = APP + '/?file=' + encodeURIComponent(FIX)

// fixture 内容：用互不相同的标记，断言才好写（踩坑 21：不要依赖常数）
const T0 = '// e2e6b fixture\nconst a: number = 1\n'
const T1 = '// ext change v1\nconst a: number = 1\nconst b: number = 2\n'
const T2 = '// agent change v2\nconst a: number = 1\nconst b: number = 2\nconst c: number = 3\n'
const T3 = '// agent change v3\nconst d: number = 4\n'
const LOCAL = T1 + '\n// my local edit\n'

if (existsSync(FIX)) rmSync(FIX)
writeFileSync(FIX, T0)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' :: ' + String(detail ?? '')}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const disk = () => { try { return readFileSync(FIX, 'utf8') } catch { return null } }

// ── 浏览器 / CDP（骨架同 e2e6.mjs）──────────────────────────────
function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]
  for (const c of cands) if (existsSync(c)) return c
  throw new Error('no edge/chrome found')
}
const userDir = join('D:\\99DSH', '.edge6b-tmp-' + process.pid)
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
  await sleep(500)
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
let consoleErrors = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    consoleErrors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 300))
  }
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
async function waitFor(expr, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await evalJs(expr)
    if (v && !v.__err) return v
    await sleep(250)
  }
  return null
}

// ── 页内取数/操作（都按 URI 过滤，避免误中 diff 编辑器的 inmemory 模型）──
const NAME = '_e2e6b_demo.ts'
const MODEL_TEXT = `(function(){ var ms = window.monaco.editor.getModels();
  for (var i=0;i<ms.length;i++){ if (String(ms[i].uri.path).indexOf(${JSON.stringify(NAME)})>=0) return ms[i].getValue(); } return null; })()`
const SET_MODEL_TEXT = (t) => `(function(){ var ms = window.monaco.editor.getModels();
  for (var i=0;i<ms.length;i++){ if (String(ms[i].uri.path).indexOf(${JSON.stringify(NAME)})>=0) { ms[i].setValue(${JSON.stringify(t)}); return true; } } return false; })()`
const BAR = `(function(){ var b=document.querySelector('.dside-extbar'); return b ? { cls: String(b.className), text: b.textContent } : null; })()`
const DIFF = `(function(){ var d=document.querySelector('.dside-diff'); if(!d) return null;
  var de = (window.monaco.editor.getDiffEditors ? window.monaco.editor.getDiffEditors() : []);
  var m = de.length ? de[0].getModel() : null;
  return { head: (document.querySelector('.dside-diff-head')||{}).textContent||'',
    dom: !!document.querySelector('.dside-diff-monaco .monaco-diff-editor'),
    diffEditors: de.length,
    original: m ? m.original.getValue() : null, modified: m ? m.modified.getValue() : null }; })()`
const DIRTY = `document.querySelectorAll('.dside-dot.dirty').length`
const STATUS = `(function(){ var s=document.querySelector('.dside-statusbar'); return s? s.textContent : ''; })()`
const CLICK = (sel, text) => `(function(){ var els=document.querySelectorAll(${JSON.stringify(sel)});
  for (var i=0;i<els.length;i++){ if (String(els[i].textContent).indexOf(${JSON.stringify(text)})>=0) { els[i].click(); return true; } } return false; })()`

// ── 探针 ───────────────────────────────────────────────────────
try {
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})

  const booted = await waitFor(`!!(window.monaco && window.monaco.editor)`, 60000)
  check('P0 应用外壳启动（monaco 全局就绪）', !!booted, 'timeout')
  if (!booted) throw new Error('shell not booted')
  await cdp('Page.navigate', { url: FILE_URL })
  await sleep(1500)

  // P1 深链文件挂载 + 轮询前提（页面可见）
  const ready = await waitFor(`(function(){ var t=${MODEL_TEXT}; return t === null ? null : t.indexOf('e2e6b fixture')>=0; })()`, 45000)
  check('P1 编辑器就绪且深链文件已挂载', !!ready, 'timeout')
  if (!ready) throw new Error('editor+file not ready')
  const vis = await evalJs(`JSON.stringify({ hidden: document.hidden, vis: document.visibilityState, bar: ${BAR} })`)
  check('P2 页面可见且初始无外部改动提示条', vis && JSON.parse(vis).hidden === false && JSON.parse(vis).bar === null, vis)

  // ── 场景 A：干净缓冲区被外部改（Agent 改了文件）──
  writeFileSync(FIX, T1)
  const barA = await waitFor(`(function(){ var b=${BAR}; return (b && b.text.indexOf('已被外部更改')>=0) ? b : null; })()`, 14000)
  check('P3 干净缓冲区：2.5s 轮询内出现「已被外部更改」提示条', !!barA, JSON.stringify(barA))
  const tA = await evalJs(MODEL_TEXT)
  check('P4 自动跟随磁盘最新内容（编辑器不再是陈旧内容）', tA === T1, JSON.stringify(tA))
  check('P5 提示条提供「查看差异」入口', !!(barA && barA.text.indexOf('查看差异') >= 0), JSON.stringify(barA))

  await evalJs(CLICK('.dside-extbar button', '查看差异'))
  const diffA = await waitFor(`(function(){ var d=${DIFF}; return d && d.diffEditors>0 ? d : null; })()`, 8000)
  check('P6 差异浮层打开（monaco 原生 diff 编辑器已建）', !!(diffA && diffA.dom), JSON.stringify(diffA && { dom: diffA.dom, n: diffA.diffEditors }))
  check('P7 差异内容正确（左=上一版 右=磁盘最新）',
    !!(diffA && diffA.original === T0 && diffA.modified === T1),
    JSON.stringify(diffA && { o: (diffA.original || '').slice(0, 24), m: (diffA.modified || '').slice(0, 24) }))

  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(600)
  const diffClosed = await evalJs(`!document.querySelector('.dside-diff')`)
  check('P8 Esc 关闭差异浮层', !!diffClosed, 'still open')

  await evalJs(CLICK('.dside-extbar button', '知道了'))
  await sleep(400)
  check('P9 「知道了」清掉提示条', !(await evalJs(`!!document.querySelector('.dside-extbar')`)), 'bar still there')

  // ── 场景 B：脏缓冲区 + 磁盘又被改 → 冲突（谁都不许静默覆盖谁）──
  await evalJs(SET_MODEL_TEXT(LOCAL))
  await sleep(500)
  check('P10 本地编辑后出现脏标记', (await evalJs(DIRTY)) >= 1, 'no dirty dot')
  writeFileSync(FIX, T2)
  const barB = await waitFor(`(function(){ var b=${BAR}; return (b && b.cls.indexOf('warn')>=0 && b.text.indexOf('磁盘上的文件已更改')>=0) ? b : null; })()`, 14000)
  check('P11 脏缓冲区：出现冲突提示条（warn）', !!barB, JSON.stringify(barB))
  const tB = await evalJs(MODEL_TEXT)
  check('P12 冲突时编辑器内容不被磁盘覆盖（我的修改还在）', tB === LOCAL, JSON.stringify((tB || '').slice(0, 30)))
  check('P13 冲突时磁盘也未被我的内容覆盖', disk() === T2, JSON.stringify((disk() || '').slice(0, 30)))

  // ── 场景 C：Ctrl+S 保存被平台守卫拦下（绝不静默盖掉 Agent 的改动）──
  await evalJs(CLICK('.dside-editor-tabs .dside-btn', '保存'))
  const blocked = await waitFor(`(function(){ var s=${STATUS}; return s.indexOf('保存被拦下')>=0 ? s : null; })()`, 8000)
  check('P14 保存被拦下并提示（未覆盖磁盘）', !!blocked, JSON.stringify(blocked))
  check('P15 拦下后磁盘仍为 Agent 版本', disk() === T2, JSON.stringify((disk() || '').slice(0, 30)))

  await evalJs(CLICK('.dside-extbar button', '比较差异'))
  const diffB = await waitFor(`(function(){ var d=${DIFF}; return d && d.diffEditors>0 ? d : null; })()`, 8000)
  check('P16 冲突差异浮层：左=编辑器 右=磁盘',
    !!(diffB && diffB.original === LOCAL && diffB.modified === T2),
    JSON.stringify(diffB && { o: (diffB.original || '').slice(0, 24), m: (diffB.modified || '').slice(0, 24) }))

  await evalJs(CLICK('.dside-diff-head button', '用我的覆盖磁盘'))
  await sleep(2500)
  check('P17 「用我的覆盖磁盘」把编辑器内容写盘', disk() === LOCAL, JSON.stringify((disk() || '').slice(0, 30)))
  check('P18 覆盖后脏标记消失', (await evalJs(DIRTY)) === 0, 'dirty dot left')
  check('P19 覆盖后浮层关闭', !(await evalJs(`!!document.querySelector('.dside-diff')`)), 'diff still open')

  // ── 场景 D：采用磁盘版（回滚我的修改）──
  await evalJs(SET_MODEL_TEXT(LOCAL + '// edit2\n'))
  await sleep(400)
  writeFileSync(FIX, T3)
  const barD = await waitFor(`(function(){ var b=${BAR}; return (b && b.text.indexOf('磁盘上的文件已更改')>=0) ? b : null; })()`, 14000)
  check('P20 再次冲突：提示条出现', !!barD, JSON.stringify(barD))
  await evalJs(CLICK('.dside-extbar button', '采用磁盘版'))
  await sleep(1200)
  const tD = await evalJs(MODEL_TEXT)
  check('P21 「采用磁盘版」把磁盘内容装回编辑器', tD === T3, JSON.stringify((tD || '').slice(0, 30)))
  check('P22 采用磁盘版后脏标记消失、提示条收起',
    (await evalJs(DIRTY)) === 0 && !(await evalJs(`!!document.querySelector('.dside-extbar')`)), 'dirty/bar left')
  check('P23 采用磁盘版不改磁盘', disk() === T3, JSON.stringify((disk() || '').slice(0, 30)))

  // ── P24 埋点：使用轨迹里能看到这条链路 ──
  let logText = ''
  try { logText = readFileSync(TRACE, 'utf8').slice(-60000) } catch { /* 无日志 */ }
  const wanted = ['ext-change-reloaded', 'save-blocked-stale', 'ext-overwrite-disk', 'ext-accept-disk']
  const missing = wanted.filter((k) => logText.indexOf(k) < 0)
  check('P24 轨迹日志记录整条链路', missing.length === 0, 'missing=' + missing.join(','))

  check('P25 页面无未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
} catch (e) {
  check('E2E 执行未中断', false, String((e && e.message) || e))
} finally {
  const pass = results.filter((r) => r.ok).length
  console.log(`\n== ${pass}/${results.length} PASS ==`)
  try { if (existsSync(FIX)) rmSync(FIX) } catch { /* 忽略 */ }
  try { ws.close() } catch { /* 忽略 */ }
  try { proc.kill() } catch { /* 忽略 */ }
  await sleep(400)
  try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch { /* 忽略 */ }
  process.exit(pass === results.length ? 0 : 2)
}
