'use strict'
// 内置浏览器**页面**的 preload（跑在浏览器视图自己的渲染进程里，沙箱中）。两件事：
//
//  ① 键位归属（第一期）：
//     · 页面自己已经消费掉的按键（`defaultPrevented`）不转发；
//     · 原生编辑键（复制/粘贴/剪切/撤销那族）不转发 —— 转发会让页面里的输入框/富文本全废；
//     · 其余带 Ctrl / Alt 的组合键**一律上交给天工键位系统**（00devCore §0.4：冲突时以天工为准）；
//     · F5 / F12 是浏览器惯例键，同样上报，由壳侧认领（刷新 / 开发者工具）。
//     ⚠ 刻意**不调 preventDefault**：VSCode 的浏览器视图也是只上报、不拦截，页面自己的快捷键照旧生效。
//
//  ② 「Agent幻影」的指针层（第三期）：往页面里注入一个**不吃鼠标事件**的指针 + 点击波纹，
//     由壳发指令驱动（移动 / 按下 / 松开 / 拖拽 / 淡入淡出）。
//     ⚠ 为什么画在**页面内部**而不是天工页面里：原生视图永远盖在天工页面之上，外层 DOM 画什么都看不见；
//       而 `position:fixed` 是相对视口定位 ⇒ 页面滚动时指针不动，语义上就等于屏幕上的鼠标，正是要的效果。
//       坐标直接用**页面的 CSS 像素**（Playwright 的 boundingBox 就是这个坐标系）—— 不需要在
//       窗口位置 / 显示器 DPI / 页面缩放之间换算（设计稿提的"三处换算"只在指针画在页面外时才需要）。

let ipc = null
try { ipc = require('electron').ipcRenderer } catch { /* 单独拿来测（没有 electron）时也让自己能用 */ }

// 让驱动层（Playwright）认出"这个页面是哪块视图"：id 由壳经 webPreferences.additionalArguments 传进来。
// ⚠ 必须走 contextBridge 暴露到**页面主世界** —— 驱动层用 page.evaluate 读的是主世界，
//   preload 隔离世界里的变量它一个字都看不见（这条踩过就白写）。
try {
  const contextBridge = require('electron').contextBridge
  const PREFIX = '--anzio-browser-view-id='
  const arg = (process.argv || []).find((a) => String(a).indexOf(PREFIX) === 0)
  if (arg) contextBridge.exposeInMainWorld('__anzioBrowserViewId', String(arg).slice(PREFIX.length))
} catch { /* 拿不到就算了：驱动层会认不出这个页面（表现为"找不到这个浏览器页面"） */ }

const NATIVE_EDIT_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y'])

function report(payload) {
  if (!ipc) return
  try { ipc.send('anzio-browser:key-from-page', payload) } catch { /* 视图正在销毁 */ }
}

window.addEventListener('keydown', (event) => {
  try {
    if (event.defaultPrevented) return
    const key = String(event.key || '')
    if (key === 'F5' || key === 'F12') {
      event.preventDefault()   // 这两个由壳侧认领，页面不该同时再处理一遍
      report({ key, code: event.code, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, repeat: event.repeat })
      return
    }
    const mod = event.ctrlKey || event.altKey || event.metaKey
    if (!mod) return
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && NATIVE_EDIT_KEYS.has(key.toLowerCase())) return
    report({ key, code: event.code, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, repeat: event.repeat })
  } catch { /* 绝不因为一次键上报让页面挂掉 */ }
}, true)

// ══ Agent幻影 · 指针层 ═══════════════════════════════════════════════════════
// 只做"演给人看"：不参与任何真实操作（真实的点击/输入由 Playwright 走自己的通道发），
// 所以这一层坏掉也绝不能让页面异常 —— 全程 try/catch。
// ⚠ 开头这个 `;` 不能删：本文件不用分号（仓库风格），而上一句以 `)` 结尾、这一句以 `(` 开头 ——
//   自动分号插入**不会**在 `(` 前补分号，两行会被解析成"把上面那个调用结果当函数再调一次"，
//   整层代码直接抛错不执行（2026-10-08 实测：指针压根画不出来，报错 `window.addEventListener(...) is not a function`）。
;(function () {
  const BRAND = '#3b82f6'
  let root = null
  let cursor = null
  let trail = null
  let on = true
  let pos = { x: -60, y: -60 }
  let raf = 0
  let fadeTimer = null
  let dragging = false
  const state = { visible: false, moves: 0, presses: 0, ripples: 0, lastCommand: '', lastPress: null }

  function ensure() {
    if (root && root.isConnected) return true
    try {
      root = document.createElement('div')
      root.id = 'anzio-phantom-layer'
      // 整层不吃鼠标事件（否则会挡住页面操作）；最高层级，压在所有页面内容之上
      root.setAttribute('style', 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;'
        + 'opacity:0;transition:opacity .35s ease;will-change:opacity;')
      cursor = document.createElement('div')
      cursor.id = 'anzio-phantom-cursor'
      cursor.setAttribute('style', 'position:absolute;left:0;top:0;transform:translate3d(-60px,-60px,0);'
        + 'filter:drop-shadow(0 0 3px rgba(59,130,246,.85));transition:transform .09s ease;')
      // 箭头本体（白色填充 + 品牌色描边）。区分幻影与真人鼠标靠描边色 + 点击波纹 + 拖拽虚线就够；
      // 曾经在箭头外面再套一圈常驻光环，用户反馈"一直粘在光标上"、浅色页面上也基本看不见，已去掉（2026-10-15）
      cursor.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">'
        + '<path d="M6 4 L6 19 L10.2 15.2 L12.9 21 L15.4 19.9 L12.5 14.1 L18.2 13.4 Z" '
        + 'fill="#fff" stroke="' + BRAND + '" stroke-width="1.4" stroke-linejoin="round"/></svg>'
      trail = document.createElement('div')
      trail.id = 'anzio-phantom-trail'
      trail.setAttribute('style', 'position:absolute;left:0;top:0;height:0;border-top:2px dashed '
        + 'rgba(59,130,246,.8);transform-origin:0 0;opacity:0;')
      root.appendChild(trail)
      root.appendChild(cursor)
      const parent = document.body || document.documentElement
      if (!parent) return false
      parent.appendChild(root)
      return true
    } catch { root = null; return false }
  }

  function show() {
    if (!ensure()) return
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null }
    root.style.opacity = '1'
    state.visible = true
  }
  // 停手一会儿就淡出（"没人看时不必一直挂着"）；再次有动作会立刻淡入
  function scheduleFade() {
    if (fadeTimer) clearTimeout(fadeTimer)
    fadeTimer = setTimeout(function () {
      fadeTimer = null
      if (!root) return
      root.style.opacity = '0'
      state.visible = false
    }, 2600)
  }

  // 远距离慢、近距离快（不是瞬移、也不是匀速）——"像真人"的第一条
  function durationFor(from, to, forced) {
    if (typeof forced === 'number' && isFinite(forced)) return Math.max(0, forced)
    const dist = Math.sqrt((to.x - from.x) * (to.x - from.x) + (to.y - from.y) * (to.y - from.y))
    return Math.round(Math.max(120, Math.min(620, dist * 1.15)))
  }
  const easeOut = (t) => 1 - Math.pow(1 - t, 3)

  function moveTo(x, y, duration) {
    if (!ensure()) return
    if (!on) return
    show()
    const from = { x: pos.x, y: pos.y }
    const ms = durationFor(from, { x, y }, duration)
    state.moves += 1
    if (raf) cancelAnimationFrame(raf)
    if (ms <= 0) { place(x, y); setShape(x, y); scheduleFade(); return }
    const t0 = performance.now()
    const step = function (now) {
      const t = Math.min(1, (now - t0) / ms)
      const k = easeOut(t)
      place(from.x + (x - from.x) * k, from.y + (y - from.y) * k)
      if (t < 1) { raf = requestAnimationFrame(step) }
      else { raf = 0; place(x, y); setShape(x, y); scheduleFade() }
    }
    raf = requestAnimationFrame(step)
  }
  // ⚠ 非法坐标一律不进指针位置：位置一旦变成 NaN，后面所有动作都画不出来（2026-10-16 事故的根）
  function place(x, y) {
    if (!isFinite(x) || !isFinite(y)) return
    pos = { x: x, y: y }
    try { cursor.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)' + (dragging ? ' scale(.92)' : '') } catch { /* 忽略 */ }
  }
  // 悬停在可点元素上时变成"手型"（读页面自己的光标样式，不猜）
  function setShape(x, y) {
    try {
      const el = document.elementFromPoint(x, y)
      const cur = el && el.ownerDocument && el.ownerDocument.defaultView
        ? el.ownerDocument.defaultView.getComputedStyle(el).cursor : ''
      cursor.style.cursor = cur === 'pointer' ? 'pointer' : 'default'
      // 手型：把箭头换成小手掌（用文字符号最省事，且不依赖字体以外的资源）
      cursor.dataset.shape = cur === 'pointer' ? 'hand' : 'arrow'
    } catch { /* 忽略 */ }
  }

  function ripple(x, y, strong) {
    if (!ensure() || !on) return
    // 坐标必须是有限数：NaN 会让 left/top 整条失效、圈静默掉到左上角（2026-10-15 真机就是这样）——
    // 与其画错地方，不如不画
    if (!isFinite(x) || !isFinite(y)) return
    try {
      const size = strong ? 46 : 34
      // 两层：外层只管位置（和指针用同一套 transform 定位，坐标系必然一致），内层只管扩散动画。
      // 挤在一层里的话，扩散的 scale 会把定位的 translate 覆盖掉（transform 是同一个属性）
      const at = document.createElement('div')
      at.setAttribute('style', 'position:absolute;left:0;top:0;transform:translate3d(' + x + 'px,' + y + 'px,0);')
      const ring = document.createElement('div')
      ring.setAttribute('style', 'width:' + size + 'px;height:' + size + 'px;'
        + 'margin:' + (-size / 2) + 'px 0 0 ' + (-size / 2) + 'px;box-sizing:border-box;'
        + 'border-radius:50%;border:2px solid ' + BRAND + ';'
        + 'opacity:.55;transform:scale(.35);transition:transform .42s cubic-bezier(.2,.7,.3,1),opacity .42s ease;')
      at.appendChild(ring)
      root.appendChild(at)
      state.ripples += 1
      requestAnimationFrame(function () {
        try {
          ring.style.transform = 'scale(2.3)'
          ring.style.opacity = '0'
        } catch { /* 忽略 */ }
      })
      setTimeout(function () { try { at.remove() } catch { /* 忽略 */ } }, 520)
    } catch { /* 忽略 */ }
  }

  function press(x, y, button) {
    if (!on) return
    // ⚠ 坐标缺失时**绝不能**拿去挪指针：NaN 会把指针位置本身写坏，之后整场动作都画不出来
    //   （2026-10-16 真机事故：老版表现为"点击波纹跑到左上角"，新版表现为"波纹彻底消失"，同一个病根）
    const has = isFinite(x) && isFinite(y)
    if (has) moveTo(x, y, 0)
    // 留痕（写在 DOM 上，方便从页面外面读）：这次按压到底带没带坐标、带的是多少
    try { cursor.dataset.lastPress = has ? (Math.round(x) + ',' + Math.round(y)) : 'no-point' } catch { /* 忽略 */ }
    state.lastPress = has ? { x: Math.round(x), y: Math.round(y) } : null
    try { cursor.style.transform = 'translate3d(' + pos.x + 'px,' + pos.y + 'px,0) scale(.82)' } catch { /* 忽略 */ }
    ripple(pos.x, pos.y, button === 'right')
    state.presses += 1
    show()
    setTimeout(function () {
      try { cursor.style.transform = 'translate3d(' + pos.x + 'px,' + pos.y + 'px,0)' } catch { /* 忽略 */ }
    }, 110)
    scheduleFade()
  }
  function release() {
    try { cursor.style.transform = 'translate3d(' + pos.x + 'px,' + pos.y + 'px,0)' } catch { /* 忽略 */ }
  }

  function drag(from, to, duration) {
    if (!on || !ensure()) return
    dragging = true
    moveTo(from.x, from.y, 0)
    try {
      const dx = to.x - from.x, dy = to.y - from.y
      const len = Math.sqrt(dx * dx + dy * dy)
      trail.style.width = len + 'px'
      trail.style.opacity = '.9'
      trail.style.transform = 'translate3d(' + from.x + 'px,' + from.y + 'px,0) rotate(' + Math.atan2(dy, dx) + 'rad)'
    } catch { /* 忽略 */ }
    moveTo(to.x, to.y, duration)
    setTimeout(function () {
      try { trail.style.opacity = '0' } catch { /* 忽略 */ }
      dragging = false
      place(pos.x, pos.y)
    }, durationFor(from, to, duration) + 120)
  }

  function command(cmd) {
    try {
      if (!cmd || typeof cmd !== 'object') return
      state.lastCommand = String(cmd.type || '')
      if (cmd.type === 'on') {
        on = cmd.value !== false
        if (!on) {
          if (root) { root.style.opacity = '0'; state.visible = false }
          if (raf) { cancelAnimationFrame(raf); raf = 0 }
        }
        return
      }
      if (!on) return                                  // 关掉时：不画、不动（动作直接执行，由驱动层负责）
      if (cmd.type === 'move') { moveTo(Number(cmd.x) || 0, Number(cmd.y) || 0, cmd.duration); return }
      if (cmd.type === 'press') { press(Number(cmd.x), Number(cmd.y), cmd.button); return }
      if (cmd.type === 'release') { release(); scheduleFade(); return }
      if (cmd.type === 'click') {
        press(Number(cmd.x), Number(cmd.y), cmd.button)
        setTimeout(release, 130)
        return
      }
      if (cmd.type === 'drag') {
        drag(cmd.from || pos, cmd.to || pos, cmd.duration)
        return
      }
      if (cmd.type === 'hide') { if (root) { root.style.opacity = '0'; state.visible = false } return }
    } catch { /* 幻影坏了不影响页面 */ }
  }

  // 自检钩子（同 window.__dsideKeys / __dshTraceStat 那套）：只读状态 + 一个命令入口。
  // 命令入口同时是 IPC 的落点，所以"用真机探针直接驱动幻影"和"壳发指令"走的是同一条路。
  try {
    window.__anzioPhantom = {
      version: 1,
      state: function () { return { on: on, x: Math.round(pos.x), y: Math.round(pos.y), visible: state.visible, moves: state.moves, presses: state.presses, ripples: state.ripples, lastCommand: state.lastCommand, lastPress: state.lastPress } },
      command: command,
    }
  } catch { /* 非浏览器环境 */ }

  if (ipc) {
    try { ipc.on('anzio-phantom', function (_e, cmd) { command(cmd) }) } catch { /* 忽略 */ }
  }
})()
