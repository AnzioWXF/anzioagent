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

    'page.navigate': async (a) => driver.navigate(String(a.id), String(a.url)),
    'page.back': async (a) => driver.back(String(a.id)),
    'page.forward': async (a) => driver.forward(String(a.id)),
    'page.reload': async (a) => driver.reload(String(a.id)),

    // ── 交互 ──────────────────────────────────────────────────────────────
    'page.click': async (a) => driver.click(String(a.id), String(a.selector), a || {}),
    'page.dblclick': async (a) => driver.click(String(a.id), String(a.selector), Object.assign({}, a, { clickCount: 2 })),
    'page.rightclick': async (a) => driver.click(String(a.id), String(a.selector), Object.assign({}, a, { button: 'right' })),
    'page.hover': async (a) => driver.hover(String(a.id), String(a.selector)),
    'page.drag': async (a) => driver.drag(String(a.id), String(a.from), String(a.to)),
    'page.scroll': async (a) => driver.scroll(String(a.id), a || {}),
    'page.press': async (a) => driver.press(String(a.id), String(a.key), a && a.selector ? String(a.selector) : null),
    'page.type': async (a) => driver.type(String(a.id), a && a.text != null ? a.text : '', a || {}),

    // ── 读取 / 等待 / 兜底 ────────────────────────────────────────────────
    'page.read': async (a) => driver.read(String(a.id), a || {}),
    'page.screenshot': async (a) => driver.screenshot(String(a.id), a || {}),
    'page.wait': async (a) => driver.waitFor(String(a.id), a || {}),
    'page.code': async (a) => driver.code(String(a.id), String(a && a.code ? a.code : '')),
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
    if (req.method !== 'POST' || !String(req.url).startsWith('/call')) { fail(404, 'not found'); return }
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
      const method = String((payload && payload.method) || '')
      const args = (payload && payload.args) || {}
      const fn = handlers[method]
      if (!fn) { fail(404, 'unknown method: ' + method); return }
      const started = Date.now()
      try {
        const result = await fn(args)
        log('bridge-call', { method: method, ms: Date.now() - started })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: result }))
      } catch (e) {
        const message = String((e && e.message) || e)
        log('bridge-call-failed', { method: method, ms: Date.now() - started, error: message })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: message }))
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
