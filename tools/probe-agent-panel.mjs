// probe-agent-panel.mjs — 验证"平台原生会话"是否挂进了天工右侧面板（A 方案）
// 用法：node tools/probe-agent-panel.mjs "<带 token 的 3082 url>"
// 探针：右侧 .dside-agent-platform 里是否出现平台会话的 DOM（消息/输入框/浮层），
//       并顺带报告页面未捕获异常（改错 slot 声明时这里会炸）。
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN_URL = process.argv[2]
if (!TOKEN_URL) { console.log('usage: node tools/probe-agent-panel.mjs <tokenUrl>'); process.exit(1) }
const ORIGIN = new URL(TOKEN_URL).origin
const PORT = 9600 + Math.floor(Math.random() * 90)
const H = 'http://127.0.0.1:' + PORT
function findBrowser() {
  for (const c of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) if (existsSync(c)) return c
  throw new Error('no browser')
}
const userDir = join('D:\\99DSH', '.edge-panel-' + process.pid)
rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
const proc = spawn(findBrowser(), [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,900', '--force-device-scale-factor=1',
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
const errs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    errs.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 300))
  }
}
const send = (method, params) => new Promise((res) => {
  const i = ++id
  pending.set(i, (m) => res(m.result || {}))
  ws.send(JSON.stringify({ id: i, method, params: params || {} }))
})
const evalIn = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result ? r.result.value : (r.exceptionDetails ? 'ERR:' + r.exceptionDetails.text : null)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Page.navigate', { url: TOKEN_URL })
await sleep(3000)
await send('Page.navigate', { url: ORIGIN + '/' })
await sleep(4500)

let up = false
for (let i = 0; i < 30 && !up; i++) {
  up = await evalIn("!!document.querySelector('.dside-root')")
  if (!up) await sleep(1000)
}
// 等平台会话挂进来（会话树要等 session scope / 入口渲染）
let kids = 0
for (let i = 0; i < 25 && !kids; i++) {
  kids = (await evalIn("(function(){var e=document.querySelector('.dside-agent-platform'); return e? e.children.length : 0})()")) || 0
  if (!kids) await sleep(1000)
}
await sleep(2500)

const dump = await evalIn(`JSON.stringify((function(){
  function q(s){ return document.querySelector(s) }
  var host = q('.dside-agent-platform')
  var txt = function(el){ return el ? (el.innerText||'').replace(/\\s+/g,' ').slice(0,240) : null }
  var classes = {}
  if (host) [].slice.call(host.querySelectorAll('*')).forEach(function(el){
    [].slice.call(el.classList||[]).forEach(function(c){ if (/conv|composer|chat|message|input|editor/i.test(c)) classes[c]=(classes[c]||0)+1 })
  })
  return {
    ide: !!q('.dside-root'),
    platformSlot: !!host,
    slotChildren: host ? host.children.length : 0,
    slotNodes: host ? host.querySelectorAll('*').length : 0,
    slotText: txt(host),
    textarea: host ? host.querySelectorAll('textarea').length : 0,
    contenteditable: host ? host.querySelectorAll('[contenteditable="true"]').length : 0,
    sendLike: host ? host.querySelectorAll('button').length : 0,
    classes: Object.keys(classes).slice(0, 14),
    overlayLayer: !!q('.dside-overlay-layer'),
    explorer: !!q('.dside-explorer'),
    editor: !!q('.dside-editor'),
    statusbar: !!q('.dside-statusbar'),
    emptyFallback: !!q('.dside-agent-empty')
  }
})())`)
console.log('DUMP: ' + dump)
console.log('EXC(' + errs.length + '): ' + errs.slice(0, 4).join(' || '))
ws.close(); proc.kill()
await sleep(300)
rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
process.exit(0)
