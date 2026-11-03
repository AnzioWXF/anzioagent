'use strict'
// 内置浏览器内核（跑在壳主进程）：一个浏览器标签 = 一个 Electron 原生 WebContentsView。
//
// 为什么是原生视图而不是 <webview> 标签：见 00devCore §3「内置浏览器」条目与设计定稿 §2
// （超长期迭代的产品，不押注 Chromium 正在淘汰的 webview 标签）。
//
// 动这份文件之前必须知道的硬约束：
//   1. 原生视图**永远盖在页面 DOM 之上**，没有任何 z-index 能压过它 → 天工任何浮层（命令面板、
//      菜单、悬停提示、对话框、通知）压上来时，必须由渲染层通知我们把视图藏起来；藏之前先截图
//      交给渲染层当占位，否则会闪一块白。漏一个浮层的后果 = "弹窗被浏览器压住"的报障。
//   2. 几何由渲染层上报 **CSS 像素**矩形，这里乘当前界面缩放比再取整。少了这一步，改了界面缩放
//      之后视图边缘会错位、发虚（VSCode 专门做了像素对齐，见设计定稿 §3.1）。
//   3. 登录态必须长期保留（这是 Agent 能模拟真实操作的前提）→ 固定持久化分区，且与天工主界面
//      隔离：浏览器页面看不到天工的 cookie/localStorage，反之亦然。
//   4. 本文件属于「壳半」，改完**不热重载**，要重启天工才生效。

const { WebContentsView, Menu, shell, clipboard, ipcMain, app, session, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')

const PARTITION = 'persist:anzio-browser'
const BROWSER_PRELOAD = path.join(__dirname, 'browser-preload.js')
const SNAPSHOT_FILE = 'browser-session-cookies.bin'
// VSCode 同款白底：视图还没渲染出内容时先铺白，配合"藏起来前先截图"避免闪黑
const BLANK_COLOR = '#FFFFFF'

// 页面 id 的协议头。壳里的页面 id 同时是编辑器标签的**伪路径**（设计定稿 §3）：
// `browser://agent-<时间戳>-<序号>`（Agent 开的，见 bridge.js）或 `browser://browser-<序号>-<时间戳>`（人开的）。
const VIEW_ID_SCHEME = 'browser://'

// 地址栏输入 → 可加载的 URL。刻意不做搜索（设计定稿 §7：第一版只做输入 URL + 回车）。
// 没有协议头时一律补 https://，本机地址例外（localhost:3000 这种补 https 会连不上）。
function normalizeUrl(raw) {
  const s = String(raw || '').trim()
  if (!s) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(s)) return 'http://' + s
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) return 'http://' + s
  return 'https://' + s
}

// ── 登录态跨重启（2026-11-03）────────────────────────────────────────────────
// 站点没给过期时间的那种登录凭证（会话 cookie）Chromium 永不写盘，而 Chrome 靠"继续浏览上次打开的网页"
// 那个开关专门把它留到下次启动，Electron 没有这个开关 ⇒ 关一次天工就掉一次登录。这里自己存：
// cookie 一变就（去抖几秒）存一份加密快照，启动时原样回填 —— 回填时**不给过期时间**，仍然算会话
// cookie，站点自己的登出与过期语义不受影响（登出后快照里就没有它，不会被复活）。

function snapshotPath() {
  return path.join(app.getPath('userData'), SNAPSHOT_FILE)
}

function browserSession() {
  return session.fromPartition(PARTITION)
}

async function snapshotSessionCookies(note) {
  try {
    const store = browserSession().cookies
    const keep = await store.get({ session: true })
    const file = snapshotPath()
    if (!keep.length) {
      try { fs.unlinkSync(file) } catch { /* 本来就没有 */ }
      return 0
    }
    // 与 SSH 口令同一条纪律：加密不可用就**不落盘**，绝不退化成明文
    if (!safeStorage.isEncryptionAvailable()) {
      note('warn', 'browser-cookie', '加密不可用，放弃保存会话 cookie', { count: keep.length })
      return 0
    }
    const payload = {
      savedAt: Date.now(),
      cookies: keep.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, hostOnly: c.hostOnly,
      })),
    }
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(payload)))
    fs.renameSync(tmp, file)
    return keep.length
  } catch (e) {
    note('warn', 'browser-cookie', '会话 cookie 快照失败', { error: (e && e.message) || String(e) })
    return 0
  }
}

async function restoreSessionCookies(note) {
  let data
  try {
    const file = snapshotPath()
    if (!fs.existsSync(file)) return 0
    if (!safeStorage.isEncryptionAvailable()) return 0
    data = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)))
  } catch (e) {
    // 换 Windows 账户 / 文件损坏都解不开，一律当没存过，不能把启动卡住
    note('warn', 'browser-cookie', '会话 cookie 快照解不开，当作没存过', { error: (e && e.message) || String(e) })
    return 0
  }
  const store = browserSession().cookies
  let n = 0
  for (const c of (data && data.cookies) || []) {
    const host = String(c.domain || '').replace(/^\./, '')
    if (!host) continue
    const details = {
      url: (c.secure ? 'https://' : 'http://') + host + (c.path || '/'),
      name: c.name, value: c.value, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || 'unspecified',
    }
    if (!c.hostOnly) details.domain = c.domain
    try { await store.set(details); n++ } catch { /* 单条被拒不影响其它站点 */ }
  }
  if (n) { try { await store.flushStore() } catch { /* 忽略 */ } }
  note('info', 'browser-cookie', '会话 cookie 已回填', { count: n })
  return n
}

function installBrowserHost(win, noteFn) {
  const note = typeof noteFn === 'function' ? noteFn : () => { }
  const entries = new Map()          // id -> { id, view, rect }
  let seq = 0

  // 回填必须赶在第一个页面加载之前：创建视图时等这个 promise，而不是靠"通常来得及"。
  const restoreReady = restoreSessionCookies(note)
  // 去抖 3 秒：登录这类 cookie 变化很少（一次登录也就几条），但平台的 'changed' 会连着报一串
  let snapTimer = null
  const scheduleSnapshot = () => {
    if (snapTimer) clearTimeout(snapTimer)
    snapTimer = setTimeout(() => { snapTimer = null; snapshotSessionCookies(note) }, 3000)
  }
  try { browserSession().cookies.on('changed', scheduleSnapshot) } catch (e) {
    note('warn', 'browser-cookie', '挂不上 cookie 变化事件', { error: (e && e.message) || String(e) })
  }
  // 退出时再存一次并强制落盘：正常关天工能拿到最新的，被强杀/崩溃时靠上面那个去抖快照兜底
  app.on('before-quit', () => {
    try { browserSession().flushStorageData() } catch { /* 忽略 */ }
    try { browserSession().cookies.flushStore().catch(() => { }) } catch { /* 忽略 */ }
    snapshotSessionCookies(note)
  })

  const send = (msg) => {
    try { if (!win.isDestroyed()) win.webContents.send('anzio-browser:event', msg) } catch { /* 窗口正在关闭 */ }
  }

  function navState(entry) {
    const wc = entry.view.webContents
    let canBack = false, canForward = false
    try {
      canBack = wc.navigationHistory.canGoBack()
      canForward = wc.navigationHistory.canGoForward()
    } catch { /* 拿不到就当不能，别让一个异常打断整条事件链 */ }
    return { url: wc.getURL(), title: wc.getTitle(), canBack, canForward, loading: wc.isLoading() }
  }
  const emitNav = (entry) => send(Object.assign({ type: 'nav', id: entry.id }, navState(entry)))

  // ── Agent幻影（第三期）：把"演给人看"的指令发给页面里的指针层 ──────────────────
  // 开关与速度档是**全局**的（工具栏上那一个开关，设计定稿 §4.4）；关掉时照样发指令，
  // 但页面那边会忽略绘制 —— 动作本身永远照做（幻影只是"演"，不是"闸门"）。
  const phantom = { on: true, speed: 1 }

  // 指针要走多久，由**这里**决定（页面只负责按给它的时长演）：远距离慢、近距离快，再按速度档缩放。
  // 这是"像真人"的第一条，也是驱动层要等的时间 —— 两处必须是同一个数，所以只在这里算一次。
  function pointerMs(from, to) {
    const a = from || { x: 0, y: 0 }
    const b = to || { x: 0, y: 0 }
    const dist = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y))
    const base = Math.max(120, Math.min(620, dist * 1.15))
    return Math.round(base / Math.max(0.25, phantom.speed))
  }

  // 给某个视图的页面发一条幻影指令；返回"驱动层该等多久"（毫秒）
  function sendToView(id, cmd) {
    const entry = entries.get(String(id))
    if (!entry || !cmd) return 0
    const full = Object.assign({}, cmd)
    let wait = 0
    if (full.type === 'move' || full.type === 'drag') {
      wait = full.duration === undefined
        ? pointerMs(full.type === 'drag' ? full.from : entry.lastPointer, full.type === 'drag' ? full.to : full)
        : Math.max(0, Number(full.duration) || 0)
      full.duration = wait
      if (full.type === 'move') entry.lastPointer = { x: Number(full.x) || 0, y: Number(full.y) || 0 }
    }
    try { entry.view.webContents.send('anzio-phantom', full) } catch { /* 视图正在销毁 */ }
    return wait
  }
  // Agent 的动作记账（键盘流）→ 天工页面里的「键盘映射面板」。
  // 开关一起管：幻影关掉时连记录都不发（那条路上的可视化全归这一个开关，设计定稿 §4.4）。
  // ⚠ 通道名带 agent 前缀：`anzio-browser:action` 是**渲染层→壳**的导航动作通道（back/forward/reload…），
  //   同名会让"按键流"和"导航动作"撞在一起，将来谁加个监听都得先猜方向（2026-10-08 改名）。
  function sendAction(record) {
    if (!record || !phantom.on) return
    try { if (!win.isDestroyed()) win.webContents.send('anzio-browser:agent-action', record) } catch { /* 窗口关闭中 */ }
  }
  function phantomSetup(entry) {
    try {
      entry.view.webContents.send('anzio-phantom', { type: 'on', value: phantom.on })
      entry.view.webContents.send('anzio-phantom', { type: 'speed', value: phantom.speed })
    } catch { /* 忽略 */ }
  }

  function create(id, url) {
    const key = String(id)
    if (entries.has(key)) return { ok: true, existed: true }
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        preload: BROWSER_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 页面 preload 靠它把自己视图的 id 挂到 window 上 —— 驱动层（Playwright）据此认出
        // "调试端口上的哪个页面 = 哪块视图"，否则只能按 URL 猜（两个标签开同一网址就分不清了）
        additionalArguments: ['--anzio-browser-view-id=' + key],
      },
    })
    view.setBackgroundColor(BLANK_COLOR)
    view.setVisible(false)
    win.contentView.addChildView(view)
    // visible 由**我们自己记账**，不读 view.getVisible()：Electron 43 的 WebContentsView 上没有那个
    // 读取接口，用它做判断会让"藏之前先截图"这一步被静默跳过（占位图永远不出现、藏起来会闪白）。
    const entry = { id: key, view, rect: null, visible: false, lastPointer: null }
    entries.set(key, entry)
    // 新视图也要立刻知道当前开关与速度档（否则工具栏关了幻影，新开的页面还会画指针）
    phantomSetup(entry)

    const wc = view.webContents
    wc.on('page-title-updated', (_e, title) => send({ type: 'title', id: key, title: String(title || '') }))
    wc.on('page-favicon-updated', (_e, urls) => send({ type: 'favicon', id: key, urls: Array.isArray(urls) ? urls.slice(0, 1) : [] }))
    wc.on('did-start-loading', () => send({ type: 'loading', id: key, loading: true }))
    wc.on('did-stop-loading', () => emitNav(entry))
    wc.on('did-navigate', () => emitNav(entry))
    wc.on('did-navigate-in-page', () => emitNav(entry))
    // errorCode -3 = 被主动取消（用户改地址/点刷新），不是错误，报了反而误导
    wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      send({ type: 'fail', id: key, code, message: String(desc || ''), url: String(failedUrl || '') })
    })
    wc.on('render-process-gone', () => send({ type: 'fail', id: key, code: 0, message: '页面进程已退出', url: wc.getURL() }))
    wc.on('focus', () => send({ type: 'focus', id: key, focused: true }))
    wc.on('blur', () => send({ type: 'focus', id: key, focused: false }))
    // target=_blank 新窗口拦下来在天工里开新标签（设计定稿 §4.2「页面行为」：绝不开出无主的原生窗口）
    wc.setWindowOpenHandler(({ url: target }) => {
      send({ type: 'open-tab', id: key, url: String(target || '') })
      return { action: 'deny' }
    })
    wc.on('context-menu', (_e, params) => showContextMenu(entry, params))

    if (url) restoreReady.then(() => {
      try { wc.loadURL(normalizeUrl(url)).catch(() => { /* 失败有 did-fail-load 兜底 */ }) } catch { /* 视图已销毁 */ }
    })
    return { ok: true }
  }

  function destroy(id) {
    const entry = entries.get(String(id))
    if (!entry) return { ok: true }
    entries.delete(entry.id)
    try { win.contentView.removeChildView(entry.view) } catch { /* 窗口已关 */ }
    try { entry.view.webContents.close() } catch { /* 忽略 */ }
    return { ok: true }
  }

  // ── 页面 id 归一（2026-10-16）──────────────────────────────────────────────
  // 页面 id 长得像网址（`browser://…`），调用方（尤其模型）常只写后半截 ⇒ 下游按原样查不到，
  // 报出来的却是"找不到页面 / 可能已关闭"，把排查引去视图生命周期（真事故：同一个错连撞 12 次）。
  // 归一放在这一层：entries 就是权威名单、同步可查，而且**所有**吃 id 的入口都能用上 —— 尤其是
  // 不经驱动层的 page.close（去掉了这一处，短名会静默假装关成功、页面其实还活着）。
  // ⚠ 只补协议头这一种写法，不做模糊 / 后缀匹配 —— 对不上宁可报错，也不能落到别的页面上去。
  // ⚠ 不认识的一律原样返回：报错交给下游（驱动层会把当前可用的 id 一并列出来）。
  function canonicalId(id) {
    const raw = String(id || '')
    if (entries.has(raw)) return raw
    if (raw !== '' && raw.indexOf(VIEW_ID_SCHEME) !== 0 && entries.has(VIEW_ID_SCHEME + raw)) return VIEW_ID_SCHEME + raw
    return raw
  }

  // 藏起来时**什么都不铺**：以前的做法是藏之前截一张图交给渲染层当替身，那张图正是白屏的来源
  // （跳转途中截到白图、视图藏过再显没重绘就一直是那张白图）。宁可让用户看到"这块没在跑"，
  // 也不给一张可能过期的假画面。（2026-10-20 用户口径：删掉这套机制，不做补丁）
  async function setVisible(id, visible) {
    const entry = entries.get(String(id))
    if (!entry) return { ok: false }
    const want = !!visible
    if (want === entry.visible) return { ok: true, visible: entry.visible }
    // ⚠ setVisible 失败必须报出去：原生层调用一旦静默失败，表现就是"视图还在那儿盖着"，
    //   而 DOM 侧一切正常 —— 查起来极难（别把它塞进 try/catch 吞掉）
    try { entry.view.setVisible(want) } catch (e) {
      return { ok: false, code: 'set-visible-failed', message: String((e && e.message) || e) }
    }
    entry.visible = want
    if (want) repaint(entry)
    return { ok: true, visible: entry.visible }
  }

  // 视图藏过再显示，Electron 会停在旧帧不重绘（屏幕上就是一张旧画面或空白）→ 显式让它整帧重画。
  // 这条是兜 Electron 自己的底，跟业务判断无关。
  function repaint(entry) {
    try {
      const wc = entry.view.webContents
      if (typeof wc.invalidate === 'function') wc.invalidate()
    } catch { /* 忽略 */ }
    if (entry.rect) applyBounds(entry, entry.rect)
  }

  // 缩放换算只在这一处做（VSCode 一样只在一个地方乘）
  function applyBounds(entry, rect) {
    const zoom = (() => { try { return win.webContents.getZoomFactor() || 1 } catch { return 1 } })()
    entry.rect = rect
    const applied = {
      x: Math.round(Number(rect.x || 0) * zoom),
      y: Math.round(Number(rect.y || 0) * zoom),
      width: Math.max(1, Math.round(Number(rect.width || 0) * zoom)),
      height: Math.max(1, Math.round(Number(rect.height || 0) * zoom)),
    }
    entry.view.setBounds(applied)
    return { applied, zoom }
  }

  function setBounds(id, rect) {
    const entry = entries.get(String(id))
    if (!entry || !rect) return { ok: false }
    const r = applyBounds(entry, rect)
    // 把**真正落下去**的矩形回给渲染层：错位/发虚这类问题只有拿它和 DOM 的矩形对比才能定位
    // （探针/回归也靠这个断言"几何同步生效"，别删）
    return { ok: true, applied: r.applied, zoom: r.zoom }
  }

  function toggleDevTools(entry) {
    const wc = entry.view.webContents
    try {
      if (wc.isDevToolsOpened()) wc.closeDevTools()
      // 原生视图没有窗口可停靠 → 只能开独立窗口（VSCode 同样）
      else wc.openDevTools({ mode: 'detach' })
    } catch { /* 忽略 */ }
  }

  function showContextMenu(entry, params) {
    const wc = entry.view.webContents
    const zoom = (() => { try { return win.webContents.getZoomFactor() || 1 } catch { return 1 } })()
    const rect = entry.rect || { x: 0, y: 0 }
    const template = []
    if (wc.navigationHistory.canGoBack()) template.push({ label: '后退', click: () => wc.navigationHistory.goBack() })
    if (wc.navigationHistory.canGoForward()) template.push({ label: '前进', click: () => wc.navigationHistory.goForward() })
    if (template.length) template.push({ type: 'separator' })
    template.push({ label: '刷新', click: () => wc.reload() })
    if (params.linkURL) {
      template.push({ type: 'separator' })
      template.push({ label: '在系统浏览器中打开链接', click: () => shell.openExternal(params.linkURL) })
      template.push({ label: '复制链接地址', click: () => clipboard.writeText(String(params.linkURL)) })
    }
    if (params.isEditable) {
      template.push({ type: 'separator' })
      template.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' })
    } else if (params.selectionText) {
      template.push({ type: 'separator' }, { role: 'copy' })
    }
    template.push({ type: 'separator' })
    template.push({ label: '开发者工具', click: () => toggleDevTools(entry) })
    const menu = Menu.buildFromTemplate(template)
    menu.popup({
      window: win,
      x: Math.round((Number(rect.x || 0) + Number(params.x || 0)) * zoom),
      y: Math.round((Number(rect.y || 0) + Number(params.y || 0)) * zoom),
    })
  }

  function findEntryBySender(sender) {
    for (const entry of entries.values()) {
      if (entry.view.webContents === sender) return entry
    }
    return null
  }

  // ── IPC：渲染层（天工页面）↔ 壳 ────────────────────────────────────────────
  const handle = (channel, fn) => ipcMain.handle(channel, (_e, ...args) => fn(...args))

  handle('anzio-browser:create', (id, url) => create(id, url))
  handle('anzio-browser:destroy', (id) => destroy(id))
  handle('anzio-browser:bounds', (id, rect) => setBounds(id, rect))
  handle('anzio-browser:visible', (id, visible) => setVisible(id, visible))
  handle('anzio-browser:focus', (id) => {
    const entry = entries.get(String(id))
    if (entry) entry.view.webContents.focus()
    return { ok: !!entry }
  })
  handle('anzio-browser:blur', () => { try { win.webContents.focus() } catch { /* 忽略 */ } return { ok: true } })
  handle('anzio-browser:navigate', (id, url) => {
    const entry = entries.get(String(id))
    if (!entry) return { ok: false }
    entry.view.webContents.loadURL(normalizeUrl(url)).catch(() => {})
    return { ok: true }
  })
  handle('anzio-browser:action', (id, action) => {
    const entry = entries.get(String(id))
    if (!entry) return { ok: false }
    const wc = entry.view.webContents
    try {
      if (action === 'back') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack() }
      else if (action === 'forward') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward() }
      else if (action === 'reload') wc.reload()
      else if (action === 'stop') wc.stop()
      else if (action === 'devtools') toggleDevTools(entry)
      else return { ok: false, code: 'unknown-action' }
    } catch (e) { return { ok: false, code: 'error', message: String((e && e.message) || e) } }
    return { ok: true }
  })
  handle('anzio-browser:open-external', (url) => {
    try { shell.openExternal(String(url || '')); return { ok: true } } catch (e) { return { ok: false, message: String((e && e.message) || e) } }
  })
  handle('anzio-browser:info', (id) => {
    const entry = entries.get(String(id))
    if (!entry) return { ok: false }
    // visible / bounds 也一起报：查"视图到底藏没藏、贴在哪"时不用再猜（探针与将来的回归都靠它）
    let bounds = null
    try { bounds = entry.view.getBounds ? entry.view.getBounds() : null } catch { bounds = null }
    return Object.assign({ ok: true, id: entry.id, visible: !!entry.visible, bounds, rect: entry.rect }, navState(entry))
  })
  // 幻影开关（渲染层 → 壳）：全局生效。关掉的只是"演给人看"—— Agent 的动作照做（设计定稿 §4.4）
  handle('anzio-browser:phantom', (opts) => {
    const o = opts || {}
    if (o.on !== undefined) phantom.on = !!o.on
    if (o.speed !== undefined) phantom.speed = Math.max(0.25, Math.min(4, Number(o.speed) || 1))
    for (const entry of entries.values()) {
      sendToView(entry.id, { type: 'on', value: phantom.on })
      if (o.speed !== undefined) sendToView(entry.id, { type: 'speed', value: phantom.speed })
    }
    return { ok: true, on: phantom.on, speed: phantom.speed }
  })
  handle('anzio-browser:phantom-state', () => ({ ok: true, on: phantom.on, speed: phantom.speed }))

  handle('anzio-browser:create-id', () => ({ ok: true, id: 'browser-' + (++seq) + '-' + Date.now().toString(36) }))
  // 页面重新加载后渲染层的浏览器标签状态全没了，但原生视图还活着 → 由渲染层开局清场，避免留下无主的视图
  handle('anzio-browser:reset', () => {
    const ids = Array.from(entries.keys())
    for (const id of ids) destroy(id)
    return { ok: true, closed: ids.length }
  })

  // 窗口尺寸/位置变化 → 让渲染层重算矩形。页面自己也监听 resize，但跨显示器拖动（DPI 变化）
  // 页面收不到事件，只有这里知道，必须补这一条，否则拖到另一个显示器后视图会错位。
  const relayout = () => send({ type: 'relayout' })
  win.on('resize', relayout)
  win.on('move', relayout)
  win.on('maximize', relayout)
  win.on('unmaximize', relayout)
  win.on('enter-full-screen', relayout)
  win.on('leave-full-screen', relayout)

  // 浏览器页面 preload 的键位转发：认领 F5/F12（浏览器惯例键），其余交给天工键位系统
  ipcMain.on('anzio-browser:key-from-page', (e, payload) => {
    const entry = findEntryBySender(e.sender)
    if (!entry) return
    const key = String((payload && payload.key) || '')
    const wc = entry.view.webContents
    if (key === 'F5') { wc.reload(); return }
    if (key === 'F12') { toggleDevTools(entry); return }
    // 其余带 Ctrl/Alt 的组合键交给天工的键位路由（独立通道：它和"视图状态事件"是两种东西）
    try { win.webContents.send('anzio-browser:key', Object.assign({ id: entry.id }, payload)) } catch { /* 窗口关闭中 */ }
  })

  return { create, destroy, canonicalId, setBounds, setVisible, entries, sendToView: sendToView, sendAction: sendAction, phantom: () => ({ on: phantom.on, speed: phantom.speed }) }
}

module.exports = { installBrowserHost, normalizeUrl, PARTITION }
