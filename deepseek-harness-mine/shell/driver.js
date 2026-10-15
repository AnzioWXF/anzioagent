'use strict'
// Playwright 驱动层（跑在壳主进程）：Agent 用它亲手操作内置浏览器的页面。
//
// 为什么是"连本机调试端口"这个看起来最土的做法（2026-10-08 拍板的技术债，设计定稿 §4.3）：
// Playwright 要的是一个 CDP 端点；正路（照抄 VSCode）是自己实现浏览器级 CDP 协议代理、在进程内接
// `webContents.debugger`，那样一个网络端口都不用开。那条路是第二版。第一版先用 Electron 自带的调试
// 端口把能力面跑通 —— ⚠ **这个端口无鉴权（只绑 127.0.0.1）**，本机任何进程都能连上来操作页面；
// 所以它必须在第二版被换掉，别在这里加更多"只有端口版才成立"的东西。
//
// 对外只暴露天工自己的接口（返回对象的那些函数），**内部实现可整体替换**（端口版 → 代理版）；
// 调用方（bridge.js / Agent 工具层）绝不许碰 Playwright 的任何对象。
//
// 页面怎么认：每个浏览器视图的页面 preload 会把自己视图的 id 挂在 `window.__anzioBrowserViewId`
// （见 browser-preload.js 与 browser.js 里的 additionalArguments）。这里反过来问每个页面"你是谁"，
// 答得出 id 的才是我们的页面 —— 绝不误碰天工主界面那一页。
//
// 2026-10-08 实测（`temp\spike-playwright.mjs`）：connectOverCDP 连 Electron 43 的 Chromium 150
// 可用，locator 点击/填表/截图/无障碍树快照全通，断开连接不会把视图带崩。

const { chromium } = require('playwright-core')   // 纯库版：用 Electron 自带的 Chromium，不下载浏览器

const IDLE_MS = 30 * 60 * 1000      // 空闲拆连（照抄 VSCode 的数值）
const T_ACT = 10000                 // 单次动作超时
const T_NAV = 30000                 // 开页 / 导航超时
const T_SETTLE = 5000               // 动作后等网络安静的上限
const EVENTS_MAX = 40               // 每个页面保留的最近事件条数（"读页面"要报最近错误）

function createDriver(opts) {
  const port = String((opts && opts.port) || 9333)
  const onLog = (opts && opts.onLog) || function () {}
  const markName = '__anzioBrowserViewId'
  // 「Agent幻影」通道（第三期，可选）：{enabled(), send(id, cmd) → 该等多久}。没给就纯干活、不演。
  const phantom = (opts && opts.phantom) || null

  let browser = null
  let connecting = null
  let idleTimer = null
  const wired = new WeakSet()          // 已经挂过事件监听的页面
  const events = new Map()             // viewId -> [{t, kind, text}]
  const queues = new Map()             // viewId -> Promise 链：同一页面的动作**串行**
  const mapCache = new Map()           // page -> viewId

  const log = (msg, meta) => { try { onLog(msg, meta) } catch { /* 忽略 */ } }

  // ── 连接（惰性建、空闲拆、断了自重建）──────────────────────────────────────
  async function connect() {
    if (browser) return browser
    if (connecting) return connecting
    connecting = (async () => {
      try {
        const b = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 15000 })
        browser = b
        b.on('disconnected', () => { browser = null; mapCache.clear(); log('driver-disconnected') })
        log('driver-connected', { port: Number(port) })
        return b
      } finally { connecting = null }
    })()
    return connecting
  }
  function touchIdle() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { disconnect().catch(() => {}) }, IDLE_MS)
    if (idleTimer.unref) idleTimer.unref()
  }
  async function disconnect() {
    const b = browser
    browser = null
    mapCache.clear()
    if (b) { try { await b.close() } catch { /* 忽略 */ } log('driver-idle-disconnect') }
  }

  function noteEvent(id, kind, text) {
    const list = events.get(id) || []
    list.push({ t: Date.now(), kind: kind, text: String(text || '').slice(0, 300) })
    while (list.length > EVENTS_MAX) list.shift()
    events.set(id, list)
  }
  function wire(page, id) {
    if (wired.has(page)) return
    wired.add(page)
    try {
      page.on('console', (msg) => {
        if (msg.type() !== 'error' && msg.type() !== 'warning') return
        noteEvent(id, 'console:' + msg.type(), msg.text())
      })
      page.on('pageerror', (err) => noteEvent(id, 'pageerror', (err && err.message) || String(err)))
      page.on('requestfailed', (req) => noteEvent(id, 'requestfailed', req.url() + ' —— ' + ((req.failure() && req.failure().errorText) || '')))
      // 页面弹窗（alert / confirm / prompt）**必须处理**：不管它，接下来的动作会一直卡着等应答
      // （设计定稿 §4.2）。Playwright 的默认行为就是自动 dismiss；这里显式接过来先记账再 dismiss，
      // 报障时能看见"刚才弹过什么"，而不是只看到"卡住了"。
      // ⚠ 代价：Agent 驱动的页面里 confirm 会被自动取消 —— 将来要做"Agent 决定接受/输入"的开关，
      //   得先把这条改成不自动应答（否则 Agent 没机会插手）。
      page.on('dialog', (d) => {
        noteEvent(id, 'dialog:' + d.type(), d.message())
        d.dismiss().catch(() => {})
      })
    } catch { /* 页面可能已经关了 */ }
  }

  // 把"我们的页面"和视图 id 对上（认不出的页面一律不碰）
  async function refreshMap() {
    const b = await connect()
    const out = new Map()
    const pages = []
    for (const ctx of b.contexts()) for (const p of ctx.pages()) pages.push(p)
    for (const p of pages) {
      let id = mapCache.get(p)
      if (id === undefined) {
        try {
          // 认不出来（不是我方页面 / 已关闭 / 还没建好）就当没有；给个 4s 上限免得卡住整轮
          id = await Promise.race([
            p.evaluate('window.' + markName + ' || ""'),
            new Promise((r) => setTimeout(() => r(''), 4000)),
          ])
          id = id ? String(id) : null
        } catch { id = null }
        if (id) mapCache.set(p, id)
      }
      if (id) { out.set(id, p); wire(p, id) }
    }
    return out
  }

  async function pageFor(id) {
    const want = String(id || '')
    let m = await refreshMap()
    if (m.has(want)) { touchIdle(); return m.get(want) }
    await new Promise((r) => setTimeout(r, 300))     // 刚建的标签可能缓存里还没有，再刷一次
    m = await refreshMap()
    if (m.has(want)) { touchIdle(); return m.get(want) }
    throw new Error('找不到这个浏览器页面（可能已关闭，或视图还没建好）：' + want)
  }

  async function safeTitle(page) {
    try { return await page.title() } catch { return '' }
  }
  // 动作后等网络安静：上限 5s，超了不算失败（照抄 VSCode 的数值）
  async function settle(page) {
    try { await page.waitForLoadState('networkidle', { timeout: T_SETTLE }) } catch { /* 一直在请求就算了 */ }
  }

  // ── Agent幻影（第三期）：动手之前先把指针挪过去，让人看清"它点了哪儿" ──────────────
  // ⚠ 这里的等待是**产品行为**（演给人看），不是拿延迟去凑时序：等多久由壳算（= 指针动画时长），
  //   幻影关掉时 enabled() 为假 ⇒ 一点等待都不会发生，动作立刻执行。
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // ── 键盘记账（第三期 · 键盘映射面板的数据源）────────────────────────────────
  // Playwright **不提供**"每个键按下/抬起"的回调，所以键流只能由我们自己的动作层推出来：
  // 我们知道自己要打什么、要按什么组合键，就按真实时序记一笔。
  // ⚠ 兜底代码（browser_run_code）里的按键**不会**有记录 —— 这是刻意的（设计定稿 §5.3：
  //   幻影只演"我们自己的动作层发起的动作"，黑盒代码不演）。
  // ⚠ 记账绝不能影响真实动作：全程 try/catch。
  const onAction = (opts && opts.onAction) || null
  function recordKey(key, phase) {
    if (!onAction) return
    try { onAction({ kind: 'key', key: String(key || ''), phase: String(phase || 'press'), at: Date.now() }) } catch { /* 忽略 */ }
  }
  function recordText(text, ascii) {
    if (!onAction) return
    const s = String(text == null ? '' : text)
    try {
      if (!ascii) { onAction({ kind: 'text', text: s.slice(0, 120), at: Date.now() }); return }
      for (const ch of s) recordKey(ch, 'press')
    } catch { /* 忽略 */ }
  }
  async function pointAt(id, page, selector) {
    if (!phantom || !phantom.enabled()) return false
    try {
      const box = await page.locator(String(selector)).first().boundingBox({ timeout: 4000 })
      if (!box) return false
      const ms = phantom.send(String(id), { type: 'move', x: box.x + box.width / 2, y: box.y + box.height / 2 })
      if (ms > 0) await sleep(ms)
      return true
    } catch { return false }        // 取不到位置就算了，绝不影响真实动作
  }

  // ── 动作实现（全部走 Playwright 的"类人"接口：自动等待、自动滚动、真实输入事件）──
  const impl = {
    async status() { return { connected: !!browser, port: Number(port) } },

    async list() {
      const m = await refreshMap()
      const out = []
      for (const [id, page] of m.entries()) out.push({ id: id, url: page.url(), title: await safeTitle(page) })
      return out
    },

    async read(id, options) {
      const page = await pageFor(id)
      const o = options || {}
      const out = {
        id: String(id), url: page.url(), title: await safeTitle(page),
        errors: (events.get(String(id)) || []).slice(-12),
      }
      if (o.aria !== false) {
        try {
          // 无障碍树快照（VSCode 的"读页面"同样用它，比抓 HTML 干净得多、也不怕超长）
          out.aria = String(await page.locator(o.selector || 'body').first().ariaSnapshot({ timeout: T_ACT }) || '').slice(0, 20000)
        } catch (e) { out.aria = null; out.ariaError = String((e && e.message) || e) }
      }
      return out
    },

    async screenshot(id, options) {
      const page = await pageFor(id)
      const o = options || {}
      const buf = o.selector
        ? await page.locator(String(o.selector)).first().screenshot({ timeout: T_ACT })
        : await page.screenshot({ timeout: T_ACT, fullPage: !!o.fullPage })
      return { id: String(id), bytes: buf.length, base64: buf.toString('base64') }
    },

    async navigate(id, url) {
      const page = await pageFor(id)
      const resp = await page.goto(String(url), { timeout: T_NAV, waitUntil: 'domcontentloaded' })
      await settle(page)
      return { id: String(id), url: page.url(), title: await safeTitle(page), status: resp ? resp.status() : null }
    },
    async back(id) {
      const page = await pageFor(id)
      const r = await page.goBack({ timeout: T_NAV, waitUntil: 'domcontentloaded' })
      await settle(page)
      return { id: String(id), url: page.url(), moved: !!r }
    },
    async forward(id) {
      const page = await pageFor(id)
      const r = await page.goForward({ timeout: T_NAV, waitUntil: 'domcontentloaded' })
      await settle(page)
      return { id: String(id), url: page.url(), moved: !!r }
    },
    async reload(id) {
      const page = await pageFor(id)
      await page.reload({ timeout: T_NAV, waitUntil: 'domcontentloaded' })
      await settle(page)
      return { id: String(id), url: page.url() }
    },

    async click(id, sel, options) {
      const page = await pageFor(id)
      const o = options || {}
      const shown = await pointAt(id, page, sel)                 // 幻影：先把指针挪过去（没人看时立即返回 false）
      if (shown) phantom.send(String(id), { type: 'press', button: o.button || 'left' })
      if (shown) await sleep(90)                                 // 按下→松开之间留一瞬，人手就是这样
      await page.locator(String(sel)).first().click({
        timeout: o.timeout || T_ACT, button: o.button || 'left',
        clickCount: o.clickCount || 1, force: !!o.force,
      })
      if (shown) phantom.send(String(id), { type: 'release' })
      await settle(page)
      return { id: String(id), clicked: String(sel) }
    },
    async hover(id, sel) {
      const page = await pageFor(id)
      await pointAt(id, page, sel)
      await page.locator(String(sel)).first().hover({ timeout: T_ACT })
      return { id: String(id), hovered: String(sel) }
    },
    async drag(id, from, to) {
      const page = await pageFor(id)
      if (phantom && phantom.enabled()) {
        try {
          const a = await page.locator(String(from)).first().boundingBox({ timeout: 4000 })
          const b = await page.locator(String(to)).first().boundingBox({ timeout: 4000 })
          if (a && b) {
            const ms = phantom.send(String(id), {
              type: 'drag',
              from: { x: a.x + a.width / 2, y: a.y + a.height / 2 },
              to: { x: b.x + b.width / 2, y: b.y + b.height / 2 },
            })
            if (ms > 0) await sleep(ms + 120)
          }
        } catch { /* 拿不到位置就只干活不演 */ }
      }
      await page.dragAndDrop(String(from), String(to), { timeout: T_ACT })
      await settle(page)
      return { id: String(id), dragged: String(from) + ' → ' + String(to) }
    },
    async press(id, key, sel) {
      const page = await pageFor(id)
      const combo = String(key)
      // 组合键按"按下顺序 + 逆序抬起"记账（Control+A → Ctrl↓ A↓ A↑ Ctrl↑），
      // 键盘面板靠这个显示"哪些修饰键正被按住"
      const parts = combo.split('+').filter(function (x) { return x !== '' })
      for (let i = 0; i < parts.length; i++) recordKey(parts[i], 'down')
      if (sel) await page.locator(String(sel)).first().press(combo, { timeout: T_ACT })
      else await page.keyboard.press(combo)
      for (let i = parts.length - 1; i >= 0; i--) recordKey(parts[i], 'up')
      await settle(page)
      return { id: String(id), pressed: combo }
    },
    async type(id, text, options) {
      const page = await pageFor(id)
      const o = options || {}
      if (o.selector) {
        // 先点一下聚焦（幻影还开着就让指针先走过去，人看得见"它点进了哪个输入框"）
        const shown = await pointAt(id, page, o.selector)
        if (shown) phantom.send(String(id), { type: 'press' })
        await page.locator(String(o.selector)).first().click({ timeout: T_ACT })
        if (shown) phantom.send(String(id), { type: 'release' })
      }
      const s = String(text == null ? '' : text)
      // 键盘敲得出来的（ASCII）**逐键派发**：键帽真的依次按下、页面补全/按键响应也真的触发；
      // 中文/表情这类敲不出来的整段写入（设计定稿 §5.3 的输入规则）
      const ascii = /^[\x20-\x7E]*$/.test(s)
      // 记账要在**动作之前**：键流的意义是"人正看着它敲"，滞后了就成回放了
      recordText(s, ascii)
      if (ascii) await page.keyboard.type(s, { delay: Number(o.delay || 0) })
      else await page.keyboard.insertText(s)
      if (o.submit && ascii) { recordKey('Enter', 'down'); await page.keyboard.press('Enter'); recordKey('Enter', 'up') }
      await settle(page)
      return { id: String(id), typed: s.length, mode: ascii ? 'per-key' : 'insert' }
    },
    async scroll(id, options) {
      const page = await pageFor(id)
      const o = options || {}
      const dx = Number(o.dx || 0), dy = Number(o.dy || 0)
      const sel = o.selector ? String(o.selector) : null
      let before = 0
      if (sel) {
        const loc = page.locator(sel).first()
        const box = await loc.boundingBox({ timeout: T_ACT })
        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        before = Number(await loc.evaluate('(el) => el.scrollTop || 0')) || 0
      } else {
        const vp = page.viewportSize() || { width: 800, height: 600 }
        await page.mouse.move(vp.width / 2, vp.height / 2)
        before = Number(await page.evaluate('window.scrollY || 0')) || 0
      }
      // 用真实滚轮事件，不直接改 scrollTop：Agent 的动作必须和人手一致（幻影也要能演）
      await page.mouse.wheel(dx, dy)
      // ⚠ 滚轮是**异步**的（合成器拿到事件才滚）→ 不等它落下去，紧接着的读页面/截图会拿到滚动前
      //   那一帧，Agent 就会以为"没滚动"。这里等的是"位置真的变了"这个**条件**（不是定时器），
      //   滚不动（已经到底/这个元素不可滚）不算失败。
      try {
        if (sel) await page.waitForFunction((a) => { const el = document.querySelector(a.sel); return !!el && (el.scrollTop || 0) !== a.before }, { sel: sel, before: before }, { timeout: 1500 })
        else await page.waitForFunction((b) => (window.scrollY || 0) !== b, before, { timeout: 1500 })
      } catch { /* 滚不动就算了 */ }
      await settle(page)
      return { id: String(id), scrolled: { dx: dx, dy: dy } }
    },

    async waitFor(id, options) {
      const page = await pageFor(id)
      const o = options || {}
      const timeout = Number(o.timeout || T_ACT)
      if (o.selector) { await page.locator(String(o.selector)).first().waitFor({ state: o.state || 'visible', timeout: timeout }); return { id: String(id), ok: true, waited: 'selector' } }
      if (o.url) { await page.waitForURL(String(o.url), { timeout: timeout }); return { id: String(id), ok: true, waited: 'url' } }
      if (o.loadState) { await page.waitForLoadState(o.loadState, { timeout: timeout }); return { id: String(id), ok: true, waited: 'load' } }
      if (o.networkIdle) { await page.waitForLoadState('networkidle', { timeout: timeout }); return { id: String(id), ok: true, waited: 'networkidle' } }
      throw new Error('等待条件没给（selector / url / loadState / networkIdle 四选一）')
    },

    // 兜底：跑一段 Playwright 代码。**能用固定动作干的场景一律不许走这里** —— 它演不出幻影（设计定稿 §4.3）
    async code(id, source) {
      const page = await pageFor(id)
      const fn = new Function('page', 'return (async () => {' + String(source || '') + '\n})()')
      const value = await fn(page)
      await settle(page)
      let out = null
      try { out = value === undefined ? null : JSON.parse(JSON.stringify(value)) } catch { out = String(value) }
      return { id: String(id), value: out }
    },
  }

  // 串行队列：同一页面的动作一个一个做（幻影要按顺序演；Agent 并发调用也不许互相插队）
  function run(id, fn) {
    const key = String(id || '')
    const prev = queues.get(key) || Promise.resolve()
    const next = prev.then(() => fn(), () => fn())
    queues.set(key, next.catch(() => {}))
    return next
  }

  const SERIAL = ['navigate', 'back', 'forward', 'reload', 'click', 'hover', 'drag', 'press', 'type', 'scroll', 'waitFor', 'read', 'screenshot', 'code']
  const out = {
    status: impl.status.bind(impl),
    list: impl.list.bind(impl),
    disconnect: disconnect,
    // 内部用（bridge 之外别碰）
    _impl: impl,
  }
  for (const k of SERIAL) out[k] = (...args) => run(args[0], () => impl[k](...args))
  return out
}

module.exports = { createDriver }
