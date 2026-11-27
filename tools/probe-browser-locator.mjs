import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// 探针：验内置浏览器动作层的「选择器解析 / 写入语义 / 断言四态 / 布局度量 /
//       提示消息缓冲 / 渲染安定 / 加载元数据 / 登录态指纹 / 失败翻译」。
// 为什么要有它：这几条改的是"操作的是不是目标、写进去的是不是对的数据、结论是不是当前状态"，
// 靠肉眼看界面验不出来（多命中时点错的那一下，界面上完全正常）。
// 做法：本机起一个静态服务（带 ETag），用无头 Edge 打开，标上 __anzioBrowserViewId，再让 driver 认成自家页面。
//   node tools\probe-browser-locator.mjs
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const SHELL = `${__TIANGONG_ROOT}\\deepseek-harness-mine\\shell`
const require = createRequire(path.join(SHELL, 'package.json'))
const { chromium } = require('playwright-core')
const { createDriver } = require(path.join(SHELL, 'driver.js'))

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9334
const VIEW_ID = 'browser://probe-1'

const fails = []
function check(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); return }
  fails.push(name + (detail === undefined ? '' : ' —— ' + detail))
  console.log('  FAIL  ' + name + (detail === undefined ? '' : ' —— ' + detail))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const HTML = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<div id="root">
  <button id="btn-a" onclick="document.getElementById('out').textContent='A clicked'">A</button>
  <button id="btn-a2" onclick="document.getElementById('out').textContent='A2 clicked'">A2</button>
  <button id="btn-save" onclick="document.getElementById('out').textContent='保存'">保存</button>
  <button id="btn-save2" onclick="document.getElementById('out').textContent='保存并关闭'">保存并关闭</button>
  <button id="btn-close" onclick="document.getElementById('out').textContent='closed'">关闭</button>
  <div id="modal" style="display:none">
    <button id="btn-close-hidden" onclick="document.getElementById('out').textContent='WRONG'">关闭</button>
  </div>
  <button id="dup1" onclick="document.getElementById('out').textContent='dup1'">重复</button>
  <button id="dup2" onclick="document.getElementById('out').textContent='dup2'">重复</button>
  <input id="name" value="旧值">
  <input id="pwd" type="password" name="password" value="">
  <div id="out">就绪</div>
  <div id="wide" style="width:100px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">一段很长很长的文字超出容器宽度</div>
  <div id="short" style="height:20px;overflow:hidden">第一行<br>第二行<br>第三行</div>
  <table id="small">
    <thead><tr><th>账号</th><th>租户</th><th>角色</th></tr></thead>
    <tbody>
      <tr><td>zhangsan</td><td>凯升威</td><td>管理员</td></tr>
      <tr><td>lisi</td><td>凯升威</td><td>只读</td></tr>
      <tr><td>wangwu</td><td>凯升威</td><td>管理员</td></tr>
    </tbody>
  </table>
  <div id="btns"></div>
  <table id="big"></table>
</div>
<script>
  var tb = document.getElementById('big')
  for (var i = 0; i < 400; i++) {
    var tr = document.createElement('tr')
    tr.innerHTML = '<td>第 ' + i + ' 行单元格内容单元格内容单元格内容</td><td>数值 ' + i + '</td><td>状态</td>'
    tb.appendChild(tr)
  }
  for (var j = 0; j < 6; j++) {
    var b = document.createElement('button')
    b.textContent = '编辑'
    document.getElementById('btns').appendChild(b)
  }
</script></body>`

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'etag': '"probe-v1"' })
  res.end(HTML)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const SITE = 'http://127.0.0.1:' + server.address().port + '/'

const profile = mkdtempSync(path.join(tmpdir(), 'anzio-probe-'))
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' })

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version')
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  return false
}

let browser = null
let driver = null
try {
  if (!await waitPort()) throw new Error('Edge 的调试端口没起来')
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT)
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0] || await ctx.newPage()
  await page.goto(SITE, { waitUntil: 'domcontentloaded' })
  await page.evaluate((id) => { window.__anzioBrowserViewId = id }, VIEW_ID)

  const records = []
  driver = createDriver({ port: PORT, onLog: () => {}, onAction: (r) => records.push(r) })
  const id = VIEW_ID
  const outText = () => page.evaluate(() => document.getElementById('out').textContent)

  console.log('\n[1] text= 精确优先：A 不能命中 A2')
  {
    const r = await driver.click(id, 'text=A')
    check('点了 A（title 一致）', (await outText()) === 'A clicked', 'out=' + await outText())
    check('回报命中数 1', r.matched === 1, 'matched=' + r.matched)
  }

  console.log('\n[2] 一个可见 + 一个隐藏副本（弹窗残留）：直接用可见的那个')
  {
    const r = await driver.click(id, 'text=关闭')
    check('点了可见的关闭', (await outText()) === 'closed', 'out=' + await outText())
    check('回报命中 2 / 可见 1', r.matched === 2 && r.visibleCount === 1, JSON.stringify(r))
    check('回报里指明用的是可见那个', String(r.clicked).includes('（可见）') && !String(r.clicked).includes('不可见'), r.clicked)
    check('用的是可见那个（DOM 顺序第 0 个）', r.index === 0, 'index=' + r.index)
  }

  console.log('\n[3] 多个可见候选：报错并列候选，不替调用方挑')
  {
    let err = null
    try { await driver.click(id, 'text=重复') } catch (e) { err = String(e.message) }
    check('抛错', err !== null)
    check('带上候选编号与文本', !!err && err.includes('1)') && err.includes('重复'), err)
    check('提示用 index', !!err && err.includes('index'), err)
    check('页面状态没被动过', (await outText()) === 'closed', 'out=' + await outText())
    const r = await driver.click(id, 'text=重复', { index: 1 })
    check('传 index 后可执行', (await outText()) === 'dup2', 'out=' + await outText())
  }

  console.log('\n[3b] 指定了不可见的候选：立刻说原因，不干等超时')
  {
    let err = null
    const started = Date.now()
    try { await driver.click(id, 'text=关闭', { index: 1 }) } catch (e) { err = String(e.message) }
    const ms = Date.now() - started
    check('抛错并说明不可见原因', !!err && err.includes('不可见') && err.includes('display:none'), err)
    check('没有干等到 10 秒', ms < 3000, 'ms=' + ms)
  }

  console.log('\n[4] 精确不到时显式回报子串候选，不静默降级')
  {
    let err = null
    const before = await outText()
    try { await driver.click(id, 'text=保存并关') } catch (e) { err = String(e.message) }
    check('抛错且页面没被点', err !== null && (await outText()) === before, err)
    check('列出子串候选', !!err && err.includes('保存并关闭'), err)
    check('提示 match=contains', !!err && err.includes('match=contains'), err)
    const r = await driver.click(id, 'text=保存并关', { match: 'contains' })
    check('显式 contains 后可执行', (await outText()) === '保存并关闭', 'out=' + await outText())
    check('回报 contains 命中', r.matched === 1, 'matched=' + r.matched)
  }

  console.log('\n[5] 写入默认覆盖 + 回读实际值')
  {
    const r = await driver.type(id, '新值', { selector: '#name' })
    check('值被覆盖而不是拼接', r.value === '新值', JSON.stringify(r))
    check('清空过原值', r.cleared === true, JSON.stringify(r))
    const r2 = await driver.type(id, '追加', { selector: '#name', mode: 'append' })
    check('append 模式是拼接', r2.value === '新值追加', JSON.stringify(r2))
  }

  console.log('\n[6] 密码字段：回读打码 + 记账打码')
  {
    records.length = 0
    const r = await driver.type(id, '123456', { selector: '#pwd' })
    check('认出敏感字段', r.sensitive === true, JSON.stringify(r))
    check('只回长度不回内容', r.valueLength === 6 && r.value === '', JSON.stringify(r))
    const textRec = records.find((x) => x.kind === 'text')
    check('记账走 masked', !!textRec && textRec.masked === true && textRec.length === 6, JSON.stringify(textRec))
    check('键流里没有明文字符', !records.some((x) => x.kind === 'key' && /[0-9]/.test(String(x.key))))
    check('任何记录里都没有明文', !JSON.stringify(records).includes('123456'))
  }

  console.log('\n[7] 断言四态')
  {
    const pass = await driver.expect(id, { assert: 'text', selector: '#out', equals: '保存并关闭', timeout: 300 })
    check('成立', pass.state === 'pass', JSON.stringify(pass))
    const bad = await driver.expect(id, { assert: 'text', selector: '#out', equals: '不存在的值', timeout: 300 })
    check('不成立并给实际值', bad.state === 'mismatch' && bad.actual === '保存并关闭', JSON.stringify(bad))
    const miss = await driver.expect(id, { assert: 'text', selector: '#nope', equals: 'x', timeout: 300 })
    check('找不到（不是 false）', miss.state === 'not-found' && miss.waitedMs >= 300, JSON.stringify(miss))
    const amb = await driver.expect(id, { assert: 'text', selector: 'text=重复', equals: '重复', timeout: 300 })
    check('有歧义并列候选', amb.state === 'ambiguous' && (amb.candidates || []).length === 2, JSON.stringify(amb))
    const vis = await driver.expect(id, { assert: 'hidden', selector: '#btn-close-hidden', timeout: 300 })
    check('hidden 断言成立', vis.state === 'pass', JSON.stringify(vis))
    const url = await driver.expect(id, { assert: 'url', equals: SITE + '*', timeout: 200 })
    check('url 断言支持通配', url.state === 'pass', JSON.stringify(url))
  }

  console.log('\n[8] 布局度量：溢出与省略号')
  {
    const m = await driver.measure(id, { selector: '#wide' })
    check('测到横向内容溢出', m.root.m.overflowX > 1, JSON.stringify(m.root.m))
    check('测到省略号截断', m.root.m.ellipsis === true, JSON.stringify(m.root.m))
    const v = await driver.measure(id, { selector: '#short' })
    check('测到纵向内容溢出', v.root.m.overflowY > 1, JSON.stringify(v.root.m))
    check('纵向两个数都是真实值', v.root.m.scrollH > 0 && v.root.m.clientH > 0, JSON.stringify(v.root.m))
  }

  console.log('\n[8b] 等待：语义与动作一致，超时要给下一步')
  {
    await page.evaluate(() => { document.getElementById('out').textContent = '就绪' })
    const ok = await driver.waitFor(id, { selector: '#btn-a', timeout: 500 })
    check('等得到就正常返回', ok.ok === true)
    let err = null
    try { await driver.waitFor(id, { selector: 'text=保存并关', timeout: 400 }) } catch (e) { err = String(e.message) }
    check('超时说清精确/子串各命中几个', !!err && err.includes('精确命中 0') && err.includes('子串命中 1'), err)
    check('并给出下一步（match=contains）', !!err && err.includes('match=contains'), err)
    let err2 = null
    try { await driver.waitFor(id, { selector: '#nope', timeout: 400 }) } catch (e) { err2 = String(e.message) }
    check('彻底没有时提示去看页面', !!err2 && err2.includes('browser_read_page'), err2)
  }

  console.log('\n[9] 快照：压缩后行数必须大幅下降，且不丢数据')
  {
    const r = await driver.read(id, {})
    check('走的是压缩模式', r.snapshot && r.snapshot.mode === 'compact', JSON.stringify(r.snapshot))
    check('压缩后行数远小于原始行数', r.snapshot.totalLines < r.snapshot.sourceLines / 3, JSON.stringify(r.snapshot))
    check('表格行数被统计', r.snapshot.rows >= 403, JSON.stringify({ rows: r.snapshot.rows }))
    const small = await driver.read(id, { selector: '#small', aria: false })
    check('读子树时不带快照也能正常返回', small.aria === undefined)
    const s2 = await driver.read(id, { selector: '#small' })
    check('表格按一行一条给', s2.aria.includes('行1：zhangsan | 凯升威 | 管理员'), s2.aria.slice(0, 400))
    check('列头只出现一次', (s2.aria.match(/列头：/g) || []).length === 1, s2.aria.slice(0, 400))
    check('单元格文字一个不少', ['zhangsan', 'lisi', 'wangwu', '只读'].every((x) => s2.aria.includes(x)), s2.aria)
    check('表格行数写在标题上', s2.aria.includes('3 行'), s2.aria)
  }

  console.log('\n[9b] 大表分页：给 40 行、说清还剩多少、能接着读')
  {
    const head = await driver.read(id, { selector: '#big' })
    check('默认给 40 行', (head.aria.match(/行\d+：/g) || []).length === 40, JSON.stringify((head.aria.match(/行\d+：/g) || []).length))
    check('说清还剩 360 行', head.aria.includes('还有 360 行没显示'), head.aria.slice(-200))
    check('给了继续读的参数', head.aria.includes('rowStart=40'), head.aria.slice(-200))
    const tail = await driver.read(id, { selector: '#big', rowStart: 398, rowCount: 2 })
    check('翻到最后两行', tail.aria.includes('行399：') && tail.aria.includes('行400：'), tail.aria)
    check('到底了就不再说"还有"', !tail.aria.includes('还有'), tail.aria)
  }

  console.log('\n[9c] 连续重复内容折叠 + 父子重复只留一层')
  {
    const r = await driver.read(id, { selector: '#btns' })
    check('6 个相同按钮折成 ×6', r.aria.includes('×6'), r.aria)
    const btn = await driver.read(id, { selector: '#btn-save' })
    const count = (btn.aria.match(/保存/g) || []).length
    check('按钮名只出现一次（父子重复被合并）', count === 1, btn.aria)
  }

  console.log('\n[9e] 动作后的可见变化：能看出"点了没反应"')
  {
    await page.evaluate(() => { document.getElementById('out').textContent = '就绪' })
    await driver.read(id, {})                       // 读一次建基线
    const noop = await driver.click(id, '#out')     // 点一个没有任何行为的元素
    const c0 = (noop.change || {}).counts || {}
    check('没反应的点击报 0 变化', c0.added === 0 && c0.changed === 0 && c0.removed === 0, JSON.stringify(noop.change))
    const r = await driver.click(id, 'text=保存')
    const c1 = (r.change || {}).counts || {}
    check('有反应的点击报出变化', c1.changed + c1.added + c1.removed >= 1, JSON.stringify(r.change))
    const dump = JSON.stringify(r.change)
    check('变化里带上了变化前后的样子', dump.includes('就绪') && dump.includes('保存'), dump)
  }

  console.log('\n[9d] raw 兜底：怀疑压缩出错时能要原始树')
  {
    const r = await driver.read(id, { selector: '#small', raw: true })
    check('标记为原始模式', r.snapshot.mode === 'raw', JSON.stringify(r.snapshot))
    check('是原始无障碍树（含 cell/row 层级）', r.aria.includes('- row') || r.aria.includes('- cell'), r.aria.slice(0, 300))
  }

  console.log('\n[10] 提示消息缓冲：页面上一闪而过，事后还能读到')
  {
    await page.evaluate(() => {
      const s = document.createElement('div')
      s.setAttribute('role', 'status')
      s.textContent = '保存成功'
      document.body.appendChild(s)
    })
    await sleep(80)
    await page.evaluate(() => {
      const t = document.createElement('div')
      t.style.cssText = 'position:fixed;right:10px;top:10px;z-index:9999;background:#333;color:#fff'
      t.textContent = '已复制到剪贴板'
      document.body.appendChild(t)
      setTimeout(() => t.remove(), 120)
    })
    await sleep(350)
    const r = await driver.read(id, { aria: false })
    const texts = (r.toasts || []).map((t) => t.text)
    check('抓到 aria-live 提示', texts.includes('保存成功'), JSON.stringify(texts))
    check('抓到一闪而过的浮层', texts.includes('已复制到剪贴板'), JSON.stringify(texts))
    check('浮层记了存活时长', (r.toasts || []).some((t) => t.kind === 'transient' && t.livedMs > 0), JSON.stringify(r.toasts))
  }

  console.log('\n[11] 渲染安定：读之前等 DOM 静默')
  {
    const r = await driver.read(id, { aria: false })
    check('返回安定结果', !!r.stability && typeof r.stability.waited === 'number', JSON.stringify(r.stability))
    check('静默后判为稳定', r.stability.stable === true, JSON.stringify(r.stability))
    check('至少等了一个静默窗口', r.stability.waited >= 150, JSON.stringify(r.stability))
  }

  console.log('\n[12] 加载元数据：时间、状态码、etag')
  {
    // driver 没赶上这次导航（页面在它连上之前就开了）→ 退回页面自己的 navigation timing
    const r = await driver.read(id, { aria: false })
    check('没赶上导航时也有页面年龄', typeof r.pageAgeMs === 'number' && r.pageAgeMs >= 0, JSON.stringify({ age: r.pageAgeMs }))
    check('没赶上导航时也有 HTTP 状态', r.httpStatus === 200, 'status=' + r.httpStatus)
    // driver 经手的导航（reload / navigate）才有响应头可听
    await driver.reload(id)
    const after = await driver.read(id, { aria: false })
    check('reload 后有加载时间', !!after.loadedAt && after.loadedAgoMs >= 0, JSON.stringify({ at: after.loadedAt, ago: after.loadedAgoMs }))
    check('reload 后拿到 etag', after.etag === '"probe-v1"', 'etag=' + after.etag)
  }

  console.log('\n[13] 地址漂移：只报事实（A→B）')
  {
    await driver.click(id, 'text=A')
    await page.evaluate(() => history.pushState({}, '', '?redirect=login'))
    await sleep(100)
    const r = await driver.read(id, { aria: false })
    check('报出地址已变', !!r.urlChangedSinceAction && r.urlChangedSinceAction.to.includes('redirect=login'), JSON.stringify(r.urlChangedSinceAction))
    check('同时给出来源地址', !!r.urlChangedSinceAction && r.urlChangedSinceAction.from.indexOf('redirect') < 0, JSON.stringify(r.urlChangedSinceAction))
  }

  console.log('\n[14] 登录态指纹：动手前发现凭证变了')
  {
    // 基线：此刻还没有 cookie，先把"没有凭证"记成一次基线
    const base = await driver.click(id, 'text=A')
    check('基线无变化标记', base.identity.changed === false, JSON.stringify(base.identity))
    await ctx.addCookies([{ name: 'sid', value: 'aaaa', domain: '127.0.0.1', path: '/' }])
    const first = await driver.click(id, 'text=A')
    check('从无凭证变成有凭证 → 标记为变过', first.identity.changed === true, JSON.stringify(first.identity))
    check('指纹不是 none', first.identity.hash && first.identity.hash !== 'none', JSON.stringify(first.identity))
    await ctx.addCookies([{ name: 'sid', value: 'bbbb', domain: '127.0.0.1', path: '/' }])
    const second = await driver.click(id, 'text=A')
    check('换凭证后下一次动作被标记', second.identity.changed === true, JSON.stringify(second.identity))
    check('两次指纹不同', first.identity.hash !== second.identity.hash, first.identity.hash + ' -> ' + second.identity.hash)
    const listed = await driver.list()
    check('列表页带共用指纹', (listed[0] || {}).identity === second.identity.hash, JSON.stringify(listed))
  }

  console.log('\n[15] 遮挡物：说出来是谁 + 下一步')
  {
    await page.evaluate(() => {
      const mask = document.createElement('div')
      mask.id = 'mask'
      mask.style.cssText = 'position:fixed;inset:0;z-index:9999'
      mask.innerHTML = '<div role="dialog" aria-modal="true" aria-label="确认删除"><button>取消</button></div>'
      document.body.appendChild(mask)
    })
    let err = null
    try { await driver.click(id, '#btn-a') } catch (e) { err = String(e.message) }
    check('抛错而不是干等', err !== null, err)
    check('说清是"被盖住"', !!err && err.includes('盖住'), err)
    check('指出遮挡物是哪个弹窗（不是 div）', !!err && err.includes('dialog') && err.includes('确认删除'), err)
    check('给出下一步', !!err && err.includes('下一步'), err)
    await page.evaluate(() => { const m = document.getElementById('mask'); if (m) m.remove() })
  }
} catch (e) {
  fails.push('探针自身炸了：' + String((e && e.stack) || e))
  console.log(String((e && e.stack) || e))
} finally {
  try { if (driver) await driver._impl.status() } catch { /* 忽略 */ }
  try { if (browser) await browser.close() } catch { /* 忽略 */ }
  try { child.kill() } catch { /* 忽略 */ }
  try { server.close() } catch { /* 忽略 */ }
  await sleep(400)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log('\n' + (fails.length === 0 ? '全部通过' : ('失败 ' + fails.length + ' 项:\n - ' + fails.join('\n - '))))
process.exit(fails.length === 0 ? 0 : 1)
