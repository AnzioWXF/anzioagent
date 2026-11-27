import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// e2e-composer.mjs — 右侧 chat 面板「对话框」控件探针（2026-09-22）
//
// 起因（用户报障）："对话框左上的工作区切换、创造模式切换、右下的模型切换，这三个下拉都用不了"。
//   + 两条版面要求：① 左上那个工作区切换没什么用，去掉；② 创造模式搬到「完全权限」右边。
//
// 根因（本探针 P3 断言的那条）：平台的弹层（下拉菜单 z-index 100/1100、模态 1000、toast 1100）
//   全都 **portal 到 document.body**，而天工的 `.dside-root{position:fixed;inset:0;z-index:2000}`
//   把整个 body 盖在自己底下 ⇒ 菜单**确实打开了、却在天工根节点后面**（点不到、看不见）。
//   ⇒ 本探针不靠肉眼：点开下拉后，量菜单中心点 `document.elementFromPoint()` 是否落在菜单内部。
//
// 用法: node tools\e2e-composer.mjs   （自起隔离测试后端 + 无头 Edge，自建自清）
//   ⚠ 测试家目录必须先用 dev-testhome.ps1 -TestHome <路径> 生成过（§6 90①），否则插件不挂载。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, openSync, closeSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const PORT = Number(process.env.DSH_E2E_PORT || 3096)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = process.env.DSH_E2E_HOME || `${__TIANGONG_ROOT}\\.smoke-home-composer`
const WS = process.env.DSH_E2E_WS || `${__TIANGONG_ROOT}\\.smoke-ws-composer`
const CLI = `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js`
const BLOG = `${__TIANGONG_ROOT}\\_e2ecomposer_backend_` + PORT + '.log'
const SHOT = `${__TIANGONG_ROOT}\\_e2e-logs\\composer-` + Date.now() + '.png'
const CDP_PORT = 9700 + Math.floor(Math.random() * 90)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' :: ' + String(detail ?? '')}`)
}
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

// ── 页内脚本 ──────────────────────────────────────────────────────────────
// 找出对话框里那四个控件（按可访问名认，不认 CSS-module 哈希 —— §6 65 的纪律）
const TRIGGERS = `(function(){
  var host = document.querySelector('.dside-agent-platform') || document;
  var out = { workspace: null, preset: null, model: null, access: null, buttons: 0 };
  function rectOf(b){ var r=b.getBoundingClientRect();
    return { x:Math.round(r.left), y:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height),
      cx:Math.round(r.left+r.width/2), cy:Math.round(r.top+r.height/2), right:Math.round(r.right),
      disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true',
      title:(b.getAttribute('title')||''), label:(b.getAttribute('aria-label')||''), text:((b.textContent||'').trim()).slice(0,24) } }
  var bs = host.querySelectorAll('button');
  out.buttons = bs.length;
  for (var i=0;i<bs.length;i++){
    var b=bs[i], lab=b.getAttribute('aria-label')||'', ti=b.getAttribute('title')||'';
    if (!out.workspace && lab.indexOf('选择工作区')>=0) out.workspace=rectOf(b);
    else if (!out.preset && (ti.indexOf('即将开始')>=0 || ti.indexOf('Agent 预设')>=0)) out.preset=rectOf(b);
    else if (!out.model && lab.indexOf('选择模型')>=0) out.model=rectOf(b);
    else if (!out.access && lab.indexOf('访问模式')>=0) out.access=rectOf(b);
  }
  return out })()`

// 菜单「在最上层」判据：菜单中心点的 elementFromPoint 必须落在菜单内部
const MENU_PROBE = `(function(){
  var ms=document.querySelectorAll('[role="menu"]'), best=null;
  for (var i=0;i<ms.length;i++){ var rr=ms[i].getBoundingClientRect(); if (rr.width>10 && rr.height>10) { best=ms[i]; break } }
  var root=document.querySelector('.dside-root');
  if (!best) return { found:false, count:ms.length, rootZ: root?getComputedStyle(root).zIndex:null };
  var r=best.getBoundingClientRect();
  var cx=Math.round(r.left+r.width/2), cy=Math.round(r.top+r.height/2);
  var top=document.elementFromPoint(cx,cy);
  return { found:true, count:ms.length, cx:cx, cy:cy,
    rect:{ left:Math.round(r.left), top:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height) },
    inside: !!(top && best.contains(top)),
    topTag: top?top.tagName:'(none)', topCls: top?(String(top.className)||'').slice(0,44):'',
    menuZ: getComputedStyle(best).zIndex, rootZ: root?getComputedStyle(root).zIndex:null };
})()`

async function main() {
  rmSync(BLOG, { force: true })
  const fd = openSync(BLOG, 'w')
  const backend = spawn(process.execPath, [CLI, 'web', '--port', String(PORT), '--no-open'], {
    cwd: `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness`, env: cleanEnv(), stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  let backendExit = null
  backend.on('exit', (c) => { backendExit = c })
  let browser = null
  const userDir = `${__TIANGONG_ROOT}\\.edge-e2ecomposer-tmp-` + process.pid
  try {
    let token = ''
    const t0 = Date.now()
    while (Date.now() - t0 < 120000) {
      await sleep(500)
      if (backendExit !== null) throw new Error('backend exited early (' + backendExit + ') — 端口 ' + PORT + ' 被占用？')
      let txt = ''
      try { txt = readFileSync(BLOG, 'utf8') } catch { /* not yet */ }
      const m = txt.match(/\?token=([A-Za-z0-9._-]+)/)
      if (m) { token = m[1]; break }
    }
    if (!token) throw new Error('no token in backend log')

    rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
    mkdirSync(WS + '\\src', { recursive: true })
    writeFileSync(WS + '\\src\\hello.txt', 'hello composer\n')

    try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch { /* Windows 文件锁 */ }
    browser = spawn(findBrowser(), [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDir,
      APP + '/?token=' + token,
    ], { stdio: 'ignore' })

    let target = null
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(500)
      try {
        const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
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
        pageErrors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 160))
      }
    }
    ws.onclose = () => { wsDead = true; for (const [, f] of pending) f({ error: { message: 'ws closed' } }); pending.clear() }
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
      while (Date.now() - t < ms) { const v = await evalJs(expr); if (v && !v.__err) return v; await sleep(200) }
      return null
    }
    // ⚠ waitFor 不能把求值异常当真值（§6 90②）
    async function clickAt(x, y) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
      await sleep(80)
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    }
    async function pressEscape() {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await cdp('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
      }
      await sleep(250)
    }
    /** 点开一个控件、量菜单是否在最上层，然后 Esc 关掉 */
    async function openAndProbe(name, rect) {
      if (!rect) return { found: false, missing: true }
      // 先看"控件中心点上到底是谁"——如果被别的东西盖住，点击本身就落空了（§6 76 的镜子）
      const hit = await evalJs(`(function(){ var el=document.elementFromPoint(${rect.cx},${rect.cy});
        if (!el) return null;
        var btn = el.closest ? el.closest('button') : null;
        return { tag:el.tagName, cls:String(el.className||'').slice(0,44), txt:((el.textContent||'').trim()).slice(0,16),
          sameButton: !!(btn && Math.abs(btn.getBoundingClientRect().left-${rect.x})<2 && Math.abs(btn.getBoundingClientRect().top-${rect.y})<2) } })()`)
      await clickAt(rect.cx, rect.cy)
      let p = null
      for (const wait of [350, 600, 900]) {
        await sleep(wait)
        p = await evalJs(MENU_PROBE)
        if (p && p.found) break
      }
      await pressEscape()
      await clickAt(5, 5).catch(() => {})   // 兜底：点空白处关掉
      await sleep(250)
      return Object.assign({ name, trigger: rect, hit }, p || { found: false })
    }

    await cdp('Runtime.enable')
    await cdp('Page.enable')
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    const ready = await waitFor(`!!document.querySelector('.dside-root') && !!window.monaco`, 90000)
    check('P1 页面挂载完成（天工 root + monaco）', !!ready, await evalJs('document.readyState'))
    await cdp('Page.reload', { ignoreCache: false })
    await sleep(2500)
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    const ready2 = await waitFor(`!!document.querySelector('.dside-root') && !!window.monaco`, 90000)
    check('P1b 重载后仍挂载', !!ready2)

    // 专用安静工作区（客户端会按会话 cwd 覆盖 active-root，见 §6 69）
    let rootOk = false
    for (let i = 0; i < 12 && !rootOk; i++) {
      await fetch(APP + '/dsh-ide/active-root', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: WS }),
      })
      await sleep(700)
      rootOk = await evalJs(`(function(){ var n=document.querySelectorAll('.dside-node-name'); for (var i=0;i<n.length;i++) if (n[i].textContent.trim()==='src') return true; return false })()`)
    }
    check('P2 工作区根已生效（树里能看到 fixture）', rootOk)

    // 点「＋ 新对话」→ 拿到 hero（空白会话）阶段的对话框
    const clicked = await evalJs(`(function(){ var bs=document.querySelectorAll('.dside-side-actions button');
      for (var i=0;i<bs.length;i++){ if ((bs[i].textContent||'').indexOf('新对话')>=0) { bs[i].click(); return true } } return false })()`)
    const heroOk = await waitFor(`(function(){ var r=document.querySelector('.dside-agent-platform [data-phase]'); return r?r.getAttribute('data-phase'):null })()`, 30000)
    const trg0 = await waitFor(TRIGGERS, 30000)
    check('P3 新对话进入 hero 阶段、对话框控件就位',
      !!(clicked && heroOk === 'hero' && trg0 && trg0.model && trg0.access), 'phase=' + heroOk + ' triggers=' + JSON.stringify(trg0))

    // 三个下拉必须都是"可点"的（禁用态点不动 —— 基线那轮模型菜单没抓到，先排除这条）
    const enabled = !!(trg0 && trg0.model && !trg0.model.disabled
      && trg0.preset && !trg0.preset.disabled
      && trg0.access && !trg0.access.disabled)
    check('P3b 工作区/创造模式/模型三个控件都不是禁用态', enabled,
      JSON.stringify({ model: trg0 && trg0.model && trg0.model.disabled, preset: trg0 && trg0.preset && trg0.preset.disabled, access: trg0 && trg0.access && trg0.access.disabled }))

    // ★ 根因断言：平台弹层必须在天工根节点**之上**
    const modelProbe = await openAndProbe('model', trg0 && trg0.model)
    check('P4 模型下拉打开后在最上层（菜单中心点命中菜单本身）',
      !!(modelProbe && modelProbe.found && modelProbe.inside === true),
      JSON.stringify(modelProbe))
    check('P5 天工根节点的 z-index 低于平台弹层（< 菜单 z-index）',
      !!(modelProbe && modelProbe.found && Number(modelProbe.rootZ) < Number(modelProbe.menuZ)),
      'rootZ=' + (modelProbe && modelProbe.rootZ) + ' menuZ=' + (modelProbe && modelProbe.menuZ))

    const presetProbe = await openAndProbe('preset', trg0 && trg0.preset)
    check('P6 创造模式下拉打开后在最上层',
      !!(presetProbe && presetProbe.found && presetProbe.inside === true), JSON.stringify(presetProbe))

    const accessProbe = await openAndProbe('access', trg0 && trg0.access)
    check('P7 访问模式（完全权限）下拉打开后在最上层',
      !!(accessProbe && accessProbe.found && accessProbe.inside === true), JSON.stringify(accessProbe))

    // 用户要求 ①：工作区切换去掉
    const trg1 = await evalJs(TRIGGERS)
    check('P8 对话框里已经没有「工作区切换」', !!(trg1 && !trg1.workspace), JSON.stringify(trg1 && trg1.workspace))

    // 用户要求 ②：创造模式在「完全权限」右边（同一行、x 在它右侧）
    const a = trg1 && trg1.access, p = trg1 && trg1.preset
    check('P9 创造模式控件在「完全权限」右边同一行',
      !!(a && p && p.x >= a.right - 2 && Math.abs(p.cy - a.cy) <= 14),
      JSON.stringify({ access: a, preset: p }))

    await sleep(400)
    check('P10 页面零未捕获异常', pageErrors.length === 0, pageErrors.join(' | '))

    // 截图（人眼验收用）
    try {
      const shot = await cdp('Page.captureScreenshot', { format: 'png' })
      if (shot && shot.data) { mkdirSync(`${__TIANGONG_ROOT}\\_e2e-logs`, { recursive: true }); writeFileSync(SHOT, Buffer.from(shot.data, 'base64')); console.log('[SHOT] ' + SHOT) }
    } catch { /* 截图失败不影响断言 */ }

    const pass = results.filter((r) => r.ok).length
    console.log(`\n== e2e-composer: ${pass}/${results.length} ==`)
    if (pass !== results.length) process.exitCode = 1
  } finally {
    try { if (browser) browser.kill() } catch { /* ignore */ }
    try { spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    setTimeout(() => {
      try { rmSync(userDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch { /* Windows 文件锁 */ }
      process.exit(process.exitCode || 0)
    }, 1200)
  }
}
main().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(1) })
