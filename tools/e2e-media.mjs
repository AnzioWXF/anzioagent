import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// e2e-media.mjs — 媒体预览 E2E（2026-09-23，用户报障"天工打不开图片"→ 对齐 VSCode）
//
// 覆盖（每条都对应一个**可量化的运行时真相**，不是"看起来对"）：
//   · /raw-file 原始字节路由：按扩展名给 MIME + 支持 Range（206 / content-range / 字节一致）
//   · 图片：双击树里的 .png → 出预览而不是文本编辑器；浏览器真的解码成功（naturalWidth）；
//           默认"适应窗口"；＋ 按 VSCode 的 zoomLevels 逐档（1→1.5→2→3）；≥3 倍上 pixelated；
//           点击"适应窗口"回 fit；＋/－ 与状态栏尺寸
//   · SVG：默认走图片预览；「以文本打开」→ monaco 里有源码；「以预览打开」→ 回到预览
//   · 二进制：.bin（含 \0）→ VSCode 那套占位卡（不是报错、更不是把标签关掉）；
//           「仍以文本方式打开」→ 强制按文本读出内容
//   · 音频（真 WAV）/视频（按扩展名路由）→ 原生 controls 元素
// 用法: pwsh -File tools\run-e2e.ps1 -Suites e2e-media.mjs
//   或: node tools\e2e-media.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, rmSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const PORT = Number(process.env.DSH_E2E_PORT || 3098)
const APP = 'http://127.0.0.1:' + PORT
const HOME_DIR = process.env.DSH_E2E_HOME || `${__TIANGONG_ROOT}\\.smoke-home-media`
const WS = process.env.DSH_E2E_WS || `${__TIANGONG_ROOT}\\.smoke-ws-media`
const CLI = `${__TIANGONG_ROOT}\\deepseek-harness-mine\\harness\\apps\\cli\\lib\\bin.js`
const BLOG = `${__TIANGONG_ROOT}\\_e2emedia_backend_` + PORT + '.log'
const CDP_PORT = 9700 + Math.floor(Math.random() * 80)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 造 fixture：不引第三方依赖，PNG 手写编码器（顺便把编码正确性交给浏览器校验）──
function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0   // 8bit RGBA
  const stride = w * 4 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0                                                // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 4
      raw[o] = (x * 16) & 0xff; raw[o + 1] = (y * 16) & 0xff; raw[o + 2] = 128; raw[o + 3] = 255
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ])
}
function makeWav() {
  const samples = 16, dataLen = samples * 2
  const b = Buffer.alloc(44 + dataLen)
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(dataLen, 40)
  return b
}
const PNG = makePng(16, 16)
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="20" viewBox="0 0 32 20">'
  + '<rect width="32" height="20" fill="#204080"/><circle cx="16" cy="10" r="6" fill="#e0e0ff"/></svg>\n'
const BIN = Buffer.concat([Buffer.from('BINHEAD'), Buffer.from([0, 1, 2, 0, 255, 254, 0]), Buffer.from('TAIL')])
const WAV = makeWav()
// 视频只验"按扩展名路由 + 元素存在"：手搓一个能被 Chromium 解码的 mp4 不现实，
// 所以这里给一个假的 mp4，断言写成"元素在 / 或走到加载失败分支"（两条都证明没走文本编辑器）。
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 7)])

const FILES = {
  'pic.png': PNG, 'icon.svg': SVG, 'blob.bin': BIN, 'tone.wav': WAV, 'clip.mp4': MP4, 'note.txt': 'plain\n',
}
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' :: ' + String(detail ?? '')}`)
}
function cleanEnv() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('DSH_')) env[k] = v
  env.DSH_HOME = HOME_DIR
  return env
}
function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]
  for (const c of cands) if (existsSync(c)) return c
  throw new Error('no edge/chrome found')
}
function killTree(pid) { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ } }

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
  // 临时浏览器 profile 一律落 temp（00devCore §0.5），别落 <仓库根> 根
  const userDir = `${__TIANGONG_ROOT}\\temp\\.edge-e2emedia-tmp-` + process.pid
  try {
    let token = ''
    const t0 = Date.now()
    while (Date.now() - t0 < 120000) {
      await sleep(500)
      if (backendExit !== null) throw new Error('backend exited early (' + backendExit + ') — 端口 ' + PORT + ' 被占用？')
      let txt = ''
      try { txt = readFileSync(BLOG, 'utf8') } catch { /* not yet */ }
      const m = txt.match(/\?token=([A-Za-z0-9._-]+)/)
      if (m) { token = m[1]; break }
    }
    if (!token) throw new Error('no token in backend log')

    // ── fixture 工作区 ────────────────────────────────────────────────────
    rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
    mkdirSync(WS, { recursive: true })
    for (const [name, buf] of Object.entries(FILES)) writeFileSync(WS + '\\' + name, buf)

    // ── host 路由（不经浏览器，直接对后端断言）───────────────────────────
    const url = (f) => APP + '/dsh-ide/raw-file?path=' + encodeURIComponent(WS + '\\' + f)
    const full = await fetch(url('pic.png'))
    const fullBuf = Buffer.from(await full.arrayBuffer())
    check('H1 /raw-file 回 PNG 原始字节 + image/png + accept-ranges（与磁盘 sha 一致）',
      full.status === 200 && full.headers.get('content-type') === 'image/png'
      && full.headers.get('accept-ranges') === 'bytes' && sha(fullBuf) === sha(PNG),
      JSON.stringify({ status: full.status, ct: full.headers.get('content-type'), n: fullBuf.length, sha: sha(fullBuf), want: sha(PNG) }))

    const ranged = await fetch(url('pic.png'), { headers: { Range: 'bytes=0-9' } })
    const rangedBuf = Buffer.from(await ranged.arrayBuffer())
    check('H2 /raw-file 支持 Range：206 + content-range + 只回 10 字节（媒体拖进度条靠它）',
      ranged.status === 206 && ranged.headers.get('content-range') === 'bytes 0-9/' + PNG.length
      && rangedBuf.length === 10 && rangedBuf.equals(PNG.subarray(0, 10)),
      JSON.stringify({ status: ranged.status, cr: ranged.headers.get('content-range'), n: rangedBuf.length }))

    const tailRange = await fetch(url('tone.wav'), { headers: { Range: 'bytes=-4' } })
    const tailBuf = Buffer.from(await tailRange.arrayBuffer())
    check('H3 后缀 Range（bytes=-4）按 VSCode/RFC 语义取末尾 4 字节',
      tailRange.status === 206 && tailBuf.equals(WAV.subarray(WAV.length - 4)),
      JSON.stringify({ status: tailRange.status, cr: tailRange.headers.get('content-range') }))

    const mimes = {}
    for (const f of ['icon.svg', 'tone.wav', 'clip.mp4']) {
      const r = await fetch(url(f), { method: 'HEAD' })
      mimes[f] = r.headers.get('content-type')
    }
    check('H4 MIME 按扩展名给：svg=image/svg+xml · wav=audio/wav · mp4=video/mp4（照抄 VSCode media-preview 的 selector）',
      mimes['icon.svg'] === 'image/svg+xml' && mimes['tone.wav'] === 'audio/wav' && mimes['clip.mp4'] === 'video/mp4',
      JSON.stringify(mimes))

    const binRead = await (await fetch(APP + '/dsh-ide/read-file?path=' + encodeURIComponent(WS + '\\blob.bin'))).json()
    check('H5 /read-file 对二进制回 415 + code=FS_NOT_TEXT（不是 500，client 靠它渲染占位卡）',
      binRead && binRead.code === 'FS_NOT_TEXT' && binRead.binary === true && typeof binRead.size === 'number',
      JSON.stringify({ code: binRead && binRead.code, size: binRead && binRead.size }))

    const forced = await (await fetch(APP + '/dsh-ide/read-file?path=' + encodeURIComponent(WS + '\\blob.bin') + '&force=1')).json()
    check('H6 /read-file?force=1（VSCode 的 Open Anyway）按文本读出内容（含 BINHEAD）',
      forced && typeof forced.content === 'string' && forced.content.indexOf('BINHEAD') >= 0,
      JSON.stringify({ has: forced && typeof forced.content === 'string', len: forced && forced.content && forced.content.length }))

    // ── 浏览器 ────────────────────────────────────────────────────────────
    try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch { /* 文件锁 */ }
    browser = spawn(findBrowser(), [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
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
    if (!target) throw new Error('CDP target not found')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect error')) })
    let msgId = 0
    const pending = new Map()
    let wsDead = false
    const pageErrors = []
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails
        pageErrors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 160))
      }
    }
    ws.onclose = () => { wsDead = true; for (const [, f] of pending) f({ error: { message: 'ws closed' } }); pending.clear() }
    function cdp(method, params, timeoutMs) {
      if (wsDead) return Promise.reject(new Error('CDP ws dead'))
      return new Promise((resolve, reject) => {
        const id = ++msgId
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, timeoutMs || 20000)
        pending.set(id, (m) => { clearTimeout(timer); resolve(m.result || { error: m.error }) })
        try { ws.send(JSON.stringify({ id, method, params: params || {} })) } catch (e) { clearTimeout(timer); reject(e) }
      })
    }
    async function evalJs(expr) {
      const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval threw' }
      return r.result && r.result.value
    }
    async function waitFor(expr, ms) {
      const t = Date.now()
      while (Date.now() - t < ms) { const v = await evalJs(expr); if (v) return v; await sleep(200) }
      return null
    }
    async function clickAt(x, y) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await sleep(80)
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(300)
    }
    // 双击（真鼠标）：clickCount 2 的按下/抬起 —— 树里"双击 = 固定打开"
    async function dblclickAt(x, y) {
      await clickAt(x, y)
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 })
      await sleep(400)
    }
    async function rectOf(sel) {
      return evalJs(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
        var r=e.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), w: Math.round(r.width), h: Math.round(r.height) } })()`)
    }
    // 人眼复核用的截图（都在 _e2e-logs，收工不看也不影响结论）
    async function shot(name) {
      try {
        const r = await cdp('Page.captureScreenshot', { format: 'png' })
        if (r && r.data) writeFileSync(`${__TIANGONG_ROOT}\\_e2e-logs\\` + name + '.png', Buffer.from(r.data, 'base64'))
      } catch { /* 截图失败不影响断言 */ }
    }
    async function openNode(name) {
      const r = await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-node-name');
        for (var i=0;i<ns.length;i++){ if (ns[i].textContent.trim()===${JSON.stringify(name)}){ var e=ns[i].parentElement; var b=e.getBoundingClientRect();
          return { x: Math.round(b.left+30), y: Math.round(b.top+b.height/2) } } } return null })()`)
      if (!r) return false
      await dblclickAt(r.x, r.y)
      return true
    }
    // 预览器的运行时形状（一条探针拿全，避免多次往返）
    const probe = `(function(){
      var img=document.querySelector('.dside-media-img'), box=document.querySelector('.dside-media');
      var zoom=document.querySelector('.dside-media-zoom');
      var bar=document.querySelector('.dside-media-bar');
      var sb=document.querySelector('.dside-statusbar');
      var tabs=document.querySelectorAll('.dside-tab').length;
      var viewLines=document.querySelectorAll('.dside-editor-monaco .view-lines').length;
      var binCard=document.querySelector('.dside-binary-card');
      return {
        hasMedia: !!box, mediaCls: box? box.className : null,
        img: img? { cls: img.className, zoom: img.style.zoom||'', nw: img.naturalWidth, nh: img.naturalHeight, cw: img.clientWidth } : null,
        zoomLabel: zoom? zoom.textContent : null,
        barText: bar? bar.textContent : null,
        status: sb? sb.textContent : '',
        tabs: tabs, viewLines: viewLines,
        audio: !!document.querySelector('.dside-media-audio'),
        video: !!document.querySelector('.dside-media-video'),
        mediaMsg: (document.querySelector('.dside-media-msg')||{}).textContent||'',
        binText: binCard? binCard.textContent : null,
        monacoText: (function(){ try { return window.monaco.editor.getModels().map(function(m){ return m.getValue().slice(0,120) }).join('\\n') } catch(e){ return '' } })(),
      } })()`

    await cdp('Runtime.enable')
    await cdp('Page.enable')
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 90000)
    check('P1 页面挂载完成', !!ready)

    let rootOk = false
    for (let i = 0; i < 12 && !rootOk; i++) {
      await fetch(APP + '/dsh-ide/active-root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: WS }) })
      await sleep(700)
      rootOk = await evalJs(`(function(){ var ns=document.querySelectorAll('.dside-node-name'); for (var i=0;i<ns.length;i++){ if (ns[i].textContent.trim()==='pic.png') return true } return false })()`)
    }
    check('P2 工作区根已生效（树里能看到 fixture）', rootOk)

    // ── 图片 ──────────────────────────────────────────────────────────────
    check('P3 双击 pic.png 打开（树里找得到这个节点）', await openNode('pic.png'))
    let st = await waitFor(`(function(){ var p=${probe}; return p.img && p.img.nw===16 ? p : null })()`, 15000)
    check('P4 图片预览出图且浏览器真的解码成功（16×16，不是文本编辑器里的一堆乱码）',
      !!st && st.img.nw === 16 && st.img.nh === 16 && st.viewLines === 0,
      JSON.stringify(st && { img: st.img, viewLines: st.viewLines, cls: st.mediaCls }))
    check('P5 初始态 = 适应窗口（fit 类 + 无 style.zoom + 工具条文案"适应窗口"）',
      !!st && /(^|\s)fit(\s|$)/.test(st.img.cls) && st.img.zoom === '' && st.zoomLabel === '适应窗口',
      JSON.stringify(st && { cls: st.img.cls, zoom: st.img.zoom, label: st.zoomLabel }))
    check('P6 工具条给出真实尺寸与体积（"16×16" + 字节数；VSCode 那边是状态栏的 size 条目）',
      !!st && st.barText.indexOf('16×16') >= 0 && /\d/.test(st.barText),
      JSON.stringify(st && st.barText))

    const plus = await rectOf('.dside-media-bar button[title^="放大"]')
    check('P7 工具条有放大/缩小/适应窗口三个按钮', !!plus, JSON.stringify(plus))
    await clickAt(plus.x, plus.y); await sleep(300)
    let st1 = await evalJs(probe)
    await clickAt(plus.x, plus.y); await sleep(300)
    let st2 = await evalJs(probe)
    await clickAt(plus.x, plus.y); await sleep(300)
    let st3 = await evalJs(probe)
    check('P8 ＋ 按 VSCode 的 zoomLevels 逐档：1 → 1.5 → 2 → 3（不是自造的比例）',
      st1.img.zoom === '1.5' && st2.img.zoom === '2' && st3.img.zoom === '3',
      JSON.stringify({ a: st1.img.zoom, b: st2.img.zoom, c: st3.img.zoom }))
    check('P9 缩放 ≥3 倍自动上 image-rendering:pixelated（VSCode 的 PIXELATION_THRESHOLD=3）',
      /pixelated/.test(st3.img.cls), JSON.stringify(st3.img.cls))

    const fit = await rectOf('.dside-media-bar button[title="适应窗口"]')
    await clickAt(fit.x, fit.y); await sleep(300)
    const stFit = await evalJs(probe)
    check('P10 点「适应窗口」回到 fit（zoom 清空 + fit 类回来）',
      /(^|\s)fit(\s|$)/.test(stFit.img.cls) && stFit.img.zoom === '', JSON.stringify({ cls: stFit.img.cls, zoom: stFit.img.zoom }))

    const zoomLabel = await rectOf('.dside-media-zoom')
    await clickAt(zoomLabel.x, zoomLabel.y); await sleep(300)
    const menuItems = await evalJs(`document.querySelectorAll('.dside-menu .dside-menu-item').length`)
    check('P11 点缩放比例能选级别（VSCode zoomStatusBarEntry 的 7 档：10/5/2/1/0.5/0.2/适应）',
      menuItems === 7, String(menuItems))
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    const imgBox = await rectOf('.dside-media-img')
    await clickAt(imgBox.x, imgBox.y); await sleep(300)
    const stClick = await evalJs(probe)
    check('P12 点图 = 放大（VSCode 手感；比例落在 zoomLevels 上）',
      stClick.img.zoom !== '' && /^1(\.5)?$|^[23]$|^5$/.test(stClick.img.zoom), JSON.stringify(stClick.img.zoom))
    await shot('media-image')

    // ── SVG：预览 ↔ 文本 ──────────────────────────────────────────────────
    check('P13 双击 icon.svg 打开', await openNode('icon.svg'))
    const stSvg = await waitFor(`(function(){ var p=${probe}; return p.hasMedia ? p : null })()`, 10000)
    check('P14 SVG 默认走图片预览（不是直接把源码丢进编辑器；VSCode 的 imagePreview 也吃 .svg）',
      !!stSvg && !!stSvg.img, JSON.stringify(stSvg && { mediaCls: stSvg.mediaCls }))
    const toText = await rectOf('.dside-media-bar button[title^="以文本方式打开"]')
    check('P15 SVG 预览工具条上有「以文本打开」', !!toText, JSON.stringify(toText))
    await clickAt(toText.x, toText.y); await sleep(1200)
    const stSvgText = await evalJs(probe)
    check('P16 切到文本：monaco 里是真正的 SVG 源码，且预览层已撤掉',
      !stSvgText.hasMedia && stSvgText.viewLines > 0 && stSvgText.monacoText.indexOf('<svg') >= 0,
      JSON.stringify({ hasMedia: stSvgText.hasMedia, viewLines: stSvgText.viewLines, txt: stSvgText.monacoText }))
    const backBtn = await rectOf('.dside-editor-meta button[title^="以图片预览方式打开"]')
    check('P17 文本态有回到预览的入口（VSCode 把这条放在编辑器标题栏）', !!backBtn, JSON.stringify(backBtn))
    await clickAt(backBtn.x, backBtn.y); await sleep(1000)
    const stSvgBack = await evalJs(probe)
    check('P18 点回去又变成预览', stSvgBack.hasMedia && !!stSvgBack.img, JSON.stringify({ hasMedia: stSvgBack.hasMedia }))

    // ── 二进制：VSCode 的占位卡 + Open Anyway ─────────────────────────────
    const tabsBeforeBin = (await evalJs(probe)).tabs
    check('P19 双击 blob.bin 打开（含 \\0 的二进制）', await openNode('blob.bin'))
    const stBin = await waitFor(`(function(){ var p=${probe}; return p.binText ? p : null })()`, 10000)
    check('P20 二进制不再报错/关标签，而是 VSCode 那张占位卡（文案 + 标签还在）',
      !!stBin && stBin.binText.indexOf('不是文本') >= 0 && stBin.binText.indexOf('仍以文本方式打开') >= 0 && stBin.tabs >= tabsBeforeBin,
      JSON.stringify(stBin && { binText: stBin.binText, tabs: stBin.tabs, before: tabsBeforeBin }))
    await shot('media-binary')
    const anyway = await rectOf('.dside-binary-card button')
    check('P21 占位卡上有「仍以文本方式打开」（VSCode 的 Open Anyway）', !!anyway, JSON.stringify(anyway))
    await clickAt(anyway.x, anyway.y); await sleep(1500)
    const stForced = await evalJs(probe)
    check('P22 点它 = 强制按文本读出内容（BINHEAD/TAIL 能看到），占位卡消失',
      !stForced.binText && stForced.viewLines > 0 && stForced.monacoText.indexOf('BINHEAD') >= 0,
      JSON.stringify({ binText: stForced.binText, viewLines: stForced.viewLines, txt: stForced.monacoText }))

    // ── 音频 / 视频 ───────────────────────────────────────────────────────
    check('P23 双击 tone.wav 打开', await openNode('tone.wav'))
    const stWav = await waitFor(`(function(){ var p=${probe}; return p.audio ? p : null })()`, 10000)
    check('P24 音频预览 = 原生 <audio controls>（真 WAV 能加载，所以停在音频分支而不是错误分支）',
      !!stWav && stWav.audio && stWav.mediaMsg === '', JSON.stringify(stWav && { audio: stWav.audio, msg: stWav.mediaMsg }))

    // 假 mp4 必然解码失败 → <video> 很快被"加载失败"分支替掉。所以在打开**之前**挂个
    // MutationObserver 把它的 src 记下来（微任务时机早于媒体错误事件，抓得到）
    await evalJs(`(function(){ window.__vidSrc=null; window.__vidMo=new MutationObserver(function(){
      var v=document.querySelector('.dside-media-video'); if(v && !window.__vidSrc) window.__vidSrc=v.getAttribute('src'); });
      window.__vidMo.observe(document.body,{childList:true,subtree:true}); return 1 })()`)
    check('P25 双击 clip.mp4 打开', await openNode('clip.mp4'))
    await sleep(1500)
    const stMp4 = await evalJs(probe)
    const videoSrc = await evalJs('window.__vidSrc')
    check('P26 视频按扩展名路由到视频预览（<video controls> 出现过，或走到"视频加载失败"分支 —— 两条都不进文本编辑器）',
      !!stMp4 && (stMp4.video || !!videoSrc || stMp4.mediaMsg.indexOf('视频') >= 0),
      JSON.stringify({ video: stMp4 && stMp4.video, captured: !!videoSrc, msg: stMp4 && stMp4.mediaMsg }))
    check('P27 视频 src 指向 /dsh-ide/raw-file（不是 file:// 也不是数据里塞 base64）',
      typeof videoSrc === 'string' && videoSrc.indexOf('/dsh-ide/raw-file') === 0,
      String(videoSrc))

    // ── 文本文件不受影响（回归）────────────────────────────────────────────
    check('P28 双击 note.txt 仍是普通文本编辑器（预览层撤掉、有源码行）', await openNode('note.txt'))
    const stTxt = await evalJs(probe)
    check('P29 文本文件没被媒体逻辑劫持', !stTxt.hasMedia && !stTxt.binText && stTxt.viewLines > 0 && stTxt.monacoText.indexOf('plain') >= 0,
      JSON.stringify({ hasMedia: stTxt.hasMedia, viewLines: stTxt.viewLines, txt: stTxt.monacoText }))

    await sleep(1600)
    let traced = false
    try {
      const log = readFileSync(HOME_DIR + '\\logs\\ide-trace.log', 'utf8')
      traced = log.indexOf('"open-media"') >= 0 && log.indexOf('"open-binary-placeholder"') >= 0 && log.indexOf('"open-anyway"') >= 0
    } catch { /* ignore */ }
    check('P30 埋点齐（open-media / open-binary-placeholder / open-anyway）', traced)
    check('P31 零未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } catch (e) {
    check('套件执行完成', false, e && e.stack ? e.stack : String(e))
  } finally {
    if (browser) killTree(browser.pid)
    killTree(backend.pid)
    await sleep(600)
    try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch { /* 文件锁 */ }
    try { rmSync(BLOG, { force: true }) } catch { /* ignore */ }
    rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
    const pass = results.filter((r) => r.ok).length
    console.log('\n===== 媒体预览 E2E: ' + pass + '/' + results.length + ' =====')
    const failed = results.filter((r) => !r.ok)
    if (failed.length) console.log('FAILED: ' + failed.map((r) => r.name).join(' | '))
  }
}
main()
