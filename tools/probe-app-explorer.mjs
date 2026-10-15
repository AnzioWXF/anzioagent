// probe-app-explorer.mjs — 真机（已运行的天工 + 调试端口）验证资源管理器标题栏四动作与 Ctrl+N 内联新建
// ⚠ 不创建任何文件：只验"内联输入行出现 + 目标层级正确 + 光标聚焦"，然后一律 Esc 取消。
// 用法: 先 `天工.exe --remote-debugging-port=9223`，再 node D:\99DSH\tools\probe-app-explorer.mjs
const CDP_PORT = Number(process.env.DSH_APP_CDP || 9223)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function verdict(name, ok, detail) { results.push(!!ok); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' :: ' + String(detail ?? '')}`) }

async function main() {
  let target = null
  for (let i = 0; i < 30 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
      target = (list || []).find((t) => t.type === 'page' && /3081/.test(t.url || ''))
    } catch { /* not up */ }
    if (!target) await sleep(1000)
  }
  if (!target) throw new Error('CDP target 没出来（应用没在跑？）')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')) })
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const cdp = (method, params) => new Promise((resolve, reject) => {
    const id = ++msgId
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)) }, 20000)
    pending.set(id, (m) => { clearTimeout(t); resolve(m.result || {}) })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
  async function evalJs(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'threw' }
    return r.result && r.result.value
  }
  async function waitFor(expr, ms) { const t = Date.now(); while (Date.now() - t < ms) { const v = await evalJs(expr); if (v) return v; await sleep(300) } return null }
  async function rectOf(sel) {
    return evalJs(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
      var r=e.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) } })()`)
  }
  async function clickAt(x, y) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await sleep(150)
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(400)
  }
  async function key(code, k, mods) {
    const base = { modifiers: mods || 0, code, key: k }
    await cdp('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base))
    await cdp('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base))
    await sleep(600)
  }

  try {
    await cdp('Runtime.enable')
    // 就绪判据用 .dside-root + monaco（左栏可能停在别的活动栏分组上，不能拿 .dside-explorer 当就绪条件）
    const ready = await waitFor(`!!document.querySelector('.dside-root') && !!window.monaco`, 60000)
    verdict('R1 应用界面就绪', !!ready)
    if (!ready) throw new Error('IDE 没挂载')

    // 左侧活动栏切到「资源管理器」（保证树在渲染）
    await evalJs(`(function(){ var bs=document.querySelectorAll('.dside-activitybar button');
      for (var i=0;i<bs.length;i++){ if ((bs[i].getAttribute('title')||'').indexOf('资源管理器')>=0){ bs[i].click(); return true } } return false })()`)
    await sleep(800)

    const btns = await evalJs(`(function(){ var bs=document.querySelectorAll('.dside-pane-actions button');
      return Array.prototype.map.call(bs, function(b){ return b.getAttribute('aria-label') }) })()`)
    verdict('R2 标题栏四个动作且顺序正确（新建文件·新建文件夹·刷新·折叠）',
      Array.isArray(btns) && btns.length === 4 && /新建文件/.test(btns[0]) && /新建文件夹/.test(btns[1]) && /刷新/.test(btns[2]) && /折叠/.test(btns[3]),
      JSON.stringify(btns))

    const opBefore = await evalJs(`(function(){ var a=document.querySelector('.dside-pane-actions'); return a? getComputedStyle(a).opacity : null })()`)
    const titleRect = await rectOf('.dside-explorer-title')
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: titleRect.x, y: titleRect.y })
    await sleep(400)
    const opAfter = await evalJs(`(function(){ var a=document.querySelector('.dside-pane-actions'); return a? getComputedStyle(a).opacity : null })()`)
    verdict('R3 平时隐藏、悬停标题栏才显形', String(opBefore) === '0' && Number(opAfter) > 0.9, JSON.stringify({ opBefore, opAfter }))

    // 点「新建文件」→ 内联输入行（Esc 取消，**不创建任何东西**）
    const b = await rectOf('.dside-pane-actions button[aria-label^="新建文件"]')
    await clickAt(b.x, b.y)
    await sleep(600)
    const i1 = await evalJs(`(function(){ var i=document.querySelector('.dside-node-new .dside-inline-input');
      return i ? { focused: document.activeElement===i, guides: i.closest('.dside-node').querySelectorAll('.dside-guide').length } : null })()`)
    verdict('R4 点「新建文件」→ 树里就地出内联输入行且光标聚焦', !!i1 && i1.focused, JSON.stringify(i1))
    await key('Escape', 'Escape', 0)
    await sleep(400)
    const gone = await evalJs(`!document.querySelector('.dside-node-new')`)
    verdict('R5 Esc 取消（磁盘上不留任何文件）', !!gone)

    // Ctrl+N（CDP 注入；真机 Electron 里这个键不会被浏览器吃掉）
    await key('KeyN', 'n', 2)
    await sleep(700)
    const i2 = await evalJs(`(function(){ var i=document.querySelector('.dside-node-new .dside-inline-input'); return !!i })()`)
    verdict('R6 Ctrl+N → 同样开出内联新建输入行', !!i2)
    await key('Escape', 'Escape', 0)
    await sleep(300)

    // 「折叠」按钮（不改变用户数据，只收起树）
    const c = await rectOf('.dside-pane-actions button[aria-label^="折叠"]')
    await clickAt(c.x, c.y)
    await sleep(600)
    verdict('R7 「折叠所有文件夹」可点、不报错', !(await evalJs(`!!window.__kerr`)))

    const pass = results.filter(Boolean).length
    console.log('\n===== 真机资源管理器动作: ' + pass + '/' + results.length + ' =====')
  } catch (e) {
    console.log('PROBE ERROR: ' + (e && e.stack ? e.stack : e))
  }
  process.exit(0)   // 不关应用 → ws 还开着，必须显式退出，否则进程挂着、外层拿不到输出
}
main()
