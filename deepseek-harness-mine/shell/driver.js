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
const crypto = require('crypto')                  // 登录态指纹（只留 8 位哈希，凭证本身不出页面）

const IDLE_MS = 30 * 60 * 1000      // 空闲拆连（照抄 VSCode 的数值）
const T_ACT = 10000                 // 单次动作超时
const T_NAV = 30000                 // 开页 / 导航超时
const T_SETTLE = 5000               // 动作后等网络安静的上限
const EVENTS_MAX = 40               // 每个页面保留的最近事件条数（"读页面"要报最近错误）
const ARIA_DRIVER_MAX = 20000       // 快照在驱动层的上限（**必须回报被截断**，见 read）
const MAX_SCAN = 40                 // 多个候选时最多逐个探测几个（再多也只会爆掉单次动作时长）
const MAX_CANDIDATES = 8            // 候选清单最多列几个（命中总数照报，不受这个限制）

// ── 页面内探针（**必须写成不捕获外部变量的纯函数**：Playwright 是按源码序列化过去的）──
// 一个候选长什么样：给模型看的标识 + 为什么不可见。可见性判据与 Playwright 的动作前置检查同源
// （有非空盒子 + visibility 不是 hidden），只是这里把"为什么"也带出来 —— 只说"不可见"等于没说。
function CANDIDATE_PROBE(el) {
  const tag = el.tagName.toLowerCase()
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  // 原因要报**成因**不能只报症状：尺寸为 0 往往是祖先 display:none 的结果，
  // 只写"尺寸为 0"等于让调用方自己去猜该关哪个弹窗
  let hiddenBy = ''
  if (cs.display === 'none') hiddenBy = 'display:none'
  if (!hiddenBy) {
    // display:none 不继承，所以祖先被藏起来时自身的 computed style 仍正常 → 逐级往上找
    let p = el.parentElement
    let depth = 0
    while (p && depth < 60) {
      if (getComputedStyle(p).display === 'none') { hiddenBy = '祖先 display:none'; break }
      p = p.parentElement
      depth += 1
    }
  }
  if (!hiddenBy && (cs.visibility === 'hidden' || cs.visibility === 'collapse')) hiddenBy = 'visibility:' + cs.visibility
  if (!hiddenBy) {
    let p = el.parentElement
    let depth = 0
    while (p && depth < 60) {
      if (getComputedStyle(p).visibility === 'hidden') { hiddenBy = '祖先 visibility:hidden'; break }
      p = p.parentElement
      depth += 1
    }
  }
  if (!hiddenBy && Number(cs.opacity) === 0) hiddenBy = 'opacity:0'
  if (!hiddenBy && (r.width <= 0 || r.height <= 0)) hiddenBy = '尺寸为 0'
  let text = ''
  try { text = String(el.innerText || el.value || el.textContent || '') } catch (e) { text = '' }
  text = text.replace(/\s+/g, ' ').trim()
  const label = String(el.getAttribute('aria-label') || '').trim()
  return {
    tag: tag,
    role: String(el.getAttribute('role') || ''),
    name: (label || text).slice(0, 60),
    id: String(el.id || ''),
    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
    visible: hiddenBy === '',
    hiddenBy: hiddenBy,
    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
  }
}

// 值探针：读回写入后的真实值，同时判断这个字段是不是敏感（密码 / 验证码 / 卡号）。
// ⚠ 敏感字段**只回长度**：回读是为了让模型核对，不是为了把密码抄进工具结果。
function VALUE_PROBE(el) {
  const tag = el.tagName.toLowerCase()
  const auto = String(el.getAttribute('autocomplete') || '')
  const ident = String(el.getAttribute('name') || '') + ' ' + String(el.id || '')
  const sensitive = (tag === 'input' && String(el.type) === 'password')
    || /one-time-code|cc-(number|csc|exp)/i.test(auto)
    || /pass(word)?|secret|token|otp|one-?time|验证码|密码/i.test(ident)
  const editable = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
  let v = ''
  if (tag === 'input' || tag === 'textarea' || tag === 'select') v = String(el.value || '')
  else if (el.isContentEditable === true) v = String(el.innerText || '')
  // 不可编辑的元素（光标落在 body 上时那种）不读内容：body 的 textContent 是整页文字，
  // 拿来当"写入后的值"只会误导（2026-10-19 加）
  return { sensitive: !!sensitive, editable: editable, length: v.length, value: sensitive ? '' : v.slice(0, 80) }
}

// 布局度量探针：只报"客观不成立"的事实（内容比可见区宽/高、越出父容器、被省略号截断、行数）。
// 行数是给"按钮有没有换行"用的：元素自身高度 / 行高。
function MEASURE_PROBE(el) {
  const describe = (n) => {
    const parts = [n.tagName.toLowerCase()]
    if (n.id) parts.push('#' + n.id)
    if (typeof n.className === 'string' && n.className.trim()) parts.push('.' + n.className.trim().split(/\s+/).slice(0, 2).join('.'))
    const t = String(n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24)
    return parts.join('') + (t ? ' 「' + t + '」' : '')
  }
  const metrics = (n) => {
    const r = n.getBoundingClientRect()
    const cs = getComputedStyle(n)
    const pr = n.parentElement ? n.parentElement.getBoundingClientRect() : null
    const lh = parseFloat(cs.lineHeight) || 0
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      scrollW: n.scrollWidth, clientW: n.clientWidth,
      scrollH: n.scrollHeight, clientH: n.clientHeight,
      overflowX: n.scrollWidth - n.clientWidth,
      overflowY: n.scrollHeight - n.clientHeight,
      outsideParent: pr === null ? false
        : (r.left < pr.left - 1 || r.right > pr.right + 1 || r.top < pr.top - 1 || r.bottom > pr.bottom + 1),
      lines: lh > 0 ? Math.max(1, Math.round(r.height / lh)) : 0,
      lineHeight: lh ? Math.round(lh) : 0,
      ellipsis: cs.textOverflow === 'ellipsis' && n.scrollWidth - n.clientWidth > 1,
      nowrap: cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre',
    }
  }
  const out = { viewport: { w: window.innerWidth, h: window.innerHeight }, scanned: 0, problems: [] }
  out.root = { node: describe(el), m: metrics(el) }
  const all = el.querySelectorAll('*')
  for (let i = 0; i < all.length && out.scanned < 400; i++) {
    const n = all[i]
    // 行内元素（span/a）的 clientWidth 恒为 0，scrollWidth 恒 > 0 → 全是假阳性，直接跳过
    if (n.clientWidth === 0) continue
    if (n.offsetParent === null && getComputedStyle(n).position !== 'fixed') continue
    out.scanned += 1
    const m = metrics(n)
    if (!(m.overflowX > 1 || m.overflowY > 1 || m.outsideParent || m.ellipsis)) continue
    if (out.problems.length >= 40) break
    out.problems.push({ node: describe(n), m: m })
  }
  return out
}

// 提示消息缓冲（挂在页面里，跨动作保留）：提示类消息只活一两秒，事后去读页面永远是空的。
// ⚠ 为什么用 addInitScript 而不是壳的页面 preload：preload 跑在隔离世界，Playwright 的 evaluate
//   在主世界，两边看不见对方挂的变量。主世界脚本才能被 driver 直接读。
// 抓两类：① aria-live / role=status|alert 里的文字（标准做法）② 出现后几秒内被移除的浮层（toast 的典型形态）。
function TOAST_INSTALL() {
  if (window.__anzioToasts) return window.__anzioToasts.length
  const buf = []
  window.__anzioToasts = buf
  const MAX = 30
  const LIFE_MS = 8000
  const push = (kind, text, extra) => {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
    if (t === '') return
    const last = buf[buf.length - 1]
    if (last && last.text === t && Date.now() - last.t < 1200) return   // 同一句反复重渲染 ≠ 又弹了一次
    buf.push(Object.assign({ t: Date.now(), kind: kind, text: t.slice(0, 160) }, extra || {}))
    while (buf.length > MAX) buf.shift()
  }
  const liveHost = (el) => {
    try { return el && el.closest ? el.closest('[role=status],[role=alert],[aria-live]') : null } catch (e) { return null }
  }
  const textOf = (el) => { try { return String(el.innerText || el.textContent || '') } catch (e) { return '' } }
  // 浮层判据：固定/绝对定位 + 显式 z-index。没有这一步，列表重渲染会把整页节点都当成"瞬时消息"
  const isFloaty = (el) => {
    try {
      const cs = getComputedStyle(el)
      return (cs.position === 'fixed' || cs.position === 'absolute') && cs.zIndex !== 'auto'
        && cs.visibility !== 'hidden' && Number(cs.opacity) > 0
    } catch (e) { return false }
  }
  const watched = new WeakMap()
  const obs = new MutationObserver((records) => {
    let budget = 12
    for (const r of records) {
      if (r.type === 'characterData') {
        const host = liveHost(r.target.parentElement)
        if (host) push('live', textOf(host), { role: host.getAttribute('role') || host.getAttribute('aria-live') || '' })
        continue
      }
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || budget <= 0) continue
        budget -= 1
        const txt = textOf(n)
        if (liveHost(n)) { push('live', txt, { role: liveHost(n).getAttribute('role') || 'aria-live' }); continue }
        if (txt.length > 200) continue
        if (txt.trim() !== '' && isFloaty(n)) watched.set(n, { t: Date.now(), text: txt })
      }
      for (const n of r.removedNodes) {
        if (n.nodeType !== 1) continue
        const w = watched.get(n)
        if (!w) continue
        if (Date.now() - w.t <= LIFE_MS) push('transient', w.text, { livedMs: Date.now() - w.t })
      }
    }
  })
  try { obs.observe(document.documentElement || document, { subtree: true, childList: true, characterData: true }) } catch (e) { /* 文档还没就绪 */ }
  return 0
}

// 渲染安定：等到 DOM 连续 quiet 毫秒没有变更，或到 max。
// ⚠ 契约：安定只保证"这一次读到的是同一帧的一致快照"，**不保证**它反映了最新代码
//   （热更新失败时 DOM 也会安定在旧版本上）。别把"稳定"读成"最新"。
function STABLE_WAIT(opts) {
  const quiet = (opts && opts.quiet) || 150
  const max = (opts && opts.max) || 1200
  return new Promise((resolve) => {
    const started = Date.now()
    let last = Date.now()
    let obs = null
    try {
      obs = new MutationObserver(() => { last = Date.now() })
      obs.observe(document.documentElement || document, { subtree: true, childList: true, characterData: true, attributes: true })
    } catch (e) {
      resolve({ waited: 0, stable: true, error: String(e) })
      return
    }
    // 用定时器不用 rAF：后台标签页会暂停 rAF，read 就会一直挂着
    const tick = () => {
      const now = Date.now()
      if (now - last >= quiet || now - started >= max) {
        try { obs.disconnect() } catch (e) { /* 忽略 */ }
        resolve({ waited: now - started, stable: (now - last) >= quiet })
        return
      }
      setTimeout(tick, 40)
    }
    tick()
  })
}

// 页面自己的导航计时：driver 只对"它连上之后发生的导航"有事件可听，
// 用户先手动打开的标签、或壳先建好页面再让 agent 接入，那些页面就一条事件都没有。
// performance 的 navigation entry 是**页面自己记的**，不依赖我们什么时候连上去。
function NAV_PROBE() {
  try {
    const n = performance.getEntriesByType('navigation')[0]
    if (!n) return null
    return {
      ageMs: Math.max(0, Math.round(performance.now() - (n.startTime || 0))),
      responseStatus: typeof n.responseStatus === 'number' ? n.responseStatus : null,
      durationMs: Math.round(n.duration || 0),
    }
  } catch (e) { return null }
}

// 遮挡物：点不动时，看点击位置上最上层是谁。只看那一层的标签名等于没说（常常是透明遮罩），
// 所以要往上找第一个有 role / 可访问名称 / aria-modal 的祖先
function COVER_PROBE(pt) {
  const el = document.elementFromPoint(pt.x, pt.y)
  if (!el) return null
  const desc = (n) => {
    let text = ''
    try { text = String(n.innerText || n.textContent || '') } catch (e) { text = '' }
    return {
      tag: n.tagName.toLowerCase(),
      role: String(n.getAttribute('role') || ''),
      name: String(n.getAttribute('aria-label') || text.replace(/\s+/g, ' ').trim()).slice(0, 40),
      modal: n.getAttribute('aria-modal') === 'true',
      cls: (typeof n.className === 'string' ? n.className : '').slice(0, 60),
    }
  }
  const top = desc(el)
  let n = el
  let depth = 0
  let owner = null
  while (n && depth < 8) {
    const role = n.getAttribute ? n.getAttribute('role') : null
    const label = n.getAttribute ? n.getAttribute('aria-label') : null
    if (role || label || (n.getAttribute && n.getAttribute('aria-modal') === 'true')) { owner = desc(n); break }
    n = n.parentElement
    depth += 1
  }
  return { top: top, owner: owner }
}

// ── 快照压缩（2026-10-19 第三批）────────────────────────────────────────────
// 为什么要压：Playwright 的 ariaSnapshot 按 DOM 逐层展开，父子重复表达、一行表格十几个节点。
// 问题不在长度，在于"要在重复里找那一处不同"——漏读就等于得出错误结论。
// 压的是**结构壳子**（row / cell / generic 的层级），数据一个字不删：单元格文字按行保留，一行一条。
// ⚠ 只做文本变换，不动 Playwright 算出来的 role/name —— 名称计算是它的强项，自己算容易错。
function parseSnapshotNode(body) {
  // 末位冒号 = "它有子节点"，不属于 role（`- table:` / `- row "a b":`）；不剥掉这一位，
  // role 会变成 `table:`，整棵树都进不了各自的渲染分支（踩过）
  let s = String(body).replace(/\s+$/, '')
  if (/:$/.test(s)) s = s.slice(0, -1).replace(/\s+$/, '')
  // `text: 内容` / `/url: /x` 是"键: 值"；键后面没内容的不算（那多半是带子节点的 role 行）
  const kv = s.match(/^([^\s:"]+):\s*(.*)$/)
  if (kv && (kv[2] !== '' || kv[1][0] === '/')) return { role: 'value', key: kv[1], name: kv[2], children: [] }
  const m = s.match(/^([^\s"[]+)(?:\s+"([^"]*)")?\s*(.*)$/)
  if (!m) return { role: 'value', key: 'text', name: s, children: [] }
  return { role: m[1], name: m[2] || '', attrs: String(m[3] || '').trim(), children: [] }
}

function snapshotTree(text) {
  const root = { depth: -1, role: 'root', name: '', children: [] }
  const stack = [root]
  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(/^(\s*)-\s(.*)$/)
    if (!m) continue
    const depth = m[1].length
    const node = parseSnapshotNode(m[2])
    node.depth = depth
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop()
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return root.children
}

// 一棵子树里的全部文字（含自身名称），相邻重复只留一份 —— 这同时解决"父子重复表达同一内容"
function nodeText(node) {
  const parts = []
  const walk = (n) => {
    if (n.role === 'value') { if (n.key === 'text') parts.push(String(n.name || '')); return }
    if (n.name) parts.push(String(n.name))
    for (const c of n.children || []) walk(c)
  }
  walk(node)
  const out = []
  for (const p of parts) {
    const t = String(p).replace(/\s+/g, ' ').trim()
    if (t === '') continue
    if (out.length && out[out.length - 1] === t) continue
    out.push(t)
  }
  return out
}

function clipText(s, max) {
  const t = String(s == null ? '' : s)
  return t.length > max ? t.slice(0, max) + '…' : t
}

// 返回 { text, lines, sourceLines, rows, omitted, truncated }
function renderSnapshot(text, opts) {
  const o = opts || {}
  const rowStart = Math.max(0, Math.floor(Number(o.rowStart || 0)))
  const rowPage = (o.rowCount === undefined || o.rowCount === null || o.rowCount === '')
    ? 40 : Math.max(1, Math.floor(Number(o.rowCount)))
  const maxLines = Math.max(20, Math.floor(Number(o.maxLines || 400)))
  const lines = []
  let rows = 0
  let omitted = 0
  const push = (depth, s) => { if (s !== '') lines.push('  '.repeat(Math.min(depth, 8)) + s) }
  const cellText = (cell) => nodeText(cell).join(' | ')
  const ROW_CELLS = { cell: 1, gridcell: 1, columnheader: 1, rowheader: 1 }
  // ⚠ 行节点自带一个"单元格文字拼起来的可访问名称"（`row "zhangsan 凯升威 管理员"`），
  // 直接 nodeText 会把整行文字重复一遍。有单元格子节点时只用单元格，行自己的名字丢掉。
  const rowText = (row) => {
    const cells = (row.children || []).filter((c) => ROW_CELLS[c.role])
    return cells.length ? cells.map(cellText).join(' | ') : nodeText(row).join(' | ')
  }

  const renderNode = (node, depth) => {
    if (node.role === 'value') {
      push(depth, node.key === 'text' ? clipText(node.name, 200) : (node.key + ': ' + clipText(node.name, 120)))
      return
    }
    // 表格：行拍平成一行一条，并按 rowStart / rowCount 分页（大表靠这个看全）
    if (node.role === 'table' || node.role === 'grid' || node.role === 'treegrid') {
      const rowNodes = []
      const collect = (n) => { for (const c of n.children || []) { if (c.role === 'row') rowNodes.push(c); else collect(c) } }
      collect(node)
      if (rowNodes.length > 0) {
        const head = rowNodes.find((r) => (r.children || []).some((c) => c.role === 'columnheader' || c.role === 'rowheader')) || null
        const dataRows = rowNodes.filter((r) => r !== head)
        const cols = head
          ? (head.children || []).filter((c) => c.role === 'columnheader').map((c) => clipText(cellText(c), 24)).filter((x) => x !== '')
          : []
        rows += dataRows.length
        push(depth, node.role + (node.name ? '「' + clipText(node.name, 40) + '」' : '') + ' ' + dataRows.length + ' 行')
        if (cols.length) push(depth + 1, '列头：' + cols.join(' | '))
        const slice = dataRows.slice(rowStart, rowStart + rowPage)
        for (let i = 0; i < slice.length; i++) {
          push(depth + 1, '行' + (rowStart + i + 1) + '：' + clipText(rowText(slice[i]), 300))
        }
        const rest = dataRows.length - rowStart - slice.length
        if (rest > 0) {
          omitted += rest
          push(depth + 1, '…还有 ' + rest + ' 行没显示（用 rowStart=' + (rowStart + slice.length) + ' 接着读；'
            + '一页里有多张表时配 selector 只读这一张）')
        }
        return
      }
    }
    const name = node.name ? '「' + clipText(node.name, 60) + '」' : ''
    const attrs = node.attrs ? ' ' + node.attrs : ''
    // 父子重复同一句话（button "保存" 下面再挂一个 text: 保存）→ 只留一层
    const kids = node.children || []
    if (kids.length === 1 && kids[0].role === 'value' && kids[0].key === 'text'
      && String(kids[0].name).trim() === String(node.name).trim()) {
      push(depth, node.role + name + attrs)
      return
    }
    push(depth, node.role + name + attrs)
    for (const k of kids) renderNode(k, depth + 1)
  }

  for (const n of snapshotTree(text)) renderNode(n, 0)

  // 连续完全相同的内容合成一条并标数量（"×12"）
  const merged = []
  for (const line of lines) {
    const last = merged[merged.length - 1]
    if (last && last.line === line) { last.n += 1; continue }
    merged.push({ line: line, n: 1 })
  }
  const out = []
  for (const m of merged) {
    if (m.n === 1) out.push(m.line)
    else if (m.n === 2) { out.push(m.line); out.push(m.line) }
    else out.push(m.line + '　×' + m.n)
  }
  const totalLines = out.length
  const cap = Math.min(totalLines, maxLines)
  return {
    text: out.slice(0, cap).join('\n'),
    lines: cap,
    totalLines: totalLines,
    sourceLines: String(text || '') === '' ? 0 : String(text).split('\n').length,
    rows: rows,
    omitted: omitted,
    truncated: totalLines > maxLines,
  }
}

// ── 动作后的可见变化（2026-10-19）──────────────────────────────────────────
// "点成功了"只代表事件发出去了，业务可能因为校验失败根本没生效。以前模型只能再读一遍页面、自己比对，
// 大页面上看漏一行就得出错误结论。这里把"跟上次快照比，哪几行变了"直接算给它。
// ⚠ 差异只覆盖**快照里看得到的部分**（表格默认 40 行）：空差异不等于没生效，只说明"没在这儿表现出来"。
function lineKey(line) {
  const t = String(line).trim()
  const row = t.match(/^(行\d+)：/)
  if (row) return 'row:' + row[1]
  return 'line:' + t
}

function diffSnapshotLines(prev, next) {
  const index = (arr) => {
    const m = new Map()
    for (const line of arr || []) {
      const base = lineKey(line)
      let key = base
      let n = 0
      while (m.has(key)) { n += 1; key = base + '#' + n }
      m.set(key, line)
    }
    return m
  }
  const a = index(prev)
  const b = index(next)
  const added = []
  const removed = []
  const changed = []
  for (const [k, v] of b) {
    if (!a.has(k)) { added.push(String(v).trim()); continue }
    if (a.get(k) !== v) changed.push({ before: String(a.get(k)).trim(), after: String(v).trim() })
  }
  for (const [k, v] of a) if (!b.has(k)) removed.push(String(v).trim())
  return { added: added, removed: removed, changed: changed }
}

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
  // ── 每页的"事实台账"（2026-10-19 第二批）────────────────────────────────
  // 只记可核查的事实：这份页面是什么时候、带着什么响应头加载的，凭证指纹变没变，上次动作之后地址动没动。
  // 不替模型下"被踢出去了""代码没生效"这种结论 —— 那些判据我们给不全，猜错一次比不报更贵。
  const pageState = new Map()
  function stateOf(id) {
    const k = String(id)
    let s = pageState.get(k)
    if (!s) {
      s = {
        loadedAt: null, url: null, etag: null, lastModified: null, status: null,
        urlAtAction: null, identity: null, lastLines: null,
      }
      pageState.set(k, s)
    }
    return s
  }
  const toastInstalled = new WeakSet()
  // 记下"上一次动作之后地址是什么"：下次读页面时若地址变了，把 A→B 这个事实说出来
  // （不替模型判断"是不是被踢去登录页了"——正常跳转也会变地址，判据我们给不全）
  function noteActionUrl(id, page) {
    try { stateOf(id).urlAtAction = page.url() } catch { /* 忽略 */ }
  }

  function wire(page, id) {
    if (wired.has(page)) return
    wired.add(page)
    try {
      // 提示消息缓冲要在**每个新文档**上都装：导航后页面对象换了，旧缓冲随文档消失（这是对的）
      page.addInitScript(TOAST_INSTALL)
      page.on('framenavigated', (frame) => {
        try {
          if (frame !== page.mainFrame()) return
          const s = stateOf(id)
          s.loadedAt = Date.now()
          s.url = frame.url()
          // 换了文档，旧快照基线作废（否则"变化"会把整页当新增）
          s.lastLines = null
        } catch { /* 页面正在销毁 */ }
      })
      page.on('response', (res) => {
        try {
          if (!res.request().isNavigationRequest()) return
          if (res.frame() !== page.mainFrame()) return
          const h = res.headers()
          const s = stateOf(id)
          s.etag = h['etag'] || null
          s.lastModified = h['last-modified'] || null
          s.status = res.status()
        } catch { /* 忽略 */ }
      })
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
      if (id) {
        out.set(id, p)
        wire(p, id)
        // 已经加载完的文档不会再跑 addInitScript → 当场补装一次（不等它，refreshMap 是热路径）
        if (!toastInstalled.has(p)) {
          toastInstalled.add(p)
          p.evaluate(TOAST_INSTALL).catch(() => { /* 页面可能正在跳转 */ })
        }
      }
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
    // 报错必须说清"你传的是什么、现在有哪些可用的"（2026-10-16 改）：
    // 旧文案只猜"可能已关闭，或视图还没建好"，把调用方引去查视图生命周期，而真因是它自己传错了名字；
    // 名单摆出来，错在哪一眼可见，也能直接拿正确的 id 接着干活。
    const available = Array.from(m.keys())
    const list = available.length
      ? '\n当前打开的页面 id：\n' + available.map((k) => '  · ' + k).join('\n')
      : '\n当前一个内置浏览器页面都没开，先用 browser_open_page 开一个。'
    throw new Error('找不到这个浏览器页面：你传的是「' + want + '」' + list)
  }

  async function safeTitle(page) {
    try { return await page.title() } catch { return '' }
  }
  // 动作后等网络安静：上限 5s，超了不算失败（照抄 VSCode 的数值）
  async function settle(page) {
    try { await page.waitForLoadState('networkidle', { timeout: T_SETTLE }) } catch { /* 一直在请求就算了 */ }
  }

  // ── 登录态指纹（2026-10-19）──────────────────────────────────────────────
  // 内置浏览器的所有标签共用一个持久分区 ⇒ 在 A 标签换了账号，B 标签的界面上看不出来，凭证却已经变了。
  // 所以这里只做**一致性检查**：动作之前算一次当前凭证的短哈希，与上次记录比对，变了就明说
  // "凭证已变（登录/退出/轮换都可能），别的标签上的结论不一定还成立"。
  // ⚠ 不下"账号变了"这种结论：轮换也会变，指纹分辨不了"该变"和"不该变"。
  // ⚠ 只留 8 位哈希，cookie 值本身不出页面、不进日志。
  async function fingerprint(page) {
    try {
      const cookies = await page.context().cookies(page.url())
      if (!cookies.length) return { hash: 'none', count: 0 }
      const src = cookies.map((c) => c.name + '=' + c.value).sort().join('|')
      return { hash: crypto.createHash('sha1').update(src).digest('hex').slice(0, 8), count: cookies.length }
    } catch { return { hash: null, count: 0 } }
  }
  // 动作之前调用：返回 {hash, count, changed}，并把最新指纹记到台账里
  async function noteIdentity(page, id) {
    const fp = await fingerprint(page)
    const s = stateOf(id)
    const prev = s.identity
    s.identity = fp
    return { hash: fp.hash, count: fp.count, changed: !!(prev && prev.hash && fp.hash && prev.hash !== fp.hash) }
  }

  // ── 动作后的可见变化 ──────────────────────────────────────────────────────
  const CHANGE_CAP = 6
  async function snapshotLines(page) {
    const full = String(await page.locator('body').first().ariaSnapshot({ timeout: T_ACT }) || '')
    const snap = renderSnapshot(full, {})
    return snap.text === '' ? [] : snap.text.split('\n')
  }
  // 返回 { counts, added, removed, changed, truncated }；没有基线（刚导航）时返回 null，绝不编一个"没变化"
  async function observeChange(page, id) {
    const st = stateOf(id)
    try {
      // 动作引起的渲染是异步的：先等 DOM 静默一小会儿，否则会把"还没渲染完"判成"没变化"
      await page.evaluate(STABLE_WAIT, { quiet: 120, max: 600 })
      const next = await snapshotLines(page)
      const prev = st.lastLines
      st.lastLines = next
      if (!prev) return null
      const d = diffSnapshotLines(prev, next)
      return {
        counts: { added: d.added.length, removed: d.removed.length, changed: d.changed.length },
        added: d.added.slice(0, CHANGE_CAP),
        removed: d.removed.slice(0, CHANGE_CAP),
        changed: d.changed.slice(0, CHANGE_CAP),
        truncated: d.added.length > CHANGE_CAP || d.removed.length > CHANGE_CAP || d.changed.length > CHANGE_CAP,
      }
    } catch { return null }
  }

  // ── 动作失败翻译（2026-10-19）────────────────────────────────────────────
  // Playwright 的原话只说现象（"<div> intercepts pointer events"），模型得自己推理那是谁、怎么关。
  // 这里补两件事：遮挡物是谁（往上找有名字的祖先）、下一步做什么。
  const COVER_RX = /intercepts pointer events|not visible|not stable|outside of the viewport|outside viewport/i
  async function translateActionError(page, target, err, verb) {
    const msg = String((err && err.message) || err)
    if (!COVER_RX.test(msg)) return err
    const name = labelOf(target)
    const why = /intercepts pointer events/i.test(msg) ? '被别的元素盖住'
      : /outside of the viewport|outside viewport/i.test(msg) ? '在可视区外'
        : '现在不可见或正在动'
    let cover = null
    try {
      const box = await target.loc.boundingBox({ timeout: 1000 })
      if (box) cover = await page.evaluate(COVER_PROBE, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
    } catch { cover = null }
    const who = (cover && cover.owner) || (cover && cover.top)
    const whoText = who
      ? ((who.role || who.tag) + (who.name ? '「' + who.name + '」' : '') + (who.modal ? '（模态弹窗）' : ''))
      : ''
    const err2 = new Error(verb + '没有发生：目标 ' + name + ' ' + why + '。'
      + (whoText ? '\n点击位置上最上层是 ' + whoText + '。' : '')
      + '\n下一步：先把它关掉（找名称含 关闭 / 取消 / 确定 的按钮点一下），或用 browser_read_page 看清现在弹了什么；'
      + '确认就是要隔着它点，再传 force。')
    err2.cause = err
    return err2
  }

  // ── 选择器解析层（2026-10-19）──────────────────────────────────────────────
  // 为什么要有这一层：以前每个动作都 `.first()`，多命中时静默取第一个 —— "以为点了 A，实际点了 A2"
  // 这类事故不留任何痕迹（真实报障）。现在固定成三级：
  //   ① text= 精确匹配优先；精确 0 个时**不自动降级**成子串（降级要显式传 match=contains）
  //   ② 候选先按可见性收窄：唯一可见的直接执行，多个可见的报"有歧义"，全不可见的逐个说明原因
  //   ③ 执行成功也把"命中几个、用了哪个"回给调用方
  // ⚠ 候选解析必须走 Playwright 的 locator API（count / nth / evaluate），**不许**自己
  //   document.querySelector：text= / role= / >> 这些引擎的语义只有 Playwright 认，自己解析会变成
  //   "工具认、动作层不认"的两套规则。
  const SEL_HELP = '支持：CSS（#id / .cls / [name=x]）、文本（text=登录，默认精确）、'
    + 'role=（role=button[name="确定"]）；不支持坐标。'

  function isTextSelector(sel) { return /^text=/i.test(String(sel).trim()) }
  function stripQuotes(s) {
    const t = String(s)
    if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) return t.slice(1, -1)
    return t
  }
  function locate(page, sel, match) {
    const raw = String(sel).trim()
    if (raw === '') throw new Error('selector 是空的。' + SEL_HELP)
    if (!isTextSelector(raw)) return page.locator(raw)
    const inner = raw.slice('text='.length).trim()
    if (inner === '') throw new Error('text= 后面没有写内容。' + SEL_HELP)
    // 正则写法（text=/已保存/）交回 Playwright 自己解释，别在这里猜
    if (inner[0] === '/') return page.locator(raw)
    return page.getByText(stripQuotes(inner), { exact: match !== 'contains' })
  }
  function selectorError(sel, e) {
    const msg = String((e && e.message) || e)
    if (/Unknown engine|Unexpected token|not a valid selector|Failed to parse|InvalidSelector|Unsupported token/i.test(msg)) {
      return new Error('选择器语法不支持：「' + sel + '」。' + SEL_HELP + '\n（引擎原话：' + msg.split('\n')[0] + '）')
    }
    return e
  }
  function describeCandidate(c) {
    const bits = [c.tag]
    if (c.id) bits.push('#' + c.id)
    if (c.cls) bits.push('.' + c.cls.trim().split(/\s+/)[0])
    const label = c.name ? '「' + c.name + '」' : ''
    const state = c.visible ? (c.disabled ? '（禁用）' : '（可见）') : '（不可见：' + (c.hiddenBy || '原因不明') + '）'
    return bits.join('') + label + state
  }
  function candidateList(set, max) {
    return set.candidates.slice(0, max || MAX_CANDIDATES).map((c) => '  ' + c.index + ') ' + describeCandidate(c)).join('\n')
  }
  function labelOf(target) {
    if (!target) return ''
    const c = (target.candidates || []).find((x) => x.index === target.index)
    return c ? describeCandidate(c) : ('#' + target.index)
  }

  async function inspectSet(page, sel, match) {
    let loc = null
    try { loc = locate(page, sel, match) } catch (e) { throw selectorError(sel, e) }
    let total = 0
    try { total = await loc.count() } catch (e) { throw selectorError(sel, e) }
    const scan = Math.min(total, MAX_SCAN)
    const candidates = []
    const visible = []
    for (let i = 0; i < scan; i++) {
      let info = null
      try { info = await loc.nth(i).evaluate(CANDIDATE_PROBE) } catch { info = { tag: '?', name: '', visible: true, hiddenBy: '', disabled: false, role: '', id: '', cls: '' } }
      if (i < MAX_CANDIDATES) candidates.push(Object.assign({ index: i }, info))
      if (info.visible) visible.push(i)
    }
    return { loc, total, match, candidates, visible }
  }

  // 严格解析（写动作 / 点击 / 拖拽用它）：拿不到**唯一**目标就报错，绝不替调用方挑
  async function resolveTarget(page, sel, options) {
    const o = options || {}
    const wantContains = o.match === 'contains'
    const set = await inspectSet(page, sel, wantContains ? 'contains' : 'exact')
    if (!wantContains && set.total === 0) {
      // 精确没中：**不自动降级**，把子串候选摆出来让调用方决定（静默降级正是误点的来源）
      const loose = await inspectSet(page, sel, 'contains')
      if (loose.total > 0) {
        throw new Error('没有与「' + String(sel).replace(/^text=/i, '') + '」精确相等的元素，动作没有执行。'
          + '子串命中的候选：\n' + candidateList(loose, 5)
          + '\n要按子串继续，请显式传 match=contains（可再用 index 指定是哪一个）。')
      }
      throw new Error('没有匹配到元素：「' + sel + '」，当前地址 ' + page.url() + '。'
        + '可能这个页面上没有它，也可能还没渲染完 —— 要等就先用 browser_wait_for 等元素出现，别靠反复点。')
    }
    if (set.total === 0) {
      throw new Error('没有匹配到元素：「' + sel + '」（按子串匹配），当前地址 ' + page.url() + '。')
    }
    if (typeof o.index === 'number' && isFinite(o.index)) {
      if (o.index < 0 || o.index >= set.total) {
        throw new Error('index 越界：给了 ' + o.index + '，实际只命中 ' + set.total + ' 个。')
      }
      const info = set.candidates.find((c) => c.index === o.index)
      // 已经知道它不可见就别让 Playwright 干等 10 秒超时：立刻说清原因 + 下一步
      if (info && !info.visible && !o.force) {
        throw new Error('第 ' + o.index + ' 个候选不可见（' + (info.hiddenBy || '原因不明') + '），没有执行。'
          + '确认要操作隐藏元素就传 force；否则用 index 换一个可见的，或先 browser_wait_for 等它出现。')
      }
      return { loc: set.loc.nth(o.index), index: o.index, total: set.total, visible: set.visible, candidates: set.candidates, match: set.match, forced: !!o.force }
    }
    if (set.visible.length === 1) {
      const i = set.visible[0]
      return { loc: set.loc.nth(i), index: i, total: set.total, visible: set.visible, candidates: set.candidates, match: set.match }
    }
    if (set.visible.length > 1) {
      throw new Error('「' + sel + '」命中了 ' + set.total + ' 个，其中 ' + set.visible.length + ' 个可见，动作没有执行（工具不替你猜是哪一个）。'
        + '候选：\n' + candidateList(set)
        + '\n传 index 指定其中一个；index 只对本次返回有效。')
    }
    // 全不可见：这是"弹窗关掉后 DOM 还在"最常见的形态，必须把每条原因说出来
    if (o.force) {
      return { loc: set.loc.nth(0), index: 0, total: set.total, visible: set.visible, candidates: set.candidates, match: set.match, forced: true }
    }
    throw new Error('「' + sel + '」匹配了 ' + set.total + ' 个，全部不可见，动作没有执行。'
      + '候选：\n' + candidateList(set)
      + (set.total > MAX_SCAN ? '\n（命中数超过 ' + MAX_SCAN + '，只扫了前 ' + MAX_SCAN + ' 个 —— 先把选择器收窄）' : '')
      + '\n这些通常是关掉的弹窗留下的副本。要等它真的出现再说（browser_wait_for），确认点隐藏元素是你要的才传 force。')
  }

  // 宽松解析（读页面 / 截图 / 滚动用它）：允许多命中，取第一个可见的，但把命中数带回去
  async function resolveSoft(page, sel) {
    const set = await inspectSet(page, sel, 'exact')
    if (set.total === 0) {
      const loose = await inspectSet(page, sel, 'contains')
      if (loose.total === 0) {
        throw new Error('没有匹配到元素：「' + sel + '」，当前地址 ' + page.url() + '。')
      }
      const i = loose.visible.length ? loose.visible[0] : 0
      return { loc: loose.loc.nth(i), index: i, total: loose.total, visible: loose.visible, note: '无精确匹配，用的是子串命中的第 ' + i + ' 个' }
    }
    const i = set.visible.length ? set.visible[0] : 0
    return { loc: set.loc.nth(i), index: i, total: set.total, visible: set.visible }
  }

  // ── 断言实现 ──────────────────────────────────────────────────────────────
  const ASSERT_KINDS = ['text', 'value', 'visible', 'hidden', 'enabled', 'disabled', 'count', 'attr', 'url', 'title']

  function wildcardMatch(pattern, actual) {
    const p = String(pattern)
    if (p.indexOf('*') < 0) return p === String(actual)
    const re = new RegExp('^' + p.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
    return re.test(String(actual))
  }

  async function assertOnce(page, kind, o) {
    const base = { kind: kind, url: page.url() }
    const expected = o.equals !== undefined ? o.equals : (o.contains !== undefined ? o.contains : o.value)
    if (kind === 'url') {
      const want = String(o.equals !== undefined ? o.equals : (o.url !== undefined ? o.url : expected))
      const ok = wildcardMatch(want, base.url)
      return Object.assign({ state: ok ? 'pass' : 'mismatch', expected: want, actual: base.url }, base)
    }
    if (kind === 'title') {
      const t = await safeTitle(page)
      const want = String(expected)
      return Object.assign({ state: wildcardMatch(want, t) ? 'pass' : 'mismatch', expected: want, actual: t }, base)
    }
    if (!o.selector) throw new Error('断言缺 selector（url / title 断言除外）')
    const set = await inspectSet(page, o.selector, o.match === 'contains' ? 'contains' : 'exact')
    if (kind === 'count') {
      const want = Number(o.equals !== undefined ? o.equals : o.count)
      if (!isFinite(want)) throw new Error('count 断言要给 equals（期望数量）')
      return Object.assign({ state: set.total === want ? 'pass' : 'mismatch', expected: want, actual: set.total, total: set.total }, base)
    }
    if (set.total === 0) return Object.assign({ state: 'not-found', expected: expected, actual: null, total: 0 }, base)
    // 多命中时先按可见性收窄（同动作那条规则）：唯一可见的那个就是人看到的那个。
    // "弹窗关掉后 DOM 还在"会让每一条断言都变成有歧义，那等于把这个工具废掉。
    const one = set.total === 1
      ? set.loc.nth(0)
      : (set.visible.length === 1 ? set.loc.nth(set.visible[0]) : null)
    if (one === null) {
      return Object.assign({ state: 'ambiguous', expected: expected, actual: null, total: set.total, candidates: set.candidates }, base)
    }
    const want = expected === undefined ? '' : String(expected)
    if (kind === 'visible' || kind === 'hidden') {
      const vis = await one.isVisible()
      const ok = kind === 'visible' ? vis : !vis
      return Object.assign({ state: ok ? 'pass' : 'mismatch', expected: kind, actual: vis ? '可见' : '不可见' }, base)
    }
    if (kind === 'enabled' || kind === 'disabled') {
      const on = await one.isEnabled()
      const ok = kind === 'enabled' ? on : !on
      return Object.assign({ state: ok ? 'pass' : 'mismatch', expected: kind, actual: on ? '可用' : '禁用' }, base)
    }
    if (kind === 'text') {
      const actual = String(await one.innerText() || '').replace(/\s+/g, ' ').trim()
      const mode = o.contains !== undefined ? 'contains' : 'equals'
      const ok = mode === 'contains' ? actual.indexOf(String(o.contains)) >= 0 : actual === want
      return Object.assign({ state: ok ? 'pass' : 'mismatch', expected: want, actual: actual.slice(0, 200), mode: mode }, base)
    }
    if (kind === 'value') {
      // 值比对在页面里做：密码框的实际值**不允许**回到这条链路上来（回读会被工具结果带进日志）
      const r = await one.evaluate((el, a) => {
        const tag = el.tagName.toLowerCase()
        const auto = String(el.getAttribute('autocomplete') || '')
        const ident = String(el.getAttribute('name') || '') + ' ' + String(el.id || '')
        const sensitive = (tag === 'input' && String(el.type) === 'password')
          || /one-time-code|cc-(number|csc|exp)/i.test(auto)
          || /pass(word)?|secret|token|otp|one-?time|验证码|密码/i.test(ident)
        let v = ''
        if (tag === 'input' || tag === 'textarea' || tag === 'select') v = String(el.value || '')
        else if (el.isContentEditable) v = String(el.innerText || '')
        const hit = a.mode === 'contains' ? v.indexOf(String(a.want)) >= 0 : v === String(a.want)
        return { sensitive: sensitive, length: v.length, match: hit, shown: sensitive ? '' : v.slice(0, 80) }
      }, { want: want, mode: o.contains !== undefined ? 'contains' : 'equals' })
      return Object.assign({
        state: r.match ? 'pass' : 'mismatch',
        expected: want, sensitive: r.sensitive, valueLength: r.length,
        actual: r.sensitive ? ('已打码（' + r.length + ' 个字符）') : r.shown,
      }, base)
    }
    if (kind === 'attr') {
      const name = String(o.attr || '')
      if (name === '') throw new Error('attr 断言要给 attr（属性名）')
      const actual = await one.getAttribute(name)
      const ok = o.contains !== undefined ? String(actual || '').indexOf(String(o.contains)) >= 0 : String(actual) === want
      return Object.assign({ state: ok ? 'pass' : 'mismatch', expected: want, actual: actual }, base)
    }
    throw new Error('不认识的断言类型：' + kind + '（支持 ' + ASSERT_KINDS.join(' / ') + '）')
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
  function recordText(text, ascii, sensitive) {
    if (!onAction) return
    const s = String(text == null ? '' : text)
    try {
      // ⚠ 敏感字段（密码 / 验证码 / 卡号）**绝不**把字符发给界面：键盘映射面板会逐字显示，
      //   等于把密码原样打在屏幕上（2026-10-19 核对代码确认这条路径确实会泄露）。
      //   只报"打了几个字符"，让幻影还有得演，但看不见内容。
      if (sensitive) { onAction({ kind: 'text', text: '', masked: true, length: s.length, at: Date.now() }); return }
      if (!ascii) { onAction({ kind: 'text', text: s.slice(0, 120), at: Date.now() }); return }
      for (const ch of s) recordKey(ch, 'press')
    } catch { /* 忽略 */ }
  }
  // 把指针挪到某个元素上，**返回该点的视口坐标**（幻影关着 / 取不到位置 → null，调用方据此跳过演的部分）。
  // 坐标要返回出去：按压指令得把坐标一起带上（见 press 的用法），否则页面只能靠自己记的指针位置画波纹
  // ⚠ 参数是**已解析好的 locator**：不能再自己 locator(sel).first()，那等于绕过候选检查又猜一次
  async function pointAt(id, loc) {
    if (!phantom || !phantom.enabled()) return null
    try {
      const box = await loc.boundingBox({ timeout: 4000 })
      if (!box) return null
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      const ms = phantom.send(String(id), { type: 'move', x: at.x, y: at.y })
      if (ms > 0) await sleep(ms)
      return at
    } catch { return null }        // 取不到位置就算了，绝不影响真实动作
  }

  // ── 动作实现（全部走 Playwright 的"类人"接口：自动等待、自动滚动、真实输入事件）──
  const impl = {
    async status() { return { connected: !!browser, port: Number(port) } },

    async list() {
      const m = await refreshMap()
      const out = []
      // 所有标签共用一个持久分区 ⇒ 凭证指纹一份就够，顺带把"它们本来就是一家的"摆在明面上
      let shared = null
      const first = m.values().next()
      if (!first.done) shared = await fingerprint(first.value)
      for (const [id, page] of m.entries()) {
        const s = stateOf(id)
        out.push({
          id: id, url: page.url(), title: await safeTitle(page),
          identity: shared ? shared.hash : null,
          loadedAt: s.loadedAt ? new Date(s.loadedAt).toISOString() : null,
        })
      }
      return out
    },

    async read(id, options) {
      const page = await pageFor(id)
      const o = options || {}
      const st = stateOf(id)
      const out = {
        id: String(id), url: page.url(), title: await safeTitle(page),
        errors: (events.get(String(id)) || []).slice(-12),
      }
      // ① 先等渲染安定，再抓快照：否则"空快照"分不清是没内容还是没渲染完。
      //    ⚠ 安定只保证这次读到的是同一帧，不保证是最新代码（见 STABLE_WAIT 的契约）
      if (o.stable !== false) {
        try { out.stability = await page.evaluate(STABLE_WAIT, { quiet: 150, max: Number(o.stableMax || 1200) }) } catch { out.stability = null }
      }
      // ② 提示类消息只在缓冲里（页面上早就没了）
      try { out.toasts = await page.evaluate('(window.__anzioToasts || []).slice(-15)') } catch { out.toasts = [] }
      // ③ 事实台账：这份页面什么时候加载的、带什么响应头、上次动作之后地址动没动
      //    driver 没赶上那次导航（页面早就开着）就退回页面自己的 navigation timing，别报"不知道"
      const nav = await page.evaluate(NAV_PROBE).catch(() => null)
      out.loadedAt = st.loadedAt ? new Date(st.loadedAt).toISOString() : null
      out.loadedAgoMs = st.loadedAt ? Date.now() - st.loadedAt : (nav ? nav.ageMs : null)
      out.etag = st.etag || null
      out.httpStatus = st.status !== null ? st.status : (nav ? nav.responseStatus : null)
      out.pageAgeMs = nav ? nav.ageMs : null
      out.urlChangedSinceAction = st.urlAtAction && st.urlAtAction !== page.url()
        ? { from: st.urlAtAction, to: page.url() }
        : null
      const fp = await fingerprint(page)
      out.identity = fp.hash
      out.identityChanged = !!(st.identity && st.identity.hash && fp.hash && st.identity.hash !== fp.hash)
      st.identity = fp
      if (o.aria !== false) {
        try {
          // 无障碍树快照（VSCode 的"读页面"同样用它，比抓 HTML 干净得多、也不怕超长）
          const scope = o.selector ? await resolveSoft(page, o.selector) : null
          const loc = scope ? scope.loc : page.locator('body').first()
          const full = String(await loc.ariaSnapshot({ timeout: T_ACT }) || '')
          out.ariaChars = full.length
          out.ariaLines = full === '' ? 0 : full.split('\n').length
          if (o.raw) {
            // 兜底：怀疑压缩丢东西时用（默认不给，否则没人用压缩后的形状）
            out.aria = full.slice(0, ARIA_DRIVER_MAX)
            out.ariaTruncated = full.length > ARIA_DRIVER_MAX
            out.snapshot = { mode: 'raw', lines: out.ariaLines, sourceLines: out.ariaLines }
          } else {
            const snap = renderSnapshot(full, { rowStart: o.rowStart, rowCount: o.rowCount, maxLines: o.maxLines })
            out.aria = snap.text
            out.ariaTruncated = snap.truncated
            out.snapshot = {
              mode: 'compact', lines: snap.lines, totalLines: snap.totalLines,
              sourceLines: snap.sourceLines, rows: snap.rows, omittedRows: snap.omitted,
            }
          }
          if (scope) out.scope = { selector: o.selector, total: scope.total, index: scope.index, note: scope.note || '' }
        } catch (e) { out.aria = null; out.ariaError = String((e && e.message) || e) }
      }
      // 读页面同时把基线刷新：这样下一次动作的"变化"是从这次读到的样子开始算的
      if (out.snapshot && out.snapshot.mode === 'compact' && typeof out.aria === 'string') {
        st.lastLines = out.aria === '' ? [] : out.aria.split('\n')
      }
      return out
    },

    async screenshot(id, options) {
      const page = await pageFor(id)
      const o = options || {}
      const buf = o.selector
        ? await (await resolveSoft(page, o.selector)).loc.screenshot({ timeout: T_ACT })
        : await page.screenshot({ timeout: T_ACT, fullPage: !!o.fullPage })
      return { id: String(id), bytes: buf.length, base64: buf.toString('base64') }
    },

    async navigate(id, url) {
      const page = await pageFor(id)
      const resp = await page.goto(String(url), { timeout: T_NAV, waitUntil: 'domcontentloaded' })
      await settle(page)
      noteActionUrl(id, page)
      return { id: String(id), url: page.url(), title: await safeTitle(page), status: resp ? resp.status() : null }
    },
    async back(id) {
      const page = await pageFor(id)
      const r = await page.goBack({ timeout: T_NAV, waitUntil: 'domcontentloaded' })
      await settle(page)
      noteActionUrl(id, page)
      return { id: String(id), url: page.url(), moved: !!r }
    },
    async forward(id) {
      const page = await pageFor(id)
      const r = await page.goForward({ timeout: T_NAV, waitUntil: 'domcontentloaded' })
      await settle(page)
      noteActionUrl(id, page)
      return { id: String(id), url: page.url(), moved: !!r }
    },
    async reload(id) {
      const page = await pageFor(id)
      await page.reload({ timeout: T_NAV, waitUntil: 'domcontentloaded' })
      await settle(page)
      noteActionUrl(id, page)
      return { id: String(id), url: page.url() }
    },

    async click(id, sel, options) {
      const page = await pageFor(id)
      const o = options || {}
      const target = await resolveTarget(page, sel, o)             // 多个候选在这里就报错，绝不自选
      // 凭证指纹要在**动手之前**比：跨标签串身份往往就发生在点击那一刻
      const identity = await noteIdentity(page, id)
      // 幻影：先把指针挪过去（没人看时是 null）
      const at = await pointAt(id, target.loc)
      // 按压**带上坐标**：点击波纹画在哪儿由驱动层实测的坐标说了算，不指望页面自己记的指针位置
      if (at) phantom.send(String(id), { type: 'press', button: o.button || 'left', x: at.x, y: at.y })
      if (at) await sleep(90)                                    // 按下→松开之间留一瞬，人手就是这样
      try {
        await target.loc.click({
          timeout: o.timeout || T_ACT, button: o.button || 'left',
          clickCount: o.clickCount || 1, force: !!(o.force || target.forced),
        })
      } catch (e) {
        throw await translateActionError(page, target, e, '点击')
      } finally {
        // 失败也要把按压状态收掉，否则页面上的指针会一直显示"按着"
        if (at) phantom.send(String(id), { type: 'release' })
      }
      await settle(page)
      noteActionUrl(id, page)
      const change = await observeChange(page, id)
      return {
        id: String(id), clicked: labelOf(target), index: target.index,
        matched: target.total, visibleCount: target.visible.length, forced: !!target.forced, identity, change,
      }
    },
    async hover(id, sel, options) {
      const page = await pageFor(id)
      const target = await resolveTarget(page, sel, options || {})
      await pointAt(id, target.loc)
      try {
        await target.loc.hover({ timeout: T_ACT, force: !!(options && options.force) || !!target.forced })
      } catch (e) { throw await translateActionError(page, target, e, '悬停') }
      return { id: String(id), hovered: labelOf(target), index: target.index, matched: target.total, visibleCount: target.visible.length }
    },
    async drag(id, from, to, options) {
      const page = await pageFor(id)
      const o = options || {}
      const a = await resolveTarget(page, from, o)
      const b = await resolveTarget(page, to, o)
      if (phantom && phantom.enabled()) {
        try {
          const ab = await a.loc.boundingBox({ timeout: 4000 })
          const bb = await b.loc.boundingBox({ timeout: 4000 })
          if (ab && bb) {
            const ms = phantom.send(String(id), {
              type: 'drag',
              from: { x: ab.x + ab.width / 2, y: ab.y + ab.height / 2 },
              to: { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 },
            })
            if (ms > 0) await sleep(ms + 120)
          }
        } catch { /* 拿不到位置就只干活不演 */ }
      }
      // ⚠ dragAndDrop 只吃选择器，会绕过刚做完的候选检查 → 自己走"悬停 + 按下 + 移动 + 松开"
      const identity = await noteIdentity(page, id)
      try {
        await a.loc.hover({ timeout: T_ACT })
        await page.mouse.down()
        const bb2 = await b.loc.boundingBox({ timeout: T_ACT })
        if (bb2) await page.mouse.move(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2, { steps: 12 })
        await page.mouse.up()
      } catch (e) {
        try { await page.mouse.up() } catch { /* 可能本来就没按下 */ }
        throw await translateActionError(page, a, e, '拖拽')
      }
      await settle(page)
      noteActionUrl(id, page)
      const change = await observeChange(page, id)
      return { id: String(id), dragged: labelOf(a) + ' → ' + labelOf(b), identity: identity, change: change }
    },
    async press(id, key, sel, options) {
      const page = await pageFor(id)
      const combo = String(key)
      // 组合键按"按下顺序 + 逆序抬起"记账（Control+A → Ctrl↓ A↓ A↑ Ctrl↑），
      // 键盘面板靠这个显示"哪些修饰键正被按住"
      const parts = combo.split('+').filter(function (x) { return x !== '' })
      let target = null
      let identity = null
      if (sel) {
        target = await resolveTarget(page, sel, options || {})
        identity = await noteIdentity(page, id)
      }
      for (let i = 0; i < parts.length; i++) recordKey(parts[i], 'down')
      try {
        if (target) await target.loc.press(combo, { timeout: T_ACT, force: !!(options && options.force) || !!target.forced })
        else await page.keyboard.press(combo)
      } catch (e) {
        for (let i = parts.length - 1; i >= 0; i--) recordKey(parts[i], 'up')
        throw target ? await translateActionError(page, target, e, '按键') : e
      }
      for (let i = parts.length - 1; i >= 0; i--) recordKey(parts[i], 'up')
      await settle(page)
      noteActionUrl(id, page)
      const change = await observeChange(page, id)
      return { id: String(id), pressed: combo, target: target ? labelOf(target) : '', identity: identity, change: change }
    },
    async type(id, text, options) {
      const page = await pageFor(id)
      const o = options || {}
      let target = null
      if (o.selector) {
        target = await resolveTarget(page, o.selector, o)
      } else {
        // 没给 selector = 往当前焦点里写。焦点元素也走同一套探针：密码判断与回读都靠它
        const focused = page.locator(':focus')
        if (await focused.count() === 1) target = { loc: focused, index: 0, total: 1, visible: [0], candidates: [] }
      }
      // 敏感字段必须**动手之前**认出来：记账在动作之前发生，晚一步就等于已经把密码发出去了
      const before = target ? await target.loc.evaluate(VALUE_PROBE).catch(() => null) : null
      const sensitive = before ? !!before.sensitive : false
      const identity = await noteIdentity(page, id)
      if (target) {
        // 先点一下聚焦（幻影还开着就让指针先走过去，人看得见"它点进了哪个输入框"）
        const at = await pointAt(id, target.loc)
        if (at) phantom.send(String(id), { type: 'press', x: at.x, y: at.y })
        try {
          await target.loc.click({ timeout: T_ACT, force: !!target.forced })
        } catch (e) {
          if (at) phantom.send(String(id), { type: 'release' })
          throw await translateActionError(page, target, e, '写入前的聚焦点击')
        }
        if (at) phantom.send(String(id), { type: 'release' })
      }
      const s = String(text == null ? '' : text)
      const ascii = /^[\x20-\x7E]*$/.test(s)
      // 覆盖是默认：往已有值的框里写，旧内容不清理就会变成新旧拼接（真实报障，界面上还不显眼）
      let cleared = false
      const overwrite = o.mode !== 'append'
      if (overwrite && target) {
        try { await target.loc.fill(''); cleared = true } catch {
          // fill 动不了的（非表单元素）→ 全选再删
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
          await page.keyboard.press('Delete')
          cleared = true
        }
      }
      // 记账要在**动作之前**：键流的意义是"人正看着它敲"，滞后了就成回放了
      recordText(s, ascii, sensitive)
      // 键盘敲得出来的（ASCII）逐键派发：键帽真的依次按下、页面补全/按键响应也真的触发；
      // 中文这类敲不出来的默认整段写入（设计定稿 §5.3）。perChar 才会逐字 insertText ——
      // ⚠ 逐字只多触发 input，**没有输入法组合过程**（composition 事件），依赖拼音联想的组件照样不响应，
      //   而且每字一次 input 会放大防抖请求，所以默认不开。
      const perChar = !!o.perChar
      const gap = Math.max(0, Number(o.interval || 60))
      if (ascii) await page.keyboard.type(s, { delay: Number(o.interval || 0) })
      else if (perChar) { for (const ch of s) { await page.keyboard.insertText(ch); if (gap > 0) await sleep(gap) } }
      else await page.keyboard.insertText(s)
      if (o.submit && ascii) { recordKey('Enter', 'down'); await page.keyboard.press('Enter'); recordKey('Enter', 'up') }
      await settle(page)
      noteActionUrl(id, page)
      const after = target ? await target.loc.evaluate(VALUE_PROBE).catch(() => null) : null
      const change = await observeChange(page, id)
      return {
        id: String(id), typed: s.length, change: change,
        mode: ascii ? 'per-key' : (perChar ? 'insert-per-char' : 'insert'),
        sensitive: sensitive, overwrite: overwrite, cleared: cleared,
        target: labelOf(target), matched: target ? target.total : 0,
        identity: identity,
        // 读不到可编辑元素就不报值（null）：宁可说"读不到"，也别把整页文字当成输入框内容
        valueLength: after && after.editable ? after.length : null,
        value: after && after.editable ? after.value : null,
      }
    },
    async scroll(id, options) {
      const page = await pageFor(id)
      const o = options || {}
      const dx = Number(o.dx || 0), dy = Number(o.dy || 0)
      const sel = o.selector ? String(o.selector) : null
      let before = 0
      let loc = null
      if (sel) {
        loc = (await resolveSoft(page, sel)).loc
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
      //   那一帧，Agent 就会以为"没滚动"。这里等的是"位置真的变了"这个**条件**（rAF 轮询到条件成立
      //   或超时），滚不动（已经到底/这个元素不可滚）不算失败。
      try {
        if (loc) {
          await loc.evaluate((el, a) => new Promise((resolve) => {
            const started = Date.now()
            const tick = () => {
              if ((el.scrollTop || 0) !== a.before || Date.now() - started > a.timeout) { resolve(true); return }
              requestAnimationFrame(tick)
            }
            tick()
          }), { before: before, timeout: 1500 })
        } else {
          await page.waitForFunction((b) => (window.scrollY || 0) !== b, before, { timeout: 1500 })
        }
      } catch { /* 滚不动就算了 */ }
      await settle(page)
      return { id: String(id), scrolled: { dx: dx, dy: dy } }
    },

    async waitFor(id, options) {
      const page = await pageFor(id)
      const o = options || {}
      const timeout = Number(o.timeout || T_ACT)
      if (o.selector) {
        // 等待用的定位规则必须与动作一致（text= 精确优先）：两处语义不同的话，
        // "等它出现"等到了、随后的点击却报"无精确匹配"，是最难查的一类不一致
        const match = o.match === 'contains' ? 'contains' : 'exact'
        const loc = locate(page, o.selector, match)
        try {
          await loc.first().waitFor({ state: o.state || 'visible', timeout: timeout })
        } catch (e) {
          const total = await loc.count().catch(() => -1)
          const loose = match === 'exact'
            ? await locate(page, o.selector, 'contains').count().catch(() => -1)
            : -1
          throw new Error('等待超时（' + timeout + 'ms）：「' + o.selector + '」没有变成 ' + (o.state || 'visible') + '。'
            + '当前精确命中 ' + total + ' 个' + (loose >= 0 ? '，子串命中 ' + loose + ' 个' : '') + '。'
            + (loose > 0 ? '子串有而精确没有 → 文本不是完全相等，改传 match=contains 或换选择器。'
              : '两边都是 0 → 元素还没出现，或者选择器跟这个页面对不上，先用 browser_read_page 看一眼。'))
        }
        return { id: String(id), ok: true, waited: 'selector' }
      }
      if (o.url) { await page.waitForURL(String(o.url), { timeout: timeout }); return { id: String(id), ok: true, waited: 'url' } }
      if (o.loadState) { await page.waitForLoadState(o.loadState, { timeout: timeout }); return { id: String(id), ok: true, waited: 'load' } }
      if (o.networkIdle) { await page.waitForLoadState('networkidle', { timeout: timeout }); return { id: String(id), ok: true, waited: 'networkidle' } }
      throw new Error('等待条件没给（selector / url / loadState / networkIdle 四选一）')
    },

    // ── 断言（2026-10-19）────────────────────────────────────────────────────
    // 为什么必要：只有"读快照 + 自己比对"这一条路时，大表格里看漏一行就会得出"功能正常"的错误结论。
    // 四态必须分开：成立 / 不成立（给了实际值）/ 找不到（等满超时也没出现）/ 有歧义（命中多个）。
    // 只回布尔会把"页面错了"和"页面还没到"混成一件事。
    async expect(id, options) {
      const page = await pageFor(id)
      const o = options || {}
      const kind = String(o.assert || (o.selector ? 'text' : 'url'))
      const timeout = Number(o.timeout || 5000)
      const started = Date.now()
      let r = null
      // 等的是"条件成立"这个**条件**（同 Playwright expect 的轮询语义），不是拿固定延时凑时序
      while (true) {
        r = await assertOnce(page, kind, o)
        if (r.state === 'pass' || r.state === 'ambiguous') break
        if (Date.now() - started >= timeout) break
        await sleep(120)
      }
      r.waitedMs = Date.now() - started
      r.timeout = timeout
      return r
    },

    // 布局度量：只报客观事实（内容比可见区宽/高、越出父容器、被省略号截断、行数），
    // 让"列宽够不够""按钮有没有换行"这类判断不必靠肉眼看截图
    async measure(id, options) {
      const page = await pageFor(id)
      const o = options || {}
      const scope = o.selector ? await resolveSoft(page, o.selector) : null
      const loc = scope ? scope.loc : page.locator('body').first()
      const data = await loc.evaluate(MEASURE_PROBE)
      data.id = String(id)
      data.url = page.url()
      if (scope) data.scope = { selector: o.selector, total: scope.total, index: scope.index }
      return data
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

  const SERIAL = ['navigate', 'back', 'forward', 'reload', 'click', 'hover', 'drag', 'press', 'type', 'scroll', 'waitFor', 'read', 'screenshot', 'expect', 'measure', 'code']
  const out = {
    status: impl.status.bind(impl),
    list: impl.list.bind(impl),
    disconnect: disconnect,
    // 内部用（bridge 之外别碰）
    _impl: impl,
    // 内部用：探针脚本直接验选择器解析 / 断言（不进壳桥白名单，模型看不到）
    _test: { pageFor, inspectSet, resolveTarget, resolveSoft, assertOnce, wildcardMatch, renderSnapshot, diffSnapshotLines, observeChange },
  }
  for (const k of SERIAL) out[k] = (...args) => run(args[0], () => impl[k](...args))
  return out
}

module.exports = { createDriver }
