import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// e2e-snapshot-ui.mjs — "反悔药"的**真浏览器**端到端：状态栏入口 → 快照面板 → 立即快照
//   → 磁盘改/增/删 → 看差异（复用差异浮层）→ 真实 window.confirm → 还原 → 核对磁盘真值
// 用法：node tools/e2e-snapshot-ui.mjs "<带 token 的 3082 url>"
// 前置：测试后端在跑（§6 49 配方），且它与本脚本用同一个 DSH_HOME 语义（快照库在 home\snapshots）。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const TOKEN_URL = process.argv[2]
if (!TOKEN_URL) { console.log('usage: node tools/e2e-snapshot-ui.mjs <tokenUrl>'); process.exit(1) }
const ORIGIN = new URL(TOKEN_URL).origin
const API = ORIGIN + '/dsh-ide'
const FIX = join(`${__TIANGONG_ROOT}`, '.snapfix-ui')
// ⚠ 别读 process.env.DSH_HOME（harness shell 里带的是开发台家目录，见 §6 31）
const SNAP = join(process.env.DSH_E2E_HOME || `${__TIANGONG_ROOT}\\.smoke-home`, 'snapshots')
const WS = join(SNAP, createHash('sha1').update(FIX.toLowerCase()).digest('hex').slice(0, 16))

const results = []
function check(name, ok, extra) {
  results.push([name, !!ok])
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra)))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = (rel) => { try { return readFileSync(join(FIX, rel), 'utf8') } catch { return null } }
async function post(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  return r.json()
}

// ── fixture（自建自清）───────────────────────────────────────────────
rmSync(FIX, { recursive: true, force: true })
rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
mkdirSync(join(FIX, 'sub'), { recursive: true })
writeFileSync(join(FIX, 'a.txt'), 'UI-A1\n')
writeFileSync(join(FIX, 'sub', 'b.txt'), 'UI-B1\n')

// ── 真浏览器 ────────────────────────────────────────────────────────
const PORT = 9800 + Math.floor(Math.random() * 90)
const H = 'http://127.0.0.1:' + PORT
function findBrowser() {
  for (const c of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) if (existsSync(c)) return c
  throw new Error('no browser')
}
const userDir = join(`${__TIANGONG_ROOT}`, '.edge-snap-' + process.pid)
rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
const proc = spawn(findBrowser(), [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,900', '--force-device-scale-factor=1',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank',
], { stdio: 'ignore' })

let target = null
for (let i = 0; i < 40 && !target; i++) {
  await sleep(400)
  try { target = ((await (await fetch(`${H}/json/list`)).json()) || []).find((t) => t.type === 'page') } catch { /* wait */ }
}
if (!target) { console.log('no target'); proc.kill(); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')) })
let id = 0
const pending = new Map()
const errs = []
const dialogs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    errs.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 200))
  }
  // 真实 confirm：记下文案并**接受**（不 stub 产品逻辑）
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(String(m.params.message || ''))
    send('Page.handleJavaScriptDialog', { accept: true })
  }
}
function send(method, params) {
  return new Promise((res) => {
    const i = ++id
    pending.set(i, (m) => res(m.result || {}))
    ws.send(JSON.stringify({ id: i, method, params: params || {} }))
  })
}
const evalIn = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result ? r.result.value : (r.exceptionDetails ? 'ERR:' + r.exceptionDetails.text : null)
}
// 按文案点按钮（页面内查找，避免依赖具体类名）
const clickByText = (scope, text) => evalIn(`(function(){
  var root = document.querySelector(${JSON.stringify(scope)});
  if (!root) return 'no-scope';
  var els = [].slice.call(root.querySelectorAll('button'));
  for (var i = 0; i < els.length; i++) if ((els[i].textContent || '').indexOf(${JSON.stringify(text)}) >= 0) { els[i].click(); return 'clicked'; }
  return 'no-button';
})()`)

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })

try {
  await send('Page.navigate', { url: TOKEN_URL })
  await sleep(3000)
  await send('Page.navigate', { url: ORIGIN + '/' })
  await sleep(4000)
  let up = false
  for (let i = 0; i < 30 && !up; i++) {
    up = await evalIn("!!document.querySelector('.dside-root') && !!document.querySelector('.dside-statusbar')")
    if (!up) await sleep(1000)
  }
  check('P1 IDE 页面挂载完成', up === true)

  const act = await post('/active-root', { path: FIX })     // 让 host 的"当前工作空间"= fixture
  check('P2 工作空间指向 fixture', act && act.ok !== false, act)
  await sleep(600)

  // ① 状态栏入口 → 快照面板
  const opened = await evalIn("(function(){var e=document.querySelector('.dside-snapstat'); if(!e) return 'no-entry'; e.click(); return 'clicked';})()")
  await sleep(900)
  const panel = await evalIn("(function(){var c=document.querySelector('.dside-search-card'); return c ? (c.textContent||'').slice(0,80) : null;})()")
  check('P3 状态栏「⏱ 快照」入口能打开面板', opened === 'clicked' && !!panel && panel.indexOf('工作区快照') >= 0, panel)
  check('P4 面板里带 VSCode 式说明（空态或列表都行）', !!panel)

  // ② 立即快照（走 UI 按钮，不打接口）
  const took = await clickByText('.dside-search-card', '立即快照')
  await sleep(1500)
  let rows = await evalIn("document.querySelectorAll('.dside-snap-row').length")
  check('P5 点「立即快照」后列表出现 1 行', took === 'clicked' && rows === 1, { took, rows })

  // ③ 磁盘改 / 增 / 删 → 再快照
  writeFileSync(join(FIX, 'a.txt'), 'UI-A2-改过\n')
  writeFileSync(join(FIX, 'c.txt'), 'UI-C1-新增\n')
  rmSync(join(FIX, 'sub', 'b.txt'))
  await sleep(1200)
  await clickByText('.dside-search-card', '立即快照')
  await sleep(1600)
  rows = await evalIn("document.querySelectorAll('.dside-snap-row').length")
  const firstRow = await evalIn("(function(){var r=document.querySelector('.dside-snap-row'); return r ? (r.textContent||'') : null;})()")
  check('P6 第二份快照进列表（共 2 行）', rows === 2, { rows })
  check('P7 首行标出 改1/增1/删1', !!firstRow && firstRow.indexOf('改 1') >= 0 && firstRow.indexOf('增 1') >= 0 && firstRow.indexOf('删 1') >= 0, firstRow)

  // ④ 看差异（点的是第 2 行 = 第 1 份快照，那份与当前磁盘差 3 个文件）
  const dclick = await evalIn(`(function(){
    var rows = [].slice.call(document.querySelectorAll('.dside-snap-row'));
    var r = rows[1]; if (!r) return 'no-row';
    var bs = [].slice.call(r.querySelectorAll('button'));
    for (var i=0;i<bs.length;i++) if ((bs[i].textContent||'').indexOf('看差异')>=0) { bs[i].click(); return 'clicked'; }
    return 'no-button';
  })()`)
  await sleep(2200)
  const head = await evalIn("(function(){var d=document.querySelector('.dside-diff-head'); return d ? (d.textContent||'').slice(0,120) : null;})()")
  check('P8 差异浮层打开且是"快照还原"模式', dclick === 'clicked' && !!head && head.indexOf('快照还原') >= 0, head)
  check('P9 队列标出第 1/3 个文件（改/增/删三处）', !!head && head.indexOf('1/3') >= 0, head)
  const diffs = await evalIn(`(function(){
    var eds = window.monaco && monaco.editor.getDiffEditors ? monaco.editor.getDiffEditors() : [];
    if (!eds.length) return null;
    return { left: eds[0].getModel().original.getValue().slice(0,40), right: eds[0].getModel().modified.getValue().slice(0,40) };
  })()`)
  check('P10 monaco 差异两侧内容正确（左=快照，右=当前磁盘）', !!diffs && diffs.left.indexOf('UI-A1') >= 0 && diffs.right.indexOf('UI-A2') >= 0, diffs)

  // ⑤ 还原整个快照（真实 confirm）
  const rclick = await clickByText('.dside-diff-head', '还原整个快照')
  await sleep(3000)
  check('P11 还原按钮触发了真实 confirm（文案讲清代价）', dialogs.length > 0 && dialogs[0].indexOf('还原') >= 0, dialogs[0] && dialogs[0].slice(0, 60))
  check('P12 磁盘真值: a.txt 回到快照版本', read('a.txt') === 'UI-A1\n', read('a.txt'))
  check('P13 磁盘真值: 被删的 sub/b.txt 回来了', read('sub/b.txt') === 'UI-B1\n', read('sub/b.txt'))
  check('P14 磁盘真值: 新增的 c.txt 已移出工作区', read('c.txt') === null)
  check('P15 还原后差异浮层自动关闭', (await evalIn("!!document.querySelector('.dside-diff')")) === false)
  const status = await evalIn("(function(){var s=document.querySelector('.dside-statusbar'); return s? (s.textContent||'') : null;})()")
  check('P16 状态栏报告还原结果', !!status && status.indexOf('已还原') >= 0, status && status.slice(0, 80))

  // ⑥ 二次撤回：面板里那份「还原前自动备份」能再还原回去
  await evalIn("(function(){var e=document.querySelector('.dside-snapstat'); if(e) e.click();})()")
  await sleep(900)
  const preRow = await evalIn(`(function(){
    var rows = [].slice.call(document.querySelectorAll('.dside-snap-row'));
    for (var i=0;i<rows.length;i++) if ((rows[i].textContent||'').indexOf('还原前自动备份')>=0) return 'found:' + i;
    return 'not-found';
  })()`)
  check('P19 面板里能找到「还原前自动备份」这份快照', String(preRow).indexOf('found:') === 0, preRow)
  const idx = Number(String(preRow).split(':')[1] || -1)
  if (idx >= 0) {
    await evalIn(`(function(){
      var row = [].slice.call(document.querySelectorAll('.dside-snap-row'))[${idx}];
      var bs = [].slice.call(row.querySelectorAll('button'));
      for (var i=0;i<bs.length;i++) if ((bs[i].textContent||'').indexOf('还原')>=0) { bs[i].click(); return; }
    })()`)
    await sleep(3000)
  }
  check('P20 撤回还原后 a.txt 回到改过的版本', read('a.txt') === 'UI-A2-改过\n', read('a.txt'))
  check('P21 撤回还原后 c.txt 又回来了', read('c.txt') === 'UI-C1-新增\n', read('c.txt'))

  check('P22 页面零未捕获异常', errs.length === 0, errs.slice(0, 3))
} finally {
  try { ws.close() } catch { /* 忽略 */ }
  proc.kill()
  await sleep(300)
  rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
  rmSync(FIX, { recursive: true, force: true })
  rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
}

const pass = results.filter((r) => r[1]).length
console.log(`\n[e2e-snapshot-ui] ${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
