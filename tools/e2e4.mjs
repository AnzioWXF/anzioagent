import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// DSH IDE ④ E2E（CDP 真浏览器）：VS Code 主题色 + VSCode 核心键位。
// 用法: node tools/e2e4.mjs   （前置：3081 后端已起；浏览器用系统 Edge/Chrome）
// 自清：fixture 文件 _e2e4_*.{js,txt} 建于 dshworkspace2 根，结束即删。
import { spawn } from 'node:child_process'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = `${__TIANGONG_ROOT}\\dshworkspace2`
const CDP_PORT = 9300 + Math.floor(Math.random() * 300) // 随机端口：避免与残留进程撞
const APP = 'http://127.0.0.1:3081'
const H = 'http://127.0.0.1:' + CDP_PORT
const __dirname = dirname(fileURLToPath(import.meta.url))
const FIX_A = join(ROOT, '_e2e4_demo.js')
const FIX_B = join(ROOT, '_e2e4_b.txt')

// ── fixture（先清旧）────────────────────────────────────────────
for (const p of [FIX_A, FIX_B]) if (existsSync(p)) rmSync(p)
writeFileSync(FIX_A, '// e2e theme probe comment\nconst greeting = "hello world";\nfunction add(a, b) { return a + b; }\nconsole.log(add(1, 2)); // tail\n')
writeFileSync(FIX_B, 'plain one\nplain two\nplain three\n')

// ── 断言收集 ────────────────────────────────────────────────────
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: ok ? '' : String(detail ?? '') })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' :: ' + detail}`)
}

// ── RPC helper（保留备用；注：sessions.open 是 client 本地状态，不走 host RPC）─
let rpcN = 0
async function rpc(method, payload) {
  const res = await fetch(`${APP}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'e2e4-' + (++rpcN), method, payload: payload || {} }),
  })
  const text = await res.text()
  let j = null
  try { j = JSON.parse(text) } catch { throw new Error(`${method}: http ${res.status} non-json: ${text.slice(0, 80)}`) }
  return j && j.result ? j.result : j
}

// ── 浏览器/CDP ──────────────────────────────────────────────────
async function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ]
  for (const c of cands) if (existsSync(c)) return c
  throw new Error('no edge/chrome found')
}
const userDir = join(`${__TIANGONG_ROOT}`, '.edge4-tmp-' + process.pid) // 每跑独立 profile
rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
const browser = await findBrowser()
console.log('browser:', browser)
const proc = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', '--run-all-compositor-stages-before-draw',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDir}`,
  APP + '/?file=' + encodeURIComponent(FIX_A),
], { stdio: 'ignore', detached: false })

let target = null
for (let i = 0; i < 40 && !target; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try {
    const list = await (await fetch(`${H}/json/list`)).json()
    target = (list || []).find((t) => t.type === 'page')
  } catch { /* not up yet */ }
}
if (!target) throw new Error('CDP target not found')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect error')) })
let msgId = 0
const pending = new Map()
let wsDead = false
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
ws.onclose = () => { wsDead = true; for (const [, fn] of pending) fn({ error: { message: 'ws closed' } }); pending.clear() }
ws.onerror = () => { wsDead = true; for (const [, fn] of pending) fn({ error: { message: 'ws error' } }); pending.clear() }
function cdp(method, params, timeoutMs) {
  if (wsDead) return Promise.reject(new Error('CDP ws dead'))
  return new Promise((resolve, reject) => {
    const id = ++msgId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, timeoutMs || 12000)
    pending.set(id, (m) => { clearTimeout(timer); resolve(m.result || { error: m.error }) })
    try { ws.send(JSON.stringify({ id, method, params: params || {} })) } catch (e) { clearTimeout(timer); reject(e) }
  })
}
async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval threw' }
  return r.result && r.result.value
}
async function waitFor(expr, ms, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await evalJs(expr)
    if (v && !v.__err) return v
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('waitFor timeout: ' + label)
}
async function key(vk, opts = {}) {
  // 页内合成 KeyboardEvent：Input.dispatchKeyEvent 会把 Ctrl+W 等当浏览器级
  // 快捷键（headless 直接关 tab、ws 断开）。我们的路由监听 window capture，
  // 合成事件同样触发，行为一致且不碰浏览器加速键。
  const { mod = 0, key } = opts
  const name = key || (vk >= 65 && vk <= 90 ? String.fromCharCode(vk) : String(vk))
  const ok = await evalJs(`(function(){
    try {
      var ev = new KeyboardEvent('keydown', {
        key: ${JSON.stringify(name)},
        code: ${JSON.stringify(name.length === 1 ? 'Key' + name.toUpperCase() : name)},
        ctrlKey: ${!!(mod & CT)}, shiftKey: ${!!(mod & SH)}, altKey: false, metaKey: false,
        bubbles: true, cancelable: true
      });
      window.dispatchEvent(ev);
      return !ev.defaultPrevented ? 'not-consumed' : 'consumed';
    } catch (e) { return 'threw: ' + e.message; }
  })()`)
  return ok
}
async function typeText(text) {
  // 直接经 monaco 公开 API 向 model 插字（位置 1:1）：模拟键盘在 headless 下
  // 进不了 monaco 隐藏 textarea（② 时代曾用真实键成功，本环境不稳定）。
  // pushEditOperations 走标准 onDidChangeContent → 脏标记/保存链路与手打一致。
  return evalJs(`(function(){
    try {
      var eds = window.monaco.editor.getEditors();
      if (!eds.length) return 'no-editor';
      var m = eds[0].getModel();
      if (!m) return 'no-model';
      var R = window.monaco.Range;
      m.pushEditOperations([], [{ range: new R(1, 1, 1, 1), text: ${JSON.stringify(text)} }], function () { return null; });
      return 'ok';
    } catch (e) { return 'threw: ' + e.message; }
  })()`)
}
const CT = 2 // ctrl modifier
const SH = 8 // shift
async function clickEditorCenter() {
  const pt = await evalJs(`(function(){var el=document.querySelector('.monaco-editor');if(!el)return null;var r=el.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})})()`)
  if (!pt) return false
  const p = JSON.parse(pt)
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  // monaco 真实输入走隐藏 textarea：确保焦点落在它上面（mousedown 偶发不聚焦）
  await evalJs(`(function(){var t=document.querySelector('.monaco-editor textarea');if(!t)return false;try{t.focus();return true}catch(e){return false}})()`)
  await new Promise((r) => setTimeout(r, 250))
  return true
}
const waitTabCount = (n, ms) => waitFor(`document.querySelectorAll('.dside-tab').length === ${n}`, ms, `tab count ${n}`)
const activeName = () => evalJs(`(function(){var a=document.querySelector('.dside-tab.active .dside-tab-name');return a?a.textContent:null})()`)

try {
  // root 解析：无活动会话时 host 兜底 workspaceRegistry.list()[0]
  // （当前 = dshworkspace2），文件树/读写沙箱根都落在 fixture 目录
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await waitFor(`document.querySelectorAll('.dside-root').length > 0`, 20000, 'dside root')
  await waitFor(`document.querySelectorAll('.dside-node').length > 0`, 25000, 'explorer nodes')

  // 主题偏好持久化在应用侧（上轮失败可能留在亮色）：启动强制回暗色再断言
  const curTheme = await evalJs(`(function(){var b=[].slice.call(document.querySelectorAll('.dside-titlebar .dside-btn')).find(function(x){return (x.getAttribute('title')||'').indexOf('切换')>=0});return b?b.getAttribute('title'):null})()`)
  if (curTheme && curTheme.indexOf('切换暗色') >= 0) {
    await evalJs(`(function(){var b=[].slice.call(document.querySelectorAll('.dside-titlebar .dside-btn')).find(function(x){return (x.getAttribute('title')||'').indexOf('切换暗色')>=0});if(b)b.click();return !!b})()`)
    await waitFor(`(function(){var b=[].slice.call(document.querySelectorAll('.dside-titlebar .dside-btn')).find(function(x){return (x.getAttribute('title')||'').indexOf('切换')>=0});return !b||b.getAttribute('title').indexOf('切换亮色')>=0})()`, 8000, 'forced dark')
  }

  // 主题文件已在 host 侧验证；页内再取一次确保 client fetch 没炸
  const routeOk = await evalJs(`fetch('/dsh-ide/themes/dark-modern.json?v=1').then(function(r){return r.ok})`)
  check('host themes 路由 200', routeOk === true, routeOk)

  // ── 开 demo.js（深链已开为第一标签）────────────────────────────
  await waitFor(`document.querySelectorAll('.dside-tab').length === 1`, 15000, 'deep-link tab')
  await waitFor(`document.querySelectorAll('.monaco-editor .view-lines').length > 0`, 20000, 'monaco view-lines')
  const errNow = await evalJs(`(function(){var e=document.querySelector('.dside-editor-error');return e?e.textContent.slice(0,200):null})()`)
  check('编辑器无错误态', errNow === null || errNow === undefined, errNow)
  // 内容级等待（容器空转不算数）：注释行文本真实渲染后再探色。
  // 注意：monaco 把行内空格渲染成 NBSP(U+00A0)，匹配前先归一化
  const hasComment = await waitFor(`(function(){var v=document.querySelector('.view-lines');if(!v)return false;return v.innerText.split(String.fromCharCode(160)).join(' ').indexOf('e2e theme probe comment') >= 0})()`, 45000, 'comment line text rendered')
  check('demo.js 注释行渲染', !!hasComment)

  // ── 主题色断言（Dark Modern：bg #1F1F1F、注释 #6A9955、字符串 #CE9178）─
  // monaco 0.56 的 js/ts token 上色走 worker 异步（headless 下偶发很慢）：
  // 轮询 + 定时"点击编辑器聚焦"作为重取 token 的 nudge
  const darkColorExpr = `(function(){
    var spans=[].slice.call(document.querySelectorAll('.view-line span')).filter(function(x){return /(^|\\s)mtk/.test(x.className)});
    var f={c:null,s:null};
    for (var i=0;i<spans.length;i++){
      var t=spans[i].textContent.split(String.fromCharCode(160)).join(' ');
      if(t.indexOf('// e2e')>=0&&!f.c) f.c=getComputedStyle(spans[i]).color;
      if(t.indexOf('"hello world"')>=0&&!f.s) f.s=getComputedStyle(spans[i]).color;
    }
    if(f.c==='rgb(106, 153, 85)'&&f.s==='rgb(206, 145, 120)')
      return JSON.stringify({bg:getComputedStyle(document.querySelector('.monaco-editor')).backgroundColor,comment:f.c,str:f.s});
    return false;
  })()`
  let c1 = null
  const dT0 = Date.now()
  while (Date.now() - dT0 < 90000 && !c1) {
    const v = await evalJs(darkColorExpr)
    if (v && typeof v === 'string') c1 = JSON.parse(v)
    else {
      const elapsed = Date.now() - dT0
      if (elapsed > 30000 && elapsed < 32000) await clickEditorCenter() // 30s 时 nudge 一次
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  if (!c1) throw new Error('dark theme token colors never applied (worker flake)')
  check('主题编辑器背景 = #1F1F1F (rgb(31,31,31))', c1.bg === 'rgb(31, 31, 31)', JSON.stringify(c1))
  check('注释色 = Dark Modern #6A9955', c1.comment === 'rgb(106, 153, 85)', JSON.stringify(c1))
  check('字符串色 = Dark Modern #CE9178', c1.str === 'rgb(206, 145, 120)', JSON.stringify(c1))

  // ── Ctrl+W 关标签 / Ctrl+Shift+T 重开 ───────────────────────────
  console.log('[step] ctrl+w / ctrl+shift+t')
  await key(87, { mod: CT, key: 'w' })
  await waitTabCount(0, 8000)
  check('Ctrl+W 关闭标签', true)
  await key(84, { mod: CT | SH, key: 'T' })
  await waitTabCount(1, 8000)
  const name1 = await activeName()
  check('Ctrl+Shift+T 重开标签', name1 === '_e2e4_demo.js', name1)

  // ── 弄脏 + Ctrl+K S 全部保存（和弦，Ctrl 保持按住）───────────────
  console.log('[step] typing + chord save')
  await clickEditorCenter()
  await new Promise((r) => setTimeout(r, 300))
  await typeText('zz')
  await new Promise((r) => setTimeout(r, 500))
  const dirty = await evalJs(`(function(){var t=document.querySelector('.dside-tab.active');return !!(t&&t.querySelector('.dside-dot.dirty'))})()`)
  check('键入后脏标记 ●', dirty === true, dirty)
  await key(75, { mod: CT, key: 'k' })
  await new Promise((r) => setTimeout(r, 120))
  await key(83, { mod: CT, key: 's' })
  await new Promise((r) => setTimeout(r, 1200))
  const cleanDot = await evalJs(`(function(){var t=document.querySelector('.dside-tab.active');return !!(t&&t.querySelector('.dside-dot.dirty'))})()`)
  const onDisk = existsSync(FIX_A) ? String(await (await import('node:fs/promises')).readFile(FIX_A, 'utf8')) : ''
  check('Ctrl+K S 后脏标记清除', cleanDot === false, cleanDot)
  check('Ctrl+K S 落盘（含键入内容）', onDisk.indexOf('zz') >= 0, 'zz in disk?')

  // 和弦变体：Ctrl+K 松开后再按裸 S（VSCode 也是常见按法）
  await clickEditorCenter()
  await new Promise((r) => setTimeout(r, 200))
  await typeText('y')
  await key(75, { mod: CT, key: 'k' })
  await key(83, { key: 's' }) // 松开 Ctrl 后的裸 S（和弦第二步同样认）
  await new Promise((r) => setTimeout(r, 1000))
  const onDisk2 = String(await (await import('node:fs/promises')).readFile(FIX_A, 'utf8'))
  check('和弦变体（松开 Ctrl 裸 S）也保存', onDisk2.indexOf('y') >= 0 && onDisk2.indexOf('zz') >= 0, 'yy?')

  // ── 双标签 + Ctrl+Tab / PageUp / PageDown ───────────────────────
  console.log('[step] two tabs + cycling')
  const openedB = await evalJs(`(function(){var ns=[].slice.call(document.querySelectorAll('.dside-node-name'));var n=ns.find(function(x){return x.textContent.trim()==='_e2e4_b.txt'});if(!n)return false;n.parentElement.click();return true})()`)
  check('点开 b.txt', openedB === true)
  await waitTabCount(2, 8000)
  const nmB = await activeName()
  check('b.txt 激活', nmB === '_e2e4_b.txt', nmB)
  await key(9, { mod: CT, key: 'Tab' }) // Ctrl+Tab → demo
  await waitFor(`(document.querySelector('.dside-tab.active .dside-tab-name')||{}).textContent === '_e2e4_demo.js'`, 6000, 'ctrl+tab to demo')
  check('Ctrl+Tab 切到上一文件', true)
  await key(9, { mod: CT | SH, key: 'Tab' }) // Ctrl+Shift+Tab → b
  await waitFor(`(document.querySelector('.dside-tab.active .dside-tab-name')||{}).textContent === '_e2e4_b.txt'`, 6000, 'ctrl+shift+tab to b')
  check('Ctrl+Shift+Tab 切回 b', true)
  await key(33, { mod: CT, key: 'PageUp' }) // Ctrl+PageUp → demo
  await waitFor(`(document.querySelector('.dside-tab.active .dside-tab-name')||{}).textContent === '_e2e4_demo.js'`, 6000, 'pageup to demo')
  check('Ctrl+PageUp 上一标签', true)
  await key(34, { mod: CT, key: 'PageDown' })
  await waitFor(`(document.querySelector('.dside-tab.active .dside-tab-name')||{}).textContent === '_e2e4_b.txt'`, 6000, 'pagedown to b')
  check('Ctrl+PageDown 下一标签', true)

  // ── Ctrl+W 关 b、Ctrl+Shift+T 重开（栈序）──────────────────────
  await key(87, { mod: CT, key: 'w' })
  await waitTabCount(1, 8000)
  check('Ctrl+W 关 b（栈顶=demo）', true)
  await key(84, { mod: CT | SH, key: 'T' })
  await waitTabCount(2, 8000)
  const nmRe = await activeName()
  check('Ctrl+Shift+T 重开 b', nmRe === '_e2e4_b.txt', nmRe)

  // ── Ctrl+B 显隐文件树 ──────────────────────────────────────────
  console.log('[step] ctrl+b explorer')
  const ex1 = await evalJs(`document.querySelectorAll('.dside-explorer').length`)
  await key(66, { mod: CT, key: 'b' })
  await waitFor(`document.querySelectorAll('.dside-explorer').length === 0`, 6000, 'explorer hidden')
  check('Ctrl+B 隐藏文件树', true)
  await key(66, { mod: CT, key: 'b' })
  await waitFor(`document.querySelectorAll('.dside-explorer').length === 1`, 6000, 'explorer shown')
  check('Ctrl+B 恢复文件树', true)

  // ── F1 命令面板 + Esc ──────────────────────────────────────────
  console.log('[step] F1 palette')
  await key(112, { key: 'F1' })
  await waitFor(`document.querySelectorAll('.dside-overlay').length > 0`, 6000, 'F1 overlay')
  const palText = await evalJs(`(document.querySelector('.dside-overlay')||{}).textContent || ''`)
  check('F1 打开命令面板', palText.indexOf('重新打开已关闭的标签') >= 0 && palText.indexOf('切换文件树显示') >= 0, palText.slice(0, 60))
  await key(27, { key: 'Escape' })
  await waitFor(`document.querySelectorAll('.dside-overlay').length === 0`, 6000, 'esc closes')
  check('Esc 关闭面板', true)

  // ── 亮色切换：编辑器跟随 Light Modern（bg #FFFFFF、注释 #008000）──
  // 先激活 demo.js（当前是 b.txt 纯文本，没有注释 token 可验色）
  console.log('[step] light/dark theme switch')
  const actDemo = await evalJs(`(function(){var ts=[].slice.call(document.querySelectorAll('.dside-tab'));var t=ts.find(function(x){return (x.querySelector('.dside-tab-name')||{}).textContent==='_e2e4_demo.js'});if(!t)return false;t.click();return true})()`)
  check('切回 demo.js 标签', actDemo === true)
  await waitFor(`(function(){var v=document.querySelector('.view-lines');if(!v)return false;return v.innerText.split(String.fromCharCode(160)).join(' ').indexOf('e2e theme probe comment') >= 0})()`, 15000, 'demo text visible again')
  const toLight = await evalJs(`(function(){var b=[].slice.call(document.querySelectorAll('.dside-titlebar .dside-btn')).find(function(x){return (x.getAttribute('title')||'').indexOf('切换亮色')>=0});if(!b)return false;b.click();return true})()`)
  check('点击标题栏切亮色', toLight === true)
  await waitFor(`getComputedStyle(document.querySelector('.monaco-editor')).backgroundColor === 'rgb(255, 255, 255)'`, 10000, 'light editor bg')
  const lightExpr = `(function(){
    var spans=[].slice.call(document.querySelectorAll('.view-line span')).filter(function(x){return /(^|\\s)mtk/.test(x.className)});
    for (var i=0;i<spans.length;i++){
      var t=spans[i].textContent.split(String.fromCharCode(160)).join(' ');
      if(t.indexOf('// e2e')>=0 && getComputedStyle(spans[i]).color==='rgb(0, 128, 0)')
        return getComputedStyle(spans[i]).color;
    }
    return false;
  })()`
  let colors2 = false
  const lT0 = Date.now()
  while (Date.now() - lT0 < 60000 && !colors2) {
    const v = await evalJs(lightExpr)
    if (v && typeof v === 'string') colors2 = v
    else {
      const elapsed = Date.now() - lT0
      if (elapsed > 20000 && elapsed < 22000) await clickEditorCenter()
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  if (!colors2) throw new Error('light comment color never applied (worker flake)')
  check('亮色注释 = Light Modern #008000', colors2 === 'rgb(0, 128, 0)', colors2)
  const toDark = await evalJs(`(function(){var b=[].slice.call(document.querySelectorAll('.dside-titlebar .dside-btn')).find(function(x){return (x.getAttribute('title')||'').indexOf('切换暗色')>=0});if(!b)return false;b.click();return true})()`)
  check('切回暗色', toDark === true)
  await waitFor(`getComputedStyle(document.querySelector('.monaco-editor')).backgroundColor === 'rgb(31, 31, 31)'`, 10000, 'dark editor bg back')
  check('暗色编辑器背景恢复 #1F1F1F', true)
} catch (e) {
  check('E2E 运行无异常', false, String((e && e.message) || e))
  try {
    const dump = await evalJs(`(function(){
      var out = {};
      out.tabs = [].slice.call(document.querySelectorAll('.dside-tab-name')).map(function(x){return x.textContent});
      out.active = (function(){var a=document.querySelector('.dside-tab.active .dside-tab-name');return a?a.textContent:null})();
      out.monaco = document.querySelectorAll('.monaco-editor').length;
      out.vl = document.querySelectorAll('.view-line').length;
      out.vlText = (function(){var v=document.querySelector('.view-lines');return v? v.innerText.slice(0,200):null})();
      out.err = (function(){var e=document.querySelector('.dside-editor-error');return e? e.textContent.slice(0,200):null})();
      out.loading = (function(){var e=document.querySelector('.dside-editor-overlay');return e? e.textContent.slice(0,100):null})();
      out.spans = document.querySelectorAll('.view-line span').length;
      return JSON.stringify(out);
    })()`)
    console.log('FAIL-DUMP:', dump)
    const shot = await cdp('Page.captureScreenshot', { format: 'png' }); if (shot && shot.data) writeFileSync(join(__dirname, 'e2e4-fail.png'), Buffer.from(shot.data, 'base64'))
  } catch { /* ignore */ }
}

// ── 清理（进程句柄可能短暂占用 profile 目录：强杀 + 重试删除）────
try { await cdp('Browser.close') } catch { /* ignore */ }
try { proc.kill() } catch { /* ignore */ }
for (const p of [FIX_A, FIX_B]) { try { rmSync(p, { force: true }) } catch { /* ignore */ } }
try { await new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000) }) } catch { /* ignore */ }
try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
for (let i = 0; i < 10; i++) {
  try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }); break } catch { await new Promise((r) => setTimeout(r, 600)) }
}
try { ws.close() } catch { /* ignore */ }

const fails = results.filter((r) => !r.ok)
console.log(`\n== E2E4 summary: ${results.length - fails.length}/${results.length} passed ==`)
process.exit(fails.length ? 1 : 0)
