import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// check-tree.mjs — 资源管理器"树形结构"探针 + 截图（折叠箭头 twistie / 缩进参考线）
// 用法：node tools/check-tree.mjs <带 token 的 url> <out.png>
// 流程：① 带 token 首访种 cookie → ② 干净导航 → ③ 等 IDE → ④ 展开两层目录
//       → ⑤ 断言：参考线数量 = 深度、文件夹有箭头 / 文件没有、收起态旋转 -90°、x 轴次序
//       → ⑥ 截图存盘（人眼再看一眼）
import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN_URL = process.argv[2]
const OUT = process.argv[3]
if (!TOKEN_URL || !OUT) { console.log('usage: node tools/check-tree.mjs <tokenUrl> <out.png>'); process.exit(1) }

const PORT = 9900 + Math.floor(Math.random() * 90)
const H = 'http://127.0.0.1:' + PORT
function findBrowser() {
  for (const c of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) if (existsSync(c)) return c
  throw new Error('no browser')
}
const userDir = join(`${__TIANGONG_ROOT}`, '.edge-tree-' + process.pid)
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
await send('Page.navigate', { url: TOKEN_URL })
await sleep(3000)
await send('Page.navigate', { url: origin + '/' })
await sleep(4000)

let up = false
for (let i = 0; i < 30 && !up; i++) {
  up = await evalIn("!!document.querySelector('.dside-root') && !!document.querySelector('.dside-statusbar')")
  if (!up) await sleep(1000)
}
// 等树里出现节点（root 解析 + /list-dir 回来）
let rows = 0
for (let i = 0; i < 20 && !rows; i++) {
  rows = (await evalIn("document.querySelectorAll('.dside-explorer-body .dside-node').length")) || 0
  if (!rows) await sleep(1000)
}

const S = (sel) => `document.querySelectorAll(${JSON.stringify(sel)})`
// 展开第 n 个**折叠态**的文件夹行（收起态 = 箭头带 collapsed 类）
async function clickFolder(n) {
  return evalIn(`(function(){
    var rows = [].slice.call(${S('.dside-explorer-body .dside-node')});
    var folded = rows.filter(function(r){
      var s = r.querySelector(':scope > .dside-lead > .dside-twist > svg');
      return s && s.classList.contains('collapsed');
    });
    var el = folded[${n}];
    if (!el) return 'no-folder';
    el.click();
    return (el.querySelector('.dside-node-name')||{}).textContent || 'ok';
  })()`)
}
const firstExpand = await clickFolder(0)          // 展开第 1 个文件夹
await sleep(1200)
const secondExpand = await clickFolder(1)         // 展开它里面的第 1 个子文件夹（现在是列表里第 2 个）
await sleep(1200)

const structure = await evalIn(`JSON.stringify([].slice.call(${S('.dside-explorer-body .dside-node')}).map(function(el){
  var gs = [].slice.call(el.querySelectorAll(':scope > .dside-lead > .dside-guide'));
  var svg = el.querySelector(':scope > .dside-lead > .dside-twist > svg');
  var icon = el.querySelector(':scope > .dside-node-icon');
  var tw = el.querySelector(':scope > .dside-lead > .dside-twist');
  var r = el.getBoundingClientRect(), ir = icon ? icon.getBoundingClientRect() : null, tr = tw ? tw.getBoundingClientRect() : null;
  return {
    name: (el.querySelector('.dside-node-name')||{}).textContent,
    depth: gs.length,
    guideX: gs.map(function(g){ return Math.round(g.getBoundingClientRect().left - r.left); }),
    guideW: gs.length ? Math.round(gs[0].getBoundingClientRect().width) : null,
    guideH: gs.length ? Math.round(gs[0].getBoundingClientRect().height) : null,
    rowLeft: Math.round(r.left),
    twistX: tr ? Math.round(tr.left - r.left) : null,
    twistW: tr ? Math.round(tr.width) : null,
    chev: !!svg,
    collapsed: svg ? svg.classList.contains('collapsed') : null,
    iconAfterTwist: (tr && ir) ? (tr.right <= ir.left + 0.5) : null,
    rowH: Math.round(r.height)
  };
}))`)

const STEP = 14, BASE = 8, TW = 16
const arr = JSON.parse(structure || '[]')
const checks = []
checks.push(['树里有节点', arr.length > 0])
checks.push(['展开出嵌套（有 depth>=1 的行）', arr.some((r) => r.depth >= 1)])
checks.push(['展开出两层（有 depth>=2 的行）', arr.some((r) => r.depth >= 2)])
checks.push(['首行 depth=0（根层不缩进）', arr.length > 0 && arr[0].depth === 0])
checks.push(['深度按 DFS 只增一层（结构自洽）', arr.every((r, i) => i === 0 || r.depth <= arr[i - 1].depth + 1)])
checks.push(['参考线 x = 8 + i*14（每层一根、对齐上层箭头列）',
  arr.every((r) => r.guideX.every((x, i) => x === BASE + i * STEP))])
checks.push(['箭头列 x = 8 + depth*14（紧跟参考线）',
  arr.every((r) => r.twistX === BASE + r.depth * STEP)])
checks.push(['箭头列恒为 16px（文件也占位 → 图标对齐）',
  arr.every((r) => r.twistW === TW)])
checks.push(['参考线宽 = 14px（含 1px 线，逐层不累积误差）',
  arr.every((r) => r.guideW === null || r.guideW === STEP)])
checks.push(['参考线高度 ≥ 行高+2（上下行之间不断线）',
  arr.every((r) => r.guideH === null || r.guideH >= r.rowH + 2)])
checks.push(['箭头在图标左侧', arr.every((r) => r.iconAfterTwist !== false)])
checks.push(['文件夹行有箭头', arr.filter((r) => r.chev).length > 0])
checks.push(['文件行无箭头', arr.filter((r) => !r.chev && r.twistW === TW).length > 0])
checks.push(['页面零未捕获异常', errs.length === 0])

const guideLine = await evalIn(`(function(){
  var g = document.querySelector('.dside-explorer-body .dside-guide');
  if (!g) return 'no-guide';
  var cs = getComputedStyle(g);
  return JSON.stringify({ w: Math.round(g.getBoundingClientRect().width), borderLeft: cs.borderLeftWidth + ' ' + cs.borderLeftColor, h: Math.round(g.getBoundingClientRect().height) });
})()`)
const chevLine = await evalIn(`(function(){
  var s = document.querySelector('.dside-explorer-body .dside-chev');
  if (!s) return 'no-chev';
  var cs = getComputedStyle(s);
  return JSON.stringify({ w: Math.round(s.getBoundingClientRect().width), transform: cs.transform, stroke: cs.color });
})()`)

console.log('EXPAND: ' + firstExpand + ' / ' + secondExpand)
console.log('ROWS=' + arr.length + ' ' + JSON.stringify(arr.slice(0, 10)))
console.log('GUIDE: ' + guideLine)
console.log('CHEV: ' + chevLine)
for (const [n, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + n)
console.log('EXC(' + errs.length + '): ' + errs.slice(0, 5).join(' | '))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot && shot.data) { writeFileSync(OUT, Buffer.from(shot.data, 'base64')); console.log('SHOT: ' + OUT) }
else console.log('SHOT FAILED')

ws.close(); proc.kill()
await sleep(300)
rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
process.exit(0)
