// ⑭ 长任务进度 / 中断反馈 E2E（真 Agent 一轮 + 真浏览器）
// 用法: node D:\99DSH\tools\e2e14.mjs
//   （自起测试后端，默认 3082；DSH_HOME=D:\99DSH\app-home）
// 验的是：Agent 跑一轮时面板给出**可观测的进度**（第 N 步 · 已用时间 · 正在做什么），
//   以及**中断后的明确反馈**（"已中断 · 上轮 N 步 · 用时"）—— 对应 2026-09-16 用户实测
//   "单轮跑到第 54 步、十几分钟，界面只有'运行中'三个字，只能中断"。
// ⚠ 本套件会真的调用模型（1–2 次请求）。
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.DSH_E2E_PORT || 3082)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = 'D:\\99DSH\\app-home'
const CLI = 'D:\\99DSH\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js'
const BLOG = 'D:\\99DSH\\_e2e14_backend_' + PORT + '.log'
const CDP_PORT = 9950 + Math.floor(Math.random() * 45)

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

const CLICK_AGENT_TAB = `(function(){ var ts=document.querySelectorAll('.dside-side-tab');
  for (var i=0;i<ts.length;i++){ if (String(ts[i].textContent).indexOf('Agent')>=0){ ts[i].click(); return true } } return false })()`
const SEND = (text) => `(function(){ var ta=document.querySelector('.dside-agent-input textarea'); if(!ta) return 'no-textarea';
  var setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  var bs=document.querySelectorAll('.dside-agent-input button');
  for (var i=0;i<bs.length;i++){ if (String(bs[i].className).indexOf('primary')>=0){ bs[i].click(); return 'sent' } }
  return 'no-send' })()`
const BADGE = `(function(){ var b=document.querySelector('.dside-agent-head .dside-badge'); return b? String(b.textContent) : null })()`
const PROGRESS = `(function(){ var p=document.querySelector('.dside-agent-progress'); return p? String(p.textContent) : null })()`
const CLICK_STOP = `(function(){ var bs=document.querySelectorAll('.dside-agent-input button');
  for (var i=0;i<bs.length;i++){ if (String(bs[i].className).indexOf('danger')>=0){ bs[i].click(); return true } } return false })()`

async function main() {
  rmSync(BLOG, { force: true })
  const fd = openSync(BLOG, 'w')
  const backend = spawn(process.execPath, [CLI, 'web', '--port', String(PORT), '--no-open'], {
    cwd: 'D:\\99DSH\\deepseek-harness-mine\\harness', env: cleanEnv(), stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  let backendExit = null
  backend.on('exit', (c) => { backendExit = c })

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

  const userDir = join('D:\\99DSH', '.edge-e2e14-tmp-' + process.pid)
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
    let last = null
    while (Date.now() - t < ms) {
      const v = await evalJs(expr)
      last = v
      if (v && !v.__err) return v
      await sleep(400)
    }
    return last
  }

  await cdp('Runtime.enable')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 90000)
  check('P1 页面挂载完成', !!ready, await evalJs('document.readyState'))

  await evalJs(CLICK_AGENT_TAB)
  // ⚠ 输入框 disabled = !sessionFace || !conv（会话还没就绪）→ 必须等它**可用**再发，
  // 否则点 send 是空操作（第一版就栽在这：只等"存在"没等"可用"，消息根本没发出去）
  const inputReady = await waitFor(`(function(){ var ta=document.querySelector('.dside-agent-input textarea');
    return (ta && !ta.disabled) ? true : null })()`, 90000)
  check('P2 Agent 面板就绪（输入框可用 = 会话已连接）', inputReady === true,
    await evalJs(`(function(){ var ta=document.querySelector('.dside-agent-input textarea'); return ta? ('disabled='+ta.disabled) : 'no-textarea' })()`))

  const idleBefore = await evalJs(BADGE)
  check('P3 发消息前是空闲态（徽标含「空闲」）', typeof idleBefore === 'string' && idleBefore.indexOf('空闲') >= 0, String(idleBefore))

  // 发一条会**长时间占住轮次**的提示（跑 30 秒命令），好观察进度与中断
  const sent = await evalJs(SEND('请用 pwsh 工具执行命令 `Start-Sleep -Seconds 30`，命令跑完后回复 DONE。'))
  // 消息真的进了对话才算发出去（别只看按钮点到了）
  const inConv = await waitFor(`(function(){ var m=document.querySelector('.dside-agent-messages');
    return (m && String(m.textContent).indexOf('Start-Sleep') >= 0) ? true : null })()`, 30000)
  check('P4 消息已发出并出现在对话里', sent === 'sent' && inConv === true, `sent=${sent} inConv=${inConv}`)

  const prog = await waitFor(PROGRESS, 120000)
  check('P5 运行中显示进度条（第 N 步 · 已用 · 正在做什么）',
    typeof prog === 'string' && prog.indexOf('第') >= 0 && prog.indexOf('已用') >= 0, String(prog))

  const badgeRunning = await evalJs(BADGE)
  check('P6 徽标在运行态显示步数与耗时',
    typeof badgeRunning === 'string' && badgeRunning.indexOf('运行中') >= 0 && badgeRunning.indexOf('步') >= 0, String(badgeRunning))

  // 等 4 秒再看一次：耗时应该变大了（证明是活的计时器，不是静态文案）
  const t1 = await evalJs(PROGRESS)
  await sleep(4000)
  const t2 = await evalJs(PROGRESS)
  const secs = (s) => {
    const m = String(s || '').match(/已用\s*(\d+):(\d+)/)
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1
  }
  check('P7 耗时在走（4 秒后读数变大）', secs(t2) > secs(t1) && secs(t1) >= 0, `t1=${String(t1)} t2=${String(t2)}`)

  // ── 中断 ──────────────────────────────────────────────────────
  const stopped = await evalJs(CLICK_STOP)
  check('P8 点 ⏹ 触发中断', stopped === true, String(stopped))

  const idleAfter = await waitFor(`(function(){ var b=${BADGE}; return (b && b.indexOf('空闲')>=0 && b.indexOf('已中断')>=0) ? b : null })()`, 90000)
  check('P9 中断后有明确反馈（空闲 · 上轮 N 步 · 用时 · 已中断）',
    typeof idleAfter === 'string' && idleAfter.indexOf('已中断') >= 0 && idleAfter.indexOf('步') >= 0, String(idleAfter))

  const progGone = await evalJs(PROGRESS)
  check('P10 中断后进度条消失', progGone === null || progGone === false, String(progGone))

  check('P11 页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))

  const pass = results.filter((x) => x.ok).length
  console.log(`\n[e2e14] ${pass}/${results.length} passed`)
  return { ok: pass === results.length, browser, backend }
}

let handles = null
try {
  handles = await main()
} catch (e) {
  console.log('[e2e14] ABORT: ' + (e && e.stack ? e.stack : e))
} finally {
  try { if (handles && handles.browser) killTree(handles.browser.pid) } catch { /* ignore */ }
  try { if (handles && handles.backend) killTree(handles.backend.pid) } catch { /* ignore */ }
  await sleep(1500)
  try { rmSync(join('D:\\99DSH', '.edge-e2e14-tmp-' + process.pid), { recursive: true, force: true }) } catch { /* ignore */ }
  console.log('[e2e14] cleanup done')
}
process.exit(handles && handles.ok ? 0 : 1)
