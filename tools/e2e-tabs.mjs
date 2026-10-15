// ⑮ 标签三件套 E2E：预览模式（VSCode preview editor）+ 标签右键菜单 + 固定标签（pin）
// 用法: node D:\99DSH\tools\e2e-tabs.mjs
//   自起隔离测试后端（DSH_HOME=D:\99DSH\.smoke-home，先跑 tools\dev-testhome.ps1 刷新插件代码）
//   + 无头 Edge/Chrome（CDP）真浏览器 + **专用安静工作区**（D:\99DSH\.smoke-ws，自建自清）。
//
// 为什么用专用工作区：测试家目录里拷来的会话 cwd 可能是 `D:\`（整盘）—— 那样树根是整块盘、
//   fs.watch 每秒几十次变更 → 树每秒重列，fixture 在树里会"忽隐忽现"（上一轮 30 项里 18 项假 FAIL
//   就是这么来的）。这里改成页面加载后 POST /dsh-ide/active-root 把根指到专用目录。
//
// 断言的语义全部来自 VSCode 源码（editor.contribution.ts / editorGroupModel.ts /
//   editorGroupView.ts / multiEditorTabsControl.ts / codeEditorService.ts），见 00devCore §3「标签三件套」。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, openSync, closeSync } from 'node:fs'

const PORT = Number(process.env.DSH_E2E_PORT || 3082)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = process.env.DSH_E2E_HOME || 'D:\\99DSH\\.smoke-home'   // 隔离测试家目录（绝不用 DSH_HOME，见 §6 60）
const WS = process.env.DSH_E2E_WS || 'D:\\99DSH\\.smoke-ws'             // 专用测试工作区
const CLI = 'D:\\99DSH\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js'
const BLOG = 'D:\\99DSH\\temp\\_e2etabs_backend_' + PORT + '.log'   // 测试垃圾统一落 temp（2026-09-22）
const TRACE_LOG = HOME_DIR + '\\logs\\ide-trace.log'
const CDP_PORT = 9900 + Math.floor(Math.random() * 90)
const P = (n) => WS + '\\_e2etabs_' + n + '.txt'

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
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]
  for (const c of cands) if (existsSync(c)) return c
  throw new Error('no edge/chrome found')
}
function killTree(pid) { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ } }

// ── 页内脚本 ──────────────────────────────────────────────────────
const HAS_NODE = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node-name');
  for (var i=0;i<ns.length;i++){ if (ns[i].textContent===${JSON.stringify(name)}) return true } return false })()`
const CLICK_NODE = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node');
  for (var i=0;i<ns.length;i++){ var t=ns[i].querySelector('.dside-node-name');
    if (t && t.textContent===${JSON.stringify(name)}){ ns[i].click(); return true } } return false })()`
const DBL_ONLY_NODE = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node');
  for (var i=0;i<ns.length;i++){ var t=ns[i].querySelector('.dside-node-name');
    if (t && t.textContent===${JSON.stringify(name)}){
      ns[i].dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true})); return true } } return false })()`
const DBL_NODE = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node');
  for (var i=0;i<ns.length;i++){ var t=ns[i].querySelector('.dside-node-name');
    if (t && t.textContent===${JSON.stringify(name)}){ ns[i].click(); ns[i].click();
      ns[i].dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true})); return true } } return false })()`
const RIGHT_CLICK_NODE = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node');
  for (var i=0;i<ns.length;i++){ var t=ns[i].querySelector('.dside-node-name');
    if (t && t.textContent===${JSON.stringify(name)}){ var r=ns[i].getBoundingClientRect();
      ns[i].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,
        clientX:Math.round(r.left+30),clientY:Math.round(r.top+8)})); return true } } return false })()`
const TAB_INFO = `(function(){ var ts=document.querySelectorAll('.dside-tablist .dside-tab'); var a=[];
  for (var i=0;i<ts.length;i++){ var n=ts[i].querySelector('.dside-tab-name'); var st=n?getComputedStyle(n):null;
    a.push({ name:n?String(n.textContent):'', preview:ts[i].classList.contains('preview'),
      pinned:ts[i].classList.contains('pinned'), compact:ts[i].classList.contains('compact'),
      active:ts[i].classList.contains('active'), italic: st?st.fontStyle:'',
      nameW: n?Math.round(n.getBoundingClientRect().width):-1,
      unpinBtn: !!ts[i].querySelector('.dside-tab-unpin') }) }
  return a })()`
const CLOSE_EVERYTHING = `(function(){ var ts=document.querySelectorAll('.dside-tablist .dside-tab');
  for (var i=0;i<ts.length;i++){ var b=ts[i].querySelector('.dside-tab-close'); if (b) b.click() } return ts.length })()`
function tabEvent(name, kind) {
  return `(function(){ var ts=document.querySelectorAll('.dside-tablist .dside-tab');
    for (var i=0;i<ts.length;i++){ var n=ts[i].querySelector('.dside-tab-name');
      if (n && n.textContent===${JSON.stringify(name)}){
        if (${JSON.stringify(kind)}==='contextmenu'){ var r=ts[i].getBoundingClientRect();
          ts[i].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,
            clientX:Math.round(r.left+20),clientY:Math.round(r.top+10)})); return true }
        if (${JSON.stringify(kind)}==='dblclick'){ ts[i].click(); ts[i].click();
          ts[i].dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true})); return true }
        ts[i].click(); return true } }
    return false })()`
}
const RIGHT_CLICK_TAB = (name) => tabEvent(name, 'contextmenu')
const CLICK_TAB = (name) => tabEvent(name, 'click')
const DBL_TAB = (name) => tabEvent(name, 'dblclick')
const MENU_ITEMS = `(function(){ var ms=document.querySelectorAll('.dside-menu-item'); var a=[];
  for (var i=0;i<ms.length;i++) a.push((ms[i].classList.contains('disabled')?'[灰]':'') + String(ms[i].textContent)); return a })()`
const MENU_OPEN = `!!document.querySelector('.dside-menu')`
const CLICK_MENU = (label) => `(function(){ var ms=document.querySelectorAll('.dside-menu-item');
  for (var i=0;i<ms.length;i++){ var t=String(ms[i].textContent);
    if (t.indexOf(${JSON.stringify(label)})>=0 && !ms[i].classList.contains('disabled')){ ms[i].click(); return true } }
  return false })()`
// Ctrl+K 和弦：按住 Ctrl 打 K，再打第二个键
const CHORD = (key, shift) => `(function(){ function kd(k, o){ var e={key:k,bubbles:true,cancelable:true,ctrlKey:true};
    if (o) for (var p in o) e[p]=o[p]; window.dispatchEvent(new KeyboardEvent('keydown', e)) }
  kd('k'); kd(${JSON.stringify(key)}, ${shift ? '{shiftKey:true}' : 'null'}); return true })()`
const CTRL_W = `(function(){ window.dispatchEvent(new KeyboardEvent('keydown',
  {key:'w',code:'KeyW',ctrlKey:true,bubbles:true,cancelable:true})); return true })()`
const MIDDLE_CLICK_TAB = (name) => `(function(){ var ts=document.querySelectorAll('.dside-tablist .dside-tab');
  for (var i=0;i<ts.length;i++){ var n=ts[i].querySelector('.dside-tab-name');
    if (n && n.textContent===${JSON.stringify(name)}){
      ts[i].dispatchEvent(new MouseEvent('auxclick',{bubbles:true,cancelable:true,button:1})); return true } }
  return false })()`
const MAKE_DIRTY = (name) => `(function(){ var ms=window.monaco.editor.getModels();
  for (var i=0;i<ms.length;i++){ if (String(ms[i].uri).toLowerCase().indexOf(${JSON.stringify(name.toLowerCase())})>=0){
    ms[i].applyEdits([{range:new window.monaco.Range(1,1,1,1), text:'// e2e-dirty\\n'}]);
    return String(ms[i].uri) } } return null })()`
const UNDO_MODEL = (name) => `(function(){ var ms=window.monaco.editor.getModels();
  for (var i=0;i<ms.length;i++){ if (String(ms[i].uri).toLowerCase().indexOf(${JSON.stringify(name.toLowerCase())})>=0){
    ms[i].undo(); return true } } return false })()`
const PICK_ACTIVITY = (label) => `(function(){ var bs=document.querySelectorAll('.dside-activitybar button');
  for (var i=0;i<bs.length;i++){ var l=String(bs[i].getAttribute('title')||'');
    if (l.indexOf(${JSON.stringify(label)})>=0){ bs[i].click(); return true } } return false })()`
const OPEN_SETTINGS = PICK_ACTIVITY('设置')
const OPEN_EXPLORER = PICK_ACTIVITY('资源管理器')
const SETTING_ROWS = `(function(){ var rs=document.querySelectorAll('.dside-explorer .dside-block-row'); var a=[];
  for (var i=0;i<rs.length;i++){ var l=rs[i].querySelector('.dside-block-label'); var tg=rs[i].querySelector('.dside-toggle');
    if (tg) a.push({ label: l?String(l.textContent):'', on: tg.classList.contains('on'), disabled: !!tg.disabled }) }
  return a })()`
const CLICK_SETTING = (label) => `(function(){ var rs=document.querySelectorAll('.dside-explorer .dside-block-row');
  for (var i=0;i<rs.length;i++){ var l=rs[i].querySelector('.dside-block-label'); var tg=rs[i].querySelector('.dside-toggle');
    if (tg && l && String(l.textContent).indexOf(${JSON.stringify(label)})>=0){ tg.click(); return true } } return false })()`

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

    // 专用安静工作区（fixture 就是工作区根，树里直接可见，不依赖任何已有会话）
    rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
    mkdirSync(WS, { recursive: true })
    writeFileSync(P('a'), 'a line1\na line2\n')
    writeFileSync(P('b'), 'b line1\nb line2\n')
    writeFileSync(P('c'), 'c line1\nc line2\n')
    writeFileSync(P('d'), 'd line1\nd line2\n')
    writeFileSync(P('e'), 'e line1\ne line2\n')
    const A = '_e2etabs_a.txt', B = '_e2etabs_b.txt', C = '_e2etabs_c.txt', D = '_e2etabs_d.txt', E = '_e2etabs_e.txt'

    // 临时浏览器 profile 一律落 temp（00devCore §0.5），别落 D:\99DSH 根
    const userDir = 'D:\\99DSH\\temp\\.edge-e2etabs-tmp-' + process.pid
    try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch (e) { /* Windows 文件锁：临时 profile 删不掉不影响结论 */ }
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
      while (Date.now() - t < ms) {
        const v = await evalJs(expr)
        if (v) return v
        await sleep(250)
      }
      return null
    }

    await cdp('Runtime.enable')
    await cdp('Page.enable')
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco && !!document.querySelector('.dside-tablist')`, 90000)
    check('P1 页面挂载完成（IDE 布局 + monaco + 标签栏）', !!ready, await evalJs('document.readyState'))

    // 把活动工作空间指到专用目录（host 会顺手 bump fsRev → 客户端立刻重列）。
    // ⚠ 客户端会在页面加载/会话列表变化时按"当前会话 cwd"上报一次 active-root，把这里设的根覆盖掉
    //   （这是产品设计）。所以**循环设根直到树里真的出现 fixture**，别只设一次就赌它不被覆盖。
    let wsOk = false
    for (let i = 0; i < 12 && !wsOk; i++) {
      await fetch(APP + '/dsh-ide/active-root', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: WS }),
      })
      wsOk = (await waitFor(HAS_NODE(A), 2500)) === true
    }
    check('P2 专用工作区生效（树里直接看到 5 个测试文件）',
      wsOk === true && (await evalJs(HAS_NODE(E))) === true, 'ws=' + WS)

    // ── 预览模式 ────────────────────────────────────────────────
    await evalJs(CLOSE_EVERYTHING); await sleep(400)
    await evalJs(CLICK_NODE(A)); await sleep(900)
    let t = await evalJs(TAB_INFO)
    check('P3 单击文件 = 打开一个预览标签（斜体 + preview 类）',
      Array.isArray(t) && t.length === 1 && t[0].name === A && t[0].preview === true && t[0].italic === 'italic',
      JSON.stringify(t))

    await evalJs(CLICK_NODE(B)); await sleep(900)
    t = await evalJs(TAB_INFO)
    check('P4 再单击另一个文件 = 就地复用同一个预览标签（标签数不变）',
      Array.isArray(t) && t.length === 1 && t[0].name === B && t[0].preview === true, JSON.stringify(t))

    await evalJs(DBL_ONLY_NODE(C)); await sleep(1000)
    t = await evalJs(TAB_INFO)
    check('P5 双击 = 固定打开（新增标签、不斜体；原来的预览标签保持不动）',
      Array.isArray(t) && t.length === 2 && t[0].name === B && t[0].preview === true
        && t[1].name === C && t[1].preview === false && t[1].italic === 'normal', JSON.stringify(t))

    await evalJs(DBL_NODE(D)); await sleep(1200)
    t = await evalJs(TAB_INFO)
    check('P6 真双击（两次单击 + dblclick）：预览槽被复用后转正，最终两个固定标签',
      Array.isArray(t) && t.length === 2 && t[0].name === D && t[0].preview === false
        && t[1].name === C && t[1].preview === false, JSON.stringify(t))

    await evalJs(CLICK_NODE(E)); await sleep(900)
    t = await evalJs(TAB_INFO)
    check('P7 没有预览标签时单击 = 新开一个预览标签（追加在末尾）',
      Array.isArray(t) && t.length === 3 && t[2].name === E && t[2].preview === true, JSON.stringify(t))

    const dirtyUri = await evalJs(MAKE_DIRTY(E))
    await sleep(1300)
    t = await evalJs(TAB_INFO)
    check('P8 预览标签一旦被编辑（变脏）= 自动转正',
      !!dirtyUri && Array.isArray(t) && t.length === 3 && t[2].name === E && t[2].preview === false,
      'uri=' + dirtyUri + ' tabs=' + JSON.stringify(t))
    await evalJs(UNDO_MODEL(E)); await sleep(900)

    await evalJs(CLICK_NODE(A)); await sleep(900)
    await evalJs(CHORD('Enter', false)); await sleep(900)
    t = await evalJs(TAB_INFO)
    check('P9 Ctrl+K Enter = 保持打开（预览转正）',
      Array.isArray(t) && t.length === 4 && t[3].name === A && t[3].preview === false && t[3].italic === 'normal',
      JSON.stringify(t))

    await evalJs(CLICK_NODE(B)); await sleep(700)
    await evalJs(DBL_TAB(B)); await sleep(800)
    t = await evalJs(TAB_INFO)
    check('P10 双击标签 = 转正（VSCode 手感）',
      Array.isArray(t) && t[t.length - 1].name === B && t[t.length - 1].preview === false, JSON.stringify(t))

    // ── 标签右键菜单（对照 VSCode 的 EditorTitleContext）────────────
    await evalJs(RIGHT_CLICK_TAB(C)); await sleep(600)
    const items = await evalJs(MENU_ITEMS)
    const joined = Array.isArray(items) ? items.join('|') : ''
    check('P11 菜单关闭族齐全（关闭 / 关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭）',
      Array.isArray(items) && joined.includes('关闭') && joined.includes('关闭其他')
        && joined.includes('关闭右侧所有标签') && joined.includes('关闭已保存的标签') && joined.includes('全部关闭'),
      JSON.stringify(items))
    check('P12 固定标签上「保持打开」置灰（VSCode 用 precondition 置灰而不是隐藏）',
      Array.isArray(items) && joined.includes('[灰]保持打开'), joined)
    check('P13 菜单里有键位提示（Ctrl+K W / Ctrl+K U / Ctrl+K Enter / Ctrl+K Shift+Enter）',
      joined.includes('Ctrl+K W') && joined.includes('Ctrl+K U') && joined.includes('Ctrl+K Enter')
        && joined.includes('Ctrl+K Shift+Enter'), joined)
    // ⚠ 旧断言（"标签菜单里没有复制路径 / 在资源管理器中显示"）**基于错误事实**，2026-09-29 反转：
    //   VSCode 这两条就在**编辑器标题右键菜单**里（files/browser/fileActions.contribution.ts:165 与
    //   files/electron-browser/fileActions.contribution.ts:61，分组 1_cutcopypaste / 2_files）。
    //   本套件跑在浏览器里没有壳桥 ⇒「在文件资源管理器中显示」应当**自动隐藏**，这也要一起钉住。
    check('P14 标签菜单里有复制路径（对齐 VSCode 编辑器标题右键）；无壳桥时「在文件资源管理器中显示」自动隐藏',
      joined.indexOf('复制路径') >= 0 && joined.indexOf('在文件资源管理器中显示') < 0, joined)
    await evalJs(CLICK_MENU('关闭')); await sleep(500)   // 顺手关掉 C 这个标签，也把菜单收起来

    await evalJs(RIGHT_CLICK_NODE(D)); await sleep(600)
    const treeItems = await evalJs(MENU_ITEMS)
    check('P15 资源管理器右键里有路径族（复制路径 / 复制相对路径）',
      Array.isArray(treeItems) && treeItems.join('|').includes('复制路径')
        && treeItems.join('|').includes('复制相对路径'), JSON.stringify(treeItems))
    await evalJs(CLICK_MENU('复制路径')); await sleep(600)

    await evalJs(CLICK_NODE(C)); await sleep(800)        // C 刚被关掉 → 现在是预览标签
    await evalJs(RIGHT_CLICK_TAB(C)); await sleep(500)
    const itemsPreview = await evalJs(MENU_ITEMS)
    check('P16 预览标签上「保持打开」可用（不置灰）',
      Array.isArray(itemsPreview) && itemsPreview.join('|').includes('保持打开')
        && itemsPreview.join('|').indexOf('[灰]保持打开') < 0, JSON.stringify(itemsPreview))
    await evalJs(CLICK_MENU('保持打开')); await sleep(700)
    t = await evalJs(TAB_INFO)
    check('P17 点「保持打开」= 转正生效',
      Array.isArray(t) && t[t.length - 1].name === C && t[t.length - 1].preview === false, JSON.stringify(t))

    // ── 关闭族 ─────────────────────────────────────────────────
    await evalJs(CLOSE_EVERYTHING); await sleep(400)
    for (const n of [A, B, C]) { await evalJs(DBL_NODE(n)); await sleep(700) }
    t = await evalJs(TAB_INFO)
    check('P18 准备三个固定标签', Array.isArray(t) && t.length === 3, JSON.stringify(t))
    await evalJs(RIGHT_CLICK_TAB(B)); await sleep(500)
    await evalJs(CLICK_MENU('关闭其他')); await sleep(800)
    t = await evalJs(TAB_INFO)
    check('P19 「关闭其他」只剩被点的那一个（且它被转正）',
      Array.isArray(t) && t.length === 1 && t[0].name === B && t[0].preview === false, JSON.stringify(t))

    await evalJs(DBL_NODE(D)); await sleep(700)
    await evalJs(DBL_NODE(E)); await sleep(700)
    await evalJs(RIGHT_CLICK_TAB(B)); await sleep(500)
    await evalJs(CLICK_MENU('关闭右侧所有标签')); await sleep(800)
    t = await evalJs(TAB_INFO)
    check('P20 「关闭右侧所有标签」把右边的都关掉', Array.isArray(t) && t.length === 1 && t[0].name === B, JSON.stringify(t))

    await evalJs(DBL_NODE(A)); await sleep(700)
    await evalJs(DBL_NODE(C)); await sleep(700)
    await evalJs(MAKE_DIRTY(C)); await sleep(1000)
    await evalJs(CHORD('u', false)); await sleep(900)
    t = await evalJs(TAB_INFO)
    check('P21 Ctrl+K U（关闭已保存）保留脏标签、关掉干净标签',
      Array.isArray(t) && t.length === 1 && t[0].name === C, JSON.stringify(t))
    await evalJs(UNDO_MODEL(C)); await sleep(900)

    // ── 固定标签（VSCode 的 sticky）─────────────────────────────
    await evalJs(CLOSE_EVERYTHING); await sleep(400)
    for (const n of [A, B, C]) { await evalJs(DBL_NODE(n)); await sleep(700) }
    await evalJs(RIGHT_CLICK_TAB(C)); await sleep(500)
    await evalJs(CLICK_MENU('固定')); await sleep(800)
    t = await evalJs(TAB_INFO)
    check('P22 固定后靠左、pinned 类生效；默认尺寸下名字仍在（VSCode pinnedTabSizing=normal）',
      Array.isArray(t) && t.length === 3 && t[0].name === C && t[0].pinned === true && t[0].nameW > 0,
      JSON.stringify(t))
    check('P23 固定标签的悬浮按钮变成「取消固定」', Array.isArray(t) && t[0].unpinBtn === true, JSON.stringify(t))

    await evalJs(CLICK_TAB(C)); await sleep(600)      // 让固定标签成为活动标签
    await evalJs(CTRL_W); await sleep(700)
    t = await evalJs(TAB_INFO)
    check('P24 Ctrl+W 关不掉固定标签（VSCode 的 preventPinnedEditorClose），且活动标签跳到下一个未固定',
      Array.isArray(t) && t.length === 3 && t[0].name === C && t[0].pinned === true && t[1].active === true,
      JSON.stringify(t))
    await evalJs(MIDDLE_CLICK_TAB(C)); await sleep(700)
    t = await evalJs(TAB_INFO)
    check('P25 中键点击也关不掉固定标签', Array.isArray(t) && t.length === 3 && t[0].name === C, JSON.stringify(t))

    await evalJs(RIGHT_CLICK_TAB(A)); await sleep(500)
    await evalJs(CLICK_MENU('全部关闭')); await sleep(900)
    t = await evalJs(TAB_INFO)
    check('P26 「全部关闭」跳过固定标签（固定的那个留下）',
      Array.isArray(t) && t.length === 1 && t[0].name === C && t[0].pinned === true, JSON.stringify(t))

    await evalJs(RIGHT_CLICK_TAB(C)); await sleep(500)
    await evalJs(CLICK_MENU('关闭')); await sleep(800)   // 菜单里的「关闭」连固定标签也能关
    t = await evalJs(TAB_INFO)
    check('P27 菜单里的「关闭」能关掉固定标签（VSCode：menu always closes, even sticky）',
      Array.isArray(t) && t.length === 0, JSON.stringify(t))

    // ── 复制路径（Ctrl+K P，VSCode 默认键位）+ 埋点 ─────────────────
    await evalJs(DBL_NODE(A)); await sleep(800)
    await evalJs(CHORD('p', false)); await sleep(2500)   // trace 是 800ms 去抖批量上报
    let traceTxt = ''
    for (let i = 0; i < 12; i++) {
      try { traceTxt = readFileSync(TRACE_LOG, 'utf8') } catch { /* 还没落盘 */ }
      if (traceTxt.includes('copy-path')) break
      await sleep(700)
    }
    check('P28 Ctrl+K P 复制当前文件路径（埋点里带完整路径）',
      traceTxt.includes('copy-path') && traceTxt.includes(A), traceTxt.includes('copy-path') ? 'ok' : 'no copy-path in trace')

    // ── 设置开关（默认值与 VSCode 一致）────────────────────────────
    await evalJs(CLOSE_EVERYTHING); await sleep(400)
    await evalJs(OPEN_SETTINGS); await sleep(800)
    const rows = await evalJs(SETTING_ROWS)
    // ⚠ SETTING_ROWS 是"把左栏所有区块里的开关行拉平"（不是只取「标签」区块），所以
    //   **每加一个开关行这条断言就会挂一次**：2026-09-22 加了第 5 条「重开软件时恢复上次打开
    //   的文件」（默认开）→ 这里从 4 条改成 5 条。以后再加开关，记得同步这里。
    check('P29 设置组「标签」区块五个开关，默认值与 VSCode 一致（预览开 / 快速打开关 / 跳转保护开 / 收窄关 / 恢复会话开）',
      Array.isArray(rows) && rows.length === 5 && rows[0].on === true && rows[1].on === false
        && rows[2].on === true && rows[3].on === false && rows[4].on === true, JSON.stringify(rows))
    await evalJs(CLICK_SETTING('预览模式')); await sleep(500)
    const rows2 = await evalJs(SETTING_ROWS)
    check('P30 关掉「预览模式」后，两个预览子开关变灰；「固定标签收窄」保持可用（与预览无关）',
      Array.isArray(rows2) && rows2[0].on === false && rows2[1].disabled === true
        && rows2[2].disabled === true && rows2[3].disabled === false, JSON.stringify(rows2))

    await evalJs(OPEN_EXPLORER); await sleep(800)
    await evalJs(CLICK_NODE(A)); await sleep(900)
    t = await evalJs(TAB_INFO)
    check('P31 预览模式关掉后，单击文件 = 固定打开（不再斜体）',
      Array.isArray(t) && t.length === 1 && t[0].preview === false && t[0].italic === 'normal', JSON.stringify(t))

    await evalJs(OPEN_SETTINGS); await sleep(700)
    const prefsRaw = await evalJs(`(function(){ try { return String(localStorage.getItem('dside.tabPrefs.v1')) } catch(e){ return 'ERR' } })()`)
    await evalJs(CLICK_SETTING('预览模式')); await sleep(400)
    const rows3 = await evalJs(SETTING_ROWS)
    await evalJs(CLICK_SETTING('固定标签收窄成图标')); await sleep(500)
    const rows4 = await evalJs(SETTING_ROWS)
    await evalJs(OPEN_EXPLORER); await sleep(700)
    await evalJs(CLOSE_EVERYTHING); await sleep(300)
    await evalJs(DBL_NODE(A)); await sleep(700)
    await evalJs(RIGHT_CLICK_TAB(A)); await sleep(500)
    await evalJs(CLICK_MENU('固定')); await sleep(800)
    t = await evalJs(TAB_INFO)
    check('P32 打开「固定标签收窄成图标」后，固定标签只显示图标（名字宽度 0 + compact 类）',
      Array.isArray(t) && t.length === 1 && t[0].pinned === true && t[0].compact === true && t[0].nameW === 0,
      JSON.stringify(t))
    check('P33 开关落盘（localStorage）且能改回默认',
      typeof prefsRaw === 'string' && prefsRaw.includes('"preview":false') && Array.isArray(rows3) && rows3[0].on === true
        && Array.isArray(rows4) && rows4[3].on === true, 'prefs=' + prefsRaw + ' rows3=' + JSON.stringify(rows3))
    await evalJs(OPEN_SETTINGS); await sleep(600)
    await evalJs(CLICK_SETTING('固定标签收窄成图标')); await sleep(400)
    await evalJs(OPEN_EXPLORER); await sleep(500)

    // ── ⑯ 选中态 + 右侧面板（2026-09-21 用户报障 / 用户要求的回归）─────────
    await evalJs(CLOSE_EVERYTHING); await sleep(300)
    await evalJs(CLICK_NODE(A)); await sleep(1000)
    const selCount = await evalJs(`document.querySelectorAll('.dside-explorer .dside-node.sel').length`)
    const selName = await evalJs(`(function(){ var n=document.querySelector('.dside-explorer .dside-node.sel .dside-node-name'); return n?String(n.textContent):null })()`)
    check('P34 打开文件后，资源管理器里**只有一个**节点是选中态（不是整棵树都高亮）',
      selCount === 1 && selName === A, `sel=${selCount} name=${selName}`)

    const sideTabs = await evalJs(`document.querySelectorAll('.dside-side-tabs, .dside-side-tab').length`)
    check('P35 右侧面板不再有「Agent 助手 / 插件」标签栏', sideTabs === 0, String(sideTabs))
    const agentMounted = await evalJs(`!!document.querySelector('.dside-side .dside-agent-platform')`)
    check('P36 右侧永远就是 Agent 面板（平台会话槽还挂着）', agentMounted === true, String(agentMounted))

    const actTitles = await evalJs(`(function(){ var bs=document.querySelectorAll('.dside-activitybar button'); var a=[];
      for (var i=0;i<bs.length;i++) a.push(String(bs[i].getAttribute('title')||'')); return a })()`)
    check('P37 活动栏多了「插件」分组（资源管理器 / 操作 / 插件 + 设置）',
      Array.isArray(actTitles) && actTitles.length === 4 && actTitles.join('|').includes('插件')
        && actTitles.join('|').includes('设置'), JSON.stringify(actTitles))
    await evalJs(PICK_ACTIVITY('插件')); await sleep(900)
    const pluginPanelInLeft = await evalJs(`!!document.querySelector('.dside-explorer .dside-plugins')`)
    check('P38 点活动栏「插件」→ 左侧面板里出现插件列表', pluginPanelInLeft === true, String(pluginPanelInLeft))
    await evalJs(OPEN_EXPLORER); await sleep(700)

    // ── ⑯ 输入框永远贴底（空会话 hero 阶段也不许居中）──────────────────
    await evalJs(`(function(){ var bs=document.querySelectorAll('.dside-side-actions button');
      for (var i=0;i<bs.length;i++){ if (String(bs[i].textContent).indexOf('新对话')>=0){ bs[i].click(); return true } } return false })()`)
    await sleep(4000)
    const chatGeo = await evalJs(`(function(){
      var panel=document.querySelector('.dside-side');
      var root=document.querySelector('.dside-agent-platform [data-phase]');
      var seat=document.querySelector('.dside-agent-platform [data-composer-seat]');
      var ed=document.querySelector('.dside-agent-platform [contenteditable="true"]');
      if(!panel||!seat||!ed) return { err:'missing', hasPanel:!!panel, hasSeat:!!seat, hasEd:!!ed };
      var pr=panel.getBoundingClientRect(), sr=seat.getBoundingClientRect(), er=ed.getBoundingClientRect();
      return { phase: root?root.getAttribute('data-phase'):null,
        seatGap: Math.round(pr.bottom-sr.bottom), edGap: Math.round(pr.bottom-er.bottom),
        panelH: Math.round(pr.height), seatTopPct: Math.round((sr.top-pr.top)/pr.height*100),
        edInSeat: seat.contains(ed) } })()`)
    check('P39 空会话（hero 阶段）输入区也贴底，不再垂直居中',
      !!chatGeo && chatGeo.phase === 'hero' && chatGeo.edInSeat === true
        && chatGeo.seatGap >= 0 && chatGeo.seatGap < 60 && chatGeo.edGap < 260,
      JSON.stringify(chatGeo))

    check('P40 全程页面零未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
    check('P41 右键菜单在操作后不残留', (await evalJs(MENU_OPEN)) === false)
  } finally {
    if (browser) killTree(browser.pid)
    killTree(backend.pid)
    await sleep(1500)
    try { rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch { /* 自清兜底 */ }
    try { rmSync('D:\\99DSH\\.edge-e2etabs-tmp-' + process.pid, { recursive: true, force: true }) } catch { /* 自清兜底 */ }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n== ⑮ 标签三件套 E2E: ${results.length - failed.length}/${results.length} 通过 ==`)
  if (failed.length) { console.log('FAIL:', failed.map((f) => f.name).join(' | ')); process.exitCode = 1 }
}

main().catch((e) => { console.error('E2E crashed:', (e && e.stack) || e); process.exitCode = 1 })
