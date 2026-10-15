// shot-ide.mjs — 给 IDE 页面拍张图（"眼睛验收"用：改皮肤/布局后自己先看一眼）
// 用法：node tools/shot-ide.mjs <带 token 的 url> <out.png> [要打开的文件路径]
// 流程：① 用带 token 的 URL 首访（种认证 cookie）→ ② 再导航到干净 URL（可选 ?file= 深链）
//       → ③ 等 .dside-root 渲染 → ④ 打印皮肤探针 → ⑤ 截图存盘
import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN_URL = process.argv[2]
const OUT = process.argv[3]
const FILE = process.argv[4] || ''
if (!TOKEN_URL || !OUT) { console.log('usage: node tools/shot-ide.mjs <tokenUrl> <out.png> [file]'); process.exit(1) }

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
const userDir = join('D:\\99DSH', '.edge-shot-' + process.pid)
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
    errs.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 200))
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

const origin = new URL(TOKEN_URL).origin
await send('Page.navigate', { url: TOKEN_URL })          // ① 认证（会 303 到 /）
await sleep(3000)
const dest = origin + '/' + (FILE ? '?file=' + encodeURIComponent(FILE) : '')
await send('Page.navigate', { url: dest })               // ② 正式导航
await sleep(4000)

let up = false
for (let i = 0; i < 30 && !up; i++) {                    // ③ 等 IDE 渲染
  up = await evalIn("!!document.querySelector('.dside-root') && !!document.querySelector('.dside-statusbar')")
  if (!up) await sleep(1000)
}
await sleep(3000)

const probe = await evalIn(`JSON.stringify((function(){
  var st = document.querySelector('style[data-plugin="dsh-ide"]');
  var root = document.querySelector('.dside-root');
  var cs = root ? getComputedStyle(root) : null;
  return {
    url: location.href,
    ide: !!root,
    styleChars: st ? st.textContent.length : 0,
    rootBg: cs ? cs.backgroundImage.slice(0,60) + ' | ' + cs.backgroundColor : null,
    titlebar: (function(){var e=document.querySelector('.dside-titlebar');return e?getComputedStyle(e).backgroundImage.slice(0,70):null})(),
    nodes: document.querySelectorAll('.dside-node').length,
    msgs: document.querySelectorAll('.dside-msg').length,
    tabs: document.querySelectorAll('.dside-tab').length,
    bodyText: (document.body.innerText||'').slice(0,160)
  };
})())`)
console.log('PROBE: ' + probe)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot && shot.data) { writeFileSync(OUT, Buffer.from(shot.data, 'base64')); console.log('SHOT: ' + OUT) }
else console.log('SHOT FAILED')
console.log('EXC(' + errs.length + '): ' + errs.slice(0, 5).join(' | '))

ws.close(); proc.kill()
await sleep(300)
rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
process.exit(0)
