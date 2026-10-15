// 附着到"已经在跑"的 CDP 端点并求值（用于验证 AnzioAgent 桌面壳里的页面）
// 用法: node tools/probe-app.mjs "<页内表达式>" [port]     # 默认端口 9222
// 与 probe-page.mjs 的区别：这个**不自己起浏览器**，直接连 Electron 的 --remote-debugging-port
const PORT = Number(process.argv[3] || 9222)
const EXPR = process.argv[2] || 'JSON.stringify({ url: location.href, title: document.title })'
const H = 'http://127.0.0.1:' + PORT

let target = null
for (let i = 0; i < 20 && !target; i++) {
  try {
    const list = await (await fetch(H + '/json/list')).json()
    target = (list || []).find((t) => t.type === 'page')
  } catch { /* 还没起来 */ }
  if (!target) await new Promise((r) => setTimeout(r, 500))
}
if (!target) { console.log('no page target on ' + H); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')) })
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const send = (method, params) => new Promise((res) => {
  const i = ++id
  pending.set(i, (m) => res(m.result || {}))
  ws.send(JSON.stringify({ id: i, method, params: params || {} }))
})
await send('Runtime.enable')
const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true })
if (r.exceptionDetails) console.log('EXCEPTION: ' + JSON.stringify(r.exceptionDetails.text || r.exceptionDetails))
else console.log(typeof r.result?.value === 'string' ? r.result.value : JSON.stringify(r.result?.value))
try { ws.close() } catch { /* 忽略 */ }
process.exit(0)
