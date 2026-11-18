'use strict'
// 天工自己的壳桥（跑在壳主进程）：让**后端里的 Agent 工具层**能指挥壳里的浏览器与 Playwright 驱动层。
//
// 为什么要有这一层：Agent 工具跑在 DSH 后端进程里（它不懂 Electron，也不该懂）；浏览器视图和
// Playwright 只能在壳主进程里动。两者之间就靠这个**只绑 127.0.0.1 + 随机端口 + 一次性口令**的小
// HTTP 服务通信（设计定稿 §4.1 的 ③↔④）。口令在壳启动后端子进程时用环境变量交给它，不落盘、不猜端口。
//
// 硬约束：
//   · 只监听 127.0.0.1，口令不对一律 401（后端进程是本机的，但别的本机进程也可能来敲这个端口）。
//   · 这里**只做转发**，不放任何业务判断（业务在 driver.js 与后端的工具层里）。
//   · 所有方法都在白名单里，名字写错直接报错，不做"猜你想调什么"。

const http = require('http')
const crypto = require('crypto')

const MAX_BODY = 32 * 1024 * 1024      // 截图（base64）可能很大，给足

function startBridge(deps) {
  const driver = deps.driver
  const host = deps.host              // 浏览器内核（browser.js 的 installBrowserHost 返回值）
  const win = deps.win
  const log = deps.log || function () {}
  const token = crypto.randomBytes(24).toString('hex')
  let seq = 0
  // 正在跑的调用：callId -> AbortController。终止时按 id（或全量）掐断，见下面的 /cancel。
  const inFlight = new Map()
  let callSeq = 0

  const send = (msg) => {
    try { if (!win.isDestroyed()) win.webContents.send('anzio-browser:event', msg) } catch { /* 窗口关着 */ }
  }

  const handlers = {
    'health': async () => ({ ok: true, driver: await driver.status() }),

    // ── 页面 ──────────────────────────────────────────────────────────────
    'pages.list': async () => driver.list(),
    'page.open': async (a) => {
      const url = String((a && a.url) || 'about:blank')
      const id = 'browser://agent-' + Date.now().toString(36) + '-' + (++seq)
      const made = host.create(id, url)
      if (!made || !made.ok) throw new Error('建视图失败：' + JSON.stringify(made))
      // 让天工界面把这个标签开出来并激活（用户要看得见 Agent 在操作什么）
      send({ type: 'agent-open', id: id, url: url })
      return { id: id, url: url }
    },
    'page.close': async (a) => {
      const id = String((a && a.id) || '')
      host.destroy(id)
      send({ type: 'agent-close', id: id })
      return { id: id }
    },
    // 界面里换到这个标签（Agent 想让人看见它在操作哪个页面时用）
    'page.activate': async (a) => { send({ type: 'agent-open', id: String((a && a.id) || ''), url: null }); return { id: String((a && a.id) || '') } },

    'page.navigate': async (a, signal) => driver.navigate(String(a.id), String(a.url), signal),
    'page.back': async (a, signal) => driver.back(String(a.id), signal),
    'page.forward': async (a, signal) => driver.forward(String(a.id), signal),
    'page.reload': async (a, signal) => driver.reload(String(a.id), signal),

    // ── 交互 ──────────────────────────────────────────────────────────────
    'page.click': async (a, signal) => driver.click(String(a.id), String(a.selector), a || {}, signal),
    'page.dblclick': async (a, signal) => driver.click(String(a.id), String(a.selector), Object.assign({}, a, { clickCount: 2 }), signal),
    'page.rightclick': async (a, signal) => driver.click(String(a.id), String(a.selector), Object.assign({}, a, { button: 'right' }), signal),
    'page.hover': async (a, signal) => driver.hover(String(a.id), String(a.selector), a || {}, signal),
    'page.drag': async (a, signal) => driver.drag(String(a.id), String(a.from), String(a.to), a || {}, signal),
    'page.scroll': async (a, signal) => driver.scroll(String(a.id), a || {}, signal),
    'page.press': async (a, signal) => driver.press(String(a.id), String(a.key), a && a.selector ? String(a.selector) : null, a || {}, signal),
    'page.type': async (a, signal) => driver.type(String(a.id), a && a.text != null ? a.text : '', a || {}, signal),

    // ── 读取 / 等待 / 判定 / 兜底 ─────────────────────────────────────────
    'page.read': async (a, signal) => driver.read(String(a.id), a || {}, signal),
    'page.screenshot': async (a, signal) => driver.screenshot(String(a.id), a || {}, signal),
    'page.wait': async (a, signal) => driver.waitFor(String(a.id), a || {}, signal),
    'page.expect': async (a, signal) => driver.expect(String(a.id), a || {}, signal),
    'page.measure': async (a, signal) => driver.measure(String(a.id), a || {}, signal),
    'page.code': async (a, signal) => driver.code(String(a.id), String(a && a.code ? a.code : ''), signal),
  }

  // 日志只记"指挥了什么"，不落原文：填写的文字/代码只留长度（2026-10-19 拍板），
  // 排查要的是"往哪填了 N 个字"。这是 Agent 指挥浏览器的唯一咽喉，逐次落盘才算有轨迹。
  function summarizeArgs(args) {
    const out = Object.assign({}, args || {})
    if (out.text !== undefined) out.text = { chars: String(out.text).length }
    if (out.code !== undefined) out.code = { chars: String(out.code).length }
    if (out.value !== undefined) out.value = { chars: String(out.value).length }
    return out
  }
  // 结果只留能判定"成没成、动的是哪个"的字段；快照正文/截图不进日志（太大且已在返回值里）
  function summarizeResult(method, result) {
    if (result === undefined || result === null) return undefined
    if (Array.isArray(result)) return { count: result.length }
    if (typeof result !== 'object') return { value: String(result).slice(0, 120) }
    const out = {}
    for (const k of ['ok', 'id', 'url', 'match', 'count', 'changed', 'elapsedMs']) {
      if (result[k] !== undefined) out[k] = result[k]
    }
    if (Object.keys(out).length === 0) out.chars = JSON.stringify(result).length
    return out
  }

  const server = http.createServer((req, res) => {
    const fail = (code, msg) => {
      try { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(msg) })) } catch { /* 忽略 */ }
    }
    if (req.method === 'GET' && req.url === '/health') {
      try { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })) } catch { /* 忽略 */ }
      return
    }
    if (req.headers['x-anzio-token'] !== token) { fail(401, 'bad token'); return }
    const isCall = req.method === 'POST' && String(req.url).startsWith('/call')
    const isCancel = req.method === 'POST' && String(req.url).startsWith('/cancel')
    if (!isCall && !isCancel) { fail(404, 'not found'); return }
    let body = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { try { req.destroy() } catch { /* 忽略 */ } return }
      body += chunk
    })
    req.on('end', async () => {
      let payload = null
      try { payload = JSON.parse(body || '{}') } catch { fail(400, 'bad json'); return }

      // ── 终止（2026-11-17）────────────────────────────────────────────────
      // 用户按终止时，后端把在跑的调用逐个掐掉。为什么必须掐：一次 page.expect 能等满 45s、
      // page.type 逐键能敲 70s，而同一页面的动作是串行队列 —— 不掐它，后面所有动作都排着队，
      // 表现就是"点了终止还要等半天"。
      if (isCancel) {
        const callId = payload.callId === undefined || payload.callId === null ? null : String(payload.callId)
        const cancelled = []
        for (const [id, controller] of inFlight) {
          if (callId !== null && id !== callId) continue
          cancelled.push(id)
          try { controller.abort() } catch { /* 忽略 */ }
        }
        log('bridge-cancel', { callId: callId, cancelled: cancelled.length })
        try { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, cancelled: cancelled.length })) } catch { /* 忽略 */ }
        return
      }

      const method = String((payload && payload.method) || '')
      const args = (payload && payload.args) || {}
      // 页面 id 归一只在这一处做（补 `browser://` 前缀，见 browser.js 的 canonicalId）：页面 id 长得
      // 像网址，调用方（尤其模型）常只写后半截 ⇒ 下游按原样查不到，报出来的却是"找不到页面"。
      // ⚠ 规则写在一处才叫规则：所有 page.* 都从这儿过，别在每个 handler 里各抄一遍
      //（2026-10-16 先抄成了 18 处，当天收回）。
      if (args.id !== undefined) args.id = host.canonicalId(args.id)
      const fn = handlers[method]
      if (!fn) { fail(404, 'unknown method: ' + method); return }
      const callId = payload.callId === undefined || payload.callId === null ? ('anon-' + (++callSeq)) : String(payload.callId)
      const controller = new AbortController()
      inFlight.set(callId, controller)
      const started = Date.now()
      try {
        const result = await fn(args, controller.signal)
        log('bridge-call', { method: method, ms: Date.now() - started, args: summarizeArgs(args), result: summarizeResult(method, result) })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: result }))
      } catch (e) {
        const message = String((e && e.message) || e)
        // 被终止不是故障：单独一条日志，别混进"调用失败"里污染排查
        log(controller.signal.aborted ? 'bridge-call-cancelled' : 'bridge-call-failed',
          { method: method, ms: Date.now() - started, args: summarizeArgs(args), error: message })
        try {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: message }))
        } catch { /* 调用方已经断开（fetch 被中止） */ }
      } finally {
        inFlight.delete(callId)
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: 'http://127.0.0.1:' + port,
        token: token,
        close: () => { try { server.close() } catch { /* 忽略 */ } },
      })
    })
  })
}

module.exports = { startBridge }
