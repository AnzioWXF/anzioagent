import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// probe-question-ui.mjs — 决定性验证：平台"提问卡片"是否真的会出现在天工右侧面板里
// 用法：node tools/probe-question-ui.mjs "<带 token 的 3082 url>" ["自定义提问指令"]
// 做法：真键盘输入（CDP Input.insertText + Enter）→ 等 Agent 调用 ask_user_question
//       → 检查输入框是否被"提问界面"接管（出现选项/翻页/跳过等控件）。
// ⚠ 会真调模型一次（一条很短的消息）。
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN_URL = process.argv[2]
const ASK = process.argv[3] || '请用提问工具问我一个问题：今晚吃什么？选项只给三个——饺子、面条、火锅。问完就停下等我选，不要做别的事。'
if (!TOKEN_URL) { console.log('usage: node tools/probe-question-ui.mjs <tokenUrl> [prompt]'); process.exit(1) }
const ORIGIN = new URL(TOKEN_URL).origin
const PORT = 9700 + Math.floor(Math.random() * 90)
const H = 'http://127.0.0.1:' + PORT
function findBrowser() {
  for (const c of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) if (existsSync(c)) return c
  throw new Error('no browser')
}
const userDir = join(`${__TIANGONG_ROOT}`, '.edge-q-' + process.pid)
rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
const proc = spawn(findBrowser(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,900', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank'], { stdio: 'ignore' })
let target = null
for (let i = 0; i < 40 && !target; i++) {
  await new Promise((r) => setTimeout(r, 400))
  try { target = ((await (await fetch(`${H}/json/list`)).json()) || []).find((t) => t.type === 'page') } catch { /* wait */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')) })
let id = 0
const pending = new Map(); const errs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; errs.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 250)) }
}
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, (m) => res(m.result || {})); ws.send(JSON.stringify({ id: i, method, params: params || {} })) })
const evalIn = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result ? r.result.value : (r.exceptionDetails ? 'ERR:' + r.exceptionDetails.text : null) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function key(k, code, extra) {
  const base = { type: 'keyDown', key: k, code: code, windowsVirtualKeyCode: extra || 0, nativeVirtualKeyCode: extra || 0 }
  await send('Input.dispatchKeyEvent', base)
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Page.navigate', { url: TOKEN_URL })
await sleep(3000)
await send('Page.navigate', { url: ORIGIN + '/' })
await sleep(4500)
let up = false
for (let i = 0; i < 30 && !up; i++) { up = await evalIn("!!document.querySelector('.dside-agent-platform')"); if (!up) await sleep(1000) }
let nodes = 0
for (let i = 0; i < 25 && !nodes; i++) { nodes = (await evalIn("(function(){var e=document.querySelector('.dside-agent-platform'); return e? e.querySelectorAll('*').length : 0})()")) || 0; if (!nodes) await sleep(1000) }
await sleep(2000)

// 输入：点进 composer 的 contenteditable 再插字（Lexical 认 beforeinput/insertText）
const focused = await evalIn(`(function(){
  var ed = document.querySelector('.dside-agent-platform [contenteditable="true"]');
  if (!ed) return 'no-editor';
  ed.focus();
  var sel = window.getSelection(); var r = document.createRange();
  r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  return 'focused';
})()`)
console.log('FOCUS: ' + focused)
await send('Input.insertText', { text: ASK })
await sleep(1200)
const typed = await evalIn("(function(){var e=document.querySelector('.dside-agent-platform [contenteditable=\"true\"]'); return e? (e.innerText||'').slice(0,60) : null})()")
console.log('TYPED: ' + JSON.stringify(typed))
await key('Enter', 'Enter', 13)
await sleep(2500)

// 等提问界面接管（最多 150s）：看面板里是否出现选项/翻页/跳过这类控件
let verdict = null
for (let i = 0; i < 50 && !verdict; i++) {
  const snap = await evalIn(`JSON.stringify((function(){
    var host = document.querySelector('.dside-agent-platform');
    var t = host ? (host.innerText||'').replace(/\\s+/g,' ') : '';
    var btns = host ? [].slice.call(host.querySelectorAll('button')).map(function(b){ return (b.innerText||b.getAttribute('aria-label')||'').trim() }).filter(Boolean) : [];
    return {
      text: t.slice(0, 320),
      hasOptions: /饺子/.test(t) && /面条/.test(t) && /火锅/.test(t),
      hasSkip: /跳过/.test(t), hasPager: /(下一页|上一个|Next|Skip)/i.test(t),
      hint: /(请选择|选择一个|回答问题|等待你)/.test(t),
      running: /\u8fd0\u884c\u4e2d|Running/.test(t),
      buttons: btns.slice(0, 8)
    }
  })())`)
  const s = JSON.parse(snap || '{}')
  if (s.hasOptions || s.hasSkip || s.hasPager) verdict = s
  else await sleep(3000)
}
console.log('QUESTION-UI: ' + JSON.stringify(verdict))
if (!verdict) console.log('（等不到提问界面 —— 模型可能没调用提问工具，或卡片没渲染）')
// 顺带：会话头按钮清单（验证"多余按钮"清理是否生效；空白会话不渲染头，所以这个探针能看到）
const buttons = await evalIn(`JSON.stringify((function(){
  var host = document.querySelector('.dside-agent-platform');
  if (!host) return null;
  var out = [].slice.call(host.querySelectorAll('button,[role="button"]')).map(function(b){
    var r = b.getBoundingClientRect();
    var t = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim().replace(/\\s+/g,' ').slice(0, 22);
    return { t: t, hidden: b.getAttribute('data-dside-hidden') === '1' || r.width === 0 };
  });
  return { all: out.length, hidden: out.filter(function(o){return o.hidden}).map(function(o){return o.t}),
           visible: out.filter(function(o){return !o.hidden}).map(function(o){return o.t}).slice(0, 12),
           headerEl: (function(){ var t = host.querySelector('[role="tab"]'); if (!t) return 'no-tabs';
             var hd = t.closest && t.closest('header'); if (!hd) return 'no-header-ancestor';
             return { hidden: hd.getAttribute('data-dside-hidden') === '1', display: hd.style.display, width: Math.round(hd.getBoundingClientRect().width) } })() };
})())`)
console.log('HEADER-BUTTONS: ' + buttons)
console.log('EXC(' + errs.length + '): ' + errs.slice(0, 3).join(' || '))
ws.close(); proc.kill(); await sleep(200); rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }); process.exit(0)
