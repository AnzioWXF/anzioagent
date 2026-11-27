import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// ⑤ LSP 语言智能 E2E（CDP 真浏览器 + 真 monaco 语言服务）
// 用法: node tools\e2e5.mjs
//   （自起测试后端，默认 3082；DSH_HOME=<仓库根>\app-home；fixture 自建自清）
// 验的是 monaco 内建语言服务（TS/JS/JSON/CSS/HTML，跑在 web worker 里）在**本应用里**
//   到底哪些能力已经能用：补全 / 悬停 / 同文件与跨文件转到定义 / 文档符号 / 重命名 /
//   格式化 / 诊断。第一轮是"探明现状"，失败项 = 待接的活。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.DSH_E2E_PORT || 3082)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = `${__TIANGONG_ROOT}\\app-home`
const CLI = `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js`
const BLOG = `${__TIANGONG_ROOT}\\_e2e5_backend_` + PORT + '.log'
const TRACE = join(HOME_DIR, 'logs', 'ide-trace.log')
const FIX = '_e2e5'
const CDP_PORT = 9700 + Math.floor(Math.random() * 400)

const A_TS = `export const answer: number = 42
export function greet(name: string): string {
  return 'hi ' + name
}
`
const B_TS = `import { answer, greet } from './a'
const  y: string = answer
function local(x: number) { return x * 2 }
const z = greet('x')
const v = local( 3 )
const w = ans
import { helper } from './c'
const h2 = helper(1)
import { fakeGreet } from 'fakelib'
const fk = fakeGreet('x')
import { pkgGreet, PKG_EXTRA } from 'fakepkg'
const pg = pkgGreet(1)
const pe = PKG_EXTRA
function implicitAnyProbe(z) { return z }
`
// c.ts 是"**从不打开**"的文件：验项目文件喂给 worker 之后，未打开文件也能跨文件跳转
const C_TS = `export function helper(n: number) { return n + 1 }
`
// 假 @types 包：验第三方类型（node_modules/@types）喂养，不依赖真实 npm install
const FAKE_DTS = `export declare function fakeGreet(name: string): string
export declare const FAKE_VERSION: string
`
const FAKE_PKG = `{ "name": "@types/fakelib", "version": "1.0.0", "types": "index.d.ts" }
`
// 自带类型的包（不经 @types）：package.json 的 types 指向 dist/index.d.ts，入口里还相对 re-export 兄弟文件
const PKG_JSON = `{ "name": "fakepkg", "version": "1.0.0", "types": "dist/index.d.ts" }
`
const PKG_DTS_INDEX = `export * from './extra'
export declare function pkgGreet(x: number): number
`
const PKG_DTS_EXTRA = `export declare const PKG_EXTRA: string
`
// 项目 tsconfig：故意带注释 + 尾逗号（验 JSONC 剥离）；strict 会让下面的隐式 any 报错
const TSCONFIG = `{
  // e2e5 fixture（跑完还原/删除）
  "compilerOptions": {
    "strict": true,
    "target": "ES2020",
    "moduleResolution": "node",
  },
}
`
// 这个文件**从不打开**：验项目级全量诊断（未打开文件的错误也要进问题面板）
const NEVER_OPEN_TS = `const broken: number = 'not a number'
`

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
// 编辑器 + 模型助手：按文本定位光标
const HELPERS = `window.__p = (function(){
  function ed(){ return window.monaco.editor.getEditors()[0] }
  function model(){ var e=ed(); return e? e.getModel() : null }
  function posOf(text, occ){
    var m=model(); if(!m) return null; var s=m.getValue(); var idx=-1, from=0;
    for (var i=0;i<(occ||1);i++){ idx=s.indexOf(text, from); if(idx<0) return null; from=idx+1 }
    return m.getPositionAt(idx + Math.floor(text.length/2));
  }
  function dom(){
    function has(sel){ return !!document.querySelector(sel) }
    return {
      suggest: has('.suggest-widget.visible') || has('.suggest-widget'),
      hover: has('.monaco-hover'),
      peek: has('.peekview-widget') || has('.monaco-editor .peekview'),
      quickInput: has('.quick-input-widget'),
      rename: has('.rename-box') || has('.monaco-editor .rename-input') || has('.monaco-inputbox.rename'),
      markers: window.monaco.editor.getModelMarkers({ resource: model().uri }).length,
      modelPath: model()? String(model().uri.path) : null,
      cursor: (function(){ var e=ed(); var p=e.getPosition(); return p? (p.lineNumber+':'+p.column) : null })(),
      activeTab: (function(){ var ts=document.querySelectorAll('.dside-tab');
        for(var i=0;i<ts.length;i++){ if(String(ts[i].className).indexOf('active')>=0){ var n=ts[i].querySelector('.dside-tab-name'); return n?n.textContent:null } } return null })(),
      tabs: (function(){ var ts=document.querySelectorAll('.dside-tab-name'); var a=[]; for(var i=0;i<ts.length;i++) a.push(ts[i].textContent); return a })(),
      text: model()? model().getValue().split('\\n')[2] : null,
    }
  }
  return { ed:ed, model:model, posOf:posOf, dom:dom };
})(); 'ok'`

const CLICK_TAB = (name) => `(function(){ var ts=document.querySelectorAll('.dside-tab');
  for(var i=0;i<ts.length;i++){ var n=ts[i].querySelector('.dside-tab-name');
    if(n && n.textContent===${JSON.stringify(name)}){ ts[i].click(); return true } } return false })()`
const ACTION = (id, setup, waitMs) => `(async function(){
  var e = __p.ed(); if(!e) return { err:'no-editor' };
  ${setup || ''}
  var a = e.getAction(${JSON.stringify(id)});
  if (!a) return { __noAction: ${JSON.stringify(id)} };
  e.focus();
  await a.run();
  await new Promise(function(r){ setTimeout(r, ${waitMs || 1500}) });
  return __p.dom();
})()`

async function main() {
  // ── fixture ────────────────────────────────────────────────────
  // 根目录先探一次（后端起来后）
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

  const ROOT = (await (await fetch(APP + '/dsh-ide/init')).json()).root
  if (!ROOT) throw new Error('no workspace root')
  globalThis.__ROOT = ROOT
  const dir = join(ROOT, FIX)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.ts'), A_TS)
  writeFileSync(join(dir, 'b.ts'), B_TS)
  writeFileSync(join(dir, 'c.ts'), C_TS)
  writeFileSync(join(dir, 'never_open.ts'), NEVER_OPEN_TS)
  const B_PATH = join(dir, 'b.ts')

  // 第三方类型 fixture：必须放在**工作空间根**的 node_modules/@types —— host /type-files 就扫那里
  // （与真实项目结构一致；TS 的模块解析本来也是从 import 处逐级向上找 node_modules）。
  // 安全：只创建/删除我们自己那一个假包，**绝不动工作空间里已有的 node_modules**（踩坑 21）
  const nmRoot = join(ROOT, 'node_modules')
  globalThis.__NM_EXISTED = existsSync(nmRoot)
  mkdirSync(join(nmRoot, '@types', 'fakelib'), { recursive: true })
  writeFileSync(join(nmRoot, '@types', 'fakelib', 'index.d.ts'), FAKE_DTS)
  writeFileSync(join(nmRoot, '@types', 'fakelib', 'package.json'), FAKE_PKG)
  mkdirSync(join(nmRoot, 'fakepkg', 'dist'), { recursive: true })
  writeFileSync(join(nmRoot, 'fakepkg', 'package.json'), PKG_JSON)
  writeFileSync(join(nmRoot, 'fakepkg', 'dist', 'index.d.ts'), PKG_DTS_INDEX)
  writeFileSync(join(nmRoot, 'fakepkg', 'dist', 'extra.d.ts'), PKG_DTS_EXTRA)

  // 项目 tsconfig：放工作空间根（host 只认根上的 tsconfig.json/jsconfig.json）。
  // 安全：先备份原有内容，跑完还原；原本没有就删掉（踩坑 21）
  const tsCfgPath = join(ROOT, 'tsconfig.json')
  globalThis.__TSCFG_TOUCHED = true
  globalThis.__TSCFG_BAK = existsSync(tsCfgPath) ? readFileSync(tsCfgPath, 'utf8') : null
  writeFileSync(tsCfgPath, TSCONFIG)

  // ── 浏览器 ─────────────────────────────────────────────────────
  const userDir = join(`${__TIANGONG_ROOT}`, '.edge-e2e5-tmp-' + process.pid)
  rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
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
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      pageErrors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 200))
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
      await sleep(400)
    }
    return null
  }

  await cdp('Runtime.enable')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco && !!window.monaco.editor`, 90000)

  // 轨迹断言助手（client 半是 800ms 去抖批量上报 —— 踩坑 29：要等它落地再读）
  const traceFrom = Date.now() - 1000
  async function traceHas(msg, waitMs) {
    const t = Date.now()
    while (Date.now() - t < waitMs) {
      let txt = ''
      try { txt = readFileSync(TRACE, 'utf8') } catch { /* 还没写过 */ }
      const lines = txt.split('\n')
      for (let i = lines.length - 1; i >= 0 && i > lines.length - 400; i--) {
        if (!lines[i] || lines[i].indexOf(msg) < 0) continue
        try { const o = JSON.parse(lines[i]); if (Date.parse(o.ts) >= traceFrom) return true } catch { /* 非法行跳过 */ }
      }
      await sleep(700)
    }
    return false
  }

  // 深链打开 b.ts（踩坑 26：token 首访会吃掉查询串 → 认证后再导航一次）
  await cdp('Page.enable')
  await cdp('Page.navigate', { url: APP + '/?file=' + encodeURIComponent(B_PATH) })
  await waitFor(`(function(){ var ts=document.querySelectorAll('.dside-tab-name');
    for(var i=0;i<ts.length;i++){ if(ts[i].textContent==='b.ts') return true } return false })()`, 60000)
  await sleep(1500)
  await evalJs(HELPERS)

  // ── P0 monaco 注册了哪些语言相关动作（诊断用，一眼看出缺什么）──
  const acts = await evalJs(`(function(){ var e=__p.ed(); if(!e) return null;
    return e.getSupportedActions().map(function(a){return a.id}).filter(function(id){
      return /definit|peek|goto|goTo|rename|symbol|reference|hover|suggest|format|signature|implement/i.test(id) }).join(',') })()`)
  console.log('[info] monaco 语言相关动作: ' + acts)
  const actCount = await evalJs(`__p.ed().getSupportedActions().length`)
  console.log('[info] 动作总数: ' + actCount)

  // ── P1/P2 语言就绪 ─────────────────────────────────────────────
  const langs = await evalJs(`window.monaco.languages.getLanguages().map(function(l){return l.id}).join(',')`)
  check('P1 monaco 语言清单含 typescript/javascript（内建语言服务已注册）',
    typeof langs === 'string' && langs.indexOf('typescript') >= 0 && langs.indexOf('javascript') >= 0, langs)

  const langId = await evalJs(`(function(){ var m=__p.model(); return m? m.getLanguageId() : null })()`)
  check('P2 .ts 文件被识别为 typescript', langId === 'typescript', langId)

  // ── P3 诊断（已知可用，回归）────────────────────────────────────
  const diag = await waitFor(`(function(){ var m=__p.model();
    var mk=window.monaco.editor.getModelMarkers({resource:m.uri});
    return mk.length>0 ? JSON.stringify(mk.map(function(x){return x.line+':'+x.message.slice(0,40)})) : null })()`, 15000)
  check('P3 类型诊断（TS worker markers）出现', !!diag, diag)

  // ── P4 悬停 ────────────────────────────────────────────────────
  let r = await evalJs(ACTION('editor.action.showHover', `var p=__p.posOf("greet('x')"); if(!p) return {err:'no-pos'}; e.setPosition(p);`, 2000))
  check('P4 悬停提示（hover）可用', r && r.hover === true, JSON.stringify(r))

  // ── P5 补全 ────────────────────────────────────────────────────
  r = await evalJs(ACTION('editor.action.triggerSuggest', `e.setPosition({lineNumber:6, column:14});`, 2500))
  check('P5 补全建议（suggest widget）可用', r && r.suggest === true, JSON.stringify(r))

  // ── 转到定义：先查清这个版本里到底注册了哪个 id ─────────────────
  const defIds = await evalJs(`(function(){ var e=__p.ed();
    var c=['editor.action.revealDefinition','editor.action.peekDefinition','editor.action.goToDefinition',
           'editor.action.revealDefinitionAside','editor.action.showDefinitionPreviewHover',
           'editor.action.goToTypeDefinition','editor.action.goToImplementation','editor.action.referenceSearch.trigger'];
    var out=[]; for (var i=0;i<c.length;i++){ if (e.getAction(c[i])) out.push(c[i]) } return out.join(',') })()`)
  console.log('[info] definition/reference 类动作可用: ' + JSON.stringify(defIds))
  const DEF = defIds && String(defIds).length ? String(defIds).split(',')[0] : null

  // ── P6 同文件转到定义 ──────────────────────────────────────────
  r = DEF
    ? await evalJs(ACTION(DEF, `var p=__p.posOf("local( 3 )"); if(!p) return {err:'no-pos'}; e.setPosition(p);`, 2000))
    : { __noAction: 'definition（候选 id 一个都没注册）' }
  check('P6 同文件转到定义可用（peek 或跳转）', r && (r.peek === true || !!r.modelPath), JSON.stringify(r))

  // ── P6b 公开 API 路线：TS worker 直接给定义位置 ─────────────────
  const wDef = (sym) => `(async function(){
    try {
      var m = __p.model();
      var gw = monaco.languages.typescript && monaco.languages.typescript.getTypeScriptWorker;
      if (!gw) return { err:'no-getTypeScriptWorker' };
      var client = await (await gw())(m.uri);
      var off = m.getOffsetAt(__p.posOf(${JSON.stringify(sym)}));
      var defs = await client.getDefinitionAtPosition(m.uri.toString(), off);
      return { defs: (defs||[]).map(function(d){ return String(d.fileName).split('/').pop() + '@' + d.textSpan.start }) };
    } catch (e) { return { err: String((e && e.message) || e) } }
  })()`
  const wd1 = await evalJs(wDef('local( 3 )'))
  check('P6b TS worker 公开 API 能取到定义位置（备选实现路线）',
    wd1 && Array.isArray(wd1.defs) && wd1.defs.length > 0, JSON.stringify(wd1))

  // ── P7 跨文件转到定义（先在资源管理器里打开 a.ts，让 worker 知道它）──
  await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node');
    for(var i=0;i<ns.length;i++){ var t=ns[i].querySelector('.dside-node-name');
      if(t && t.textContent==='${FIX}'){ ns[i].click(); return true } } return false })()`)
  await sleep(1200)
  await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node');
    for(var i=0;i<ns.length;i++){ var t=ns[i].querySelector('.dside-node-name');
      if(t && t.textContent==='a.ts'){ ns[i].click(); return true } } return false })()`)
  await sleep(1500)
  const tabsAfterA = await evalJs(`(function(){ var ts=document.querySelectorAll('.dside-tab-name'); var a=[]; for(var i=0;i<ts.length;i++) a.push(ts[i].textContent); return a })()`)
  check('P7 两个模型都在（a.ts 已作为标签打开）', Array.isArray(tabsAfterA) && tabsAfterA.indexOf('a.ts') >= 0 && tabsAfterA.indexOf('b.ts') >= 0, JSON.stringify(tabsAfterA))

  // 回到 b.ts，从 greet 跳到 a.ts
  await evalJs(`(function(){ var ts=document.querySelectorAll('.dside-tab');
    for(var i=0;i<ts.length;i++){ var n=ts[i].querySelector('.dside-tab-name'); if(n && n.textContent==='b.ts'){ ts[i].click(); return true } } return false })()`)
  await sleep(1500)
  r = DEF
    ? await evalJs(ACTION(DEF, `var p=__p.posOf("greet('x')"); if(!p) return {err:'no-pos'}; e.setPosition(p);`, 2200))
    : { __noAction: 'definition（候选 id 一个都没注册）' }
  // 这条是"记录已知缺口"：monaco 这个 build 没有注册原生 definition 导航动作
  // （只有 showDefinitionPreviewHover），所以转到定义由我们自己的 dside.goToDefinition 补
  // （见 P8c/P8d/P8e）。**升级 monaco 后这条会翻红** —— 那说明原生动作回来了，可以简化实现。
  check('P8 [已知缺口] monaco 原生 definition 导航动作未注册（故自实现）',
    DEF === null || DEF === 'editor.action.showDefinitionPreviewHover', 'DEF=' + String(DEF))

  // ── P8b 公开 API 的跨文件定义（a.ts 已作为模型存在）─────────────
  const wd2 = await evalJs(`(async function(){
    try {
      var m = __p.model();
      var client = await (await monaco.languages.typescript.getTypeScriptWorker())(m.uri);
      var off = m.getOffsetAt(__p.posOf("greet('x')"));
      var defs = await client.getDefinitionAtPosition(m.uri.toString(), off);
      return { model: String(m.uri.path).split('/').pop(),
        defs: (defs||[]).map(function(d){ return String(d.fileName).split('/').pop() + '@' + d.textSpan.start }) };
    } catch (e) { return { err: String((e && e.message) || e) } }
  })()`)
  check('P8b TS worker 公开 API 跨文件定义可用（→ a.ts）',
    wd2 && Array.isArray(wd2.defs) && wd2.defs.length > 0 && String(wd2.defs[0]).indexOf('a.ts') >= 0, JSON.stringify(wd2))

  // ── P8c 我们自己补的"转到定义"动作（F12）────────────────────────
  const hasDefAction = await evalJs(`!!__p.ed().getAction('dside.goToDefinition')`)
  check('P8c 编辑器里注册了 dside.goToDefinition（F12 + 右键）', hasDefAction === true, String(hasDefAction))

  r = await evalJs(ACTION('dside.goToDefinition', `var p=__p.posOf("local( 3 )"); if(!p) return {err:'no-pos'}; e.setPosition(p);`, 2200))
  check('P8d F12 转到定义（同文件）跳到函数定义行 3:10', r && r.cursor === '3:10', JSON.stringify(r))

  r = await evalJs(ACTION('dside.goToDefinition', `var p=__p.posOf("greet('x')"); if(!p) return {err:'no-pos'}; e.setPosition(p);`, 2500))
  check('P8e F12 转到定义（跨文件，目标已打开）切到 a.ts 并定位 2:17',
    r && r.activeTab === 'a.ts' && r.cursor === '2:17', JSON.stringify(r))

  // 回到 b.ts（后面探针都基于它）
  await evalJs(CLICK_TAB('b.ts'))
  await sleep(1300)
  await evalJs(HELPERS)

  // ── P8f/P8g 项目文件喂给 worker → **从未打开过的文件**也能跨文件跳转 ──
  const fed = await traceHas('project-files-fed', 12000)
  check('P8f 项目源文件已喂给 TS worker（埋点 project-files-fed）', fed === true, TRACE)

  const cIsModel = await evalJs(`(function(){ var ms=window.monaco.editor.getModels();
    for (var i=0;i<ms.length;i++){ if (String(ms[i].uri.path).indexOf('c.ts')>=0) return true } return false })()`)
  check('P8g c.ts 从未在编辑器里打开过（模型不存在，排除"其实是打开过才能跳"）', cIsModel === false, String(cIsModel))

  r = await evalJs(`(async function(){
    var e=__p.ed(); var m=__p.model();
    var p=__p.posOf("helper(1)");
    var info = { pos: p? (p.lineNumber+':'+p.column) : null, line7: m.getLineContent(7), line8: m.getLineContent(8) };
    if(!p) return info;
    e.setPosition(p);
    var a=e.getAction('dside.goToDefinition'); if(!a) return { err:'no-action', info:info };
    e.focus();
    await a.run();
    await new Promise(function(x){ setTimeout(x, 3000) });
    var d=__p.dom(); d.diag = info;
    return d })()`)
  check('P8h F12 跳到**从未打开过**的 c.ts 并定位 1:17（项目文件喂养生效）',
    r && r.activeTab === 'c.ts' && r.cursor === '1:17', JSON.stringify(r))

  await evalJs(CLICK_TAB('b.ts'))
  await sleep(1200)
  await evalJs(HELPERS)

  // ── P8i/P8j/P8k 第三方类型（node_modules/@types）喂养 ────────────
  const typeFed = await traceHas('type-files-fed', 12000)
  check('P8i 第三方类型已喂给 TS worker（埋点 type-files-fed）', typeFed === true, TRACE)

  const fakeDiag = await evalJs(`(function(){ var m=__p.model();
    var mk=window.monaco.editor.getModelMarkers({resource:m.uri});
    for (var i=0;i<mk.length;i++){ if (String(mk[i].message).toLowerCase().indexOf('fakelib')>=0) return String(mk[i].message) }
    return null })()`)
  check('P8j 第三方类型生效：fakelib 不再报 cannot find module', fakeDiag === null, String(fakeDiag))

  const hovFake = await evalJs(`(async function(){ var e=__p.ed(); var p=__p.posOf("fakeGreet('x')"); if(!p) return 'no-pos';
    e.setPosition(p); e.focus(); var a=e.getAction('editor.action.showHover'); if(!a) return 'no-action';
    await a.run(); await new Promise(function(r){ setTimeout(r,1800) });
    var h=document.querySelector('.monaco-hover'); return h? String(h.textContent).slice(0,140) : 'no-hover' })()`)
  check('P8k 悬停显示第三方库函数签名', typeof hovFake === 'string' && hovFake.indexOf('string') >= 0, String(hovFake))

  r = await evalJs(ACTION('dside.goToDefinition', `var p=__p.posOf("fakeGreet('x')"); if(!p) return {err:'no-pos'}; e.setPosition(p);`, 3000))
  check('P8l F12 跳进 **真实路径** 的 node_modules/@types/fakelib/index.d.ts 并定位 1:25',
    r && r.activeTab === 'index.d.ts' && r.cursor === '1:25' && String(r.modelPath).indexOf('@types') >= 0, JSON.stringify(r))

  await evalJs(CLICK_TAB('b.ts'))
  await sleep(1200)
  await evalJs(HELPERS)

  // ── P8m/P8n/P8o 自带类型的包（package.json types → dist/*.d.ts，含相对 re-export）──
  const pkgDiag = await evalJs(`(function(){ var m=__p.model();
    var mk=window.monaco.editor.getModelMarkers({resource:m.uri});
    for (var i=0;i<mk.length;i++){ var s=String(mk[i].message);
      if (s.toLowerCase().indexOf('fakepkg')>=0 || s.indexOf('PKG_EXTRA')>=0) return s }
    return null })()`)
  check('P8m 自带类型的包解析成功（无 cannot find module / 无导出缺失）', pkgDiag === null, String(pkgDiag))

  const hovPkg = await evalJs(`(async function(){ var e=__p.ed(); var p=__p.posOf("pkgGreet(1)"); if(!p) return 'no-pos';
    e.setPosition(p); e.focus(); var a=e.getAction('editor.action.showHover'); if(!a) return 'no-action';
    await a.run(); await new Promise(function(r){ setTimeout(r,1800) });
    var h=document.querySelector('.monaco-hover'); return h? String(h.textContent).slice(0,140) : 'no-hover' })()`)
  check('P8n 悬停显示自带类型包的函数签名', typeof hovPkg === 'string' && hovPkg.indexOf('number') >= 0, String(hovPkg))

  r = await evalJs(ACTION('dside.goToDefinition', `var p=__p.posOf("pkgGreet(1)"); if(!p) return {err:'no-pos'}; e.setPosition(p);`, 3000))
  check('P8o F12 跳进 fakepkg/dist/index.d.ts 定位 2:25（入口 + 相对 re-export 都在）',
    r && r.activeTab === 'index.d.ts' && r.cursor === '2:25' && String(r.modelPath).indexOf('fakepkg') >= 0, JSON.stringify(r))

  await evalJs(CLICK_TAB('b.ts'))
  await sleep(1200)
  await evalJs(HELPERS)

  // ── P8p/P8q 项目 tsconfig（JSONC + 选项映射）套用 ────────────────
  const anyDiag = await waitFor(`(function(){ var m=__p.model();
    var mk=window.monaco.editor.getModelMarkers({resource:m.uri});
    for (var i=0;i<mk.length;i++){ if (String(mk[i].message).indexOf("implicitly has an 'any' type")>=0) return String(mk[i].message) }
    return null })()`, 15000)
  check('P8p 项目 tsconfig 生效（strict → 隐式 any 报错）', typeof anyDiag === 'string', String(anyDiag))

  const tsApplied = await traceHas('tsconfig-applied', 10000)
  check('P8q 埋点 tsconfig-applied（记录读到的文件 + 映射出的选项）', tsApplied === true, TRACE)

  // ── P9 文档符号（大纲）──────────────────────────────────────────
  r = await evalJs(ACTION('editor.action.quickOutline', '', 2000))
  check('P9 文档符号/大纲（quickOutline）可用', r && r.quickInput === true, JSON.stringify(r))

  // ── P10 重命名 ─────────────────────────────────────────────────
  // 注意：rename 的 run() 会一直等用户输入 → 不能 await，点了就查 DOM，查完 Esc 收掉
  r = await evalJs(`(async function(){ var e=__p.ed(); var p=__p.posOf("local(x: number)"); if(!p) return {err:'no-pos'};
    e.setPosition(p); e.focus(); var a=e.getAction('editor.action.rename'); if(!a) return {__noAction:'rename'};
    a.run(); await new Promise(function(x){ setTimeout(x,1500) }); var d=__p.dom();
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    return d })()`)
  check('P10 重命名（F2 rename widget）可用', r && r.rename === true, JSON.stringify(r))
  await sleep(400)

  // ── P11 格式化 ─────────────────────────────────────────────────
  await evalJs(`(function(){ var ts=document.querySelectorAll('.dside-tab');
    for(var i=0;i<ts.length;i++){ var n=ts[i].querySelector('.dside-tab-name'); if(n && n.textContent==='b.ts'){ ts[i].click(); return true } } return false })()`)
  await sleep(1200)
  await evalJs(HELPERS)
  const before = await evalJs(`__p.model().getValue().split('\\n')[4]`)
  r = await evalJs(ACTION('editor.action.formatDocument', '', 2500))
  const after = await evalJs(`__p.model().getValue().split('\\n')[4]`)
  check('P11 文档格式化（TS formatter）可用', before !== after, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)

  // ── P11b 命令面板已收录语言智能命令 ─────────────────────────────
  await evalJs(`(function(){ var e=new KeyboardEvent('keydown',{key:'p',code:'KeyP',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true});
    window.dispatchEvent(e); return true })()`)
  await sleep(800)
  const paletteTxt = await evalJs(`(function(){
    var inp=document.querySelector('.dside-palette-input'); if(!inp) return 'no-input';
    var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(inp,'转到定义'); inp.dispatchEvent(new Event('input',{bubbles:true}));
    var box=document.querySelector('.dside-palette-list') || document.querySelector('.dside-overlay .card');
    return box? String(box.textContent).slice(0,160) : 'no-box' })()`)
  check('P11b 命令面板收录「转到定义」等语言智能命令',
    typeof paletteTxt === 'string' && paletteTxt.indexOf('转到定义') >= 0, paletteTxt)
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await sleep(500)

  // ── P13 问题面板（Ctrl+Shift+M）────────────────────────────────
  await evalJs(`(function(){ window.dispatchEvent(new KeyboardEvent('keydown',
    {key:'m',code:'KeyM',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})); return true })()`)
  await sleep(1500)
  const probPanel = await evalJs(`(function(){
    var list=document.querySelector('.dside-problems-list'); if(!list) return 'no-panel';
    var rows=document.querySelectorAll('.dside-problem');
    var title=document.querySelector('.dside-palette-title');
    return { title: title? String(title.textContent):'', rows: rows.length,
      first: rows.length? String(rows[0].textContent):'' } })()`)
  check('P13 Ctrl+Shift+M 打开问题面板并按文件列出诊断',
    probPanel && probPanel.rows > 0 && String(probPanel.title).indexOf('问题') >= 0, JSON.stringify(probPanel))

  const clicked = await evalJs(`(function(){ var rows=document.querySelectorAll('.dside-problem');
    if(!rows.length) return 'no-rows'; rows[0].click(); return true })()`)
  await sleep(1500)
  const afterClick = await evalJs(`(function(){ return {
    panelOpen: !!document.querySelector('.dside-problems-list'),
    tab: (function(){ var ts=document.querySelectorAll('.dside-tab');
      for(var i=0;i<ts.length;i++){ if(String(ts[i].className).indexOf('active')>=0){ var n=ts[i].querySelector('.dside-tab-name'); return n?n.textContent:null } } return null })() } })()`)
  check('P14 点问题条目 → 关面板并跳转（标签页正确）',
    clicked === true && afterClick && afterClick.panelOpen === false && afterClick.tab === 'b.ts', JSON.stringify(afterClick))

  const statusProb = await waitFor(`(function(){ var el=document.querySelector('.dside-statusbar .dside-prob');
    return el? String(el.textContent) : null })()`, 8000)
  check('P15 状态栏显示诊断计数（✕/⚠）', typeof statusProb === 'string' && statusProb.indexOf('✕') >= 0, String(statusProb))

  // ── P16 项目级全量诊断：**从未打开过**的文件里的错误也要出现在问题面板 ──
  await evalJs(`(function(){ window.dispatchEvent(new KeyboardEvent('keydown',
    {key:'m',code:'KeyM',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})); return true })()`)
  const projRow = await waitFor(`(function(){
    var box=document.querySelector('.dside-problems-list'); if(!box) return null;
    var txt=String(box.textContent);
    return txt.indexOf('never_open.ts')>=0 ? txt.slice(0,200) : null })()`, 25000)
  check('P16 项目级扫描：未打开文件的错误也进问题面板', typeof projRow === 'string', String(projRow))
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await sleep(500)

  check('P12 页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))

  const pass = results.filter((x) => x.ok).length
  console.log(`\n[e2e5] ${pass}/${results.length} passed  （语言清单: ${langs}）`)
  return { ok: pass === results.length, browser, backend }
}

let handles = null
try {
  handles = await main()
} catch (e) {
  console.log('[e2e5] ABORT: ' + (e && e.stack ? e.stack : e))
} finally {
  try { if (handles && handles.browser) killTree(handles.browser.pid) } catch { /* ignore */ }
  try { if (handles && handles.backend) killTree(handles.backend.pid) } catch { /* ignore */ }
  await sleep(1500)
  try { rmSync(join(`${__TIANGONG_ROOT}`, '.edge-e2e5-tmp-' + process.pid), { recursive: true, force: true }) } catch { /* ignore */ }
  const root = globalThis.__ROOT || `${__TIANGONG_ROOT}\\dshworkspace2`
  try { rmSync(join(root, FIX), { recursive: true, force: true }) } catch { /* ignore */ }
  // 第三方类型 fixture：本来没有 node_modules 就整个删掉；本来有就只删我们建的那个假包
  try {
    if (globalThis.__NM_EXISTED === true) rmSync(join(root, 'node_modules', '@types', 'fakelib'), { recursive: true, force: true })
    else if (globalThis.__NM_EXISTED === false) rmSync(join(root, 'node_modules'), { recursive: true, force: true })
  } catch { /* ignore */ }
  // tsconfig fixture：还原备份；原本没有就删掉；**没碰过就什么都不做**（别误删真实配置）
  try {
    if (globalThis.__TSCFG_TOUCHED === true) {
      const p = join(root, 'tsconfig.json')
      if (typeof globalThis.__TSCFG_BAK === 'string') writeFileSync(p, globalThis.__TSCFG_BAK)
      else rmSync(p, { force: true })
    }
  } catch { /* ignore */ }
  console.log('[e2e5] cleanup done')
}
process.exit(handles && handles.ok ? 0 : 1)
