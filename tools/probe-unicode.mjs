import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// probe-unicode.mjs — 两个问题的"一手证据"探针（只测量、不改产品代码）：
//   ① 编辑器对易混淆字符（U+FF09「）」等）的高亮：DOM 里长什么样？关掉哪个选项才真消失？
//   ② 设置面板下方「安装位置…」那一片为什么一直闪：数一数 DOM 变更 / 请求次数。
//
// 用法：node tools\probe-unicode.mjs
// 依赖隔离测试家目录（先跑 tools\dev-testhome.ps1 刷插件代码），自起 3082 后端 + 无头 Edge。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, openSync, closeSync } from 'node:fs'

const PORT = Number(process.env.DSH_E2E_PORT || 3087)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = process.env.DSH_E2E_HOME || `${__TIANGONG_ROOT}\\.smoke-home`
const WS = process.env.DSH_E2E_WS || `${__TIANGONG_ROOT}\\.smoke-ws`
const CLI = `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js`
const BLOG = `${__TIANGONG_ROOT}\\_probe_unicode_` + PORT + '.log'
const CDP_PORT = 9870 + Math.floor(Math.random() * 90)
const FIX = WS + '\\_probe_unicode.txt'
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
  throw new Error('no edge/chrome')
}

const OPEN_NODE = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node');
  for (var i=0;i<ns.length;i++){ var t=ns[i].querySelector('.dside-node-name');
    if (t && t.textContent===${JSON.stringify(name)}){ ns[i].click(); return true } } return false })()`
const HAS_NODE = (name) => `(function(){ var ns=document.querySelectorAll('.dside-explorer .dside-node-name');
  for (var i=0;i<ns.length;i++){ if (ns[i].textContent===${JSON.stringify(name)}) return true } return false })()`
const PICK_ACTIVITY = (label) => `(function(){ var bs=document.querySelectorAll('.dside-activitybar button');
  for (var i=0;i<bs.length;i++){ var l=String(bs[i].getAttribute('title')||'');
    if (l.indexOf(${JSON.stringify(label)})>=0){ bs[i].click(); return true } } return false })()`
// 编辑器里与"易混淆字符"有关的所有 DOM 痕迹（monaco 的 unicode 高亮类名带 unicode 字样）
const UNI_DOM = `(function(){
  var out={};
  var all=document.querySelectorAll('.dside-editor-monaco [class]');
  for (var i=0;i<all.length;i++){
    var c=String(all[i].className||'');
    if (c.indexOf('unicode')>=0){ out[c]=(out[c]||0)+1 }
  }
  var sq=document.querySelectorAll('.dside-editor-monaco .squiggly-warning').length;
  var gm=document.querySelectorAll('.dside-editor-monaco .cdr, .dside-editor-monaco [class*="glyph"]').length;
  var lines=document.querySelectorAll('.dside-editor-monaco .view-line').length;
  return { unicodeClasses: out, squiggly: sq, glyphish: gm, viewLines: lines }
})()`
// 打开 fixture 后，把光标放到第 1 行的「）」上 → 触发 hover 里的警告（用户看到的那句就是他 hover 看到的）
const HOVER_ON_CHAR = `(function(){
  var ed=window.monaco && window.monaco.editor.getEditors()[0];
  if(!ed) return 'no-editor';
  ed.setPosition({lineNumber:1, column:8});
  ed.trigger('probe','editor.action.showHover',null);
  return 'ok'
})()`
const HOVER_TEXT = `(function(){ var w=document.querySelector('.monaco-hover'); return w?String(w.innerText).slice(0,400):'' })()`
// 用 IDE 将要采用的同一批选项去改编辑器，看高亮是否真的消失
const SET_OPT = (opts) => `(function(){
  var ed=window.monaco && window.monaco.editor.getEditors()[0];
  if(!ed) return 'no-editor';
  ed.updateOptions(${JSON.stringify(opts)});
  return 'ok'
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
  let ws = null

  try {
    let token = ''
    const t0 = Date.now()
    while (Date.now() - t0 < 120000) {
      await sleep(500)
      if (backendExit !== null) throw new Error('backend exited early (' + backendExit + ')')
      let txt = ''
      try { txt = readFileSync(BLOG, 'utf8') } catch { /* not yet */ }
      const m = txt.match(/\?token=([A-Za-z0-9._-]+)/)
      if (m) { token = m[1]; break }
    }
    if (!token) throw new Error('no token')

    rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
    mkdirSync(WS, { recursive: true })
    // 一行里同时放：半角括号 + 全角右括号（U+FF09）+ 零宽空格（U+200B）
    writeFileSync(FIX, 'const a = foo(x)\uff09; // \u200bzero-width\ntext \u4e2d\u6587\u6807\u70b9\u3002\n')

    const userDir = `${__TIANGONG_ROOT}\\.edge-probe-uni-` + process.pid
    try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch { /* ignore */ }
    browser = spawn(findBrowser(), [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--window-size=1600,1000',
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
    if (!target) throw new Error('no CDP target')

    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')) })
    let msgId = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    }
    function cdp(method, params) {
      return new Promise((resolve) => {
        const id = ++msgId
        pending.set(id, (m) => resolve(m.result || { error: m.error }))
        ws.send(JSON.stringify({ id, method, params: params || {} }))
      })
    }
    async function evalJs(expr) {
      const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) return 'ERR:' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description)
      return r.result && r.result.value
    }
    async function waitFor(expr, ms) {
      const t = Date.now()
      while (Date.now() - t < ms) { const v = await evalJs(expr); if (v) return v; await sleep(250) }
      return null
    }

    await cdp('Runtime.enable'); await cdp('Page.enable')
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 90000)

    for (let i = 0; i < 12; i++) {
      await fetch(APP + '/dsh-ide/active-root', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: WS }),
      })
      if ((await waitFor(HAS_NODE('_probe_unicode.txt'), 2500)) === true) break
    }
    await evalJs(OPEN_NODE('_probe_unicode.txt'))
    await sleep(2500)

    console.log('== ① 编辑器易混淆字符 ==')
    console.log('baseline DOM  :', JSON.stringify(await evalJs(UNI_DOM)))
    await evalJs(HOVER_ON_CHAR)
    await sleep(900)
    const hv = await evalJs(HOVER_TEXT)
    console.log('hover 文案    :', JSON.stringify(hv))

    console.log('关 ambiguousCharacters 后:', await evalJs(SET_OPT({ unicodeHighlight: { ambiguousCharacters: false } })))
    await sleep(900)
    console.log('DOM  :', JSON.stringify(await evalJs(UNI_DOM)))
    await evalJs(HOVER_ON_CHAR); await sleep(700)
    console.log('hover :', JSON.stringify(await evalJs(HOVER_TEXT)))

    console.log('关 invisibleCharacters 后:', await evalJs(SET_OPT({ unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false } })))
    await sleep(600)
    console.log('DOM  :', JSON.stringify(await evalJs(UNI_DOM)))

    console.log('== ② 设置面板闪动 ==')
    await evalJs(PICK_ACTIVITY('设置'))
    await sleep(1200)
    // 计数：DOM 变更次数 + 对 /tools-status 的请求次数（拦 fetch 统计）
    await evalJs(`(function(){
      window.__probeMuts=0; window.__probeFetch=[];
      var obs=new MutationObserver(function(ms){ window.__probeMuts+=ms.length });
      obs.observe(document.querySelector('.dside-leftpanel')||document.body,{childList:true,subtree:true,characterData:true,attributes:true});
      var of=window.fetch;
      window.fetch=function(u,o){ try{ window.__probeFetch.push(String(u).slice(0,80)) }catch(e){}; return of.apply(this,arguments) };
      window.__probeObs=obs; return true })()`)
    await sleep(10000)
    const muts = await evalJs('window.__probeMuts')
    const fetches = await evalJs('JSON.stringify((window.__probeFetch||[]).filter(function(u){return u.indexOf("/tools-status")>=0}).length)')
    const allF = await evalJs('JSON.stringify((window.__probeFetch||[]).slice(0,20))')
    console.log('10s 内左栏 DOM 变更次数:', muts)
    console.log('10s 内 /tools-status 请求数:', fetches)
    console.log('10s 内前 20 条请求:', allF)
    // 关键判据：给「安装位置」那个节点打标记，等 12s 看它还在不在 — 不在 = React 把它整个重建了（=闪）
    console.log('打标记    :', await evalJs(`(function(){ var e=document.querySelector('.dside-codenav');
      if(!e) return 'no-node'; e.__probeMark=1; return 'marked' })()`))
    // 谁动了它？记录左栏 mutation 的细节（被移除/新增的节点类名 + 它的父级链）
    await evalJs(`(function(){
      window.__probeLog=[];
      var obs=new MutationObserver(function(ms){
        for (var i=0;i<ms.length && window.__probeLog.length<40;i++){
          var m=ms[i]; if(m.type!=='childList') continue;
          var t=m.target; if(!t || !t.className || String(t.className).indexOf('dside-block')<0) continue;
          window.__probeLog.push({
            at:Math.round(performance.now()),
            target:String(t.className),
            removed:(m.removedNodes.length?Array.prototype.map.call(m.removedNodes,function(n){return n.nodeName+'.'+(n.className||'')}):[]),
            added:(m.addedNodes.length?Array.prototype.map.call(m.addedNodes,function(n){return n.nodeName+'.'+(n.className||'')}):[])
          });
        }
      });
      obs.observe(document.querySelector('.dside-leftpanel')||document.body,{childList:true,subtree:true});
      return true })()`)
    // 谁被换掉了？记录「父节点类名 + 被移除/新增的子节点类名」（不做过滤，全记）
    await evalJs(`(function(){
      window.__probeLog=[]; window.__probeMuts2=0;
      var obs=new MutationObserver(function(ms){
        for (var i=0;i<ms.length;i++){
          var m=ms[i]; if(m.type!=='childList') continue;
          window.__probeMuts2++;
          if(window.__probeLog.length>=12) continue;
          var t=m.target;
          window.__probeLog.push({ at:Math.round(performance.now()),
            target:String((t&&t.className)||(t&&t.nodeName)||'?').slice(0,50),
            removed:Array.prototype.map.call(m.removedNodes,function(n){return String(n.nodeName+'.'+(n.className||'')).slice(0,50)}),
            added:Array.prototype.map.call(m.addedNodes,function(n){return String(n.nodeName+'.'+(n.className||'')).slice(0,50)}) });
        }
      });
      obs.observe(document.querySelector('.dside-leftpanel')||document.body,{childList:true,subtree:true});
      return true })()`)
    for (let i = 0; i < 6; i++) {
      await sleep(2000)
      const alive = await evalJs(`(function(){ var e=document.querySelector('.dside-codenav');
        if(!e) return 'gone'; return e.__probeMark ? 'same-node' : 'recreated' })()`)
      console.log('  +' + ((i + 1) * 2) + 's :', alive)
    }
    console.log('mutation 明细:', await evalJs('JSON.stringify(window.__probeLog||[])'))
    console.log('左栏 childList 总数:', await evalJs('window.__probeMuts2'))
    // 记录左栏整体被替换的次数（挂在 .dside-explorer 上）
    await evalJs(`(function(){ var e=document.querySelector('.dside-leftpanel .dside-explorer');
      if(!e) return 'no-panel'; e.__p1=1;
      window.__panelChecks=[];
      window.__panelTimer=setInterval(function(){
        var c=document.querySelector('.dside-leftpanel .dside-explorer');
        if(!c){ window.__panelChecks.push('gone'); return }
        if(!c.__p1) window.__panelChecks.push('panel-recreated@'+Math.round(performance.now()))
      },100);
      return 'watching' })()`)
    for (let i = 0; i < 6; i++) {
      await sleep(2000)
      const alive = await evalJs(`(function(){ var e=document.querySelector('.dside-codenav');
        if(!e) return 'gone'; return e.__probeMark ? 'same-node' : 'recreated' })()`)
      console.log('  +' + ((i + 1) * 2) + 's :', alive)
    }
    console.log('左栏 explorer 被重建:', await evalJs('JSON.stringify(window.__panelChecks||[])'))
    console.log('左栏 DOM 总变更:', await evalJs('window.__probeMuts'))
    // 决定性对照：同一时刻，普通行（.dside-block-row，纯对象渲染）会不会也被重建？
    //   · 若普通行也换 = 整块 PanelBlocks 被换（用 key/结构解释）
    //   · 只有 render 项（.dside-codenav 的匿名包裹 div）换 = 单独那条 render 分支被重建
    await evalJs(`(function(){
      var rows=document.querySelectorAll('.dside-leftpanel .dside-block-row');
      for (var i=0;i<rows.length;i++) rows[i].__row1=1;
      var dg=document.querySelectorAll('.dside-leftpanel .dside-block');
      for (var j=0;j<dg.length;j++) dg[j].__blk1=1;
      window.__rowChecks=[];
      window.__rowTimer=setInterval(function(){
        var rs=document.querySelectorAll('.dside-leftpanel .dside-block-row');
        var gone=0, fresh=0;
        for (var i=0;i<rs.length;i++){ if(rs[i].__row1) gone++; else fresh++ }
        var bs=document.querySelectorAll('.dside-leftpanel .dside-block');
        var bFresh=0; for (var j=0;j<bs.length;j++) if(!bs[j].__blk1) bFresh++;
        if (fresh||bFresh) window.__rowChecks.push({freshRows:fresh,totalRows:rs.length,freshBlocks:bFresh,totalBlocks:bs.length});
      },150);
      return 'ok' })()`)
    await sleep(11000)
    console.log('普通行/整块被重建的情况:', await evalJs('JSON.stringify((window.__rowChecks||[]).slice(0,6))'))
    // 直接看 .dside-codenav 的父元素是谁、它是不是 render 项那个匿名 div
    console.log('codenav 父链 + 兄弟:', await evalJs(`(function(){
      var e=document.querySelector('.dside-codenav'); if(!e) return 'no-node';
      var p=e.parentElement;
      return JSON.stringify({ parentClass:String(p.className||'(空)'), parentChildren:p.children.length,
        blockChildren:(p.parentElement?p.parentElement.children.length:-1),
        blockTag:String(p.parentElement?p.parentElement.className:'') }) })()`))
    await evalJs(`(function(){ window.__cnStats={mounts:0,renders:0}; return true })()`)
    await sleep(12000)
    console.log('12s 内 CodeNavRow 渲染/挂载次数:', await evalJs('JSON.stringify(window.__cnStats)'))
    // 对照：IDE 自己那个根容器（.dside-root）会不会也被重建？= 判定"是平台重挂还是我们的树重挂"
    console.log('对照 watch :', await evalJs(`(function(){
      var r=document.querySelector('.dside-root'); if(!r) return 'no-root'; r.__r1=1;
      var e=document.querySelector('.dside-leftpanel .dside-explorer'); if(e) e.__e1=1;
      window.__watch={root:[],explorer:[]};
      window.__watchTimer=setInterval(function(){
        var rr=document.querySelector('.dside-root'); var ee=document.querySelector('.dside-leftpanel .dside-explorer');
        if(rr && !rr.__r1){ window.__watch.root.push(Math.round(performance.now())); rr.__r1=1 }
        if(ee && !ee.__e1){ window.__watch.explorer.push(Math.round(performance.now())); ee.__e1=1 }
      },100); return 'ok' })()`))
    await sleep(10000)
    console.log('10s 内 .dside-root 重建:', await evalJs('JSON.stringify(window.__watch.root)'))
    console.log('10s 内 .dside-explorer 重建:', await evalJs('JSON.stringify(window.__watch.explorer)'))
    // 切到资源管理器：看它的树会不会同样每隔几秒被重建（对照 .dside-codenav）
    await evalJs(PICK_ACTIVITY('资源管理器')); await sleep(1500)
    console.log('树节点打标记:', await evalJs(`(function(){ var n=document.querySelector('.dside-explorer-body');
      if(!n) return 'no-body'; n.__t1=1; return 'marked' })()`))
    for (let i = 0; i < 4; i++) {
      await sleep(2500)
      console.log('  +' + ((i + 1) * 2.5) + 's 树:', await evalJs(`(function(){ var n=document.querySelector('.dside-explorer-body');
        return n ? (n.__t1 ? 'same-node' : 'recreated') : 'gone' })()`))
    }
    const panelText = await evalJs(`(function(){ var p=document.querySelector('.dside-leftpanel'); return p?String(p.innerText).slice(0,300):'' })()`)
    console.log('设置面板文本片段:', JSON.stringify(panelText))
  } catch (e) {
    console.log('PROBE ERROR: ' + ((e && e.message) || e))
  } finally {
    try { if (ws) ws.close() } catch { /* ignore */ }
    try { if (browser) browser.kill() } catch { /* ignore */ }
    try { spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    await sleep(400)
    process.exit(0)
  }
}

main()
