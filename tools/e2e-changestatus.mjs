// e2e-changestatus.mjs — 「本轮改动」审阅状态持久化 E2E（2026-09-17 用户实测 bug 的回归套件）
//
// 背景：点「全部保留」后只改了内存 ref，重开软件又从会话事件重新投影 → 改动全变回"待审阅"。
// 修法：状态落 localStorage（{ [sessionId]: { 'turn|path': 'kept'|'undone' } }）。
//
// 用法：node D:\99DSH\tools\e2e-changestatus.mjs "<带 token 的 app url>"
// 前置：一个跑在 3082 的测试后端（DSH_HOME 指向临时家目录，见 README 配方），且该 home 里有
//       带「工具改动」的会话。脚本自带浏览器（headless Edge），**profile 目录固定**，
//       因为要验证"重新加载页面后状态还在"——随机 profile 会把 localStorage 一起丢掉。
import { spawn } from 'node:child_process'
import { rmSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const URL_ = process.argv[2]
if (!URL_) { console.log('用法: node e2e-changestatus.mjs "<带 token 的 app url>"'); process.exit(1) }
const KEEP_PROFILE = process.env.KEEP_PROFILE === '1'
const PORT = 9700 + Math.floor(Math.random() * 200)
const H = 'http://127.0.0.1:' + PORT
const userDir = join('D:\\99DSH', '.edge-changestatus')

function findBrowser() {
  for (const c of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) if (existsSync(c)) return c
  throw new Error('no browser')
}
if (!KEEP_PROFILE) rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
mkdirSync(userDir, { recursive: true })

const proc = spawn(findBrowser(), [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank',
], { stdio: 'ignore' })

const results = []
function check(id, ok, detail) { results.push({ id, ok: !!ok, detail: String(detail == null ? '' : detail) }) }

let target = null
for (let i = 0; i < 40 && !target; i++) {
  await new Promise((r) => setTimeout(r, 400))
  try { target = ((await (await fetch(`${H}/json/list`)).json()) || []).find((t) => t.type === 'page') } catch { /* wait */ }
}
if (!target) { console.log('no target'); proc.kill(); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')) })
let id = 0
const pending = new Map()
const logs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    logs.push('[EXCEPTION] ' + String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 300))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    logs.push('[console.error] ' + m.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300))
  }
}
const send = (method, params) => new Promise((res) => {
  const i = ++id
  pending.set(i, (m) => res(m.result || {}))
  ws.send(JSON.stringify({ id: i, method, params: params || {} }))
})
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)) }
  return r.result ? r.result.value : null
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 页内辅助：等 IDE 就绪 + 把「有改动的会话」点到当前
const HELPERS = `
window.__e2e = {
  sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) },
  ready: async function () {
    for (var i = 0; i < 60; i++) { if (document.querySelector('.dside-root')) return true; await this.sleep(500) }
    return false
  },
  hasPanel: function () { return !!document.querySelector('.dside-changes') },
  head: function () { var e = document.querySelector('.dside-changes-head'); return e ? e.innerText.replace(/\\n/g, ' | ') : '' },
  rows: function () { return document.querySelectorAll('.dside-change').length },
  headBtns: function () {
    var bs = document.querySelectorAll('.dside-changes-head button')
    return Array.prototype.map.call(bs, function (b) { return b.textContent })
  },
  clickIn: function (root, text) {
    if (!root) return false
    var bs = root.querySelectorAll('button')
    for (var i = 0; i < bs.length; i++) if (bs[i].textContent.indexOf(text) >= 0) { bs[i].click(); return true }
    return false
  },
  clickRow: function (i) {
    var rs = document.querySelectorAll('.dside-change')
    if (!rs[i]) return null
    var n = rs[i].querySelector('.dside-change-name')
    var name = n ? n.textContent : ''
    rs[i].click()
    return name
  },
  diffTitle: function () {
    var d = document.querySelector('.dside-diff')
    if (!d) return ''
    var f = d.querySelector('.file')
    return f ? f.textContent : '(no-file)'
  },
  sessionItems: function () {
    return document.querySelectorAll('.dside-session, .dside-sessions [class*=item], .dside-sessions > *')
  },
  // 逐个点会话，直到出现改动面板；返回命中的下标（-1 = 没找到）
  pickSessionWithChanges: async function () {
    if (document.querySelector('.dside-changes')) return 0
    var items = this.sessionItems()
    for (var i = 0; i < items.length && i < 10; i++) {
      try { items[i].click() } catch (e) { continue }
      for (var t = 0; t < 8; t++) { await this.sleep(400); if (document.querySelector('.dside-changes')) return i }
    }
    return -1
  },
  // 第二次加载：点同一个会话（此时面板"不该"出现，所以不能用上面的判据）
  pickSessionIndex: async function (i) {
    var items = this.sessionItems()
    if (!items[i]) { await this.sleep(1500); return 'no-item' }
    try { items[i].click() } catch (e) { return 'click-fail' }
    await this.sleep(2000)
    return items[i].className
  },
  status: function () { try { return window.localStorage.getItem('dside.changeStatus.v1') || '' } catch (e) { return 'ERR:' + e.message } },
}
'ok'
`

await send('Runtime.enable')
await send('Page.enable')

// ── 第一次加载：找会话 → 点文件行看差异 → 全部保留 → 区域应整体消失 ──
await send('Page.navigate', { url: URL_ })
await sleep(9000)
await evalJs(HELPERS)
check('P1 IDE 根渲染', (await evalJs('window.__e2e.ready()')) === true, '')
const sidx = await evalJs('window.__e2e.pickSessionWithChanges()')
check('P2 找到带改动的会话（改动区域出现）', typeof sidx === 'number' && sidx >= 0, 'sessionIndex=' + sidx)

const headText = await evalJs('window.__e2e.head()')
const btnArr = JSON.parse((await evalJs('JSON.stringify(window.__e2e.headBtns())')) || '[]')
check('P3 头部只报待处理文件数', /本轮改动\s*\d+\s*个文件/.test(headText || ''), headText)
check('P4 面板里不再有「审阅」按钮', btnArr.every((t) => String(t).indexOf('审阅') < 0), btnArr.join(' / '))

const rowName = await evalJs('window.__e2e.clickRow(0)')
await sleep(1500)
const diffTitle = await evalJs('window.__e2e.diffTitle()')
check('P5 点文件行 = 直接打开该文件的差异',
  !!diffTitle && !!rowName && String(diffTitle).indexOf(String(rowName).slice(0, 6)) >= 0,
  '点=' + rowName + ' → 浮层=' + diffTitle)
await evalJs('window.__e2e.clickIn(document.querySelector(".dside-diff"), "关闭")')
await sleep(700)

const kept = JSON.parse((await evalJs(`(async function () {
  var ok = window.__e2e.clickIn(document.querySelector('.dside-changes-head'), '全部保留');
  await window.__e2e.sleep(1000);
  return JSON.stringify({ clicked: ok, panel: window.__e2e.hasPanel(), rows: window.__e2e.rows(), ls: window.__e2e.status() });
})()`)) || '{}')
check('P6 点「全部保留」后整个改动区域消失', kept.clicked === true && kept.panel === false,
  'clicked=' + kept.clicked + ' panel=' + kept.panel + ' rows=' + kept.rows)
let lsObj = null
try { lsObj = JSON.parse(kept.ls || '{}') } catch { /* ignore */ }
const lsKeys = lsObj ? Object.keys(lsObj) : []
let inner = []
for (const k2 of lsKeys) { const ks = Object.keys(lsObj[k2] || {}); if (ks.length) { inner = ks; break } }
check('P7 状态已落盘 localStorage', inner.length > 0, 'sessions=' + lsKeys.length + ' entries=' + inner.length + ' 例:' + (inner[0] || '-'))

// ── 第二次加载（= 重开软件）：区域不该再出现 ──
await send('Page.navigate', { url: URL_ })
await sleep(9000)
await evalJs(HELPERS)
await evalJs('window.__e2e.ready()')
await evalJs('window.__e2e.pickSessionIndex(' + sidx + ')')
const after = JSON.parse((await evalJs(`JSON.stringify({
  panel: window.__e2e.hasPanel(), rows: window.__e2e.rows(), ls: window.__e2e.status()
})`)) || '{}')
check('P8 重新加载后改动区域依然不出现（本次核心断言）', after.panel === false,
  'panel=' + after.panel + ' rows=' + after.rows)
check('P9 重新加载后 localStorage 仍在', (after.ls || '').indexOf('kept') >= 0, (after.ls || '').slice(0, 90))
check('P10 页面零未捕获异常', logs.filter((l) => l.startsWith('[EXCEPTION]')).length === 0,
  logs.filter((l) => l.startsWith('[EXCEPTION]')).slice(0, 2).join(' || ') || 'none')

const pass = results.filter((r) => r.ok).length
console.log('')
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.id + (r.detail ? '   → ' + r.detail : ''))
console.log('')
console.log(`结果: ${pass}/${results.length}`)
if (logs.length) { console.log('页面日志(前 8 条):'); for (const l of logs.slice(0, 8)) console.log('  ' + l) }
ws.close(); proc.kill()
await sleep(300)
if (!KEEP_PROFILE) rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
process.exit(pass === results.length ? 0 : 1)
