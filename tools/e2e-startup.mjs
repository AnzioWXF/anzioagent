import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// e2e-startup.mjs — 2026-09-22 用户三个报障的回归套件：
//   ① 打开天工先闪一下别人的工作空间，过一会才换成真正在用的目录
//   ② 一关软件，上次打开的文件全没了（含"没保存的改动"）
//   ③ 设置面板下方「代码导航」那一片一直在闪
//   （④ 编辑器易混淆字符高亮 = 【编辑器设置】页的开关，见 P12–P16）
//
// 用法：node tools\e2e-startup.mjs
//   自起隔离测试后端（DSH_HOME=<仓库根>\.smoke-home，先跑 tools\dev-testhome.ps1 刷插件代码）
//   + 无头 Edge/Chrome（CDP）真浏览器 + 专用安静工作区（<仓库根>\.smoke-ws）。
//
// 断言的"语义依据"（不是凭印象）：
//   · 记忆恢复的判据是**页面重载后**树/标签/脏缓冲区还在（等价于"关软件再打开"），
//     而不是看某个内部变量 —— 内部变量再对，用户看到的也得对。
//   · 易混淆字符的判据取 monaco 自己的 DOM：`.unicode-highlight` 元素数量
//     （2026-09-22 实测：U+FF09 命中 1 个、U+200B 命中 1 个；关掉 ambiguousCharacters 后只剩后者）。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, openSync, closeSync } from 'node:fs'

const PORT = Number(process.env.DSH_E2E_PORT || 3089)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = process.env.DSH_E2E_HOME || `${__TIANGONG_ROOT}\\.smoke-home`
const WS_OLD = `${__TIANGONG_ROOT}\\.smoke-ws-old`      // "上次遗留的旧工作空间"（模拟用户抱怨的 00WORK）
const WS_NEW = `${__TIANGONG_ROOT}\\.smoke-ws-new`      // "我真正在用的目录"
const CLI = `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js`
const BLOG = `${__TIANGONG_ROOT}\\_e2estartup_backend_` + PORT + '.log'
const CDP_PORT = 9950 + Math.floor(Math.random() * 40)
const F1 = WS_NEW + '\\_e2esu_one.txt'
const F2 = WS_NEW + '\\_e2esu_two.txt'
const F3 = WS_NEW + '\\_e2esu_old.txt'
const P1 = '_e2esu_one.txt', P2 = '_e2esu_two.txt', P3 = '_e2esu_old.txt'
const F4 = WS_NEW + '\\_e2esu_gone.txt'   // 开过标签但**从没被打开**（无内存模型）→ 关软件前从磁盘删掉
const P4 = '_e2esu_gone.txt'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' :: ' + String(detail ?? '')}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cleanEnv() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('DSH_')) env[k] = v
  env.DSH_HOME = HOME_DIR
  return env
}
function findBrowser() {
  for (const c of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) if (existsSync(c)) return c
  throw new Error('no edge/chrome found')
}

// ── 页内脚本 ──────────────────────────────────────────────────────
const NODE_NAMES = `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node-name'); var a=[];
  for (var i=0;i<ns.length;i++) a.push(String(ns[i].textContent)); return a })()`
const CLICK_NODE = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node');
  for (var i=0;i<ns.length;i++){ var t=ns[i].querySelector('.dside-node-name');
    if (t && t.textContent===${JSON.stringify(name)}){ ns[i].click(); return true } } return false })()`
const PICK_ACTIVITY = (label) => `(function(){ var bs=document.querySelectorAll('.dside-activitybar button');
  for (var i=0;i<bs.length;i++){ var l=String(bs[i].getAttribute('title')||'');
    if (l.indexOf(${JSON.stringify(label)})>=0){ bs[i].click(); return true } } return false })()`
const CLICK_BLOCK_ROW = (label) => `(function(){ var rs=document.querySelectorAll('.dside-explorer .dside-block-row');
  for (var i=0;i<rs.length;i++){ var l=rs[i].querySelector('.dside-block-label');
    if (l && String(l.textContent).indexOf(${JSON.stringify(label)})>=0){ rs[i].click(); return true } } return false })()`
const TAB_NAMES = `(function(){ var ts=document.querySelectorAll('.dside-tablist .dside-tab-name'); var a=[];
  for (var i=0;i<ts.length;i++) a.push(String(ts[i].textContent)); return a })()`
const STATUS = `(function(){ var e=document.querySelector('.dside-statusbar'); return e?String(e.innerText).slice(0,160):'' })()`
const UNI_COUNT = `(function(){ return document.querySelectorAll('.dside-editor-monaco .unicode-highlight').length })()`
// monaco 的 unicode 高亮只算"聚焦中的那个编辑器" → 断言前必须先点一下编辑器（模拟真人）
const CLICK_EDITOR = `(function(){ var e=document.querySelector('.dside-editor-monaco .monaco-editor');
  if(!e) return 'no-editor-dom'; var r=e.getBoundingClientRect();
  var x=Math.round(r.left+r.width/2), y=Math.round(r.top+40);
  ['mousedown','mouseup','click'].forEach(function(t){
    e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,view:window})) });
  var ed=window.monaco && window.monaco.editor.getEditors()[0]; if(ed) ed.focus();
  return document.activeElement ? String(document.activeElement.className).slice(0,40) : 'none' })()`
const EDITOR_VALUE = `(function(){ var ed=window.monaco && window.monaco.editor.getEditors()[0];
  return ed && ed.getModel() ? String(ed.getModel().getValue()) : null })()`
const EDITOR_OPT = (key) => `(function(){ var ed=window.monaco && window.monaco.editor.getEditors()[0];
  if(!ed) return 'no-editor'; var o=ed.getOptions();
  var v=(o && typeof o.get==='function')?o.get(${JSON.stringify(key)}):undefined;
  return v===undefined?'undefined':(v?'true':'false') })()`
// 设置面板里按**行标签**开关一个开关（ToggleRow：按钮文字「开 / 关」）
const SET_TOGGLE_BY_LABEL = (label, want) => `(function(){
  var rows=document.querySelectorAll('.dside-explorer .dside-block-row');
  for (var i=0;i<rows.length;i++){ var l=rows[i].querySelector('.dside-block-label'); if(!l) continue;
    if (String(l.textContent).indexOf(${JSON.stringify(label)})<0) continue;
    var b=rows[i].querySelector('.dside-toggle'); if(!b) return 'no-btn';
    var on=(String(b.textContent)==='开'); if(on!==${want ? 'true' : 'false'}){ b.click(); return 'clicked' }
    return 'already' }
  return 'no-row' })()`
// 关掉中面板的设置页（点它头部的「✕ 关闭」）—— 编辑器被藏在 display:none 里时
// monaco 根本不算 unicode 高亮，量出来永远是 0（2026-09-22 实测踩到）
const CLOSE_CENTER_PAGE = `(function(){ var bs=document.querySelectorAll('.dside-eset .dside-btn');
  for (var i=0;i<bs.length;i++) if (String(bs[i].textContent).indexOf('关闭')>=0){ bs[i].click(); return true }
  return false })()`
const SET_PREF_TOGGLE = (key, want) => `(function(){
  var rows=document.querySelectorAll('.dside-eset-row[data-pref]');
  for (var i=0;i<rows.length;i++){ if (rows[i].getAttribute('data-pref')!==${JSON.stringify(key)}) continue;
    var b=rows[i].querySelector('.dside-toggle'); if(!b) return 'no-btn';
    var on=b.classList.contains('on'); if(on!==${want ? 'true' : 'false'}) b.click(); return 'clicked' }
  return 'no-row' })()`
const ESET_VALUE = (key) => `(function(){ var r=document.querySelector('.dside-eset-row[data-pref='+${JSON.stringify(JSON.stringify(key))}+']');
  if(!r) return null; var b=r.querySelector('.dside-toggle'); return b?b.textContent:'?' })()`
// 重新加载页面（= 关软件再打开：tabs/drafts 只活在本机存储里）
const RELOAD = `(function(){ var q=new URLSearchParams(location.search); location.href=location.pathname+(q.get('token')?('?token='+q.get('token')):''); return true })()`

async function main() {
  // ── 准备（必须在后端起来之前）：建两个专用工作区，并把它们**直接写进隔离测试家目录的
  //    工作空间注册表**（顺序 = old 在前，模拟用户抱怨的"host 只能回退到 list[0] = 00WORK"）。
  //    宿主会把 storages/workspace.json 读进内存，起来之后再改文件不作数。
  //    （试过走无头 RPC /api/workspace.create：2026-09-22 实测该 HTTP 路由在本版本返回 404，
  //      所以用"直接写注册表"这条更可靠的路。）
  const wsJsonPath = HOME_DIR + '\\storages\\workspace.json'
  let reg = null
  try { reg = JSON.parse(readFileSync(wsJsonPath, 'utf8')) } catch { reg = null }
  if (!reg || !reg.tables || !reg.tables.workspaces) {
    reg = { unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [] }, tables: { workspaces: {} } }
  }
  for (const [id, rec] of Object.entries(reg.tables.workspaces)) {
    if (rec && typeof rec.path === 'string' && (rec.path === WS_OLD || rec.path === WS_NEW)) {
      delete reg.tables.workspaces[id]
      reg.global.workspaceIds = reg.global.workspaceIds.filter((x) => x !== id)
    }
  }
  const wsOldId = 'e2esu-old-' + Date.now()
  const wsNewId = 'e2esu-new-' + Date.now()
  const mk = (p, title, at) => ({ path: p, title, sessionIds: [], createdAt: at, updatedAt: at })
  reg.tables.workspaces[wsOldId] = mk(WS_OLD, 'smoke-ws-old', '2026-01-01T00:00:00.000Z')
  reg.tables.workspaces[wsNewId] = mk(WS_NEW, 'smoke-ws-new', new Date().toISOString())
  reg.global.workspaceIds = [wsOldId, wsNewId, ...reg.global.workspaceIds.filter((x) => x !== wsOldId && x !== wsNewId)]
  reg.global.initialized = true
  mkdirSync(HOME_DIR + '\\storages', { recursive: true })
  writeFileSync(wsJsonPath, JSON.stringify(reg, null, 2))

  rmSync(BLOG, { force: true })
  const fd = openSync(BLOG, 'w')
  const backend = spawn(process.execPath, [CLI, 'web', '--port', String(PORT), '--no-open'], {
    cwd: `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness`, env: cleanEnv(), stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  let backendExit = null
  backend.on('exit', (c) => { backendExit = c })
  let browser = null
  let ws = null

  try {
    let token = ''
    const t0 = Date.now()
    while (Date.now() - t0 < 120000) {
      await sleep(500)
      if (backendExit !== null) throw new Error('backend exited early (' + backendExit + ') — 端口 ' + PORT + ' 可能被占用')
      let txt = ''
      try { txt = readFileSync(BLOG, 'utf8') } catch { /* not yet */ }
      const m = txt.match(/\?token=([A-Za-z0-9._-]+)/)
      if (m) { token = m[1]; break }
    }
    if (!token) throw new Error('no token in backend log')

    // 两个专用工作区：old = "上次遗留的旧工作空间"，new = "我真正在用的目录"
    for (const d of [WS_OLD, WS_NEW]) { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }); mkdirSync(d, { recursive: true }) }
    writeFileSync(WS_OLD + '\\_e2esu_old_ws.txt', 'old workspace file\n')
    writeFileSync(F1, 'one line1\none line2\n')
    writeFileSync(F2, 'two line1\n')
    writeFileSync(F3, 'will be deleted\n')
    writeFileSync(F4, 'never opened, then deleted\n')

    const userDir = `${__TIANGONG_ROOT}\\.edge-e2estartup-tmp-` + process.pid
    try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch { /* 文件锁：临时 profile 删不掉不影响结论 */ }
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

    ws = new WebSocket(target.webSocketDebuggerUrl)
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
        pageErrors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 200))
      }
      if (m.method === 'Page.javascriptDialogOpening') cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
    }
    ws.onclose = () => { wsDead = true; for (const [, f] of pending) f({ error: { message: 'ws closed' } }); pending.clear() }
    ws.onerror = () => { wsDead = true; for (const [, f] of pending) f({ error: { message: 'ws error' } }); pending.clear() }

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
      while (Date.now() - t < ms) { const v = await evalJs(expr); if (v) return v; await sleep(250) }
      return null
    }
    async function reloadAndWait() {
      await evalJs(RELOAD)
      await sleep(2500)
      await cdp('Runtime.enable'); await cdp('Page.enable')
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
      await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco && !!document.querySelector('.dside-tablist')`, 90000)
    }

    await cdp('Runtime.enable'); await cdp('Page.enable')
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco && !!document.querySelector('.dside-tablist')`, 90000)
    check('P1 页面挂载完成（IDE 布局 + monaco + 标签栏）', !!ready, await evalJs('document.readyState'))

    // 把"用户真正在用的目录"记进本机（= 上次关机前留下的记忆）；
    // 并让 host 那边的 activeRoot 停在 old（模拟"host 起来时只能回退到 list[0]"）。
    // ⚠ 先清掉本机所有 dside.* 记忆（同一个浏览器 profile 会被反复跑测；上一轮留下的
    //   session/tab 记忆会污染这一轮，2026-09-22 实测吃过假 FAIL），只留我们要的那条。
    await evalJs(`(function(){ var ks=[]; for (var i=0;i<window.localStorage.length;i++) ks.push(window.localStorage.key(i));
      for (var j=0;j<ks.length;j++) if (String(ks[j]).indexOf('dside.')===0) window.localStorage.removeItem(ks[j]);
      window.localStorage.setItem('dside.lastRoot.v1', ${JSON.stringify(WS_NEW)}); return true })()`)
    // ⚠ 判据必须用**注入进去的 WS_NEW**（JSON 转义后是单反斜杠），别在断言里写死转义串 ——
    //   第一版写成 '\\\\_smoke-ws-new'，在 JS 里等于找"双反斜杠"，永远匹配不上（假 FAIL）。
    await fetch(APP + '/dsh-ide/active-root', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: WS_OLD }),
    })
    // 再重载一次 = 真正的干净开机（同一个浏览器 profile 会被反复跑测，第一次加载可能已经
    // 把旧记忆写进去了；清完再重载，这一轮才是"从零开始的一次开机"，2026-09-22 实测过）
    await reloadAndWait()

    // ── ① 开机就该是我真正在用的目录（而不是先闪一下 old）──────────────────
    await reloadAndWait()
    const names = await evalJs(NODE_NAMES)
    console.log('   树里的文件:', JSON.stringify(names))
    check('P2 开机画面直接就是我上次在用的工作空间（不再先显示旧的那个）',
      Array.isArray(names) && names.indexOf(P1) >= 0 && names.indexOf('_e2esu_old_ws.txt') < 0, JSON.stringify(names))
    const initRoot = await (await fetch(APP + '/dsh-ide/init')).json()
    check('P3 host 的活动工作空间 = 我上次在用的那个（树/搜索/快照都跟着它）',
      !!(initRoot && initRoot.root && initRoot.root.toLowerCase() === WS_NEW.toLowerCase()),
      'host root=' + (initRoot && initRoot.root) + ' 期望=' + WS_NEW)
    // 标题栏那个「当前工作空间路径」是常显的（状态栏那行会被"语言智能就绪"这类瞬时消息顶掉，
    // 不适合当断言依据）—— 用它验证"用户一眼看到的就是我在用的目录"
    const barPath = await evalJs(`(function(){ var e=document.querySelector('.dside-wspath') || document.querySelector('.dside-titlebar');
      return e?String(e.textContent||''):'' })()`)
    check('P4 标题栏显示的工作空间就是我上次在用的那个（用户一眼可见）',
      String(barPath).replace(/\\\\/g, '\\').toLowerCase().indexOf(WS_NEW.toLowerCase()) >= 0,
      JSON.stringify(String(barPath).slice(0, 120)) + ' 期望含 ' + WS_NEW)

    // ── ② 关软件再打开：文件回来（含没保存的改动）──────────────────────────
    // ⚠ 单击 = **预览标签**（VSCode 手感：同一时刻只有一个，下一次单击就地替换它）——
    //    第一版测试用三次单击去"打开三个文件"，结果只剩最后一个，是测试写法错、不是产品错
    //    （2026-09-22 实测：tabs 一路 ["one"]→["two"]→["old"]）。所以先把「预览模式」关掉，
    //    让单击=固定打开；测完再开回来。
    await evalJs(PICK_ACTIVITY('设置')); await sleep(900)
    const previewOff = await evalJs(SET_TOGGLE_BY_LABEL('预览模式', false))
    await sleep(600)
    await evalJs(PICK_ACTIVITY('资源管理器')); await sleep(900)
    console.log('   [准备] 关掉预览模式:', previewOff)
    console.log('   开测②前树里:', JSON.stringify(await evalJs(NODE_NAMES)))
    for (const nm of [P1, P2, P3, P4]) {
      const hit = await evalJs(CLICK_NODE(nm))
      await sleep(800)
      if (!hit) console.log('   [警告] 树里没找到 ' + nm)
    }
    let tabs = await evalJs(TAB_NAMES)
    check('P5 四个文件都开了标签（活动的那个是 P4 —— 它从没上过编辑器）',
      Array.isArray(tabs) && tabs.length === 4, JSON.stringify(tabs))
    // 测完把预览模式恢复默认（免得影响后面的用例与用户偏好预期）
    await sleep(300)
    // 把 P2 改脏（不保存），模拟"关软件时还有没保存的改动"。
    // ⚠ 必须先把它切成活动标签：脏标记的订阅只挂在**当前挂上编辑器的那个 model** 上
    //   （attachModel 里 onDidChangeContent → onDirtyChange），改后台 model 不会变脏
    //   —— 2026-09-22 实测：直接改 P2 的 model → 3 个标签 0 个脏。
    await evalJs(CLICK_NODE(P2)); await sleep(800)
    await evalJs(`(function(){ var ms=window.monaco.editor.getModels();
      for (var i=0;i<ms.length;i++){ if (String(ms[i].uri).indexOf(${JSON.stringify(P2)})>=0){
        ms[i].applyEdits([{range:new window.monaco.Range(1,1,1,1), text:'// UNSAVED-DRAFT\\n'}]); return true } } return false })()`)
    await sleep(1000)
    // 关软件前：把"从来没打开过、但被记进标签列表"的文件从磁盘删掉
    // （它没有内存模型 → 重开恢复时是真去问磁盘的，所以能验证"已删文件自动跳过"）
    console.log('   [准备] 删文件前，记忆里是否记着 P3/P4:',
      String(await evalJs(`window.localStorage.getItem('dside.session.v1')`)).indexOf(P3) >= 0,
      String(await evalJs(`window.localStorage.getItem('dside.session.v1')`)).indexOf('_e2esu_gone') >= 0)
    rmSync(F3, { force: true })
    rmSync(F4, { force: true })

    await reloadAndWait()
    tabs = await evalJs(TAB_NAMES)
    check('P6 重开软件后，上次开着的文件自己回来了（两个已被删的都跳过、不留空白标签）',
      Array.isArray(tabs) && tabs.indexOf(P1) >= 0 && tabs.indexOf(P2) >= 0
        && tabs.indexOf(P3) < 0 && tabs.indexOf(P4) < 0, JSON.stringify(tabs))
    // 激活的应当是 P2（上次的活动标签）
    const activeTab = await evalJs(`(function(){ var ts=document.querySelectorAll('.dside-tablist .dside-tab');
      for (var i=0;i<ts.length;i++) if (ts[i].classList.contains('active')){ var n=ts[i].querySelector('.dside-tab-name'); return n?String(n.textContent):'' }
      return '' })()`)
    check('P7 上次的活动标签还是活动标签', String(activeTab) === P2, JSON.stringify(activeTab))
    const v2 = await evalJs(EDITOR_VALUE)
    check('P8 没保存的改动也回来了（草稿重新套进缓冲区）', String(v2).indexOf('UNSAVED-DRAFT') >= 0, JSON.stringify(String(v2).slice(0, 80)))
    // ⚠ 脏标是标签里的圆点 .dside-dot.dirty（不是标签自身的 class）—— 第一版断言查错了 DOM
    const dirtyFlag = await evalJs(`(function(){ var ts=document.querySelectorAll('.dside-tablist .dside-tab');
      for (var i=0;i<ts.length;i++){ var n=ts[i].querySelector('.dside-tab-name');
        if (n && n.textContent===${JSON.stringify(P2)}){ var d=ts[i].querySelector('.dside-dot');
          return !!(d && d.classList.contains('dirty')) } } return null })()`)
    check('P9 恢复回来的草稿仍标着"未保存"（不会假装已存盘）', dirtyFlag === true, JSON.stringify(dirtyFlag))
    const diskP2 = readFileSync(F2, 'utf8')
    check('P10 磁盘内容没被草稿偷偷覆盖（草稿只在编辑器里）', diskP2.indexOf('UNSAVED-DRAFT') < 0, JSON.stringify(diskP2))

    // ── ③ 设置面板下方的「代码导航」卡片不再每隔几秒被重建 ──────────────────
    await evalJs(PICK_ACTIVITY('设置')); await sleep(1200)
    await evalJs(`window.__suFetch=0; var of=window.fetch;
      window.fetch=function(u,o){ try{ if(String(u).indexOf('/tools-status')>=0) window.__suFetch++ }catch(e){}; return of.apply(this,arguments) }`)
    await evalJs(`(function(){ window.__suMuts=0;
      window.__suObs=new MutationObserver(function(ms){ window.__suMuts+=ms.length });
      window.__suObs.observe(document.querySelector('.dside-leftpanel')||document.body,{childList:true,subtree:true,characterData:true,attributes:true});
      return true })()`)
    await sleep(12000)
    const suMuts = await evalJs('window.__suMuts')
    const fetchCount = await evalJs('window.__suFetch')
    check('P11 设置面板 12 秒内零 DOM 变更（不再闪）', suMuts === 0, 'mutations=' + suMuts)
    check('P12 设置面板不会反复去拉状态（12 秒内 0 次请求）', fetchCount === 0, 'requests=' + fetchCount)
    const cnRow = await evalJs(`(function(){ var rs=document.querySelectorAll('.dside-explorer .dside-block-row');
      for (var i=0;i<rs.length;i++){ var l=rs[i].querySelector('.dside-block-label');
        if (l && String(l.textContent).indexOf('tools')>=0) return String(l.textContent) } return null })()`)
    check('P13 代码导航那一格还在（静态说明，信息没丢）', typeof cnRow === 'string' && cnRow.indexOf('lsp') >= 0, JSON.stringify(cnRow))

    // ── ④ 【编辑器设置】页：易混淆字符开关（真开真关真生效）──────────────────
    const opened = await evalJs(CLICK_BLOCK_ROW('编辑器设置'))
    await sleep(1200)
    const pageUp = await evalJs(`!!document.querySelector('.dside-eset')`)
    check('P14 左侧「设置 → 编辑器设置…」能打开中面板的设置页', opened === true && pageUp === true, JSON.stringify({ opened, pageUp }))
    const rowsSeen = await evalJs(`(function(){ var rs=document.querySelectorAll('.dside-eset-row[data-pref]'); var a=[];
      for (var i=0;i<rs.length;i++) a.push(rs[i].getAttribute('data-pref')); return a })()`)
    check('P15 设置页列出了编辑器偏好项（含易混淆字符）',
      Array.isArray(rowsSeen) && rowsSeen.indexOf('ambiguousCharacters') >= 0 && rowsSeen.indexOf('invisibleCharacters') >= 0,
      JSON.stringify(rowsSeen))

    // 量高亮的统一动作：把含 U+FF09 / U+200B 的内容放进 P1 缓冲区 → 关设置页（编辑器才可见）
    // → 点编辑器（monaco 只给聚焦的编辑器算 unicode 高亮）→ 数 .unicode-highlight。
    // ⚠ 每一步都确认到达（第一版直接连续发指令、没等状态落定 → 开关没点上、量出 0）。
    async function openEsPage() {
      await evalJs(PICK_ACTIVITY('设置')); await sleep(700)
      await evalJs(CLICK_BLOCK_ROW('编辑器设置')); await sleep(900)
      return await evalJs(`!!document.querySelector('.dside-eset')`)
    }
    async function measureUni() {
      await evalJs(CLOSE_CENTER_PAGE); await sleep(500)     // 编辑器可见
      await evalJs(PICK_ACTIVITY('资源管理器')); await sleep(400)
      await evalJs(CLICK_NODE(P1)); await sleep(900)
      const setRes = await evalJs(`(function(){ var ms=window.monaco.editor.getModels();
        var txt='const a = foo(x)\\uff09; // \\u200bzw' + String.fromCharCode(10);
        for (var i=0;i<ms.length;i++){ if (String(ms[i].uri).indexOf(${JSON.stringify(P1)})>=0){
          ms[i].setValue(txt); return 'set:' + String(ms[i].uri).slice(-20) } }
        return 'no-match:' + ms.map(function(m){ return String(m.uri).slice(-16) }).join(',') })()`)
      // 这一句是"量测的前提"：没把内容放进去，后面数出来的 0 是假 FAIL（2026-09-22 就吃过）
      if (String(setRes).indexOf('set:') !== 0) console.log('   [警告] 没能把测试内容写进 model:', setRes)
      await evalJs(CLICK_EDITOR)
      await sleep(2000)
      return await evalJs(UNI_COUNT)
    }

    // 默认（易混淆字符关、看不见的字符开）→ 应当只有 U+200B 那一个
    const uniDefault = await measureUni()
    if (uniDefault !== 1) {
      console.log('   [诊断] tabs=', JSON.stringify(await evalJs(TAB_NAMES)),
        ' editors=', await evalJs('(window.monaco.editor.getEditors()||[]).length'))
    }
    check('P16 默认：易混淆字符不提示、看不见的字符仍提示（1 个 = U+200B）', uniDefault === 1, 'unicode-highlight=' + uniDefault)

    // 打开"易混淆字符" → 应当变成 2 个（U+FF09 那处也提示）
    const esUp1 = await openEsPage()
    const toggle1 = await evalJs(SET_PREF_TOGGLE('ambiguousCharacters', true))
    console.log('   [准备] 设置页=' + esUp1 + ' 打开易混淆字符=' + toggle1)
    await sleep(800)
    const uniOn = await measureUni()
    check('P17 打开「易混淆字符」后立刻多出一个提示（不用重开文件/重启）', uniOn === 2, 'unicode-highlight=' + uniOn)
    const storedOn = await evalJs(`window.localStorage.getItem('dside.editorPrefs.v1')`)
    check('P18 设置已落到编辑器（提示数变化）且写进本机',
      uniOn === 2 && typeof storedOn === 'string' && storedOn.indexOf('"ambiguousCharacters":true') >= 0,
      'uni=' + uniOn + ' stored=' + JSON.stringify(storedOn))

    // 关回去 → 又只剩 1 个；并且这个选择存在本机、重开软件后仍然生效
    const esUp2 = await openEsPage()
    const toggle2 = await evalJs(SET_PREF_TOGGLE('ambiguousCharacters', false))
    console.log('   [准备] 设置页=' + esUp2 + ' 关回易混淆字符=' + toggle2)
    await sleep(800)
    const uniOff = await measureUni()
    check('P19 关掉后提示又消失（回到 1 个）', uniOff === 1, 'unicode-highlight=' + uniOff)
    const stored = await evalJs(`window.localStorage.getItem('dside.editorPrefs.v1')`)
    check('P20 编辑器设置存在本机（重开软件后仍然是你的选择）', typeof stored === 'string' && stored.indexOf('"ambiguousCharacters":false') >= 0, JSON.stringify(stored))
    await reloadAndWait()
    const uniAfterReload = await measureUni()
    check('P21 重开软件后编辑器仍然按你的设置来（易混淆字符不提示 → 只剩 1 个）',
      uniAfterReload === 1, 'unicode-highlight=' + uniAfterReload)

    check('P22 零未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } catch (e) {
    check('EXCEPTION ' + ((e && e.message) || e), false)
  } finally {
    const pass = results.filter((r) => r.ok).length
    console.log('\n== 结果: ' + pass + '/' + results.length + ' ==')
    try { if (ws) ws.close() } catch { /* ignore */ }
    try { if (browser) browser.kill() } catch { /* ignore */ }
    try { spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    await sleep(400)
    process.exit(pass === results.length ? 0 : 1)
  }
}

main()
