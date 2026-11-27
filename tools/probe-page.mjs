import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// 最小页面诊断探针：node tools/probe-page.mjs [url]
// 输出：标题、正文前 400 字、关键全局、控制台错误/异常（抓 15s）
import { spawn } from 'node:child_process'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const URL_ = process.argv[2] || 'http://127.0.0.1:3081/'
const PORT = 9700 + Math.floor(Math.random() * 200)
const H = 'http://127.0.0.1:' + PORT
function findBrowser() {
  for (const c of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) if (existsSync(c)) return c
  throw new Error('no browser')
}
const userDir = join(`${__TIANGONG_ROOT}`, '.edge-probe-' + process.pid)
rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
const proc = spawn(findBrowser(), [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank',
], { stdio: 'ignore' })

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
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push('[' + m.params.type + '] ' + m.params.args.map((a) => String(a.value ?? a.description ?? a.type)).join(' ').slice(0, 300))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    logs.push('[EXCEPTION] ' + String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 400))
  }
}
const send = (method, params) => new Promise((res) => {
  const i = ++id
  pending.set(i, (m) => res(m.result || {}))
  ws.send(JSON.stringify({ id: i, method, params: params || {} }))
})
await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: URL_ })
await new Promise((r) => setTimeout(r, 12000))
// 可选：先跑一段页内脚本（可 await），用于点击/交互后再取状态
if (process.argv[3]) {
  const a = await send('Runtime.evaluate', { expression: process.argv[3], returnByValue: true, awaitPromise: true })
  console.log('SNIPPET: ' + JSON.stringify((a.result && a.result.value) || (a.exceptionDetails ? a.exceptionDetails.text : null)))
}
await new Promise((r) => setTimeout(r, 2000))
const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({ title: document.title, url: location.href,
    text: (document.body ? document.body.innerText : '').slice(0,400),
    monaco: typeof window.monaco, dside: !!document.querySelector('.dside-app, .dside-root, [class*=dside]'),
    msgCount: document.querySelectorAll('.dside-msg').length,
    msgClasses: Array.prototype.map.call(document.querySelectorAll('.dside-msg'), function(e){ return String(e.className); }),
    hasCtxText: document.body ? document.body.innerText.indexOf('编辑器上下文') >= 0 : false,
    tail: (document.body ? document.body.innerText : '').slice(-500),
    scripts: document.querySelectorAll('script').length })`,
  returnByValue: true,
})
console.log('PAGE: ' + (r.result && r.result.value))
console.log('LOGS(' + logs.length + '):')
for (const l of logs.slice(0, 25)) console.log('  ' + l)
ws.close(); proc.kill()
await new Promise((r2) => setTimeout(r2, 300))
rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
process.exit(0)
