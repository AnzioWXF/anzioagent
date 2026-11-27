import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// AnzioAgent 内置更新器 E2E（真机：跑安装目录里的真 exe，不是无头浏览器）
// 前置：<安装目录> 已安装旧版本；更新源 <安装目录>\_updates 已有更新的 latest.json
// 用法: node tools/e2e-update.mjs
// 验的是：版本徽标/检查更新 → 下载校验落地 staging → 退出后助手脚本覆盖文件 → 自动重启 → 新版本生效（IDE 正常渲染）
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const INSTALL = `${__TIANGONG_INSTALL}`
const EXE = join(INSTALL, 'AnzioAgent.exe')
const VERSION_FILE = join(INSTALL, 'version.json')
const CDP_PORT = 9223
const APP = 'http://127.0.0.1:3081'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' :: ' + String(detail ?? '')}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

// 干净环境启动（模拟双击 exe：不带 DSH_* 变量 —— 从 DSH 终端启动会污染应用，见 main.js 注释）
function cleanEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('DSH_')) delete env[k]
  return env
}
function launchApp() {
  const p = spawn(EXE, ['--remote-debugging-port=' + CDP_PORT], { env: cleanEnv(), detached: true, stdio: 'ignore', windowsHide: false })
  p.unref()
  return p
}
function killApp() {
  spawnSync('taskkill', ['/im', 'AnzioAgent.exe', '/t', '/f'], { stdio: 'ignore' })
}

async function cdpTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const t = (list || []).find((x) => x.type === 'page')
      if (t) return t
    } catch { /* 还没起来 */ }
    await sleep(500)
  }
  return null
}
let ws = null
const pending = new Map()
let msgId = 0
async function connect(target) {
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')) })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  await evalJs('1')
}
function evalJs(expr) {
  return new Promise((resolve) => {
    const id = ++msgId
    const timer = setTimeout(() => { pending.delete(id); resolve({ __err: 'timeout' }) }, 20000)
    pending.set(id, (m) => {
      clearTimeout(timer)
      const r = m.result || {}
      if (r.exceptionDetails) return resolve({ __err: String(r.exceptionDetails.text || '') })
      resolve(r.result ? r.result.value : undefined)
    })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
  })
}
async function waitFor(expr, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await evalJs(expr)
    if (v && !v.__err) return v
    await sleep(500)
  }
  return null
}

try {
  const before = readJson(VERSION_FILE)
  check('P0 前置：安装目录已有版本记录', !!(before && before.version), JSON.stringify(before && before.version))
  const latest = readJson(join(INSTALL, '_updates', 'latest.json'))
  check('P1 前置：更新源有更新的版本', !!(latest && latest.version && latest.version !== (before && before.version)),
    JSON.stringify({ feed: latest && latest.version, installed: before && before.version }))
  if (!latest || !before) throw new Error('前置不满足')

  killApp()
  await sleep(1500)
  launchApp()
  const target = await cdpTarget()
  check('P2 旧版本能启动并暴露调试端点', !!target, 'no cdp target')
  if (!target) throw new Error('no target')
  await connect(target)

  const st0 = await waitFor(`(async function(){ var b=window.anzioUpdater; if(!b) return null; var s=await b.getState(); return JSON.stringify(s); })()`, 30000)
  const s0 = st0 ? JSON.parse(st0) : null
  check('P3 渲染层能读到更新桥 + 已安装版本 = 更新前的版本',
    !!(s0 && s0.installed === before.version), JSON.stringify(s0))

  const chk = await waitFor(`(async function(){ var r = await window.anzioUpdater.check(); return JSON.stringify(r); })()`, 30000)
  const c = chk ? JSON.parse(chk) : null
  check('P4 「检查更新」发现新版本', !!(c && c.ok && c.available && c.latest && c.latest.version === latest.version), JSON.stringify(c))

  const ins = await evalJs(`(async function(){ var r = await window.anzioUpdater.install(); return JSON.stringify(r); })()`)
  const i = ins && !ins.__err ? JSON.parse(ins) : null
  check('P5 下载 + sha256 校验 + 落地 staging',
    !!(i && i.ok && i.files === latest.fileCount), JSON.stringify({ got: i, expectFiles: latest.fileCount }))
  check('P6 staging 里有 apply.json（下次启动照它覆盖）',
    existsSync(join(INSTALL, '_staging', 'v' + latest.version, 'apply.json')), 'missing apply.json')

  const applied = await evalJs(`(async function(){ var r = await window.anzioUpdater.applyAndRestart(); return JSON.stringify(r); })()`)
  const a = applied && !applied.__err ? JSON.parse(applied) : null
  check('P7 「重启并安装」被接受', !!(a && a.ok), JSON.stringify(a))

  // 新实例启动时先应用（此时无进程占用文件）→ 再自重启一次 → 这次才是新代码
  let ver = null
  for (let k = 0; k < 60; k++) {
    await sleep(1000)
    ver = readJson(VERSION_FILE)
    if (ver && ver.version === latest.version) break
  }
  check('P8 重启后自动安装完成（version.json 变成新版本）', !!(ver && ver.version === latest.version),
    JSON.stringify(ver && ver.version))
  const loadingHtml = readFileSync(join(INSTALL, 'resources', 'app', 'loading.html'), 'utf8')
  const mainJs = readFileSync(join(INSTALL, 'resources', 'app', 'main.js'), 'utf8')
  check('P9 壳文件按包替换（loading.html 改名 + main.js 是本轮修复版）',
    loadingHtml.indexOf('AnzioAgent 正在启动') >= 0 && mainJs.indexOf('ANZIO_DSH_URL') >= 0,
    JSON.stringify({ loading: loadingHtml.indexOf('AnzioAgent 正在启动') >= 0, main: mainJs.indexOf('ANZIO_DSH_URL') >= 0 }))
  check('P9b staging 已清理（不留垃圾）', !existsSync(join(INSTALL, '_staging', 'v' + latest.version)), 'staging 仍在')

  // 新版本自己被拉起来了：后端应就绪，且 dsh-ide 插件挂载（= 用的是应用自己的 home）
  let initOk = false
  for (let k = 0; k < 60 && !initOk; k++) {
    await sleep(1000)
    try {
      const r = await fetch(APP + '/dsh-ide/init')
      initOk = r.ok
    } catch { /* 后端还没起 */ }
  }
  check('P10 自动重启后后端就绪且 dsh-ide 插件挂载（/dsh-ide/init 200）', initOk, 'not mounted')

  // 版本号已更新；因为重启参数被保留（--remote-debugging-port），新实例仍可连
  const t2 = await cdpTarget()
  if (!t2) {
    killApp()
    await sleep(2500)
    launchApp()
    const t3 = await cdpTarget()
    if (t3) await connect(t3)
  } else {
    await connect(t2)
  }
  const ui = await waitFor(`(function(){
    var b=document.querySelector('.dside-upd');
    var root=!!document.querySelector('.dside-root');
    return (root && b) ? JSON.stringify({ root: root, badge: b.textContent, url: location.href, len: document.body.innerText.length }) : null; })()`, 60000)
  const u = ui ? JSON.parse(ui) : null
  check('P11 窗口直接进 IDE（token 修复：不再是 401 空白页）', !!(u && u.root && u.len > 100), JSON.stringify(u))
  check('P12 标题栏版本徽标 = 新版本', !!(u && u.badge === 'v' + latest.version), JSON.stringify(u && u.badge))
} catch (e) {
  check('E2E 执行未中断', false, String((e && e.message) || e))
} finally {
  const pass = results.filter((r) => r.ok).length
  console.log(`\n== ${pass}/${results.length} PASS ==`)
  try { if (ws) ws.close() } catch { /* 忽略 */ }
  process.exit(pass === results.length ? 0 : 2)
}
