import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// ⑫ 地基补漏 · A1 文件树三件套 E2E（新建 / 重命名 / 删除）
// 用法: node tools\e2e12.mjs
//   （自起测试后端，默认 3082；DSH_HOME=<仓库根>\app-home；fixture 自建自清）
// 验的是：真浏览器右键 → 菜单 → 命名对话框 → 真磁盘落盘；以及三道闸
//   （不覆盖已有内容 · 工作空间根围栏 · 删除需确认且目录要 recursive）。
// confirm 走 CDP 的真实弹窗处理（Page.javascriptDialogOpening → accept），**不 stub 产品逻辑**。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.DSH_E2E_PORT || 3082)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = `${__TIANGONG_ROOT}\\app-home`
const CLI = `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js`
const BLOG = `${__TIANGONG_ROOT}\\_e2e12_backend_` + PORT + '.log'
const FIX = '_e2e12'
const CDP_PORT = 9800 + Math.floor(Math.random() * 200)

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
const NAMES = `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node-name'); var a=[];
  for (var i=0;i<ns.length;i++) a.push(ns[i].textContent); return a })()`
const HAS_NODE = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node-name');
  for (var i=0;i<ns.length;i++){ if (ns[i].textContent===${JSON.stringify(name)}) return true } return false })()`
const CLICK_NODE = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node');
  for (var i=0;i<ns.length;i++){ var t=ns[i].querySelector('.dside-node-name');
    if (t && t.textContent===${JSON.stringify(name)}){ ns[i].click(); return true } } return false })()`
// ⑮ 起单击 = 预览标签（VSCode 手感），要"固定打开"（多标签场景）得双击
const DBL_NODE = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node');
  for (var i=0;i<ns.length;i++){ var t=ns[i].querySelector('.dside-node-name');
    if (t && t.textContent===${JSON.stringify(name)}){ ns[i].click(); ns[i].click();
      ns[i].dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true})); return true } } return false })()`
const RIGHT_CLICK = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node');
  for (var i=0;i<ns.length;i++){ var t=ns[i].querySelector('.dside-node-name');
    if (t && t.textContent===${JSON.stringify(name)}){ var r=ns[i].getBoundingClientRect();
      ns[i].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:Math.round(r.left+30),clientY:Math.round(r.top+8)}));
      return true } } return false })()`
const MENU_ITEMS = `(function(){ var ms=document.querySelectorAll('.dside-menu-item'); var a=[];
  for (var i=0;i<ms.length;i++) a.push(ms[i].textContent); return a })()`
const CLICK_MENU = (label) => `(function(){ var ms=document.querySelectorAll('.dside-menu-item');
  for (var i=0;i<ms.length;i++){ if (String(ms[i].textContent).indexOf(${JSON.stringify(label)})>=0){ ms[i].click(); return true } } return false })()`
const DIALOG_TITLE = `(function(){ var t=document.querySelector('.dside-dialog .dside-palette-title'); return t? String(t.textContent) : null })()`
// ⑲ 新建走**内联输入行**（VSCode 手感，2026-09-21 起）：树里就地出输入框，不是命名对话框
const INLINE_INPUT = `(function(){ var i=document.querySelector('.dside-node-new .dside-inline-input');
  return i ? { focused: document.activeElement===i, placeholder: i.getAttribute('placeholder')||'' } : null })()`
const INLINE_SUBMIT = (text) => `(function(){ var inp=document.querySelector('.dside-node-new .dside-inline-input'); if(!inp) return 'no-input';
  var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(inp, ${JSON.stringify(text)}); inp.dispatchEvent(new Event('input',{bubbles:true}));
  inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return true })()`
const DIALOG_SUBMIT = (text) => `(function(){ var inp=document.querySelector('.dside-dialog input'); if(!inp) return 'no-input';
  var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(inp, ${JSON.stringify(text)}); inp.dispatchEvent(new Event('input',{bubbles:true}));
  inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return true })()`
const STATUS = `(function(){ var el=document.querySelector('.dside-statusbar span'); return el? String(el.textContent) : '' })()`
// ── ⑫ A2/A3/A4 用 ──
const OPEN_SEARCH = `(function(){ window.dispatchEvent(new KeyboardEvent('keydown',
  {key:'f',code:'KeyF',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})); return true })()`
const TYPE_SEARCH = (text) => `(function(){ var inp=document.querySelector('.dside-search-input'); if(!inp) return 'no-input';
  var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(inp, ${JSON.stringify(text)}); inp.dispatchEvent(new Event('input',{bubbles:true})); return true })()`
const HIT_COUNT = `document.querySelectorAll('.dside-search-line').length`
const FILE_COUNT = `document.querySelectorAll('.dside-search-group').length`
const CLICK_OPT = (label) => `(function(){ var os=document.querySelectorAll('.dside-opt');
  for (var i=0;i<os.length;i++){ if (String(os[i].textContent).indexOf(${JSON.stringify(label)})>=0){ os[i].click(); return true } } return false })()`
const OPT_STATE = `(function(){ var os=document.querySelectorAll('.dside-opt'); var a=[];
  for (var i=0;i<os.length;i++) a.push(String(os[i].textContent)+(String(os[i].className).indexOf('on')>=0?'[on]':'')); return a })()`
const TYPE_REPLACE = (text) => `(function(){ var row=document.querySelector('.dside-search-reprow'); if(!row) return 'no-reprow';
  var inp=row.querySelector('input'); if(!inp) return 'no-input';
  var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(inp, ${JSON.stringify(text)}); inp.dispatchEvent(new Event('input',{bubbles:true})); return true })()`
const CLICK_REPLACE_ALL = `(function(){ var row=document.querySelector('.dside-search-reprow'); if(!row) return 'no-reprow';
  var bs=row.querySelectorAll('button'); for (var i=0;i<bs.length;i++){ if (String(bs[i].textContent).indexOf('全部替换')>=0){ bs[i].click(); return true } }
  return false })()`
const CLICK_HIT_REPLACE = `(function(){ var el=document.querySelector('.dside-search-line .dside-search-rep'); if(!el) return 'no-hit-rep'; el.click(); return true })()`
const TAB_NAMES = `(function(){ var ts=document.querySelectorAll('.dside-tab-name'); var a=[];
  for (var i=0;i<ts.length;i++) a.push(ts[i].textContent); return a })()`
const DRAG_TAB = `(function(){ var ts=document.querySelectorAll('.dside-tab'); if(ts.length<2) return 'need-2-tabs';
  var dt=new DataTransfer();
  ts[1].dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));
  ts[0].dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
  ts[0].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
  return true })()`

const S1 = `alpha one
Alpha two
alphabet three
alpha4 four
`
const S2 = `alpha five
alpha six
`

async function main() {
  rmSync(BLOG, { force: true })
  const fd = openSync(BLOG, 'w')
  const backend = spawn(process.execPath, [CLI, 'web', '--port', String(PORT), '--no-open'], {
    cwd: `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness`, env: cleanEnv(), stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  let backendExit = null
  backend.on('exit', (c) => { backendExit = c })

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

  // ⑮ 起改成「专用安静工作区」：这个家目录（<仓库根>\app-home）当前的活动工作区可能是整盘 `D:\`
  // —— 那样 /search、/tree 会撞 2 万文件上限、树被 fs.watch 每秒重列，fixture 在树里会忽隐忽现
  // （2026-09-21 实测：18 项里 12 项假 FAIL）。这里把活动根指到一个专用小目录（自建自清）。
  const WS = process.env.DSH_E2E_WS || `${__TIANGONG_ROOT}\\.smoke-ws12`
  rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
  mkdirSync(WS, { recursive: true })
  const ROOT = WS
  globalThis.__E2E_WS = WS
  globalThis.__ROOT = ROOT
  const dir = join(ROOT, FIX)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  writeFileSync(join(dir, 'search1.txt'), S1)
  writeFileSync(join(dir, 'search2.txt'), S2)

  const userDir = join(`${__TIANGONG_ROOT}`, '.edge-e2e12-tmp-' + process.pid)
  try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch (e) { /* Windows 文件锁：临时 profile 删不掉不影响结论 */ }
  const browser = spawn(findBrowser(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDir}`,
    APP + '/?token=' + token,
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
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
  let dialogs = 0
  let dialogText = ''
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      pageErrors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 200))
    }
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs += 1
      dialogText = String(m.params.message || '')
      cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})   // 真实弹窗：自动点「确定」
    }
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
      if (v && !v.__err) return v
      await sleep(300)
    }
    return null
  }

  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 90000)
  check('P1 页面挂载完成（IDE 布局 + monaco）', !!ready, await evalJs('document.readyState'))
  // ⚠ 顺序很重要：必须在**页面就绪之后**再把活动根指到专用工作区 —— 客户端会在页面加载时按
  // "当前会话 cwd"上报一次 active-root，早早 POST 会被它覆盖（树根又翻回整盘 D:\，fixture 就不见了）。
  // 而且它可能在加载后**再报一次**，所以这里循环设根直到树里真的出现 fixture。
  let wsOk = false
  for (let i = 0; i < 12 && !wsOk; i++) {
    await fetch(APP + '/dsh-ide/active-root', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: WS }),
    })
    wsOk = (await waitFor(HAS_NODE(FIX), 2500)) === true
  }
  check('P2 树里能看到 fixture 目录（专用工作区已生效）', wsOk === true, JSON.stringify(await evalJs(NAMES)))

  // ── P3/P4/P5 新建文件 ──────────────────────────────────────────
  await evalJs(RIGHT_CLICK(FIX))
  await sleep(600)
  const items = await evalJs(MENU_ITEMS)
  check('P3 右键目录弹出菜单（含新建文件/文件夹、重命名、删除）',
    Array.isArray(items) && items.join(',').indexOf('新建文件') >= 0 && items.join(',').indexOf('重命名') >= 0
      && items.join(',').indexOf('删除') >= 0, JSON.stringify(items))

  await evalJs(CLICK_MENU('新建文件'))
  await sleep(700)
  const inlineInfo = await evalJs(INLINE_INPUT)
  check('P4 树里出现内联新建输入行（VSCode 手感），且光标已聚焦', !!inlineInfo && inlineInfo.focused, JSON.stringify(inlineInfo))

  await evalJs(INLINE_SUBMIT('made.txt'))
  await sleep(1500)
  const madeOnDisk = existsSync(join(dir, 'made.txt'))
  // ⚠ 内联新建会**自动展开目标目录**（VSCode 同款），所以这里不能再无脑点一下展开 —— 那是把它收起。
  // 只有看不见目标目录时才点（同 e2e-explorer P11 的写法）。
  const folderVisible = await evalJs(HAS_NODE('made.txt'))
  if (!folderVisible) { await evalJs(CLICK_NODE(FIX)); await sleep(1000) }
  const madeInTree = await waitFor(HAS_NODE('made.txt'), 8000)
  check('P5 新建文件落到磁盘并出现在树里（且自动打开标签）', madeOnDisk && madeInTree === true,
    `disk=${madeOnDisk} tree=${JSON.stringify(await evalJs(NAMES))}`)

  // ── P6 新建文件夹 ──────────────────────────────────────────────
  await evalJs(RIGHT_CLICK(FIX))
  await sleep(500)
  await evalJs(CLICK_MENU('新建文件夹'))
  await sleep(700)
  await evalJs(INLINE_SUBMIT('sub'))
  await sleep(1500)
  check('P6 新建文件夹落到磁盘并出现在树里',
    existsSync(join(dir, 'sub')) && (await waitFor(HAS_NODE('sub'), 8000)) === true, String(existsSync(join(dir, 'sub'))))

  // ── P7 重命名 ──────────────────────────────────────────────────
  await evalJs(RIGHT_CLICK('made.txt'))
  await sleep(500)
  await evalJs(CLICK_MENU('重命名'))
  await sleep(600)
  await evalJs(DIALOG_SUBMIT('renamed.txt'))
  await sleep(1800)
  check('P7 重命名：旧名消失、新名落盘',
    !existsSync(join(dir, 'made.txt')) && existsSync(join(dir, 'renamed.txt')),
    JSON.stringify(await evalJs(NAMES)))

  // ── P8/P9 两道闸（直接打接口，验服务端行为）────────────────────
  const dup = await (await fetch(APP + '/dsh-ide/rename', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: join(dir, 'renamed.txt'), to: join(dir, 'seed.txt') }),
  })).json()
  check('P8 重命名撞已有文件被拒绝（不覆盖）', dup && dup.code === 'exists', JSON.stringify(dup))

  const outside = await (await fetch(APP + '/dsh-ide/new-entry', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: join(ROOT, '..', '_e2e12_outside.txt'), kind: 'file' }),
  })).json()
  check('P9 工作空间外的新建被拒绝（根围栏）', outside && outside.error === 'outside-workspace', JSON.stringify(outside))

  // ── P10/P11 删除（走真实 confirm）──────────────────────────────
  await evalJs(RIGHT_CLICK('renamed.txt'))
  await sleep(500)
  await evalJs(CLICK_MENU('删除'))
  await sleep(1800)
  check('P10 删除文件：弹过 confirm、磁盘已消失、树里也没了',
    dialogs > 0 && !existsSync(join(dir, 'renamed.txt')) && (await evalJs(HAS_NODE('renamed.txt'))) === false,
    `dialogs=${dialogs} msg=${dialogText.slice(0, 40)} tree=${JSON.stringify(await evalJs(NAMES))}`)

  await evalJs(RIGHT_CLICK('sub'))
  await sleep(500)
  await evalJs(CLICK_MENU('删除'))
  await sleep(1800)
  check('P11 删除文件夹（recursive 确认后生效）', !existsSync(join(dir, 'sub')), String(existsSync(join(dir, 'sub'))))

  // ── P13/P14/P15 ⑫ A3：搜索开关（大小写 / 全词 / 正则）──────────
  await evalJs(OPEN_SEARCH)
  await sleep(800)
  await evalJs(TYPE_SEARCH('alpha'))
  await sleep(1200)
  const n1 = await evalJs(HIT_COUNT)
  check('P13 搜索 alpha：命中 6 处（跨 2 个文件，大小写不敏感）',
    n1 === 6 && (await evalJs(FILE_COUNT)) === 2, `hits=${n1} files=${await evalJs(FILE_COUNT)}`)

  await evalJs(CLICK_OPT('ab'))
  await sleep(1200)
  const n2 = await evalJs(HIT_COUNT)
  check('P14 全词匹配：alphabet / alpha4 被排除（6 → 4）', n2 === 4, `hits=${n2} opts=${JSON.stringify(await evalJs(OPT_STATE))}`)

  await evalJs(CLICK_OPT('ab'))          // 关掉全词
  await sleep(600)
  await evalJs(CLICK_OPT('.*'))          // 开正则
  await sleep(600)
  await evalJs(TYPE_SEARCH('one$'))
  await sleep(1200)
  const n3 = await evalJs(HIT_COUNT)
  // 关掉正则 → 同一个串按**字面**搜（'one$' 这四个字符）→ 应为 0；
  // 这一对照才真正证明"正则 + 行锚定"生效（命中数受工作空间其它文件影响，不做精确断言）
  await evalJs(CLICK_OPT('.*'))
  await sleep(1000)
  const n4 = await evalJs(HIT_COUNT)
  check('P15 正则 one$：按行锚定有命中，关掉正则按字面搜则 0 命中',
    n3 >= 1 && n4 === 0, `regexHits=${n3} literalHits=${n4} opts=${JSON.stringify(await evalJs(OPT_STATE))}`)

  // P15 结尾已把正则关掉，这里直接回到普通搜索
  await evalJs(TYPE_SEARCH('alpha'))
  await sleep(1200)

  // ── P16 ⑫ A2：全部替换（跨文件）──────────────────────────────
  await evalJs(CLICK_OPT('⇄ 替换'))
  await sleep(700)
  await evalJs(TYPE_REPLACE('omega'))
  await sleep(300)
  const clickedAll = await evalJs(CLICK_REPLACE_ALL)
  await sleep(2500)
  const c1 = readFileSync(join(dir, 'search1.txt'), 'utf8')
  const c2 = readFileSync(join(dir, 'search2.txt'), 'utf8')
  const omegas = (c1 + c2).split('omega').length - 1
  check('P16 全部替换：两个文件里的 alpha 全部换成 omega（磁盘为准）',
    clickedAll === true && omegas === 6 && /alpha/i.test(c1 + c2) === false,
    `clicked=${clickedAll} omegas=${omegas} c1=${JSON.stringify(c1.slice(0, 40))}`)

  // ── P17 单处替换（只改一处）──────────────────────────────────
  await evalJs(TYPE_SEARCH('omega'))
  await sleep(1200)
  await evalJs(TYPE_REPLACE('OMEGA'))   // 替换框里要填**新的**文本（不然就是 omega→omega 原地不动）
  await sleep(300)
  const before2 = readFileSync(join(dir, 'search2.txt'), 'utf8')
  const hitClicked = await evalJs(CLICK_HIT_REPLACE)
  await sleep(2200)
  const after1 = readFileSync(join(dir, 'search1.txt'), 'utf8')
  const after2 = readFileSync(join(dir, 'search2.txt'), 'utf8')
  const upper = (after1 + after2).split('OMEGA').length - 1
  const omegasLeft = (after1 + after2).split('omega').length - 1
  // 单处替换打的是"结果里的第一处"，可能在任一文件 → 两个文件一起断言
  check('P17 单处替换：只有一处变成 OMEGA，其它保持 omega',
    hitClicked === true && upper === 1 && omegasLeft === 5,
    `clicked=${hitClicked} upper=${upper} omegas=${omegasLeft} s1=${JSON.stringify(after1.slice(0, 24))} s2=${JSON.stringify(after2.slice(0, 24))}`)

  // ── P18 ⑫ A4：标签拖拽排序 ───────────────────────────────────
  await evalJs(`(function(){ var cs=document.querySelector('.dside-search-card'); if(cs) window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return true })()`)
  await sleep(600)
  // 目录可能已经是展开状态（再点会折叠）→ 先看文件节点在不在
  if (!(await evalJs(HAS_NODE('search1.txt')))) {
    await evalJs(CLICK_NODE(FIX))
    await sleep(1000)
  }
  await evalJs(DBL_NODE('search1.txt'))     // ⑮ 双击 = 固定打开（单击只会占同一个预览标签）
  await sleep(1200)
  await evalJs(DBL_NODE('search2.txt'))
  await sleep(1500)
  const tabsBefore = await evalJs(TAB_NAMES)
  await evalJs(DRAG_TAB)
  await sleep(1200)
  const tabsAfter = await evalJs(TAB_NAMES)
  check('P18 标签拖拽排序：把第 2 个标签拖到第 1 个前面（插到它前面）',
    Array.isArray(tabsBefore) && Array.isArray(tabsAfter) && tabsBefore.length >= 2
      && tabsAfter[0] === tabsBefore[1] && tabsAfter[1] === tabsBefore[0],
    `before=${JSON.stringify(tabsBefore)} after=${JSON.stringify(tabsAfter)}`)

  check('P12 页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))

  const pass = results.filter((x) => x.ok).length
  console.log(`\n[e2e12] ${pass}/${results.length} passed`)
  return { ok: pass === results.length, browser, backend }
}

let handles = null
try {
  handles = await main()
} catch (e) {
  console.log('[e2e12] ABORT: ' + (e && e.stack ? e.stack : e))
} finally {
  try { if (handles && handles.browser) killTree(handles.browser.pid) } catch { /* ignore */ }
  try { if (handles && handles.backend) killTree(handles.backend.pid) } catch { /* ignore */ }
  await sleep(1500)
  try { rmSync(join(`${__TIANGONG_ROOT}`, '.edge-e2e12-tmp-' + process.pid), { recursive: true, force: true }) } catch { /* ignore */ }
  const root = globalThis.__ROOT || `${__TIANGONG_ROOT}\\dshworkspace2`
  try { rmSync(join(root, FIX), { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(join(root, '..', '_e2e12_outside.txt'), { force: true }) } catch { /* ignore */ }
  if (globalThis.__E2E_WS) { try { rmSync(globalThis.__E2E_WS, { recursive: true, force: true }) } catch { /* ignore */ } }
  console.log('[e2e12] cleanup done')
}
process.exit(handles && handles.ok ? 0 : 1)
