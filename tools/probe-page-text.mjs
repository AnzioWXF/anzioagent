import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// probe-page-text.mjs — 抓页面文本 + 关键 DOM 标志（客户端插件没挂上时用来看清落在哪）
// 用法：node tools/probe-page-text.mjs "<带 token 的 url>"
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const TOKEN_URL = process.argv[2]
const ORIGIN = new URL(TOKEN_URL).origin
const PORT = 9500 + Math.floor(Math.random() * 90)
const H = 'http://127.0.0.1:' + PORT
function findBrowser() {
  for (const c of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) if (existsSync(c)) return c
  throw new Error('no browser')
}
const userDir = join(`${__TIANGONG_ROOT}`, '.edge-text-' + process.pid)
rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
const proc = spawn(findBrowser(), ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank'], { stdio: 'ignore' })
let target = null
for (let i = 0; i < 40 && !target; i++) {
  await new Promise((r) => setTimeout(r, 400))
  try { target = ((await (await fetch(`${H}/json/list`)).json()) || []).find((t) => t.type === 'page') } catch { /* wait */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')) })
let id = 0
const pending = new Map(); const errs = []; const logs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; errs.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 400)) }
  if (m.method === 'Runtime.consoleAPICalled') { logs.push(m.params.type + ': ' + (m.params.args || []).map((a) => String(a.value || a.description || '')).join(' ').slice(0, 300)) }
}
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, (m) => res(m.result || {})); ws.send(JSON.stringify({ id: i, method, params: params || {} })) })
const evalIn = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result ? r.result.value : (r.exceptionDetails ? 'ERR:' + r.exceptionDetails.text : null) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: TOKEN_URL })
await sleep(6000)
const out = await evalIn(`JSON.stringify({
  url: location.href,
  title: document.title,
  bodyText: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 700),
  rootChildren: [].slice.call(document.body.children).map(function(e){ return e.tagName + '.' + (e.className||'') }).slice(0,8),
  hasBoot: !!window.__DSH_BOOT__,
  bootKeys: window.__DSH_BOOT__ ? Object.keys(window.__DSH_BOOT__).slice(0,12) : null,
  loader: typeof window.__ModuleLoader__,
  plugins: window.__DSH_BOOT__ && window.__DSH_BOOT__.plugins ? Object.keys(window.__DSH_BOOT__.plugins).length : null
})`)
console.log('PAGE: ' + out)
console.log('LOGS(' + logs.length + '): ' + logs.slice(-8).join(' | '))
console.log('EXC(' + errs.length + '): ' + errs.slice(0, 3).join(' || '))
ws.close(); proc.kill(); await sleep(200); rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }); process.exit(0)
