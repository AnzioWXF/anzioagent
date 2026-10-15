// DSH IDE ⑥ 第二刀 E2E（CDP 真浏览器 + 真实 Agent 一轮改动）
// 用法: node tools/e2e6c.mjs   （前置：3081 后端已起；DSH_E2E_TOKEN 由调用方给）
// 验的是：会话事件 → 本轮改动清单（按文件归组）→ 审阅（diff）→ 保留 / 撤销（编辑还原、新建删除）
// 自清：fixture _e2e6c_demo.ts / _e2e6c_new.ts 建在当前工作空间根，结束即删（踩坑 21）
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const CDP_PORT = 9700 + Math.floor(Math.random() * 400)
const APP = 'http://127.0.0.1:3081'
const H = 'http://127.0.0.1:' + CDP_PORT
const TOKEN = process.env.DSH_E2E_TOKEN || ''
const AUTH_URL = APP + '/' + (TOKEN ? '?token=' + TOKEN : '')
const TRACE = 'D:\\99DSH\\app-home\\logs\\ide-trace.log'

const T0 = '// e2e6c fixture\nconst a: number = 1\nconst b: string = "keep"\n'
let ROOT = ''
let FIX = ''
let FIX2 = ''

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' :: ' + String(detail ?? '')}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const diskOf = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]
  for (const c of cands) if (existsSync(c)) return c
  throw new Error('no edge/chrome found')
}
const userDir = join('D:\\99DSH', '.edge6c-tmp-' + process.pid)
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
const consoleErrors = []
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
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await evalJs(expr)
    if (v && !v.__err) return v
    await sleep(400)
  }
  return null
}

// ── 页内取数/操作 ──────────────────────────────────────────────
// 工作空间根走插件自己的 API（页面里 fetch 同源 /dsh-ide/init，无需 token），
// 不解析状态栏文案（文案会变、且有前缀截断坑）
const ROOT_VIA_API = `fetch('/dsh-ide/init').then(function(r){ return r.json() }).then(function(j){ return (j && j.root) ? j.root : null })`
const AGENT_TAB_READY = `!!document.querySelector('.dside-agent-input textarea')`
const CLICK_AGENT_TAB = `(function(){ var ts=document.querySelectorAll('.dside-side-tab');
  for (var i=0;i<ts.length;i++){ if (String(ts[i].textContent).indexOf('Agent')>=0){ ts[i].click(); return true; } } return false; })()`
const MODEL_TEXT = (name) => `(function(){ var ms = window.monaco.editor.getModels();
  for (var i=0;i<ms.length;i++){ if (String(ms[i].uri.path).indexOf(${JSON.stringify(name)})>=0) return ms[i].getValue(); } return null; })()`
const ROW = (name) => `(function(){ var rows=document.querySelectorAll('.dside-change');
  for (var i=0;i<rows.length;i++){ var n=rows[i].querySelector('.dside-change-name');
    if (n && n.textContent.indexOf(${JSON.stringify(name)})>=0)
      return { text: rows[i].textContent, cls: String(rows[i].className), icon: (rows[i].querySelector('.dside-change-icon')||{}).textContent||'' }; }
  return null; })()`
const CLICK_ROW = (name, label) => `(function(){ var rows=document.querySelectorAll('.dside-change');
  for (var i=0;i<rows.length;i++){ var n=rows[i].querySelector('.dside-change-name');
    if (!n || n.textContent.indexOf(${JSON.stringify(name)})<0) continue;
    var bs=rows[i].querySelectorAll('button');
    for (var j=0;j<bs.length;j++){ if (bs[j].textContent.indexOf(${JSON.stringify(label)})>=0){ bs[j].click(); return 'btn'; } }
    n.click(); return 'name'; }
  return false; })()`
const CLICK_TEXT = (sel, text) => `(function(){ var els=document.querySelectorAll(${JSON.stringify(sel)});
  for (var i=0;i<els.length;i++){ if (String(els[i].textContent).indexOf(${JSON.stringify(text)})>=0){ els[i].click(); return true; } } return false; })()`
const DIFF = `(function(){ var d=document.querySelector('.dside-diff'); if(!d) return null;
  var de=(window.monaco.editor.getDiffEditors?window.monaco.editor.getDiffEditors():[]); var m=de.length?de[0].getModel():null;
  return { head:(document.querySelector('.dside-diff-head')||{}).textContent||'', n:de.length,
    original: m?m.original.getValue():null, modified: m?m.modified.getValue():null }; })()`
const SEND = (text) => `(function(){ var ta=document.querySelector('.dside-agent-input textarea'); if(!ta) return 'no-textarea';
  var setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  var bs=document.querySelectorAll('.dside-agent-input button');
  for (var i=0;i<bs.length;i++){ if (String(bs[i].className).indexOf('primary')>=0){ bs[i].click(); return 'sent'; } }
  return 'no-send'; })()`
const IDLE = `(function(){ var b=document.querySelector('.dside-agent-head .dside-badge'); return b? String(b.textContent) : ''; })()`

try {
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})

  const booted = await waitFor(`!!(window.monaco && window.monaco.editor)`, 60000)
  check('P0 应用外壳启动（monaco 就绪）', !!booted, 'timeout')
  if (!booted) throw new Error('shell not booted')

  // ── 0. 定位当前工作空间根，建 fixture，深链打开 ──
  ROOT = await waitFor(ROOT_VIA_API, 40000)
  check('P1 读到当前工作空间根（/dsh-ide/init）', !!(ROOT && /^[A-Za-z]:\\/.test(ROOT)), JSON.stringify(ROOT))
  if (!ROOT || !/^[A-Za-z]:\\/.test(ROOT)) throw new Error('no workspace root: ' + ROOT)
  FIX = join(ROOT, '_e2e6c_demo.ts')
  FIX2 = join(ROOT, '_e2e6c_new.ts')
  writeFileSync(FIX, T0)
  if (existsSync(FIX2)) rmSync(FIX2)
  await cdp('Page.navigate', { url: APP + '/?file=' + encodeURIComponent(FIX) })
  await sleep(1500)
  const ready = await waitFor(`(function(){ var t=${MODEL_TEXT('_e2e6c_demo.ts')}; return t===null?null:t.indexOf('e2e6c fixture')>=0; })()`, 45000)
  check('P2 深链文件已在编辑器打开', !!ready, 'timeout')

  // ── 1. 真实 Agent 一轮：改一行 ──
  if (!(await evalJs(AGENT_TAB_READY))) { await evalJs(CLICK_AGENT_TAB); await sleep(600) }
  const prompt1 = '请用 edit 工具把 ' + FIX + ' 里第 2 行的数字 1 改成 2（只改这一处，不要动别的文件，改完回复 OK）'
  const sent1 = await evalJs(SEND(prompt1))
  check('P3 提示已发给 Agent（面板输入框 + 发送按钮）', sent1 === 'sent', String(sent1))

  const row1 = await waitFor(`(function(){ var r=${ROW('_e2e6c_demo.ts')}; return r; })()`, 240000)
  check('P4 本轮改动清单出现该文件（Agent 一动完就登记）', !!row1, 'timeout（Agent 未产出改动？）')
  if (!row1) throw new Error('no change row')
  check('P5 清单行显示增删行数（+N −N）', /\+/.test(row1.text) && /−/.test(row1.text), row1.text)

  // 等这一轮跑完再操作（避免 Agent 还在写）
  await waitFor(`(function(){ var t=${IDLE}; return t.indexOf('空闲')>=0 ? t : null; })()`, 90000)
  await sleep(600)

  // ── 2. 审阅：点行内「审阅」→ 复用第一刀的 diff 浮层 ──
  const clickedReview = await evalJs(CLICK_ROW('_e2e6c_demo.ts', '审阅'))
  check('P6 点「审阅」触发', clickedReview === 'btn', String(clickedReview))
  const diff = await waitFor(`(function(){ var d=${DIFF}; return d && d.n>0 ? d : null; })()`, 10000)
  check('P7 差异浮层打开（monaco diff 编辑器已建）', !!diff, JSON.stringify(diff && { n: diff.n }))
  check('P8 差异两侧内容正确（改动前 = 1 / 改动后 = 2）',
    !!(diff && typeof diff.original === 'string' && typeof diff.modified === 'string'
      && /=\s*1\b/.test(diff.original) && /=\s*2\b/.test(diff.modified)),
    JSON.stringify(diff && { o: (diff.original || '').slice(0, 40), m: (diff.modified || '').slice(0, 40) }))
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(500)
  check('P9 Esc 关闭差异浮层', !(await evalJs(`!!document.querySelector('.dside-diff')`)), 'still open')

  // ── 3. 全部保留 ──
  await evalJs(CLICK_TEXT('.dside-changes-head button', '全部保留'))
  const keptRow = await waitFor(`(function(){ var r=${ROW('_e2e6c_demo.ts')}; return r && r.text.indexOf('已保留')>=0 ? r : null; })()`, 6000)
  check('P10 「全部保留」标记为已保留', !!keptRow, JSON.stringify(keptRow))
  check('P11 保留=不动磁盘（Agent 的改动还在）', /=\s*2\b/.test(diskOf(FIX) || ''), JSON.stringify((diskOf(FIX) || '').slice(0, 40)))

  // ── 4. 撤销编辑（反向还原 hunk）──
  const clickedUndo = await evalJs(CLICK_ROW('_e2e6c_demo.ts', '↺'))
  check('P12 点行内「↺」触发撤销', clickedUndo === 'btn', String(clickedUndo))
  const undone = await waitFor(`(function(){ var r=${ROW('_e2e6c_demo.ts')}; return r && r.text.indexOf('已撤销')>=0 ? r : null; })()`, 15000)
  check('P13 撤销后清单行标为已撤销', !!undone, JSON.stringify(undone))
  check('P14 撤销把磁盘还原成 Agent 动手之前', diskOf(FIX) === T0, JSON.stringify((diskOf(FIX) || '').slice(0, 60)))

  // ── 5. 第二轮：Agent 新建文件 → 撤销 = 删除 ──
  const prompt2 = '请新建文件 ' + FIX2 + '，内容只有一行：hello agent（只做这一件事，改完回复 OK）'
  const sent2 = await evalJs(SEND(prompt2))
  check('P15 第二轮提示已发出', sent2 === 'sent', String(sent2))
  const row2 = await waitFor(`(function(){ var r=${ROW('_e2e6c_new.ts')}; return r; })()`, 240000)
  check('P16a 第二轮清单登记了新建的文件', !!row2, 'timeout（write 结果没被收集？）')
  const row2c = await waitFor(`(function(){ var r=${ROW('_e2e6c_new.ts')}; return (r && r.icon.indexOf('＋')>=0) ? r : null; })()`, 20000)
  check('P16b 判定为"新建"（＋ 图标，birthMs 探测）', !!row2c, JSON.stringify(row2))
  check('P17 新建文件确已落盘', existsSync(FIX2), 'missing on disk')
  let stBirth = null
  try { stBirth = await (await fetch(`${APP}/dsh-ide/stat?path=` + encodeURIComponent(FIX2))).json() } catch { /* 忽略 */ }
  check('P17b /stat 回创建时间（撤销=删除的判定依据）',
    !!(stBirth && stBirth.exists && typeof stBirth.birthMs === 'number' && (Date.now() - stBirth.birthMs) < 3600000),
    JSON.stringify(stBirth))
  await waitFor(`(function(){ var t=${IDLE}; return t.indexOf('空闲')>=0 ? t : null; })()`, 90000)
  await sleep(600)
  const clickedDel = await evalJs(CLICK_ROW('_e2e6c_new.ts', '↺'))
  check('P18 点「↺」撤销新建', clickedDel === 'btn', String(clickedDel))
  const gone = await waitFor(`(function(){ var r=${ROW('_e2e6c_new.ts')}; return r && r.text.indexOf('已撤销')>=0 ? r : null; })()`, 15000)
  check('P19 撤销新建后行标为已撤销', !!gone, JSON.stringify(gone))
  check('P20 撤销新建 = 磁盘上文件被删除', !existsSync(FIX2), 'still exists')

  // ── 6. 安全边界：整文件覆写"既有文件"（内容不变 → meta.diffs 为空，与新建长得一样）──
  // 这一格是防误删的关键：撤销必须拒绝删除，宁可只开差异让人自己处理
  const prompt3 = '请务必真的调用 write 工具把文件 ' + FIX
    + ' 原样重写一遍（内容与当前磁盘完全一致，不要改动任何字符，改完回复 OK）'
  const sent3 = await evalJs(SEND(prompt3))
  check('P21 第三轮提示已发出', sent3 === 'sent', String(sent3))
  const row3 = await waitFor(`(function(){ var r=${ROW('_e2e6c_demo.ts')}; return r; })()`, 240000)
  check('P22 覆写既有文件也登记进清单', !!row3, 'timeout')
  if (row3) {
    await waitFor(`(function(){ var t=${IDLE}; return t.indexOf('空闲')>=0 ? t : null; })()`, 90000)
    await sleep(600)
    const existsBefore = existsSync(FIX)
    const undoClick = await evalJs(CLICK_ROW('_e2e6c_demo.ts', '↺'))
    await sleep(3000)
    check('P23 覆写既有文件后点撤销：文件绝不能被删掉', existsBefore && existsSync(FIX), 'file deleted!')
    const guarded = await evalJs(`(function(){ var s=document.querySelector('.dside-statusbar');
      var t=s? String(s.textContent):''; return { undoHint: t.indexOf('删除会误伤')>=0, diff: !!document.querySelector('.dside-diff') }; })()`)
    console.log('    （本节信息）撤销分支: ' + JSON.stringify({ clicked: undoClick, ...(guarded || {}) }))
  }

  // ── 7. 埋点 ──
  let logText = ''
  try { logText = readFileSync(TRACE, 'utf8').slice(-80000) } catch { /* 无日志 */ }
  const wanted = ['change-undo-ok', 'change-keep-all', 'delete-ok']
  const missing = wanted.filter((k) => logText.indexOf(k) < 0)
  check('P21 轨迹日志记录保留/撤销/删除', missing.length === 0, 'missing=' + missing.join(','))

  check('P22 页面无未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
} catch (e) {
  check('E2E 执行未中断', false, String((e && e.message) || e))
} finally {
  const pass = results.filter((r) => r.ok).length
  console.log(`\n== ${pass}/${results.length} PASS ==`)
  for (const p of [FIX, FIX2]) { try { if (p && existsSync(p)) rmSync(p) } catch { /* 忽略 */ } }
  try { ws.close() } catch { /* 忽略 */ }
  try { proc.kill() } catch { /* 忽略 */ }
  await sleep(400)
  try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch { /* 忽略 */ }
  process.exit(pass === results.length ? 0 : 2)
}
