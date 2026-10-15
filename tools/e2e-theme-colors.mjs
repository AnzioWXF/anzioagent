// e2e-theme-colors.mjs — 编辑器配色「选中态可辨认」探针（2026-09-21）
//
// 起因（用户报障）："文字选中的时候的背景颜色，跟光标聚焦到附近时文字的背景色一模一样，
//   导致选中某段文字看不出来选没选中"。
// 根因：我们的 static/themes/*-modern.json 是**拍平的 VSCode 主题文件**，而 VSCode 官方那两个
//   主题文件里**本来就没有 `editor.selectionBackground`** —— 它在 VSCode 里是
//   `src/vs/platform/theme/common/colors/editorColors.ts:121` 的**注册默认值**（dark #264F78 /
//   light #ADD6FF），拍平成 JSON 时丢了。我们那份又没有任何兜底 → monaco 落回它自己的老默认，
//   而 claude 的 `--dsw-alias-interactive-bg-active`（rgba(255,255,255,.14)）又盖在同词高亮上 ⇒
//   选中 / 同词高亮 / 行高亮 三者糊成一片。
//
// 本探针**不靠肉眼看截图**：在页面启动最开头把 `monaco.editor.defineTheme` 包一层代理，把
//   **真正喂给 monaco 的色板对象**抓下来（这是"monaco 到底收到什么"的第一手证据，不是读我们的源文件），
//   再断言三个色**两两不同**且与 VSCode 规格一致；另外顺带断言编辑器右上角不再有「保存」按钮。
//
// 用法: node D:\99DSH\tools\e2e-theme-colors.mjs   （自起隔离测试后端 + 无头 Edge，自建自清）
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, openSync, closeSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const PORT = Number(process.env.DSH_E2E_PORT || 3099)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = process.env.DSH_E2E_HOME || 'D:\\99DSH\\.smoke-home-colors'
const WS = process.env.DSH_E2E_WS || 'D:\\99DSH\\.smoke-ws-colors'
const CLI = 'D:\\99DSH\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js'
const BLOG = 'D:\\99DSH\\_e2ecolors_backend_' + PORT + '.log'
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

// 规格（VSCode 1.138.0 源码）：
//   editorColors.ts:121  editor.selectionBackground         dark #264F78 / light #ADD6FF
//   editorColors.ts:129  editor.inactiveSelectionBackground = transparent(sel, .5) → 8 位 hex
//   highlightDecorations.ts:14  editor.wordHighlightBackground  dark #575757B8 / light #57575740
const SPEC = {
  'editor.selectionBackground': { dark: '#264F78', light: '#ADD6FF' },
  'editor.selectionHighlightBackground': { dark: '#575757B8', light: '#57575740' },
  'editor.wordHighlightBackground': { dark: '#575757B8', light: '#57575740' },
}

async function main() {
  rmSync(BLOG, { force: true })
  const fd = openSync(BLOG, 'w')
  const backend = spawn(process.execPath, [CLI, 'web', '--port', String(PORT), '--no-open'], {
    cwd: 'D:\\99DSH\\deepseek-harness-mine\\harness', env: cleanEnv(), stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  let backendExit = null
  backend.on('exit', (c) => { backendExit = c })
  let browser = null
  const userDir = 'D:\\99DSH\\.edge-e2ecolors-tmp-' + process.pid
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
    // fixture：一段有重复词、够长的文本，方便看"选中 vs 同词高亮"的区别
    writeFileSync(WS + '\\src\\pick.txt', 'alpha beta alpha gamma\nsecond line alpha here\nthird line of text\n')

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
      while (Date.now() - t < ms) { const v = await evalJs(expr); if (v) return v; await sleep(200) }
      return null
    }

    // ★ 关键：在页面任何脚本之前装好代理，抓"真正喂给 monaco 的色板"
    const INJECT = `(function(){
      window.__injectAt = Date.now();
      window.__themeCaptured = [];
      window.__hookState = 'pending';
      function hook(){
        if (!window.monaco || !window.monaco.editor) { window.__hookState = 'no-monaco'; return false }
        if (window.__themeHooked) return true;
        var orig = window.monaco.editor.defineTheme;
        window.__hookState = 'hooking:' + (typeof orig);
        if (typeof orig !== 'function') return false;
        window.monaco.editor.defineTheme = function(name, theme){
          try {
            window.__themeCaptured.push({ name: String(name), base: theme && theme.base, colors: (theme && theme.colors) || {}, ruleCount: ((theme && theme.rules) || []).length });
          } catch (e) { /* 只读捕获，绝不影响主题生效 */ }
          return orig.apply(this, arguments);
        };
        window.__themeHooked = true;
        window.__hookState = 'hooked';
        return true;
      }
      var n = 0;
      var t = setInterval(function(){ if (hook() || ++n > 3000) clearInterval(t) }, 10);
      window.__hookCount = function(){ return (window.__themeCaptured || []).length };
    })()`
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: INJECT })
    await cdp('Runtime.enable')
    await cdp('Page.enable')
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })

    const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 90000)
    check('P1 页面挂载完成（IDE + monaco）', !!ready)
    // 与其它套件一致：首访可能落在"工作空间还没连上"的半成品页面 → 刷一次再进（§6 26 的 token 首访重定向）
    await cdp('Page.reload', { ignoreCache: false })
    await sleep(2500)
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    const ready2 = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 90000)
    check('P1b 重载后 IDE 仍然挂载（monaco 全局可用）', !!ready2)

    // 专用安静工作区（客户端会按会话 cwd 覆盖 active-root，见 §6 69）
    let rootOk = false
    for (let i = 0; i < 12 && !rootOk; i++) {
      await fetch(APP + '/dsh-ide/active-root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: WS }) })
      await sleep(700)
      rootOk = await evalJs(`(function(){ var n=document.querySelectorAll('.dside-node-name'); for (var i=0;i<n.length;i++) if (n[i].textContent.trim()==='src') return true; return false })()`)
    }
    check('P2 工作区根已生效（树里能看到 fixture）', rootOk)

    // 打开 src/pick.txt（真点树）→ 触发 monaco 建主题
    await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-node-name'); for (var i=0;i<ns.length;i++){ if (ns[i].textContent.trim()==='src'){ var r=ns[i].closest('.dside-node')||ns[i].parentElement; r.click(); return true } } return false })()`)
    await sleep(1200)
    await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-node-name'); for (var i=0;i<ns.length;i++){ if (ns[i].textContent.trim()==='pick.txt'){ var r=ns[i].closest('.dside-node')||ns[i].parentElement; r.click(); return true } } return false })()`)
    const modelOk = await waitFor(`(function(){ var e=monaco.editor.getEditors()[0]; return !!(e&&e.getModel()) })()`, 12000)
    check('P3 打开文件后编辑器挂上 model', !!modelOk)

    const hookDiag = await evalJs(`(function(){ return { injectAt: window.__injectAt||0, state: window.__hookState||'(无)', hooked: !!window.__themeHooked,
      hasMonaco: !!window.monaco, hasEditor: !!(window.monaco && window.monaco.editor), defineType: (window.monaco && window.monaco.editor) ? typeof window.monaco.editor.defineTheme : '(no)',
      captured: (window.__themeCaptured||[]).length,
      currentTheme: (function(){ try { var e = monaco.editor.getEditors()[0]; return e ? (e._themeService && e._themeService.getColorTheme ? e._themeService.getColorTheme().themeName : '(no svc)') : '(no ed)' } catch (err) { return 'err:' + err.message } })(),
      themeNames: (function(){ try { var e = monaco.editor.getEditors()[0]; var ts = e && e._themeService; return ts ? 'has-themeService' : 'no' } catch (err) { return 'err' } })() } })()`)
    const captured = await evalJs(`(function(){ var c=window.__themeCaptured||[]; return { count: c.length, last: c.length?c[c.length-1]:null } })()`)
    // 代理通路只作诊断记录，不在计数里（运行时 `_themeService` 那条更硬。
    // ⚠ 探针实测：monaco 0.56 的主题在我们注入之后由**模块内的 monaco 命名空间**注册，
    //   代理偶尔抓不到 —— 所以判据一律落在 P4b 的运行时读数上，代理只留一行 note。）
    console.log('[NOTE] 代理诊断: ' + JSON.stringify(hookDiag) + '  captured=' + ((captured && captured.count) || 0))

    // ★ 兜底通路：直接问 monaco 自己"当前生效的主题里这几个色是什么"（比代理更硬 —— 这是运行时真相）
    const live = await evalJs(`(function(){
      var out = { api: [], colors: {}, themeName: null };
      var ids = ['editor.selectionBackground','editor.selectionHighlightBackground','editor.wordHighlightBackground','editor.lineHighlightBackground','editor.inactiveSelectionBackground','editor.background'];
      function put(k, v){ if (v !== undefined && v !== null && out.colors[k] === undefined) out.colors[k] = String(v) }
      function fromTheme(t, tag){
        if (!t) return;
        out.api.push(tag);
        if (t.themeName && !out.themeName) out.themeName = String(t.themeName);
        for (var i=0;i<ids.length;i++){
          if (t.colors && t.colors[ids[i]] !== undefined) { put(ids[i], t.colors[ids[i]]); continue }
          if (typeof t.getColor === 'function') {
            try { var c = t.getColor(ids[i]); if (c && c.toString) put(ids[i], c.toString()) } catch (e) { /* 某些版本只吃 ColorIdentifier */ }
          }
        }
      }
      try { fromTheme(monaco.editor.getColorTheme && monaco.editor.getColorTheme(), 'editor.getColorTheme') } catch (e) { out.err1 = String(e.message) }
      try { var ed = monaco.editor.getEditors()[0]; fromTheme(ed && ed._themeService && ed._themeService.getColorTheme && ed._themeService.getColorTheme(), 'editor._themeService') } catch (e) { out.err2 = String(e.message) }
      try { var anyEd = monaco.editor.getEditors()[0]; var ts = anyEd && anyEd._themeService; if (ts && ts.getColor) { for (var j=0;j<ids.length;j++){ try { var c2 = ts.getColor(ids[j]); if (c2 && c2.toString) put(ids[j], c2.toString()) } catch (e2) { /* ignore */ } } out.api.push('themeService.getColor'); } } catch (e) { out.err3 = String(e.message) }
      return out;
    })()`)
    check('P4b 能读到 monaco 运行时主题（getColorTheme / _themeService 任一通路）',
      !!(live && Object.keys((live && live.colors) || {}).length >= 4), JSON.stringify(live))

    // 判定用哪份数据：优先 **运行时主题**（live，最硬），没有再用代理抓到的 defineTheme 入参
    const colors = Object.assign({}, (captured && captured.last && captured.last.colors) || {}, (live && live.colors) || {})
    const ruleCount = (captured && captured.last && captured.last.ruleCount) || 0
    check('P5 色板是真的（编辑器色家族 ≥ 20 项，或运行时至少拿到 4 个目标色）',
      Object.keys(colors).length >= 4 && (ruleCount > 0 || Object.keys((live && live.colors) || {}).length >= 4),
      'merged=' + Object.keys(colors).length + ' rules=' + ruleCount)

    // ① 三个色必须与 VSCode 规格一致（暗色）。
    // ⚠ monaco 内部把 #RRGGBBAA 规范成 `RGBA(r, g, b, a)` 字符串（alpha 四舍五入到 2 位），
    //   所以断言前要把 hex 转成同一形态再比 —— 直接比 "RGBA(87, 87, 87, 0.72)" 与 "#575757B8"
    //   会得到一条**假 FAIL**（错误代码 0.72 其实是精确值：184/255，只是被四舍五入显示）。
    function rgbaOf(hex) {
      const h = String(hex).replace('#', '')
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
      const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
      return 'RGBA(' + r + ', ' + g + ', ' + b + ', ' + Number(a.toFixed(2)) + ')'
    }
    for (const [key, spec] of Object.entries(SPEC)) {
      const got = String(colors[key] || '').toUpperCase()
      const wantHex = spec.dark.toUpperCase()
      const wantRgba = rgbaOf(spec.dark).toUpperCase()
      check('P6 ' + key + ' 与 VSCode 规格一致（' + spec.dark + '）',
        got === wantHex || got === wantRgba, 'got=' + (got || '(缺)') + ' want=' + wantHex + ' | ' + wantRgba)
    }

    // ② 选中 / 同词高亮 / 行高亮 **两两不同**（这就是用户报障的判据）
    const norm = (v) => String(v || '').toUpperCase()
    const sel = norm(colors['editor.selectionBackground'])
    const selHi = norm(colors['editor.selectionHighlightBackground'])
    const wordHi = norm(colors['editor.wordHighlightBackground'])
    const lineHi = norm(colors['editor.lineHighlightBackground'])
    check('P7 选中色 ≠ 同词高亮色（选中一眼看得出来）', !!sel && !!selHi && sel !== selHi, sel + ' vs ' + selHi)
    check('P8 选中色 ≠ 行高亮色（光标所在行）', !!sel && !!lineHi && sel !== lineHi, sel + ' vs ' + lineHi)
    // 选中色必须"够实"：alpha ≥ 0.5（用户报障时它其实是 rgba(255,255,255,.14) 这种几乎看不见的叠色）
    function alphaOf(v) {
      const s = String(v || '').toUpperCase()
      const m = s.match(/^RGBA\(\s*\d+,\s*\d+,\s*\d+,\s*([\d.]+)\s*\)$/)
      if (m) return parseFloat(m[1])
      const h = s.replace('#', '')
      if (h.length === 8) return parseInt(h.slice(6, 8), 16) / 255
      if (h.length === 6 || h.length === 3) return 1
      return null
    }
    const selAlpha = alphaOf(colors['editor.selectionBackground'])
    check('P9 选中色够实（alpha ≥ 0.5，不是几乎看不见的叠色）', selAlpha !== null && selAlpha >= 0.5, 'alpha=' + selAlpha + ' raw=' + sel)
    check('P10 同词高亮色与词高亮(strong)一致（VSCode 同值）', selHi === wordHi, selHi + ' vs ' + wordHi)

    // ③ 真选中一段文字：monaco 收得下选区，且选区不被主题拦掉
    const selRes = await evalJs(`(function(){
      var e = monaco.editor.getEditors()[0]; if (!e || !e.getModel()) return null;
      e.setSelection(new monaco.Selection(1, 1, 1, 11));
      var s = e.getSelection();
      var decos = e.getModel().getAllDecorations ? e.getModel().getAllDecorations().length : -1;
      return { sl: s.startLineNumber, sc: s.startColumn, el: s.endLineNumber, ec: s.endColumn, decos: decos, text: e.getModel().getValueInRange(s) };
    })()`)
    check('P11 真设一段选区（monaco 收得下：alpha beta）',
      !!(selRes && selRes.text === 'alpha beta' && selRes.ec === 11), JSON.stringify(selRes))

    // ④ 编辑器右上角不该再有「保存」按钮（用户 2026-09-21 点名去掉）
    const saveBtns = await evalJs(`(function(){ var out=[]; var bs=document.querySelectorAll('.dside-editor-tabs button, .dside-editor-meta button');
      for (var i=0;i<bs.length;i++){ var t=(bs[i].textContent||'').trim(); if (t) out.push(t) } return out })()`)
    check('P12 编辑器标签栏里没有「保存」按钮', !!(Array.isArray(saveBtns) && !saveBtns.some((t) => t.indexOf('保存') >= 0)), JSON.stringify(saveBtns))

    // ⑤ 未保存提示仍在（删按钮 ≠ 砍状态提示）
    const dirtyProbe = await evalJs(`(function(){
      var e = monaco.editor.getEditors()[0];
      e.getModel().pushEditOperations([], [{ range: new monaco.Range(1,1,1,1), text: 'X' }], function(){ return null });
      return true })()`)
    await sleep(900)
    const metaText = await evalJs(`(function(){ var m=document.querySelector('.dside-editor-meta'); return m?m.textContent.trim():'(无)' })()`)
    check('P13 改脏后仍显示「● 未保存」（状态提示没被一起删）', !!(dirtyProbe && String(metaText).indexOf('未保存') >= 0), String(metaText))

    // ⑥ 保存能力仍在：Ctrl+S 走 monaco 命令（不依赖那个按钮）
    const saveCmd = await evalJs(`(function(){ var ids = monaco.editor.getEditors()[0].getSupportedActions().map(function(a){return a.id});
      var hit = ids.filter(function(i){ return i.toLowerCase().indexOf('save') >= 0 });
      return { hit: hit, total: ids.length } })()`)
    check('P14 编辑器里仍注册着保存动作（Ctrl+S 通路在）', !!(saveCmd && saveCmd.hit && saveCmd.hit.length > 0), JSON.stringify(saveCmd))

    await sleep(600)
    check('P15 页面零未捕获异常', pageErrors.length === 0, pageErrors.join(' | '))

    const pass = results.filter((r) => r.ok).length
    console.log(`\n== e2e-theme-colors: ${pass}/${results.length} ==`)
    if (pass !== results.length) process.exitCode = 1
  } finally {
    try { if (browser) browser.kill() } catch { /* ignore */ }
    try { spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    const port = PORT
    setTimeout(() => {
      try { rmSync(userDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch { /* Windows 文件锁 */ }
      process.exit(process.exitCode || 0)
    }, 1200)
  }
}
main().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(1) })
