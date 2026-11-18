// DSH IDE — Host 半（正式后端服务）
//
// 挂载于 profile 组合（cordis.patch.yml）。注册 /dsh-ide/* JSON API：
//   - 工作区与动态插件概览、目录列表、文件读写
//   - 动态插件清单与管理（停止 / 运行 / 删除）、正式插件清单
// Agent 对话已不经过本服务：client 半直接用官方 ctx.sessions（列表/历史/
// 流式/发消息），/agent-state、/agent-send 已退役（2026-08-20）。
// Client 半（lib/client.js）经浏览器 fetch 调用这些 API。
//
// 另注册 /dsh-ide/monaco/* 静态资源：monaco-editor@0.56.0 的 min/vs 构建
// （npm 包提取，随插件目录镜像到应用）。client 半用 script 标签加载，
// 绕过 client bundle 纯度门禁（monaco 不在模块白名单，见 00devCore §7）。
// 另注册 /dsh-ide/themes/*：④ 编辑器主题 JSON（买的 VS Code 官方默认
// Dark/Light Modern，已拍平 include 链自包含，来源 microsoft/vscode
// theme-defaults，MIT）。client 半启动时 fetch，把 colors/tokenColors
// 合并进 monaco defineTheme（界面皮肤仍走 --dsw-* token）。

import { createRequire } from 'node:module'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createReadStream, watch, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { defineTool } from './tool-def.js'
import { createSshManager, sshAvailable, sshLoadError } from './ssh.js'

const ROUTE_PREFIX = '/dsh-ide'

// 工具被终止时（用户按停止）要能立刻放手：exec.signal 由工具包装层带到 browserCall。
// 为什么用隐式上下文而不是逐个调用点传参：浏览器工具有 19 处 browserCall，漏一处就是
// "别的工具都停了、这一个还在等 50 秒"，而且漏了不报错，只能靠人记得（2026-11-17）。
const toolAbortSignal = new AsyncLocalStorage()

/** Run a tool body with its abort signal reachable from browserCall. */
function withToolSignal(exec, run) {
  const signal = exec === null || exec === undefined ? undefined : exec.signal
  return signal === undefined || signal === null ? run() : toolAbortSignal.run(signal, run)
}

// monaco 静态资源根（相对本文件：../static/monaco；URL /dsh-ide/monaco/<p>
// 与根下目录树一一对应，min/vs 即 monaco-editor@0.56.0 的 AMD 构建）
const MONACO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'monaco')
// ④ 编辑器主题 JSON 根（../static/themes；URL /dsh-ide/themes/<mode>-modern.json）
const THEMES_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'themes')

// ⑬ xterm.js（vendor 进来的终端前端：xterm.js / xterm.css / addon-fit.js，MIT）
const XTERM_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'xterm')

const STATIC_MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.map': 'application/json; charset=utf-8',
}

// ── 媒体预览用的 MIME 表（2026-09-23 用户要求"跟 VSCode 一样能看图"）─────────
// 扩展名清单**照抄 VSCode 内置 media-preview 扩展的 customEditors selector**
// （本地源码 D:\04other\vscode-src\extensions\media-preview\package.json）：
//   imagePreview.previewEditor → *.{jpg,jpe,jpeg,png,bmp,gif,ico,webp,avif,svg}
//   vscode.audioPreview        → *.{mp3,wav,ogg,oga}
//   vscode.videoPreview        → *.{mp4,webm}
const MEDIA_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

// VSCode「Open Anyway」的上限（它那边由 files.maxMemoryForLargeFilesMB 兜底，我们给个保守值）
const FORCE_TEXT_MAX = 16 * 1024 * 1024

// root: 静态根目录；label: 日志标识；immutableCache: 稳定内容走强缓存
// （monaco 资源名带内容哈希、稳定名走 client 的 ?v= 破缓存 → immutable 1 年；
// themes 内容随插件版本变、client 亦带 ?v=，宽松缓存即可）
// ── 历史对话内容搜索（2026-09-17 用户要求）────────────────────────────────
// 为什么自己实现：平台 client 有 `sessions.search` 契约，但 **host 侧没有对应的检索/索引服务**
// （用 cordis_inspect 查 host 服务目录确认：只有 in-memory 的 sessions store，没有任何会话检索服务），
// 实测那个调用**永远返回空数组**。所以直接读会话日志：
//   <DSH_HOME>/sessions/<cwd 编码>/<sessionId>/session.v3.jsonl.zstd
// 它是**多帧 zstd**（每批写入一帧）：按 magic(28 B5 2F FD) 切帧、逐帧解、拼成 JSONL，
// 只提取消息正文（user/assistant 的 text 块，跳过系统注入的 user/message）。
// 解压结果按 (mtimeMs,size) 缓存 → 重复搜索几乎零成本。
const SESSION_TEXT_CACHE = new Map()   // 文件路径 -> { mtimeMs, size, text }
const ZM0 = 0x28
const ZM1 = 0xb5
const ZM2 = 0x2f
const ZM3 = 0xfd

function decodeSessionLog(file) {
  const st = statSync(file)
  const hit = SESSION_TEXT_CACHE.get(file)
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
  const buf = readFileSync(file)
  const offs = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === ZM0 && buf[i + 1] === ZM1 && buf[i + 2] === ZM2 && buf[i + 3] === ZM3) offs.push(i)
  }
  let out = ''
  for (let k = 0; k < offs.length; k += 1) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    try { out += zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8') } catch { /* 坏帧跳过 */ }
  }
  SESSION_TEXT_CACHE.set(file, { mtimeMs: st.mtimeMs, size: st.size, text: out })
  return out
}

/** 从会话 JSONL 里抽出"能被搜到的正文"：只认 user/assistant 消息的 text 块。 */
function messageTextOf(jsonl) {
  const parts = []
  for (const line of jsonl.split('\n')) {
    if (line.length < 2 || line.charCodeAt(0) !== 0x7b) continue   // 只看 '{' 开头的行
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    const t = ev && ev.type
    if (t !== 'user/message' && t !== 'assistant/message') continue
    const src = ev.source || (ev.data && ev.data.source)
    if (t === 'user/message' && src && src.kind !== 'user') continue   // 系统注入的不算"对话内容"
    const msg = ev.message || ev.data || ev
    const content = msg && msg.content
    if (Array.isArray(content)) {
      for (const c of content) if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    } else if (typeof content === 'string') parts.push(content)
  }
  return parts.join('\n')
}

/** 列出家目录下所有会话文件（最近的优先）。 */
function sessionFilesUnder(home) {
  const out = []
  const root = path.join(home, 'sessions')
  let dirs = []
  try { dirs = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const sub = path.join(root, d.name)
    let ids = []
    try { ids = readdirSync(sub, { withFileTypes: true }) } catch { continue }
    for (const s of ids) {
      if (!s.isDirectory()) continue
      const f = path.join(sub, s.name, 'session.v3.jsonl.zstd')
      try {
        const st = statSync(f)
        if (st.isFile()) out.push({ file: f, sessionId: s.name, mtimeMs: st.mtimeMs })
      } catch { /* 没有日志就跳过 */ }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/** 在所有会话日志里搜 query，返回 { ok, items:[{sessionId,snippet,time}], hasMore, scanned }。 */
function searchSessionLogs(home, query, limit) {
  const ql = query.toLowerCase()
  const items = []
  let scanned = 0
  let hasMore = false
  for (const s of sessionFilesUnder(home)) {
    scanned += 1
    let text = ''
    try { text = messageTextOf(decodeSessionLog(s.file)) } catch { continue }
    if (!text) continue
    const flat = text.replace(/\s+/g, ' ')
    const at = flat.toLowerCase().indexOf(ql)
    if (at < 0) continue
    const snippet = flat.slice(Math.max(0, at - 40), Math.min(flat.length, at + ql.length + 160)).trim()
    items.push({ sessionId: s.sessionId, snippet, time: s.mtimeMs })
    if (items.length >= limit) { hasMore = true; break }
  }
  return { ok: true, items, hasMore, scanned }
}

async function serveStatic(req, res, rel, root, label, immutableCache) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    return res.end()
  }
  let decoded = ''
  try { decoded = decodeURIComponent(rel) } catch { /* 非法编码 → 走 404 */ }
  // 防目录穿越：normalize 后必须仍在静态根内
  const target = path.normalize(path.join(root, decoded))
  if (target !== root && !target.startsWith(root + path.sep)) {
    console.error(`[dsh-ide] ${label} guard 404`, JSON.stringify({ root, rel: decoded, target }))
    res.writeHead(404)
    return res.end('not found')
  }
  try {
    const info = await stat(target)
    if (!info.isFile()) {
      console.error(`[dsh-ide] ${label} not-file`, target)
      res.writeHead(404)
      return res.end('not found')
    }
    const ext = path.extname(target).toLowerCase()
    res.writeHead(200, {
      'content-type': STATIC_MIME[ext] || 'application/octet-stream',
      'content-length': info.size,
      'cache-control': immutableCache ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    })
    if (req.method === 'HEAD') return res.end()
    const stream = createReadStream(target)
    stream.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
    stream.pipe(res)
  } catch (e) {
    console.error(`[dsh-ide] ${label} stat/serve 404`, JSON.stringify({ root, rel: decoded, target }), String((e && e.message) || e))
    res.writeHead(404)
    res.end('not found')
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function errOf(e) {
  return String((e && e.message) || e)
}

// 平台 FsError 带 .code（FS_STALE_VERSION 等）：保存冲突要据此回 409 而不是 500
function codeOf(e) {
  const c = e && e.code
  return typeof c === 'string' ? c : undefined
}

// 路径是否落在工作空间根内（Windows 大小写不敏感 + 分隔符边界，防 /root 匹配 /root2）
function isInside(child, parent) {
  const c = path.resolve(child).toLowerCase()
  const p = path.resolve(parent).toLowerCase()
  if (c === p) return false
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

// ── 工作区快照（内容寻址 CAS）+ 一键还原：给实战项目的"反悔药"（2026-09-20）────
// 为什么不能只靠会话事件里的改动清单（⑥ 三刀）：那只覆盖"Agent 用**文件工具**改的东西"，
// Agent 跑 pwsh / npm / 脚本、外部编辑器、git 操作改的磁盘**一律看不见**（§5 ⑥ 下一刀未做项①）。
// 这里改成**扫磁盘**的内容寻址快照：只有内容真变了的文件才落盘（按 sha1 去重），
// git / 非 git 工作区都能用，且**完全不碰用户仓库的状态**（不建 commit、不动 index、不留 ref）。
const SNAP_KEEP = 40                       // 每个工作空间保留的快照份数
const SNAP_MAX_BYTES = 1024 * 1024 * 1024  // 单个工作空间快照库容量上限（超了从最旧开始淘汰）
const SNAP_MAX_FILE = 8 * 1024 * 1024      // 单文件超过 8MB 不进快照（记账为 skipped，不静默漏）
const SNAP_TEXT_MAX = 400 * 1024           // 差异预览单侧文本上限（超过只报尺寸，不塞进 JSON）
const SNAP_COALESCE_MS = 3000              // 这么近的两份快照合并（客户端多处触发，别重复扫盘）
const SNAP_SKIP_MAX = 2000                 // 单份快照最多记账多少个"没进去的文件"（超了整份标记 partial）
const snapBaseDir = () => path.join(process.env.DSH_HOME || process.cwd(), 'snapshots')
// ── 编辑器会话 / Hot Exit 的落盘位置（2026-09-22）──────────────────────────────
// 对齐 VSCode 的 hot exit：**未保存内容备份到磁盘**（VSCode 放用户数据目录，我们放应用家目录）。
// 为什么不放页面的 localStorage：刷盘时机由浏览器决定 —— 实测"setItem 之后立刻 taskkill /F"会把
// 最后几次写整份丢掉，标签和未保存草稿一起没了（见 2026-09-22 日志）。磁盘副本是权威，
// localStorage 退化成"host 不在时的兜底"。路径：<DSH_HOME>/ide-session.json（应用侧 =
// D:\99DSH\app-home\ide-session.json，升级/换版本都不动它）
const sessionFilePath = () => path.join(process.env.DSH_HOME || process.cwd(), 'ide-session.json')
const SESSION_MAX_BYTES = 4 * 1024 * 1024
// 快照/还原要排除的"应用自己的地盘"：工作区根可能是盘符根（如 D:\），那就把应用家目录
// （会话/凭证/设置/日志/快照库）与安装目录一并卷进来 —— "还原"可能覆盖应用自身数据。
// 这几个前缀整棵跳过（2026-09-20，配合"盘符根也能当工作区"那一刀）。
const snapExcludeRoots = () => [
  process.env.DSH_HOME,
  process.env.ANZIO_INSTALL_DIR,
  'D:\\000AnzioAgent',   // 安装目录默认值（§3：更新源/基线/脚本都绑死它）
].filter(Boolean)
const snapWsKey = (root) => createHash('sha1').update(String(root).toLowerCase()).digest('hex').slice(0, 16)
const readDirSafe = async (dir) => { try { return await readdir(dir, { withFileTypes: true }) } catch { return [] } }
const buffered = async (abs) => { try { return await readFile(abs) } catch { return null } }
const fileExists = async (p) => { try { await stat(p); return true } catch { return false } }

// 文本预览：超大 / 二进制（含 \0）都不给文本，只报尺寸与标记
function previewText(buf) {
  if (!buf) return { text: null, size: 0, binary: false }
  const binary = buf.includes(0)
  if (binary || buf.length > SNAP_TEXT_MAX) return { text: null, size: buf.length, binary }
  return { text: buf.toString('utf8'), size: buf.length, binary: false }
}

// 容错列目录（**盘符根专用退路**，2026-09-20）：平台 ctx.fs.listDir 会逐个 stat 每个孩子，
// 任何一个孩子读不了就把**整次列目录**判失败（`FS_PERMISSION_DENIED`，且这是有测试盯着的契约）；
// 而盘符根必然含 `System Volume Information`、`$RECYCLE.BIN` 这类读不了的目录
// → 直接列 `D:\` 会整锅失败、文件树打不开。这里退回到"只 readdir、不探孩子"：
// 只出现在平台版失败时的兜底路径上，读不到的条目跳过，能读的照常列出来。
async function listDirTolerant(dir) {
  let entries = null
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return null }
  const out = []
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    const type = e.isDirectory() ? 'directory' : (e.isFile() ? 'file' : 'other')
    let size = null
    if (type === 'file') { try { size = (await stat(abs)).size } catch { /* 读不到就当普通文件 */ } }
    out.push({ name: e.name, type, size, path: abs })
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'directory' ? -1 : 1)))
  return out
}

// 遍历工作区（与 /tree、/search 同一张忽略表；只走真实文件，符号链接跳过以防环）
// excludeRoots：**绝对路径前缀黑名单** —— 工作区根可能是盘符根（如 D:\），那样会把
// "应用自己的地盘"（DSH_HOME：会话/凭证/设置/日志/快照库，以及安装目录）一并卷进快照，
// 一旦"还原"就可能覆盖应用自身数据。所以按路径把它们整棵跳过（2026-09-20）。
async function walkTree(root, ignoreDirs, maxFiles, excludeRoots) {
  const out = []
  const excl = (excludeRoots || []).map((s) => path.resolve(String(s)).toLowerCase())
  const isExcluded = (abs) => {
    const p = path.resolve(abs).toLowerCase()
    for (const e of excl) {
      if (p === e) return true
      if (p.startsWith(e.endsWith(path.sep) ? e : e + path.sep)) return true
    }
    return false
  }
  const rec = async (dir, depth) => {
    if (depth > 24 || out.length >= maxFiles) return
    for (const e of await readDirSafe(dir)) {
      if (out.length >= maxFiles) return
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (ignoreDirs[e.name]) continue
        if (isExcluded(abs)) continue
        await rec(abs, depth + 1)
      } else if (e.isFile()) {
        try {
          const st = await stat(abs)
          out.push({ abs, rel: path.relative(root, abs), size: st.size, mtime: Math.round(st.mtimeMs) })
        } catch { /* 读不到（占用/权限）就跳过，不打断整次快照 */ }
      }
    }
  }
  await rec(root, 0)
  return out
}

// ── 使用轨迹 / 错误日志（JSONL，供开发台 Agent 直接读取）──────────
// 位置 <DSH_HOME>\logs\ide-trace.log（应用侧 = D:\99DSH\app-home\logs）。
// 用 node:fs 直写：日志属于插件自身存储，不受 ctx.fs 沙箱围栏影响。
// 2026-10-19 落盘纪律（当天统计：20.6 万条 / 33MB，其中 92.8% 是重复噪声）：
//   · 8MB 一份、留 5 份（ide-trace.log + .1~.4）—— 之前从没切过，人已经翻不动了
//   · 单行超长先丢 meta 再截 msg，不再整条静默丢（丢了等于"那一下没发生"）
//   · 优先用采集端时间戳：client 是 800ms 攒批上报，落盘时刻会把一批压成同一毫秒
const TRACE_DIR = path.join(process.env.DSH_HOME || process.cwd(), 'logs')
const TRACE_LOG = path.join(TRACE_DIR, 'ide-trace.log')
const TRACE_MAX_BYTES = 8 * 1024 * 1024
const TRACE_KEEP = 4                  // 轮转保留 .1 ~ .4
const TRACE_LINE_MAX = 8192
let traceQueue = Promise.resolve()
let traceBytes = null                 // null = 还没量过当前文件大小
const traceGates = new Map()          // 高频同类条目合并用（见 traceThrottled）

// 单行兜底：超长先砍 meta，再截 msg；仍然超长（极端路径）才放弃
function fitTraceLine(obj) {
  let line = JSON.stringify(obj)
  if (line.length <= TRACE_LINE_MAX) return line
  const slim = Object.assign({}, obj, { msg: '', dropped: 'too-long' })
  delete slim.meta
  const room = TRACE_LINE_MAX - JSON.stringify(slim).length - 2
  slim.msg = String(obj.msg || '').slice(0, Math.max(0, room))
  line = JSON.stringify(slim)
  return line.length <= TRACE_LINE_MAX ? line : null
}

async function rotateTrace() {
  // Windows 的 rename 目标已存在会失败：先删目标再挪（必须 await，同步写法会变成竞态）
  for (let i = TRACE_KEEP; i >= 1; i--) {
    const from = i === 1 ? TRACE_LOG : TRACE_LOG + '.' + (i - 1)
    const to = TRACE_LOG + '.' + i
    try { await rm(to, { force: true }) } catch { /* 目标不存在 */ }
    try { await rename(from, to) } catch { /* 这一份不存在 */ }
  }
  traceBytes = 0
}

function trace(entry) {
  try {
    if (!entry || typeof entry !== 'object') return
    const at = Number(entry.ts)
    const ts = at > 0 && at <= Date.now() + 60000 ? new Date(at).toISOString() : new Date().toISOString()
    const { ts: _drop, ...rest } = entry
    const line = fitTraceLine(Object.assign({}, rest, { ts, src: rest.src || 'host' }))
    if (!line) return
    traceQueue = traceQueue.then(async () => {
      try {
        if (traceBytes === null) {
          try { traceBytes = (await stat(TRACE_LOG)).size } catch { traceBytes = 0 }
        }
        const bytes = Buffer.byteLength(line) + 1
        if (traceBytes + bytes > TRACE_MAX_BYTES) await rotateTrace()
        await mkdir(TRACE_DIR, { recursive: true })
        await appendFile(TRACE_LOG, line + '\n')
        traceBytes += bytes
      } catch { /* 日志失败不干扰业务 */ }
    })
  } catch { /* 日志失败不干扰业务 */ }
}

// 高频同类条目合并：窗口内只落第一条，下一次落时把被压掉的条数带上。
// 用在"同一个错误每秒重复一遍"这类地方（例如盘符根上读不到系统目录），
// 否则真问题会被埋掉 —— 判据是这条记录重复一万遍也不会多出任何信息。
function traceThrottled(key, windowMs, entry) {
  const now = Date.now()
  const prev = traceGates.get(key)
  if (prev && now - prev.at < windowMs) { prev.suppressed += 1; return }
  const meta = Object.assign({}, entry.meta || {})
  if (prev && prev.suppressed > 0) meta.suppressed = prev.suppressed
  trace(Object.assign({}, entry, { meta }))
  if (traceGates.size > 500) traceGates.clear()
  traceGates.set(key, { at: now, suppressed: 0 })
}

export default {
  // 全部服务显式 inject（比 ctx.get 更可靠，等待服务就绪；profile 行作用域
  // 内 ctx.get 对部分服务（webServer/workspaceRegistry/clientModules 等）会
  // 拿到 undefined 而静默降级）。这些服务都在 web profile 组合中，缺失时
  // 本行会保持 waiting 而不是错误降级。
  inject: ['webServer', 'fs', 'agents', 'workspaceRegistry', 'sandboxPolicy', 'dynamicCordisRunner', 'clientModules', 'llm', 'tools', 'sessions'],
  apply(ctx) {
    trace({ level: 'info', kind: 'boot', msg: 'dsh-ide host 启动', home: process.env.DSH_HOME || null })
    const webServer = ctx.webServer

    const fsService = ctx.fs
    const agentsService = ctx.agents
    const workspaceRegistry = ctx.workspaceRegistry
    const sandboxPolicy = ctx.sandboxPolicy
    const runner = ctx.dynamicCordisRunner
    const clientModules = ctx.clientModules
    const sessionsService = ctx.sessions

    let activeRoot = null // client 上报的"当前活动工作空间"（跟随当前会话 cwd）

    // ── 给 Agent 的"加一门语言"工具（模型可见）─────────────────────────────
    // 形状（用户定的）：Agent 发现这门语言没有导航 → 自己查该装什么 → 用自己的提问工具
    // 问用户 → 用户点头 → 调这个工具 → 装好并追加装配单（热加载，立即生效）→ 重试查询。
    // 动态 import + try/catch：拿不到平台工具注册器就安静跳过，天工其余功能不受影响。
    let disposeCodeNavTool = null
    ctx.effect(() => () => {
      try { if (typeof disposeCodeNavTool === 'function') disposeCodeNavTool() } catch { /* 忽略 */ }
      disposeCodeNavTool = null
    }, 'dsh-ide: code_nav_install tool')
    Promise.resolve()
      .then(() => {
        if (ctx.tools === undefined || typeof ctx.tools.register !== 'function') {
          trace({ level: 'warn', kind: 'code-nav-tool-skip', reason: 'no-tools-service' })
          return
        }
        const registered = ctx.tools.register(defineTool({
          name: 'code_nav_install',
          description: '给"代码导航"（lsp 工具）加一门语言：从 npm 取该语言的语言服务器（第三方程序），'
            + '按来源官方 sha512 校验，装进应用数据目录，并往装配单追加一行 provider（装配单是热加载的，装完立即生效）。'
            + '**只允许在用户明确同意之后调用**：先用提问工具把"装什么包、从哪来、多大、什么许可证"讲清楚并拿到同意。'
            + '语言服务器叫什么、从哪个包来、映射哪些扩展名，由你自己查（例如 npm view <包名> version / 该语言的官方文档），不要猜。',
          parameters: {
            language: { type: 'string', required: true, description: 'LSP language id，例如 python、go、cpp（写进装配单）' },
            extensions: { type: 'array', required: true, items: { type: 'string' }, description: '要映射的扩展名（小写带点），例如 [".py"]' },
            packages: {
              type: 'array',
              required: true,
              description: 'npm 包（版本可省略 = 取 latest）',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { name: { type: 'string', required: true }, version: { type: 'string' } },
              },
            },
            args: { type: 'array', items: { type: 'string' }, description: '可选：师傅的启动参数（省略则用包自带 bin + --stdio）' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { ok: { type: 'boolean', required: true }, language: { type: 'string', required: true }, detail: { type: 'string', required: true } },
            },
            render: (_args, value) => [{ type: 'text', text: String(value.detail || '') }],
          },
          async execute(rawArgs) {
            const out = await addCodeNavLanguage(rawArgs)
            const pkgs = out.packages
              .map((p) => p.name + '@' + p.version + '（' + p.source + '，许可证 ' + (p.license || '未知') + '，' + Math.round(p.packedBytes / 1024) + 'KB）')
              .join('；')
            const patchText = out.patch.changed
              ? '装配单已追加 ' + out.language + ' 一行（热加载，立即生效）'
              : '装配单里已有 ' + out.language + '，未改动'
            return {
              ok: true,
              language: out.language,
              detail: '已装：' + pkgs + '。' + patchText + '。现在可以重试刚才那次 lsp 查询。',
            }
          },
        }))
        if (typeof registered === 'function') disposeCodeNavTool = registered
        trace({ level: 'info', kind: 'code-nav-tool-ready' })
      })
      .catch((err) => trace({ level: 'warn', kind: 'code-nav-tool-failed', error: String((err && err.message) || err) }))

    // ── 内置浏览器：Agent 工具（第二期，2026-10-08）──────────────────────────
    // 工具跑在后端进程里，浏览器视图与 Playwright 跑在壳进程里 → 两边靠**壳桥**通信（只绑
    // 127.0.0.1 + 一次性口令；地址与口令由壳起后端时经环境变量注入，见 dsh-desktop/bridge.js）。
    // 拿不到壳桥 = 不是天工桌面版（浏览器里开的开发台 3080）→ 每个工具都明说一句，不静默失败。
    //
    // 产品原则（设计定稿 §4.3）：**能用固定动作干的一律不许走 browser_run_code** ——
    // 兜底代码的动作演不出幻影（第三期），走多了那一期就废了。
    const BROWSER_BRIDGE = process.env.ANZIO_BROWSER_BRIDGE || ''
    const BROWSER_TOKEN = process.env.ANZIO_BROWSER_TOKEN || ''

    let browserCallSeq = 0
    // 终止时告诉壳里"把这个动作停下"。为什么不能只让 fetch 放手：壳里那个 page.expect 还在等、
    // page.type 还在逐键敲，同一页面的动作队列一直被它占着，接着发的动作还是排在后面。
    async function cancelAtBridge(callId) {
      try {
        await fetch(BROWSER_BRIDGE + '/cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-anzio-token': BROWSER_TOKEN },
          body: JSON.stringify({ callId: callId }),
          signal: AbortSignal.timeout(2000),
        })
      } catch { /* 壳桥没收到也不要紧：这边的等待已经放开了，最坏是壳里那个动作自己跑完 */ }
    }

    async function browserCall(method, args) {
      if (!BROWSER_BRIDGE || !BROWSER_TOKEN) {
        throw new Error('内置浏览器只在「天工」桌面版里可用（当前进程没有壳桥）。请在应用里做这件事，或让用户自己操作。')
      }
      const signal = toolAbortSignal.getStore()
      const callId = 'bc-' + Date.now().toString(36) + '-' + (++browserCallSeq)
      const request = {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-anzio-token': BROWSER_TOKEN },
        body: JSON.stringify({ method: method, args: args || {}, callId: callId }),
      }
      if (signal === undefined) {
        const res = await fetch(BROWSER_BRIDGE + '/call', request)
        return readBridgeBody(res, method)
      }
      if (signal.aborted) throw new Error('已被用户终止，这次操作没有执行')
      const notifyCancel = () => { void cancelAtBridge(callId) }
      signal.addEventListener('abort', notifyCancel, { once: true })
      try {
        const res = await fetch(BROWSER_BRIDGE + '/call', Object.assign({ signal: signal }, request))
        return await readBridgeBody(res, method)
      } catch (err) {
        if (signal.aborted) throw new Error('已被用户终止，这次操作中途停下了')
        throw err
      } finally {
        signal.removeEventListener('abort', notifyCancel)
      }
    }

    async function readBridgeBody(res, method) {
      let body = null
      try { body = await res.json() } catch { body = null }
      if (body === null) throw new Error('壳桥没有返回可解析的结果（HTTP ' + res.status + '）')
      if (body.ok !== true) throw new Error(String(body.error || ('壳桥调用失败：' + method)))
      return body.result
    }

    // 模型能不能吃图像（照抄引擎 read_image 的判据：路由必须显式声明 image 输入）
    async function imageCapable(exec) {
      try {
        const header = exec.agent && exec.agent.session && exec.agent.session.requestHeader
          ? exec.agent.session.requestHeader() : null
        const cfg = header && header.config
        const opts = (exec.agent && exec.agent.options) || {}
        const provider = (cfg && cfg.provider) || opts.provider
        const model = (cfg && cfg.model) || opts.model
        const llm = ctx.get('llm')
        if (provider === undefined || model === undefined || llm === undefined) return { ok: false, why: '当前模型路由认不出来' }
        const active = await llm.resolveModelInfo(provider, model, exec.signal)
        const mods = active && active.inputModalities
        if (mods === undefined || mods.indexOf('image') < 0) return { ok: false, why: '模型「' + model + '」没有声明图像输入' }
        return { ok: true }
      } catch (e) { return { ok: false, why: String((e && e.message) || e) } }
    }

    let disposeBrowserTools = []
    ctx.effect(() => () => {
      for (const d of disposeBrowserTools) { try { if (typeof d === 'function') d() } catch { /* 忽略 */ } }
      disposeBrowserTools = []
    }, 'dsh-ide: browser tools')
    Promise.resolve()
      .then(() => {
        if (ctx.tools === undefined || typeof ctx.tools.register !== 'function') {
          trace({ level: 'warn', kind: 'browser-tools-skip', reason: 'no-tools-service' })
          return
        }
        const S = (d) => ({ type: 'string', required: true, description: d })
        const OS = (d) => ({ type: 'string', description: d })
        const ON = (d) => ({ type: 'number', description: d })
        const OB = (d) => ({ type: 'boolean', description: d })
        const ID = S('页面 id（先用 browser_list_pages 列出来，或 browser_open_page 开一个新的）')
        const SEL = S('元素选择器：CSS（#id / .cls / [name=x]）、文本（text=登录）、role=（role=button[name="确定"]）。'
          + 'text= 默认**精确相等**，精确不到时会列出子串候选、不替你执行。别用坐标')
        const MATCH = OS('匹配方式：exact（默认）/ contains（子串，要显式写才降级）')
        const INDEX = ON('命中多个时用第几个（候选清单里的编号，只对本次返回有效）')
        // 动作结果里必须带上"命中几个、用了哪个" —— 这是"点了 A2 却以为点了 A"唯一的事后线索，
        // 所以每个动作工具都走同一个格式化函数，别各写一套
        const fmtCandidate = (c) => '  ' + c.index + ') ' + c.tag + (c.id ? '#' + c.id : '')
          + (c.name ? '「' + c.name + '」' : '') + (c.visible ? '' : '（不可见：' + (c.hiddenBy || '原因不明') + '）')
        const fmtCandidates = (r) => (r.candidates || []).map(fmtCandidate).join('\n')
        // 凭证指纹变了就明说：内置浏览器所有标签共用一个登录态，在 A 标签换账号时 B 标签的界面看不出来
        const idWarn = (r) => (r && r.identity && r.identity.changed)
          ? '\n⚠ 动手之前登录态变过（凭证指纹 ' + r.identity.hash + '）—— 可能是刚登录、退出或被轮换；'
            + '别的标签上之前读到、判过的结论不一定还算数。'
          : ''
        // 动作后的可见变化：以前模型得再读一遍页面、自己比对才知道"点了没反应"，
        // 大页面上看漏一行就判成"已生效"。这里直接把差异算出来。
        const fmtChange = (c) => {
          if (c === null || c === undefined) return ''
          const n = c.counts || { added: 0, removed: 0, changed: 0 }
          if (n.added === 0 && n.removed === 0 && n.changed === 0) {
            return '\n本次动作后页面没有可见变化 —— 可能是校验没过、被拦下，或者改动不在当前快照范围内'
              + '（表格默认只比前 40 行）。别当成已生效。'
          }
          const clip = (s) => (String(s).length > 90 ? String(s).slice(0, 90) + '…' : String(s))
          const out = ['\n本次动作后的变化：新增 ' + n.added + ' 行、修改 ' + n.changed + ' 行、删除 ' + n.removed + ' 行']
          for (const a of c.added || []) out.push('  + ' + clip(a))
          for (const ch of c.changed || []) out.push('  ~ ' + clip(ch.before) + '  →  ' + clip(ch.after))
          for (const d of c.removed || []) out.push('  - ' + clip(d))
          if (c.truncated) out.push('  …（还有更多，只列了前几条）')
          return out.join('\n')
        }
        const picked = (verb, r) => {
          const what = r.clicked || r.hovered || r.target || ''
          const more = (typeof r.matched === 'number' && r.matched > 1)
            ? '（匹配 ' + r.matched + ' 个、可见 ' + r.visibleCount + ' 个，用了第 ' + r.index + ' 个）'
            : ''
          return verb + ' ' + what + more + (r.forced ? ' —— ⚠ 不可见元素，是 force 强制点的' : '') + idWarn(r) + fmtChange(r.change)
        }
        // 所有"固定动作"工具的结果都是一句给人看也够用的文字 —— 结构化数据留给 browser_read_page
        const list = []
        const textTool = (spec) => {
          list.push(defineTool({
            name: spec.name,
            description: spec.description,
            parameters: spec.parameters || {},
            output: {
              schema: { type: 'object', additionalProperties: false, properties: { detail: { type: 'string', required: true } } },
              render: (_args, value) => [{ type: 'text', text: String(value.detail || '') }],
            },
            async execute(args, exec) {
              return { detail: String(await withToolSignal(exec, () => spec.run(args || {}, exec))) }
            },
          }))
        }

        textTool({
          name: 'browser_list_pages',
          description: '列出内置浏览器里当前打开的页面（含页面 id、标题、地址，以及所有标签**共用**的登录态指纹）。'
            + '要操作浏览器前先调它拿 id。',
          parameters: {},
          async run() {
            const pages = await browserCall('pages.list', {})
            if (!pages.length) return '现在一个浏览器页面都没开。用 browser_open_page 开一个。'
            const shared = pages[0].identity
            const head = shared
              ? '所有标签共用一个登录态（凭证指纹 ' + shared + '）—— 在某一个标签里换账号，其它标签的界面不会跟着变。\n'
              : ''
            return head + pages.map((p) => '· ' + p.id + ' —— ' + (p.title || '(无标题)') + ' —— ' + p.url
              + (p.loadedAt ? '（' + p.loadedAt.slice(11, 19) + ' UTC 加载）' : '')).join('\n')
          },
        })
        textTool({
          name: 'browser_open_page',
          description: '在内置浏览器里开一个新标签并返回它的 id。url 省略则开空白页。'
            + '⚠ 只开"用户请你做的事"需要的页面，别自己乱开。',
          parameters: { url: OS('要打开的网址（省略 = about:blank）。不带协议时按 https 补，localhost/IP 按 http 补') },
          async run(args) {
            const r = await browserCall('page.open', { url: args.url || 'about:blank' })
            return '已开：' + r.id + ' —— ' + r.url + '。接下来用这个 id 调其它 browser_* 工具。'
          },
        })
        textTool({
          name: 'browser_close_page',
          description: '关掉一个浏览器标签（页面本身也被销毁）。',
          parameters: { id: ID },
          async run(args) { await browserCall('page.close', { id: args.id }); return '已关闭 ' + args.id },
        })
        textTool({
          name: 'browser_navigate',
          description: '让某个页面跳到指定网址（当前页可以是任何状态）。',
          parameters: { id: ID, url: S('要去的网址') },
          async run(args) {
            const r = await browserCall('page.navigate', { id: args.id, url: args.url })
            return '已跳到 ' + r.url + (r.title ? '（标题：' + r.title + '）' : '') + (r.status === null ? '' : '，HTTP ' + r.status)
          },
        })
        textTool({
          name: 'browser_back', description: '浏览器后退一页。', parameters: { id: ID },
          async run(args) { const r = await browserCall('page.back', { id: args.id }); return (r.moved ? '已后退到 ' : '没有可后退的历史，仍在 ') + r.url },
        })
        textTool({
          name: 'browser_forward', description: '浏览器前进一页。', parameters: { id: ID },
          async run(args) { const r = await browserCall('page.forward', { id: args.id }); return (r.moved ? '已前进到 ' : '没有可前进的历史，仍在 ') + r.url },
        })
        textTool({
          name: 'browser_reload', description: '刷新页面（拿最新内容）。', parameters: { id: ID },
          async run(args) { const r = await browserCall('page.reload', { id: args.id }); return '已刷新：' + r.url },
        })
        textTool({
          name: 'browser_click',
          description: '点击页面上的元素（自动等待元素可点、自动滚动到它）。selector 别用坐标。'
            + '命中多个可见元素时**不会替你挑**：会报错并列出候选，用 index 指定；只有一个可见候选时直接点。',
          parameters: {
            id: ID, selector: SEL, match: MATCH, index: INDEX,
            button: OS('鼠标键：left（默认）/ right / middle'),
            clickCount: ON('连击次数：2 = 双击'),
            force: OB('true = 允许点不可见的元素（弹窗残留副本那种才用）'),
          },
          async run(args) {
            const r = await browserCall('page.click', {
              id: args.id, selector: args.selector, match: args.match, index: args.index,
              button: args.button, clickCount: args.clickCount, force: args.force,
            })
            return picked('已点击', r)
          },
        })
        textTool({
          name: 'browser_hover', description: '把鼠标移到元素上（触发悬停才出现的菜单/提示）。命中规则同 browser_click。',
          parameters: { id: ID, selector: SEL, match: MATCH, index: INDEX },
          async run(args) { const r = await browserCall('page.hover', { id: args.id, selector: args.selector, match: args.match, index: args.index }); return picked('已悬停', r) },
        })
        textTool({
          name: 'browser_drag', description: '把一个元素拖到另一个元素上。两端都按命中规则解析（各有一个可见候选才执行）。',
          parameters: { id: ID, from: S('被拖的元素选择器'), to: S('拖到的目标元素选择器'), match: MATCH },
          async run(args) { const r = await browserCall('page.drag', { id: args.id, from: args.from, to: args.to, match: args.match }); return '已拖拽 ' + r.dragged + idWarn(r) + fmtChange(r.change) },
        })
        textTool({
          name: 'browser_scroll',
          description: '滚动页面（或某个元素内部）。用真实的滚轮事件，deltaY 正数向下。',
          parameters: { id: ID, selector: OS('要滚动的元素（省略 = 整页）'), dx: ON('横向像素，正数向右'), dy: ON('纵向像素，正数向下') },
          async run(args) {
            const r = await browserCall('page.scroll', { id: args.id, selector: args.selector, dx: args.dx, dy: args.dy })
            return '已滚动 dx=' + r.scrolled.dx + ' dy=' + r.scrolled.dy
          },
        })
        textTool({
          name: 'browser_press_key',
          description: '按键（Enter / Escape / Tab / ArrowDown / Control+A / Shift+Enter…）。带 selector 时先聚焦那个元素再按。',
          parameters: {
            id: ID, key: S('键名，Playwright 写法：Enter、Escape、Control+A、Shift+Enter'),
            selector: OS('先聚焦的元素（省略 = 当前焦点）'), match: MATCH, index: INDEX,
          },
          async run(args) {
            const r = await browserCall('page.press', { id: args.id, key: args.key, selector: args.selector, match: args.match, index: args.index })
            return '已按 ' + r.pressed + (r.target ? '（目标 ' + r.target + '）' : '') + idWarn(r) + fmtChange(r.change)
          },
        })
        textTool({
          name: 'browser_type',
          description: '往页面里输入文本：给了 selector 会先点它再输入。'
            + '**默认覆盖**（先清空原有内容，再写），要追加必须显式传 mode=append。'
            + '写完会回读该字段的实际值（密码/验证码只回字符数），所以不用再截图核对有没有写错。'
            + '输入节奏按真人的方式来：英文/数字/符号逐键敲、间隔随机、词后与句中会停顿；'
            + '中文按输入法"整词上屏"分批落字（不是逐字母、也不是一次吐出整段）。'
            + '代价是**比一次性粘贴慢**（长文几十秒），这是刻意的：整段瞬写是最容易被判定为机器操作的特征。'
            + '依赖逐键或联想联动的组件仍不会收到 composition 事件，需要时传 perChar=true。',
          parameters: {
            id: ID, text: S('要输入的文本'), selector: OS('输入目标元素（省略 = 当前焦点）'),
            mode: OS('overwrite（默认，清空后写入）/ append（追加在原值后面）'),
            perChar: OB('true = 非 ASCII 也逐字插入（每字一次 input，会放大防抖请求，默认关）'),
            interval: ON('固定逐键间隔毫秒（省略 = 每次随机 35~165ms，词后与偶尔会停顿更久）'),
            submit: OB('true = 输完按回车'), match: MATCH, index: INDEX,
          },
          async run(args) {
            const r = await browserCall('page.type', {
              id: args.id, text: args.text, selector: args.selector, mode: args.mode,
              perChar: args.perChar, interval: args.interval, submit: args.submit, match: args.match, index: args.index,
            })
            const bits = ['已输入 ' + r.typed + ' 个字符']
            bits.push(r.mode === 'per-key' ? '逐键' : (r.mode === 'insert-per-char' ? '逐字插入' : ('分批上屏 ' + (r.chunks || 0) + ' 段')))
            if (r.overwrite === false) bits.push('追加（没清空原内容）')
            if (r.target) bits.push('目标 ' + r.target)
            let tail = ''
            if (r.valueLength === null || r.valueLength === undefined) tail = '；读不到写入后的值（没有可读的输入元素）'
            else if (r.sensitive) tail = '；写入后该字段有 ' + r.valueLength + ' 个字符（密码/验证码，内容不回显）'
            else if (r.valueLength === 0) tail = '；⚠ 写入后该字段仍为空 —— 页面可能拒绝了这次输入'
            else tail = '；写入后的值：' + JSON.stringify(r.value)
            const note = r.mode === 'insert-per-char'
              ? '。注：逐字插入每字一次 input，但同样没有输入法组合过程'
              : ''
            return bits.join('，') + tail + note + idWarn(r) + fmtChange(r.change)
          },
        })
        textTool({
          name: 'browser_read_page',
          description: '读页面：标题、地址、加载时间/etag、地址有没有在上次动作之后变过、登录态指纹变没变、'
            + '最近的控制台错误/失败请求、**最近的提示消息**（页面上早已消失的那种），以及**页面快照**。'
            + '快照的表格按"一行一条"给（单元格文字照留），连续重复的内容折成 ×N；表格超过 40 行会明说还剩多少、'
            + '用 rowStart 接着读。快照若仍被截断，截断规模会明写。'
            + '读之前会先等 DOM 安定（连续 150ms 无变更，最多等 1.2s）：**安定只保证读到的是同一帧的一致快照，'
            + '不保证它反映最新代码** —— 热更新失败时 DOM 也会安定在旧版本上，要判断"改动生效没有"看加载时间与 etag，别拿"稳定"当"最新"。',
          parameters: {
            id: ID, selector: OS('只读某个子树（省略 = 整页）'),
            raw: OB('true = 给原始无障碍树（只在怀疑压缩丢东西时用）'),
            rowStart: ON('表格从第几行开始给（默认 0，翻页接着读用）'),
            rowCount: ON('表格一次给多少行（默认 40）'),
          },
          async run(args) {
            const r = await browserCall('page.read', {
              id: args.id, selector: args.selector, raw: args.raw, rowStart: args.rowStart, rowCount: args.rowCount,
            })
            const errs = (r.errors || []).map((e) => '  · [' + e.kind + '] ' + e.text).join('\n')
            const full = String(r.aria || '')
            const CAP = 6000
            // ⚠ 截断必须说出来：静默切一半，模型会以为表格只有半张，进而得出"数据完整"的结论
            const body = full.length > CAP ? full.slice(0, CAP) : full
            const cut = full.length > CAP
              ? '\n…（这里只给了前 ' + CAP + ' 字符，**已截断**。没看到的部分不代表不存在：用 rowStart 翻行，或用 selector 收窄。）'
              : ''
            const snap = r.snapshot || null
            const snapHead = snap === null ? ''
              : snap.mode === 'raw'
                ? '（原始无障碍树，' + (snap.sourceLines || 0) + ' 行）'
                : '（原始 ' + (snap.sourceLines || 0) + ' 行 → 压缩后 ' + (snap.totalLines || 0) + ' 行'
                  + (snap.rows ? '，表格 ' + snap.rows + ' 行' : '')
                  + (snap.omittedRows ? '，本次没给 ' + snap.omittedRows + ' 行' : '') + '）'
            const scope = (r.scope && r.scope.total > 1)
              ? '\n（该 selector 命中 ' + r.scope.total + ' 个，读的是第 ' + r.scope.index + ' 个）'
              : ''
            const ariaText = r.aria === null || r.aria === undefined
              ? ('(取不到：' + (r.ariaError || '未知原因') + ')')
              : (body || '(空 —— 这个范围里没有任何可访问节点)')
            // 页面"是什么时候、带着什么头加载的"：这是判断"我在旧页面上验新代码"唯一可靠的事实
            const meta = []
            if (r.loadedAgoMs !== null && r.loadedAgoMs !== undefined) {
              meta.push('本页 ' + Math.round(r.loadedAgoMs / 1000) + ' 秒前加载')
            }
            if (r.httpStatus !== null && r.httpStatus !== undefined) meta.push('HTTP ' + r.httpStatus)
            if (r.etag) meta.push('etag ' + r.etag)
            const drift = r.urlChangedSinceAction
              ? '\n地址在上次动作之后变了：' + r.urlChangedSinceAction.from + ' → ' + r.urlChangedSinceAction.to
                + '\n（页面自己跳的，或被守卫挡去了别的页 —— 先看这条地址是不是你预期的那个）'
              : ''
            const idChange = r.identityChanged
              ? '\n⚠ 这个标签的登录态变了（凭证指纹 ' + r.identity + '）—— 可能刚登录/退出/被轮换，'
                + '之前读到的身份、数据不一定还算数。'
              : ''
            const stableText = r.stability
              ? (r.stability.stable
                ? 'DOM 在 ' + r.stability.waited + 'ms 内没再变（本次读到的是同一帧）'
                : '⚠ 页面仍在变化（等了 ' + r.stability.waited + 'ms 也没静默）—— 现在读到的可能只是中间态')
              : ''
            const toasts = (r.toasts || []).map((t) => '  · ' + new Date(t.t).toTimeString().slice(0, 8)
              + ' [' + (t.kind === 'live' ? (t.role || 'live') : '一闪而过 ' + Math.round((t.livedMs || 0) / 100) / 10 + 's') + '] ' + t.text).join('\n')
            return '标题：' + (r.title || '(无)') + '\n地址：' + r.url
              + (meta.length ? '\n（' + meta.join('，') + '）' : '')
              + drift + idChange
              + (stableText ? '\n' + stableText : '')
              + (errs ? '\n最近的问题：\n' + errs : '\n最近没有控制台错误/失败请求')
              + (toasts ? '\n最近的提示消息（页面上可能已经消失）：\n' + toasts : '')
              + scope
              + '\n页面快照' + snapHead + '：\n' + ariaText + cut
          },
        })
        textTool({
          name: 'browser_wait_for',
          description: '等一件事发生：等元素出现/消失（selector + state）、等网址变成某个样子（url）、等页面加载完（loadState）、等网络安静（networkIdle）。'
            + '页面加载慢或要等异步结果时用它，别反复点击碰运气。',
          parameters: {
            id: ID, selector: OS('要等的元素（定位规则与 browser_click 一致）'), match: MATCH,
            state: OS('元素状态：visible（默认）/ attached / hidden / detached'),
            url: OS('等网址变成（支持通配符 *）'), loadState: OS('load / domcontentloaded / networkidle'),
            networkIdle: OB('true = 等网络安静'), timeout: ON('超时毫秒（默认 10000）'),
          },
          async run(args) {
            const r = await browserCall('page.wait', {
              id: args.id, selector: args.selector, match: args.match, state: args.state, url: args.url,
              loadState: args.loadState, networkIdle: args.networkIdle, timeout: args.timeout,
            })
            return '等待完成（' + r.waited + '）'
          },
        })
        textTool({
          name: 'browser_expect',
          description: '断言页面某处"应该是这样"，返回四态之一：**成立 / 不成立（附实际值）/ 找不到（等满超时也没出现）/ 有歧义（命中多个）**。'
            + '这是验证"操作到底生效没有"唯一可靠的办法 —— 靠读快照再用眼睛比对，大表格里看漏一行就会得出错误结论。'
            + '它会一直等到条件成立或超时（默认 5000ms），所以也能当"等它变成这个值"用。',
          parameters: {
            id: ID,
            assert: OS('断言什么：text（默认，元素文字）/ value（输入值）/ visible / hidden / enabled / disabled / count（命中数量）/ attr（属性）/ url（地址）/ title（标题）'),
            selector: OS('断言目标（url / title 断言可省略）'),
            equals: OS('期望值：text 精确相等、value、attr、count 的数量；url/title 支持 * 通配'),
            contains: OS('期望包含这段文字（text / value / attr 用）'),
            attr: OS('assert=attr 时的属性名'),
            match: MATCH,
            timeout: ON('等多久毫秒（默认 5000）'),
          },
          async run(args) {
            const r = await browserCall('page.expect', {
              id: args.id, assert: args.assert, selector: args.selector, equals: args.equals,
              contains: args.contains, attr: args.attr, match: args.match, timeout: args.timeout,
            })
            const show = (v) => (v === null || v === undefined ? '(无)' : JSON.stringify(v))
            const head = r.state === 'pass' ? '成立'
              : r.state === 'mismatch' ? '不成立'
                : r.state === 'not-found' ? '找不到（等满超时也没出现）'
                  : '有歧义（命中多个）'
            const lines = ['断言' + head + '（等了 ' + r.waitedMs + 'ms）：' + r.kind]
            if (r.state === 'pass') lines.push('  实际：' + show(r.actual))
            if (r.state === 'mismatch') lines.push('  期望：' + show(r.expected) + '\n  实际：' + show(r.actual))
            if (r.state === 'not-found') {
              lines.push('  期望：' + show(r.expected)
                + '\n  一个都没匹配到，当前地址：' + r.url
                + '\n  这可能是"还没到这一步"，也可能是选择器不对 —— 先用 browser_read_page 看一眼再判断')
            }
            if (r.state === 'ambiguous') {
              lines.push('  命中 ' + r.total + ' 个，没法判定是哪一处。候选：\n' + fmtCandidates(r))
            }
            return lines.join('\n')
          },
        })
        textTool({
          name: 'browser_measure',
          description: '量布局：只报**客观事实**——内容比可见区宽/高（溢出多少）、是否越出父容器、文字是否被省略号截断、元素占几行。'
            + '"列宽够不够""按钮有没有换行"这类判断用它，不用靠看截图。省略 selector = 量整页并列出所有出问题的元素。',
          parameters: { id: ID, selector: OS('只量的元素（省略 = 整页 body）') },
          async run(args) {
            const r = await browserCall('page.measure', { id: args.id, selector: args.selector })
            const describeM = (m) => {
              const bits = []
              if (m.overflowX > 1) bits.push('内容宽 ' + m.scrollW + ' > 可见 ' + m.clientW + '（溢出 ' + m.overflowX + 'px）')
              if (m.overflowY > 1) bits.push('内容高 ' + m.scrollH + ' > 可见 ' + m.clientH + '（溢出 ' + m.overflowY + 'px）')
              if (m.outsideParent) bits.push('越出父容器')
              if (m.ellipsis) bits.push('文字被省略号截断')
              if (m.lines > 1) bits.push('占 ' + m.lines + ' 行')
              return bits.join('；')
            }
            const lines = ['视口 ' + r.viewport.w + '×' + r.viewport.h + '，扫描了 ' + r.scanned + ' 个元素']
            if (r.root) {
              lines.push('目标 ' + r.root.node + '：' + r.root.m.w + '×' + r.root.m.h
                + '，占 ' + r.root.m.lines + ' 行（行高 ' + r.root.m.lineHeight + 'px）'
                + (describeM(r.root.m) ? '；' + describeM(r.root.m) : ''))
            }
            const probs = r.problems || []
            lines.push(probs.length
              ? ('发现 ' + probs.length + ' 处问题：\n' + probs.map((p) => '  · ' + p.node + '：' + describeM(p.m)).join('\n'))
              : '没有发现溢出、越界或省略号截断')
            return lines.join('\n')
          },
        })
        textTool({
          name: 'browser_run_code',
          description: '兜底：在页面对象上跑一段 Playwright 代码（**只有 page 可用**，例如 `return await page.title()`；'
            + '要在页面里取值用 `return await page.evaluate("...")`）。'
            + '⚠ 能用固定动作（browser_click / browser_type / browser_read_page…）干的事，一律不许走这里 —— '
            + '固定动作才能被人看见（幻影），兜底代码只是个黑盒。',
          parameters: { id: ID, code: S('Playwright 代码，可用 page；用 return 给结果') },
          async run(args) {
            const r = await browserCall('page.code', { id: args.id, code: args.code })
            return '执行完成，返回值：' + JSON.stringify(r.value)
          },
        })
        // 截图要单独写：它得把图片落到附件里再给模型（模型不吃图像就退成文字说明）
        list.push(defineTool({
          name: 'browser_screenshot',
          description: '给页面（或某个元素）截图，图会直接给模型看。适合"看看现在长什么样"、'
            + '验证样式/布局问题。当前模型不支持图像输入时只会回一句说明（那就改用 browser_read_page）。',
          parameters: { id: ID, selector: OS('只截某个元素（省略 = 整个可视区）'), fullPage: OB('true = 整页长图') },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                note: { type: 'string', required: true },
                image: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    attachmentId: { type: 'string', required: true },
                    mediaType: { type: 'string', required: true },
                    bytes: { type: 'number', required: true },
                    width: { type: 'number', required: true },
                    height: { type: 'number', required: true },
                    name: { type: 'string' },
                  },
                },
              },
            },
            render: (_args, value) => (value.image === undefined
              ? [{ type: 'text', text: String(value.note || '') }]
              : [{ type: 'text', text: String(value.note || '') }, { type: 'image', attachment: value.image }]),
          },
          async execute(args, exec) {
            return await withToolSignal(exec, async () => {
              const shot = await browserCall('page.screenshot', { id: args.id, selector: args.selector, fullPage: !!args.fullPage })
              const capable = await imageCapable(exec)
              if (!capable.ok) {
                return { note: '截图拍到了（' + shot.bytes + ' 字节），但' + capable.why + '，没法把图交给模型。改用 browser_read_page 看页面结构。' }
              }
              const attachments = ctx.get('attachments')
              if (attachments === undefined) {
                return { note: '截图拍到了（' + shot.bytes + ' 字节），但这个部署里没有附件服务，没法把图交给模型。改用 browser_read_page。' }
              }
              const ref = await attachments.saveImage({ data: Buffer.from(shot.base64, 'base64'), mediaType: 'image/png', name: 'browser-screenshot.png' })
              return {
                note: '截图如下（' + ref.width + '×' + ref.height + '，' + Math.round(ref.bytes / 1024) + 'KB）。',
                image: {
                  attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes,
                  width: ref.width, height: ref.height,
                  ...(ref.name === undefined ? {} : { name: ref.name }),
                },
              }
            })
          },
        }))
        for (const def of list) {
          const off = ctx.tools.register(def)
          if (typeof off === 'function') disposeBrowserTools.push(off)
        }
        trace({ level: 'info', kind: 'browser-tools-ready', count: list.length, bridge: BROWSER_BRIDGE !== '' })
      })
      .catch((err) => trace({ level: 'warn', kind: 'browser-tools-failed', error: String((err && err.message) || err) }))

    // ── 文件系统变更信号（资源管理器自动刷新，2026-09-16）───────────────
    // 平台 ctx.fs 没有 watch 能力（packages/fs/fs/src 全文无 watch），"磁盘变没变"
    // 只能用 node:fs.watch（Windows 下 = ReadDirectoryChangesW，整棵子树一个句柄）。
    // 客户端只轮询一个整数（/fs-rev），变了才重列目录 → 轮询开销 O(1)，
    // 不随目录大小增长；事件 250ms 去抖合并（Agent 一轮建几十个文件 = 一次刷新）。
    // 触发场景：Agent 建/改文件、外部编辑器、git 操作、explorer 自己保存。
    let fsRev = 0
    let watchRoot = null
    let watcher = null
    let watchTimer = null
    // 与 /tree、/search 的忽略表同源：这些目录里的抖动不算"用户可见的变化"
    const IGNORE_SEG = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', '.idea'])
    const bumpFsRev = (delay) => {
      if (watchTimer !== null) clearTimeout(watchTimer)
      watchTimer = setTimeout(() => { watchTimer = null; fsRev += 1 }, delay === undefined ? 250 : delay)
    }
    const ensureWatch = (root) => {
      if (!root || (watcher !== null && watchRoot === root)) return
      if (watcher !== null) {
        try { watcher.close() } catch { /* 已经死了 */ }
        watcher = null
        watchRoot = null
      }
      try {
        const w = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
          const rel = filename === null || filename === undefined ? '' : String(filename)
          if (rel) {
            const segs = rel.split(/[\\/]/)
            for (const s of segs) if (IGNORE_SEG.has(s)) return
          }
          bumpFsRev()
        })
        w.on('error', () => {
          try { w.close() } catch { /* 忽略 */ }
          if (watcher === w) { watcher = null; watchRoot = null }
        })
        watcher = w
        watchRoot = root
      } catch {
        // 根不存在 / 权限不足：静默降级，资源管理器退回"手动 ⟳ 刷新"
        watcher = null
        watchRoot = null
      }
    }

    // ── ⑬ 集成终端：自建真 PTY（2026-09-16）──────────────────────────────
    // 为什么不用平台件：`packages/terminal/*` 是**请求/响应式**的（`startSend` 拿
    // `TerminalSendOperation.readOutput()`、输出经行消毒器投影、无流式订阅、无 resize），
    // 那是给 Agent"发一条命令读一段输出"用的；交互式终端 UI（逐字符输入、ANSI 颜色、
    // 进度条回车、Ctrl+C、窗口尺寸）必须自己开真 PTY。
    // node-pty 是**原生模块**，插件目录 require 不到 → 从**检出目录**的 subprocess-local
    // 包解析（pnpm 符号链接）；应用本来就跑在检出目录上（§3），所以这条依赖成立。
    const harnessRoot = (() => {
      if (process.env.DSH_HARNESS) return process.env.DSH_HARNESS
      const m = String(process.argv[1] || '').match(/^(.*?)[\\/]apps[\\/]cli[\\/]/i)
      return m ? m[1] : 'D:\\99DSH\\deepseek-harness-mine\\harness'
    })()
    let ptyMod = null
    let ptyLoadError = null
    try {
      const req = createRequire(path.join(harnessRoot, 'packages', 'subprocess', 'subprocess-local', 'package.json'))
      ptyMod = req('node-pty')
    } catch (e) { ptyLoadError = errOf(e) }

    const TERM_MAX_CHUNKS = 4000            // 每会话输出块上限（防内存爆）
    const TERM_MAX_BYTES = 512 * 1024       // 每会话输出字节上限
    const TERM_IDLE_MS = 6 * 60 * 60 * 1000 // 兜底：6 小时没读就回收
    const terminals = new Map()             // id -> { pty, chunks, seq, bytes, droppedUntil, exited, exitCode, lastRead }
    let termSeq = 0

    const termAppend = (t, data) => {
      if (!data) return
      // 口令提示识别：`Password:` / `密码：` 之后敲的那一行是口令，不能当命令记（打码只盖命令行参数，
      // 盖不住交互式追问 —— 2026-10-19 加）。只看输出尾部 200 字，够认提示、又不留整屏内容。
      try {
        const clean = String(data).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        t.tail = ((t.tail || '') + clean).slice(-200)
        if (/(?:password|passphrase|口令|密码)[^\r\n]{0,24}[:：]\s*$/i.test(t.tail)) t.secretPrompt = true
      } catch { /* 识别失败只是少打一层码，不影响终端 */ }
      t.seq += 1
      t.chunks.push({ seq: t.seq, data })
      t.bytes += data.length
      while (t.chunks.length > TERM_MAX_CHUNKS || t.bytes > TERM_MAX_BYTES) {
        const dropped = t.chunks.shift()
        if (!dropped) break
        t.bytes -= dropped.data.length
        t.droppedUntil = dropped.seq
      }
    }
    const termKill = (t, reason) => {
      try { t.pty.kill() } catch { /* 已经退了 */ }
      trace({ level: 'info', kind: 'terminal', msg: 'close', meta: { id: t.id, reason } })
    }

    // ── 终端命令留痕（2026-10-19 拍板：记命令原文，常见口令参数打码）──
    // 只在**回车那一刻**落一行完整命令，不逐键记；光标移动/方向键产生的转义序列全部跳过。
    // 打码只覆盖常见写法，不保证 100%（用户已知情）：目的是"能查我敲了什么"，不是当保险箱。
    const TERM_SECRET_PROGS = new Set(['mysql', 'mysqldump', 'mysqladmin', 'psql', 'pg_dump', 'redis-cli', 'sqlcmd', 'sshpass', 'curl', 'wget'])
    function maskTermLine(line) {
      let out = String(line)
      // 长参数（--password / -Password / --token / --secret / --api-key …）：值一律 ***
      out = out.replace(/((?:--?|[/\\])(?:password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key)[ \t:=]+)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
      // 短参数 -p：只在确实吃口令的程序后面打码，避免误伤 mkdir -p / tar -p
      const prog = (out.match(/^\s*([a-z0-9_.\-]+)/i) || [])[1] || ''
      if (TERM_SECRET_PROGS.has(prog.toLowerCase())) {
        out = out.replace(/\s-p\s+("[^"]*"|'[^']*'|\S+)/gi, ' -p ***')
        out = out.replace(/\s-p(\S+)/gi, ' -p***')
      }
      return out
    }
    function termFlushCommand(t) {
      const line = String(t.cmdBuf || '').trim()
      t.cmdBuf = ''
      if (!line) { t.secretPrompt = false; return }
      // 上一屏输出停在"请输入密码" → 这一行就是口令，只记长度
      if (t.secretPrompt) {
        t.secretPrompt = false
        trace({
          level: 'info', kind: 'terminal', msg: 'command',
          meta: { id: t.id, cwd: t.cwd, line: '***', secret: true, chars: line.length },
        })
        return
      }
      trace({
        level: 'info', kind: 'terminal', msg: 'command',
        meta: { id: t.id, cwd: t.cwd, line: maskTermLine(line), chars: line.length },
      })
    }
    function termTrackInput(t, data) {
      const s = String(data || '')
      for (let i = 0; i < s.length; i++) {
        const ch = s[i]
        if (ch === '\x1b') { t.cmdEsc = true; continue }
        // 转义序列：等到终结字节（字母、@ \ ] ^ _ ` { | } ~）再恢复收字
        if (t.cmdEsc) { if (/[@-Z\\-_a-z{}|~]/.test(ch)) t.cmdEsc = false; continue }
        if (ch === '\r' || ch === '\n') { termFlushCommand(t); continue }
        if (ch === '\x7f' || ch === '\b') { t.cmdBuf = String(t.cmdBuf || '').slice(0, -1); continue }
        if (ch === '\x03') { t.cmdBuf = ''; t.secretPrompt = false; continue }   // Ctrl+C：半行作废（连口令提示一起清）
        if (ch === '\t') { if ((t.cmdBuf || '').length < 2000) t.cmdBuf = (t.cmdBuf || '') + '\t'; continue }
        if (ch >= ' ') { if ((t.cmdBuf || '').length < 2000) t.cmdBuf = (t.cmdBuf || '') + ch }
      }
    }
    // 兜底回收：页面崩了/没发 close 的会话别一直挂着
    ctx.effect(() => {
      const timer = setInterval(() => {
        const now = Date.now()
        for (const t of [...terminals.values()]) {
          if (now - (t.lastRead || t.startedAt) > TERM_IDLE_MS) {
            termKill(t, 'idle-timeout')
            terminals.delete(t.id)
          }
        }
      }, 5 * 60 * 1000)
      return () => {
        clearInterval(timer)
        for (const t of terminals.values()) termKill(t, 'plugin-dispose')
        terminals.clear()
      }
    }, 'dsh-ide: terminals')

    // ── ㉒ 服务器控制台 · SSH 会话（2026-10-21）─────────────────────────────
    // 会话活在后端进程里：界面切走只是不画，连接与终端输出都留着（切回来不用重连）。
    // 服务器清单落 <DSH_HOME>/ide-ssh.json，**只存地址与密钥路径，口令永远不落盘**。
    const ssh = createSshManager({ trace })
    // 远端文件的伪路径：`ssh://<连接 id>/<绝对路径>`。
    // 为什么不给编辑器另开一套读写接口：编辑器的读、写、版本令牌、冲突条全部只认
    // /read-file、/write-file、/stat 三个入口 —— 在这三处转发，编辑器那边一行都不用改。
    const SSH_SCHEME = 'ssh://'
    const parseSshPath = (p) => {
      const s = String(p || '')
      if (!s.startsWith(SSH_SCHEME)) return null
      const rest = s.slice(SSH_SCHEME.length)
      const i = rest.indexOf('/')
      if (i <= 0) return null
      return { sid: rest.slice(0, i), path: '/' + rest.slice(i + 1) }
    }
    const sshServersPath = () => path.join(process.env.DSH_HOME || process.cwd(), 'ide-ssh.json')
    const readSshServers = async () => {
      try {
        const raw = await readFile(sshServersPath(), 'utf8')
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed && parsed.servers) ? parsed.servers : []
      } catch { return [] }
    }
    // ── 系统 known_hosts：主机指纹的可信来源（2026-10-21）──────────────────
    // 你机器上的 ssh 早就连过这台服务器，那份记录就是"第一次的见证"——
    // 能对账就不必让你手工核指纹；对不上才是真问题（重装 or 中间人）。
    // 支持明文主机名与 HashKnownHosts（|1|salt|hmac，HMAC-SHA1），通配符不处理（罕见）。
    function readKnownHosts(host, port) {
      const dir = process.env.USERPROFILE || process.env.HOME || ''
      const file = path.join(dir, '.ssh', 'known_hosts')
      let text = ''
      try { text = readFileSync(file, 'utf8') } catch { return { file, keys: [] } }
      const target = (Number(port) || 22) !== 22 ? '[' + host + ']:' + (Number(port) || 22) : String(host)
      const keys = []
      for (const line of text.split(/\r?\n/)) {
        const ln = line.trim()
        if (!ln || ln.startsWith('#')) continue
        const parts = ln.split(/\s+/)
        if (parts.length < 3) continue
        const hostField = parts[0]
        let hit = false
        if (hostField.startsWith('|1|')) {
          const seg = hostField.split('|')
          try {
            const salt = Buffer.from(seg[2] || '', 'base64')
            const mac = createHmac('sha1', salt).update(target).digest('base64')
            hit = mac === seg[3]
          } catch { hit = false }
        } else {
          for (const h of hostField.split(',')) {
            if (h === target || h === String(host)) { hit = true; break }
          }
        }
        if (hit) keys.push({ type: parts[1], base64: parts[2] })
      }
      return { file, keys }
    }

    const writeSshServers = async (servers) => {
      const clean = (Array.isArray(servers) ? servers : []).slice(0, 20).map((s) => ({
        id: String(s.id || '').slice(0, 60),
        name: String(s.name || '').slice(0, 60),
        host: String(s.host || '').slice(0, 200),
        port: Number(s.port) || 22,
        user: String(s.user || 'root').slice(0, 60),
        keyPath: String(s.keyPath || '').slice(0, 400),
        // 记住的那台机器的公钥（TOFU）：下次连接直接对账，对不上就拒连
        fp: (s.fp && s.fp.fingerprint) ? {
          fingerprint: String(s.fp.fingerprint),
          type: String(s.fp.type || ''),
          base64: String(s.fp.base64 || ''),
          at: Number(s.fp.at) || 0,
        } : null,
      }))
      await writeFile(sshServersPath(), JSON.stringify({ servers: clean }, null, 2), 'utf8')
      return clean
    }

    // SSH 终端里敲了什么也要留痕（与本地终端同一口径：只记回车那一刻，口令打码）
    const sshCmdBuf = new Map()
    const sshFeedKeys = (sid, tid, chunk, owner) => {
      const s = String(chunk || '')
      const st = sshCmdBuf.get(tid) || { buf: '', esc: false, secret: false }
      for (let i = 0; i < s.length; i++) {
        const ch = s[i]
        if (ch === '\x1b') { st.esc = true; continue }
        if (st.esc) { if (/[@-Z\\-_a-z{}|~]/.test(ch)) st.esc = false; continue }
        if (ch === '\r' || ch === '\n') {
          const line = String(st.buf || '').trim()
          st.buf = ''
          if (line) {
            trace({
              level: 'info', kind: 'ssh-terminal', msg: 'command',
              meta: { sid, term: tid, by: owner === 'agent' ? 'agent' : 'user', line: st.secret ? '***' : maskTermLine(line), secret: st.secret || undefined },
            })
          }
          st.secret = false
          continue
        }
        if (ch === '\x7f' || ch === '\b') { st.buf = st.buf.slice(0, -1); continue }
        if (ch === '\x03') { st.buf = ''; continue }
        if (ch >= ' ') { if (st.buf.length < 2000) st.buf += ch }
      }
      sshCmdBuf.set(tid, st)
    }

    ctx.effect(() => {
      const timer = setInterval(() => {
        const now = Date.now()
        for (const s of ssh.list()) {
          for (const t of s.terms) {
            const rec = ssh.get(s.id)
            const term = rec && rec.terms.get(t.id)
            if (term && now - (term.lastRead || term.startedAt) > TERM_IDLE_MS) ssh.closeTerm(s.id, t.id, 'idle-timeout')
          }
        }
      }, 5 * 60 * 1000)
      return () => {
        clearInterval(timer)
        // 插件卸载时还挂着的审批一律作废：绝不让一个等待中的写入在没人看的时候落地
        for (const [, a] of sshApprovals) { clearTimeout(a.timer); a.resolve({ ok: false, reason: 'disposed' }) }
        sshApprovals.clear()
        ssh.disposeAll()
      }
    }, 'dsh-ide: ssh-sessions')

    // ── ㉓ 服务器控制台 · 给 Agent 的工具（2026-10-21 第三刀）──────────────────
    // Agent 与人在界面里用的是同一套能力（跑命令 / 列目录 / 读文件 / 写文件），
    // 差别只在闸门：读与执行直接做；写、删先要在界面上点「允许」。
    // 为什么不用引擎的审批卡：那套只认沙箱升权，自定义工具挂不上去（baseline §D.5）。
    // 界面上下文（哪台机器、当前目录、选中项）由前端随时推进来，Agent 不用问路径。
    const sshCtx = { sid: null, path: '/', sel: null, term: null, at: 0 }
    const sshApprovals = new Map()
    let sshApprovalSeq = 0
    const askSshApproval = (entry) => new Promise((resolve) => {
      sshApprovalSeq += 1
      const id = 'a' + sshApprovalSeq
      const timer = setTimeout(() => {
        sshApprovals.delete(id)
        trace({ level: 'warn', kind: 'ssh-approval', msg: 'timeout', meta: { id, tool: entry.tool } })
        resolve({ ok: false, reason: 'timeout' })
      }, 120000)
      sshApprovals.set(id, { id, entry, resolve, timer })
      trace({ level: 'info', kind: 'ssh-approval', msg: 'ask', meta: { id, tool: entry.tool, target: entry.target || '' } })
    })
    const answerSshApproval = (id, ok) => {
      const rec = sshApprovals.get(String(id))
      if (!rec) return { ok: false, error: 'no-approval' }
      clearTimeout(rec.timer)
      sshApprovals.delete(String(id))
      trace({ level: 'info', kind: 'ssh-approval', msg: ok ? 'allow' : 'deny', meta: { id, tool: rec.entry.tool } })
      rec.resolve({ ok: !!ok, reason: ok ? 'allowed' : 'denied' })
      return { ok: true }
    }
    const shQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"

    Promise.resolve().then(() => {
      if (ctx.tools === undefined || typeof ctx.tools.register !== 'function') {
        trace({ level: 'warn', kind: 'ssh-tool-skip', reason: 'no-tools-service' })
        return
      }
      const pickSid = (args) => {
        const want = String((args && args.server) || '')
        if (want) {
          for (const s of ssh.list()) {
            if (s.id === want || s.name === want || s.host === want) return s.id
          }
        }
        return sshCtx.sid
      }
      const needSid = (args) => {
        const sid = pickSid(args)
        if (!sid) throw new Error('还没有连服务器：先在左侧「服务器控制台」里连上一台，再让我干活')
        const rec = ssh.get(sid)
        if (!rec || rec.status !== 'open') throw new Error('那台服务器的连接不在线（可能已断开或超时），先在界面上重连')
        return sid
      }
      const textOutput = {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, detail: { type: 'string', required: true } } },
        render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || '') }],
      }
      const reg = (tool) => ctx.tools.register(tool)

      // Agent 干活用的那条终端：一个连接只养一条，跑完留着不关 —— 用户往上翻就能看到每一步干了什么。
      // 指定别的终端 id 就写进那条（用户的终端），但默认不动用户的。
      const ensureAgentTerm = async (sid, want) => {
        const pick = String(want || '').trim()
        if (pick && pick !== 'agent') {
          const rec = ssh.get(sid)
          const t = rec && rec.terms ? rec.terms.get(pick) : null
          if (!t) throw new Error('没有 ' + pick + ' 这条终端（可能已关掉，用 ssh_term_list 看现存的）')
          if (t.exited) throw new Error(pick + ' 这条终端已经结束了，别往死终端里写')
          return pick
        }
        const live = ssh.agentTerm(sid)
        if (live) return live.id
        // 挂同一路留痕：Agent 在终端里敲的命令也进 ide-trace，标 by=agent
        const r = await ssh.openTerm(sid, {
          cols: 120, rows: 32, owner: 'agent', title: 'Agent',
          onData: (t, chunk) => sshFeedKeys(sid, t.id, chunk, 'agent'),
        })
        trace({ level: 'info', kind: 'ssh-tool', msg: 'term-open', meta: { sid, term: r.id } })
        return r.id
      }

      reg(defineTool({
        name: 'ssh_run',
        description: '在「服务器控制台」的终端里执行一条 shell 命令，返回退出码与输出。'
          + '**命令会真的敲进界面上那条终端里跑，用户当场看得见**（这是设计：没有背后的暗箱操作）。'
          + '适合看日志、看进程、看服务状态、重启服务。**改动线上文件请用 ssh_write（要用户点允许）**；'
          + '这里跑什么都会立刻生效，别拿它做不可逆的删除/覆盖。'
          + '**想知道终端里已经发生过什么（用户敲过什么、刚才那个报错是什么），不要用 history、'
          + '不要读 ~/.bash_history、不要 cat 日志 —— 那是往终端里塞新命令，会打断正在跑的东西、污染命令历史。'
          + '这类「看」一律用 ssh_read_term（纯读，不产生任何输入）。**'
          + '另外本次执行的返回里已经附带了这条终端之前的画面，多数情况不用再单独读。',
        parameters: {
          cmd: { type: 'string', required: true, description: '要执行的命令（在服务器上跑）' },
          cwd: { type: 'string', description: '先在哪个目录下 cd 过去再执行（省略 = 终端当前目录）' },
          term: { type: 'string', description: '在哪个终端里跑：省略 = Agent 自己那条；填用户终端的 id 就写进用户那条' },
          timeoutSec: { type: 'integer', description: '等多久算超时（秒，默认 60，最多 600）；超时后命令可能还在跑，可再用 ssh_read_term 看后续输出' },
          server: { type: 'string', description: '服务器（名字/地址/连接 id），省略 = 界面当前这台' },
        },
        output: textOutput,
        async execute(args) {
          const sid = needSid(args)
          const tid = await ensureAgentTerm(sid, args.term)
          const cmd = String(args.cmd)
          const sec = Number(args.timeoutSec)
          const timeoutMs = Math.max(5000, Math.min(600000, Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60000))
          const r = await ssh.runInTerm(sid, tid, cmd, {
            timeoutMs,
            cwd: args.cwd ? String(args.cwd) : '',
          })
          trace({
            level: 'info', kind: 'ssh-tool', msg: 'run',
            meta: { sid, term: tid, code: r.code, ms: r.ms, timeout: r.timeout || undefined, line: maskTermLine(cmd).slice(0, 200) },
          })
          const parts = []
          parts.push('终端：' + tid + '（界面上可见）')
          parts.push('退出码：' + (r.code === null ? '未知（还没跑完或终端已断）' : r.code) + '（' + r.ms + 'ms）')
          const out = String(r.output || '').trim()
          // 留 20000 字给这一轮；要全文就让 Agent 自己用 ssh_read_term 读那条终端
          if (out) parts.push('输出：\n' + out.slice(-20000) + (out.length > 20000 ? '\n…（前面还有 ' + (out.length - 20000) + ' 字，要全量用 ssh_read_term 读终端 ' + tid + '）' : ''))
          else if (!r.timeout) parts.push('（没有任何输出）')
          // 终端在本次执行之前的样子：用户手打的命令与报错都在这里，省得它再去敲 history 看
          const priorText = String(r.prior || '').trim()
          if (priorText) {
            const priorLines = priorText.split('\n')
            const priorTail = priorLines.slice(-15).join('\n').trim()
            if (priorTail) {
              parts.push('--- 这条终端在本次执行之前的内容（只读快照' + (priorLines.length > 15 ? '，这里只给最后 15 行' : '') + '）---')
              parts.push(priorTail)
            }
          }
          if (r.timeout) {
            parts.push('⚠ 到 ' + Math.round(timeoutMs / 1000) + ' 秒还没跑完：命令可能还在跑。'
              + '输出可能继续增长，用 ssh_read_term（term=' + tid + '）看后续；要中断就在终端里按 Ctrl+C。')
          }
          if (r.exited) parts.push('（这条终端随之结束了）')
          return { ok: r.code === 0, detail: parts.join('\n') }
        },
      }))

      reg(defineTool({
        name: 'ssh_read_term',
        description: '只读快照：直接取终端缓冲里已经有的内容（用户手打的命令、Agent 跑的命令、以及输出），'
          + '**不在终端里输入任何字符，也不打断正在跑的命令**。'
          + '想知道终端里发生过什么、或者用户说的「刚才那个报错」指什么，就用它 ——'
          + '不要用 history / ~/.bash_history / tail 日志去查，那是往终端里塞新命令，会干扰。'
          + '不指定 term 就读界面当前正在看的那条终端。',
        parameters: {
          term: { type: 'string', description: '终端 id；省略 = 界面当前正开着的那条；填 agent = Agent 自己那条' },
          tailLines: { type: 'integer', description: '只取末尾多少行（默认 200，最多 2000）' },
          server: { type: 'string', description: '服务器（名字/地址/连接 id），省略 = 界面当前这台' },
        },
        output: textOutput,
        async execute(args) {
          const sid = needSid(args)
          let tid = String(args.term || '').trim()
          if (tid === 'agent') {
            const t = ssh.agentTerm(sid)
            if (!t) throw new Error('这台连接上 Agent 还没开过终端（先 ssh_run 跑一条就有）')
            tid = t.id
          }
          if (!tid && sshCtx.sid === sid) tid = String(sshCtx.term || '')
          if (!tid) {
            // 界面没在看任何终端（用户切去编辑器了之类）：退到 Agent 那条，再退到最近活跃的一条。
            // 这里宁可多猜一步也别报错 —— 报错就把模型逼回"敲 history 去看"的老路。
            const rec = ssh.get(sid)
            const all = (rec && rec.terms) ? [...rec.terms.values()] : []
            const mine = ssh.agentTerm(sid)
            if (mine) tid = mine.id
            else if (all.length) {
              const latest = all.slice().sort((a, b) => (b.lastRunAt || b.startedAt || 0) - (a.lastRunAt || a.startedAt || 0))[0]
              tid = latest.id
            }
          }
          if (!tid) throw new Error('这台连接上还没有任何终端：先用 ssh_run 跑一条，或让用户在界面上开一条')
          const text = ssh.termText(sid, tid)
          if (text === null) throw new Error('没有 ' + tid + ' 这条终端')
          const n = Math.max(1, Math.min(2000, Number(args.tailLines) || 200))
          const lines = text.split('\n')
          const body = lines.slice(-n).join('\n')
          trace({ level: 'info', kind: 'ssh-tool', msg: 'read-term', meta: { sid, term: tid, chars: text.length, lines: lines.length } })
          const head = '终端 ' + tid + '：共 ' + lines.length + ' 行 / ' + text.length + ' 字'
            + (lines.length > n ? '，这里给最后 ' + n + ' 行' : '')
          return { ok: true, detail: head + '\n\n' + (body.trim() || '（这条终端还没有任何输出）') }
        },
      }))

      reg(defineTool({
        name: 'ssh_term_list',
        description: '列出「服务器控制台」里这台服务器上的所有终端（是谁开的、还活着吗、多少输出），用来决定读哪一条。',
        parameters: {
          server: { type: 'string', description: '服务器（名字/地址/连接 id），省略 = 界面当前这台' },
        },
        output: textOutput,
        async execute(args) {
          const sid = needSid(args)
          const rec = ssh.get(sid)
          const terms = (rec && rec.terms) ? [...rec.terms.values()] : []
          if (!terms.length) return { ok: true, detail: '这台连接上还没有终端。' }
          const active = sshCtx.sid === sid ? String(sshCtx.term || '') : ''
          const lines = terms.map((t) => {
            const mark = t.id === active ? ' ←界面正在看' : ''
            return t.id + '  ' + (t.owner === 'agent' ? 'Agent' : '你')
              + (t.title ? '（' + t.title + '）' : '')
              + (t.exited ? '  已结束' + (t.exitCode === null ? '' : '（退出码 ' + t.exitCode + '）') : '  在跑')
              + '  ' + Math.round(t.bytes / 1024) + 'KB' + mark
          })
          return { ok: true, detail: '终端：\n' + lines.join('\n') }
        },
      }))

      reg(defineTool({
        name: 'ssh_ls',
        description: '列出「服务器控制台」那台服务器上某个目录的内容（一层，不递归）。省略 path 就用界面里当前目录。',
        parameters: {
          path: { type: 'string', description: '目录绝对路径，省略 = 界面当前目录' },
          server: { type: 'string', description: '服务器（名字/地址/连接 id），省略 = 界面当前这台' },
        },
        output: textOutput,
        async execute(args) {
          const sid = needSid(args)
          const dir = String(args.path || sshCtx.path || '/')
          const r = await ssh.ls(sid, dir)
          const lines = r.entries.map((e) => (e.dir ? 'd' : '-') + ' ' + String(e.size).padStart(9) + '  ' + e.name)
          return { ok: true, detail: dir + '（' + r.entries.length + ' 项）\n' + lines.join('\n') }
        },
      }))

      reg(defineTool({
        name: 'ssh_read',
        description: '读「服务器控制台」那台服务器上的一个文本文件（上限 4MB）。看配置、看日志都用它。',
        parameters: {
          path: { type: 'string', required: true, description: '文件绝对路径' },
          server: { type: 'string', description: '服务器（名字/地址/连接 id），省略 = 界面当前这台' },
        },
        output: textOutput,
        async execute(args) {
          const sid = needSid(args)
          const r = await ssh.readText(sid, String(args.path))
          const text = r.buf.toString('utf8')
          trace({ level: 'info', kind: 'ssh-tool', msg: 'read', meta: { sid, path: String(args.path), bytes: r.size } })
          return { ok: true, detail: text.slice(0, 200000) }
        },
      }))

      reg(defineTool({
        name: 'ssh_write',
        description: '把内容写到「服务器控制台」那台服务器的文件里（覆盖整个文件；不存在就新建）。'
          + '**调用后会在天工界面上弹出确认条，用户点「允许」才真的写**；用户拒绝或 2 分钟没点就作废。',
        parameters: {
          path: { type: 'string', required: true, description: '文件绝对路径' },
          content: { type: 'string', required: true, description: '完整的新内容（不是补丁）' },
          reason: { type: 'string', description: '一句话说明为什么要改它（给用户看，帮助判断）' },
          server: { type: 'string', description: '服务器（名字/地址/连接 id），省略 = 界面当前这台' },
        },
        output: textOutput,
        async execute(args) {
          const sid = needSid(args)
          const path = String(args.path)
          const content = String(args.content)
          const verdict = await askSshApproval({
            tool: 'ssh_write', target: path, reason: String(args.reason || ''),
            detail: '写入 ' + path + '（' + content.length + ' 字）',
          })
          if (!verdict.ok) {
            return { ok: false, detail: verdict.reason === 'timeout' ? '用户没有在 2 分钟内确认，本次写入作废' : '用户拒绝了这次写入' }
          }
          await ssh.writeText(sid, path, content)
          trace({ level: 'info', kind: 'ssh-tool', msg: 'write', meta: { sid, path, bytes: content.length } })
          return { ok: true, detail: '已写入 ' + path + '（' + content.length + ' 字）' }
        },
      }))

      reg(defineTool({
        name: 'ssh_delete',
        description: '删「服务器控制台」那台服务器上的文件或空目录。'
          + '**调用后会在天工界面上弹出确认条，用户点「允许」才真的删**；目录必须为空（不做递归删）。',
        parameters: {
          path: { type: 'string', required: true, description: '文件或目录的绝对路径' },
          dir: { type: 'boolean', description: 'true = 这是个目录（只能删空目录）' },
          reason: { type: 'string', description: '一句话说明为什么要删（给用户看）' },
          server: { type: 'string', description: '服务器（名字/地址/连接 id），省略 = 界面当前这台' },
        },
        output: textOutput,
        async execute(args) {
          const sid = needSid(args)
          const path = String(args.path)
          const isDir = args.dir === true
          const verdict = await askSshApproval({
            tool: 'ssh_delete', target: path, reason: String(args.reason || ''),
            detail: '删除 ' + path + (isDir ? '（目录，必须为空）' : ''),
          })
          if (!verdict.ok) {
            return { ok: false, detail: verdict.reason === 'timeout' ? '用户没有在 2 分钟内确认，本次删除作废' : '用户拒绝了这次删除' }
          }
          await ssh.remove(sid, path, isDir)
          trace({ level: 'info', kind: 'ssh-tool', msg: 'delete', meta: { sid, path, dir: isDir } })
          return { ok: true, detail: '已删除 ' + path }
        },
      }))

      trace({ level: 'info', kind: 'ssh-tool-ready' })
    }).catch((err) => trace({ level: 'warn', kind: 'ssh-tool-failed', error: String((err && err.message) || err) }))

    // ── ⑭-② inline 建议（ghost text）：模型配置从应用设置读 ──────────────────
    // 平台有 ctx.settings 服务，但要先知道模型配置注册在哪个 namespace；而 dsh-settings-file
    // 落的就是 home 下这份 settings.yaml，形状固定（agent-default-model: {provider, model}），
    // 直接读更省事，读不到就优雅降级（返回 no-model-config，前端只提示不报错）。
    const readModelConfig = () => {
      try {
        const home = process.env.DSH_HOME
        if (!home) return null
        const lines = readFileSync(path.join(home, 'settings.yaml'), 'utf8').split(/\r?\n/)
        let inBlock = false
        let provider = null
        let model = null
        for (const line of lines) {
          if (/^agent-default-model\s*:/.test(line)) { inBlock = true; continue }
          if (!inBlock) continue
          if (/^\S/.test(line)) break // 回到顶层键 → 块结束
          const m1 = line.match(/^\s+provider\s*:\s*(\S+)/)
          const m2 = line.match(/^\s+model\s*:\s*(\S+)/)
          if (m1) provider = m1[1]
          if (m2) model = m2[1]
        }
        return provider && model ? { provider, model } : null
      } catch { return null }
    }

    const INLINE_SYSTEM = [
      '你是代码补全引擎。用户给你光标前后的代码上下文。',
      '只输出**应当插入到光标位置**的代码文本：不要解释、不要加 Markdown 代码围栏、不要重复光标前已有的内容。',
      '没有值得补的就输出空字符串。缩进风格与上下文保持一致。',
    ].join('\n')
    const buildInlinePrompt = (file, language, prefix, suffix) => [
      '文件：' + (file || '(未命名)') + '　语言：' + (language || '未知'),
      '--- 光标前 ---',
      prefix,
      '--- 光标后 ---',
      suffix,
      '--- 只输出要插入的代码 ---',
    ].join('\n')

    const resolveRoot = async () => {
      if (activeRoot) return activeRoot
      if (workspaceRegistry !== undefined) {
        try {
          const list = workspaceRegistry.list()
          if (list.length > 0 && list[0].path) return list[0].path
        } catch { /* fall through */ }
      }
      if (sandboxPolicy !== undefined && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
      return undefined
    }

    const pluginInventory = () => {
      if (runner === undefined) return []
      try { return runner.inventory() } catch { return [] }
    }

    const formalPlugins = () => {
      if (clientModules === undefined) return []
      try { return clientModules.graph().entries } catch { return [] }
    }

    // ── 代码导航：让 Agent 自己装（2026-09-22 第九轮重做）────────────────────
    // 用户要的形状：Agent 干活时发现"这门语言没有导航" → 它自己去查该装什么 →
    //   用它自己的提问工具问用户（装什么/从哪来/多大） → 用户点头 → 它调本插件注册的
    //   `code_nav_install` 工具 → 下载（**按来源官方哈希校验**）→ 落数据目录 →
    //   往装配单追加一行 provider（装配单是 **live reload** 的，不重启即生效）→ 重试刚才那次查询。
    // ⚠ 这里**没有任何"语言清单"**：装哪个包、映射哪些扩展名、用什么参数，全由 Agent 在
    //   需要的那一刻查出来（包自带的 bin 字段也由它自己看）。人工只在"要不要装"上出现一次。
    // ⚠ 与内置更新器**物理隔离**：更新器是"启动时替换我们自己的程序文件"，这里是
    //   "随时往数据目录加第三方程序 + 往装配单追加一行" —— 目录/时机/权限都不同，别混用。
    const TOOL_SOURCES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']
    const toolsRoot = () => (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'tools', 'lsp') : null)
    const profilePatchPath = () => (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml') : null)
    /** 装配单里"Agent 追加语言"的锚点：新语言插在这行注释下面（缩进必须一致）。 */
    const LANG_MARKER = '          # ← Agent 追加的语言写在这行下面（勿删这行、勿改缩进）'
    /** 跑一个子进程（解包用系统 tar：Windows 10+ 自带 bsdtar）。 */
    const runCommand = (cmd, argv, cwd) => new Promise((resolve, reject) => {
      const child = spawn(cmd, argv, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      child.stderr.on('data', (b) => { err += String(b) })
      child.on('error', reject)
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(cmd + ' 退出码 ' + code + '：' + err.slice(0, 300))))
    })
    const readToolManifest = (root) => {
      try { return JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) } catch { return { entries: [] } }
    }
    /**
     * 取一个 npm 包：元数据（国内镜像优先、官方源兜底）→ **校 sha512** → 解包落盘。
     * @returns 该包的安装记录（含来源、哈希、许可证、字节数）。
     */
    const fetchNpmPackage = async (root, spec) => {
      const name = String(spec.name || '').trim()
      if (name === '') throw new Error('包名不能为空')
      const want = spec.version === undefined || spec.version === null || spec.version === '' ? null : String(spec.version)
      let meta = null
      let sourceUsed = null
      let lastErr = null
      for (const source of TOOL_SOURCES) {
        try {
          const url = source + '/' + name.replace('/', '%2f') + (want === null ? '/latest' : '/' + want)
          const res = await fetch(url)
          if (!res.ok) throw new Error('HTTP ' + res.status)
          meta = await res.json()
          sourceUsed = source
          break
        } catch (err) { lastErr = err }
      }
      if (meta === null) throw new Error(name + '：取元数据失败（' + String((lastErr && lastErr.message) || lastErr) + '）')
      const version = String(meta.version || want || '')
      const dist = meta.dist || {}
      if (typeof dist.tarball !== 'string' || typeof dist.integrity !== 'string' || !dist.integrity.startsWith('sha512-')) {
        throw new Error(name + '@' + version + '：来源没有给 sha512 校验值，拒绝安装')
      }
      const expected = dist.integrity.slice('sha512-'.length)
      const buf = Buffer.from(await (await fetch(dist.tarball)).arrayBuffer())
      const actual = createHash('sha512').update(buf).digest('base64')
      if (actual !== expected) throw new Error(name + '@' + version + '：哈希不符，拒绝安装')
      const target = path.join(root, 'node_modules', ...name.split('/'))
      const staging = await mkdtemp(path.join(root, '.staging-'))
      try {
        await writeFile(path.join(staging, 'pkg.tgz'), buf)
        await runCommand('tar', ['-xzf', path.join(staging, 'pkg.tgz'), '-C', staging], staging)
        const unpacked = path.join(staging, 'package')
        await mkdir(path.dirname(target), { recursive: true })
        // ⚠ 刚解出来的文件常被 Windows Defender 首扫按住 → rename 偶发 EPERM，重试几次
        let lastErr = null
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await rm(target, { recursive: true, force: true })
            await rename(unpacked, target)
            lastErr = null
            break
          } catch (err) {
            lastErr = err
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
          }
        }
        if (lastErr !== null) throw lastErr
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => { /* 清不掉不影响安装结果 */ })
      }
      return {
        name, version, source: sourceUsed, tarball: dist.tarball, integrity: dist.integrity,
        license: typeof meta.license === 'string' ? meta.license : undefined,
        packedBytes: buf.length, installedAt: new Date().toISOString(),
        bin: meta.bin === undefined ? undefined : meta.bin,
      }
    }
    /** 装一组包（逐个校验、逐个落盘），并合并写回 manifest.json。 */
    const installNpmPackages = async (packages) => {
      const root = toolsRoot()
      if (root === null) throw new Error('不知道应用家目录（DSH_HOME 没设），拒绝安装')
      await mkdir(root, { recursive: true })
      const manifest = readToolManifest(root)
      manifest.entries = Array.isArray(manifest.entries) ? manifest.entries : []
      const installed = []
      for (const spec of packages) {
        const record = await fetchNpmPackage(root, spec)
        manifest.entries = manifest.entries.filter((e) => !(e.name === record.name && e.version === record.version))
        manifest.entries.push(record)
        installed.push(record)
      }
      await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ root, entries: manifest.entries }, null, 2) + '\n')
      return { root, installed }
    }
    /**
     * 往装配单追加一行语言（provider）：插在锚点注释下面，缩进与既有条目一致。
     * 装配单是 live reload 的（应用 profile 里 patchReload: live）⇒ 不重启即生效。
     */
    const appendProviderEntry = async ({ id, command, args, extensionToLanguage }) => {
      const file = profilePatchPath()
      if (file === null) throw new Error('不知道应用家目录（DSH_HOME 没设），无法写装配单')
      const text = await readFile(file, 'utf8')
      if (text.includes('          ' + id + ':')) return { changed: false, reason: 'already-present' }
      const lines = text.split('\n')
      const at = lines.findIndex((l) => l.trim() === LANG_MARKER.trim())
      if (at < 0) throw new Error('装配单里找不到锚点注释，拒绝改文件（请检查 profile 的 cordis.patch.yml）')
      const block = [
        '          ' + id + ':',
        '            command: ' + command,
        '            args:',
        ...args.map((a) => "              - '" + String(a).replace(/'/g, "''") + "'"),
        '            extensionToLanguage:',
        ...Object.entries(extensionToLanguage).map(([ext, lang]) => "              '" + ext + "': " + lang),
        '',
      ]
      lines.splice(at + 1, 0, ...block)
      await writeFile(file, lines.join('\n'))
      return { changed: true, file }
    }
    /** 已装的组件（读 manifest，供状态接口/设置面板显示）。 */
    const installedComponents = () => {
      const root = toolsRoot()
      if (root === null) return { root: null, entries: [] }
      return { root, entries: readToolManifest(root).entries }
    }
    /**
     * Agent 现在能查哪些语言的代码（⑤）：读装配单里每个 provider 的 extensionToLanguage。
     * ⚠ 口径是**装配单**，不是"装了哪些包"——装了包却没写进装配单 = 没生效，不能当有。
     * 为什么读文件而不问引擎：引擎的代码导航服务只暴露 registerProvider/query，
     * 没有任何"列举已覆盖语言"的接口（packages/lsp/lsp/src/types.ts 明说"只暴露这四个操作"）。
     * 装配单是 live reload 的 ⇒ 这份结果就是"此刻真正生效"的那一份。
     */
    const codeNavCoverage = async () => {
      const file = profilePatchPath()
      const out = { root: toolsRoot(), patch: file, extToLang: {}, languages: [] }
      if (file === null) return out
      let text = ''
      try { text = await readFile(file, 'utf8') } catch { return out }
      // 逐行过，只在 `extensionToLanguage:` 这一小节里收 `'.ext': lang`。
      // 为什么不全文抓同形状的行：装配单里别的功能也可能有同样的映射形状，
      // 全局抓会把"别的配置"错算成"代码导航已覆盖" → 界面从此不再提示缺语言。
      const byLang = new Map()
      const lines = text.split('\n')
      let mapIndent = -1
      for (const line of lines) {
        const body = line.replace(/\s+$/, '')
        const indent = body.length - body.trimStart().length
        if (mapIndent < 0) {
          if (/^\s*extensionToLanguage:\s*$/.test(body)) mapIndent = indent
          continue
        }
        if (body.trim() === '') continue
        if (indent <= mapIndent) { mapIndent = -1; continue }   // 这一小节结束
        const m = /^'([^']+)':\s*([A-Za-z0-9_.\-]+)$/.exec(body.trim())
        if (m === null) continue
        const ext = m[1].toLowerCase()
        const lang = m[2]
        if (out.extToLang[ext] === undefined) out.extToLang[ext] = lang
        if (!byLang.has(lang)) byLang.set(lang, [])
        const list = byLang.get(lang)
        if (!list.includes(ext)) list.push(ext)
      }
      out.languages = [...byLang.entries()].map(([id, exts]) => ({ id, exts }))
      return out
    }
    /**
     * 一次"加一门语言"的完整动作：装包 → 追加 provider 行。
     * 由模型可见工具 `code_nav_install` 与 HTTP 路由 `/nav-install` 共用同一份实现。
     */
    const addCodeNavLanguage = async (input) => {
      const language = String(input.language || '').trim()
      const extensions = Array.isArray(input.extensions) ? input.extensions.map((e) => String(e).trim()).filter((e) => e !== '') : []
      const packages = Array.isArray(input.packages) ? input.packages : []
      if (language === '' || extensions.length === 0 || packages.length === 0) {
        throw new Error('需要 language、extensions、packages 三样；例如 language=python, extensions=[".py"], packages=[{name:"pyright"}]')
      }
      const installed = await installNpmPackages(packages)
      // 师傅的入口：优先用调用方给的 args；否则从包自带 bin 推断（node + bin 文件 + --stdio）
      let command = input.command === undefined ? 'node' : String(input.command)
      let args = Array.isArray(input.args) ? input.args.map(String) : null
      if (args === null) {
        const primary = installed.installed[0]
        const binField = primary && primary.bin
        let entry = ''
        if (typeof binField === 'string') entry = binField
        else if (binField && typeof binField === 'object') {
          // 一个包里常有好几个 bin（例如 pyright 有 CLI 和 langserver 两个入口），
          // 优先挑名字像语言服务器的那个；挑不到就用第一个。
          const keys = Object.keys(binField)
          const pick = keys.find((k) => /lang(server|uage-server)/i.test(k))
            || keys.find((k) => /server/i.test(k))
            || keys[0]
          entry = String((pick === undefined ? '' : binField[pick]) || '')
        }
        if (entry === '') {
          throw new Error('包装好了，但没法确定入口：请在调用时显式给 args（例如 args=["<包内入口文件>","--stdio"]）')
        }
        args = [path.join(installed.root, 'node_modules', ...String(primary.name).split('/'), entry), '--stdio']
      }
      const extensionToLanguage = {}
      for (const ext of extensions) extensionToLanguage[ext] = language
      const patched = await appendProviderEntry({ id: language, command, args, extensionToLanguage })
      trace({ level: 'info', kind: 'code-nav-add-language', language, packages: installed.installed.map((p) => p.name + '@' + p.version), patchChanged: patched.changed })
      return { language, extensions, packages: installed.installed.map((p) => ({ name: p.name, version: p.version, source: p.source, license: p.license, packedBytes: p.packedBytes })), command, args, patch: patched }
    }

    // ── 插件面板的「全量透明」数据（2026-09-22 用户要求）────────────────────
    // 用户原话："后端那一大批插件也要在这里显示……其它什么不可见的统统都要显示，这些东西
    // 必须对我透明的，我是软件的开发者，隐藏干嘛。"
    // 所以这里读**插件树的真身**：ctx.loader.entries()（含嵌套组，含 **disabled 的行**），
    // 每条带：行 id / 包 specifier / 有效状态（fiber state）/ 是否停用 / 是否另有一个前端半 /
    // 前端 bundle 的 rev 与加载方式 / 所在组（getOuterStack）/ 包版本与 package.json 的说明。
    // ⚠ 故意**不回传 config**（配置里可能有凭证/密钥，面板会落进截图与轨迹日志）。
    const FIBER_STATE_TEXT = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed' }
    /** loader 的 getOuterStack() 回的是 `    at file:///…/profiles/web/#<组名>` 这种串，取 # 后面的组名。 */
    const cleanStack = (outer) => {
      const out = []
      for (const raw of Array.isArray(outer) ? outer : []) {
        const text = String(raw || '')
        const hash = text.lastIndexOf('#')
        const tail = (hash >= 0 ? text.slice(hash + 1) : text).trim()
        if (tail !== '') out.push(tail)
      }
      return out
    }
    /** 包元数据缓存（包不会在运行中变；重启后端才重读）。 */
    const pkgMetaCache = new Map()
    const profileDir = path.dirname(fileURLToPath(import.meta.url)) // <home>/profiles/web/ide/dsh-ide/lib
    const profileRequire = createRequire(path.join(profileDir, '..', '..', '..', 'package.json'))
    const readPkgMeta = (specifier) => {
      if (typeof specifier !== 'string' || specifier === '' || specifier.startsWith('.') || specifier.startsWith('/')) return undefined
      if (pkgMetaCache.has(specifier)) return pkgMetaCache.get(specifier)
      let meta
      try {
        const pkgPath = profileRequire.resolve(specifier.replace(/\\/g, '/') + '/package.json')
        const j = JSON.parse(readFileSync(pkgPath, 'utf8'))
        meta = {
          version: typeof j.version === 'string' ? j.version : undefined,
          description: typeof j.description === 'string' ? j.description : undefined,
          dir: path.dirname(pkgPath),
        }
      } catch { meta = undefined }
      pkgMetaCache.set(specifier, meta)
      return meta
    }
    const pluginRows = () => {
      const clientById = new Map()
      for (const e of formalPlugins()) clientById.set(e.id, e)
      const rows = []
      let entries = []
      try { entries = [...ctx.loader.entries()] } catch (err) {
        trace({ level: 'warn', kind: 'plugin-rows-failed', error: String((err && err.message) || err) })
        return rows
      }
      for (const entry of entries) {
        let id = ''
        let name = ''
        let disabled = false
        let outer = []
        try { id = String(entry.id || '') } catch { /* id getter 异常不该拖垮整份清单 */ }
        try { name = String((entry.options && entry.options.name) || '') } catch { /* 同上 */ }
        try { disabled = entry.disabled === true } catch { /* 同上 */ }
        try { outer = typeof entry.getOuterStack === 'function' ? entry.getOuterStack() : [] } catch { /* 同上 */ }
        const fiber = entry.fiber
        const state = disabled ? 'disabled'
          : fiber === undefined ? 'unloaded'
            : (FIBER_STATE_TEXT[fiber.state] || ('state-' + String(fiber.state)))
        const client = clientById.get(name)
        const meta = readPkgMeta(name)
        const stack = cleanStack(outer)
        rows.push({
          id: id || name,
          name,
          state,
          disabled,
          group: stack.length > 0 ? stack.join(' › ') : undefined,
          stack,
          hasClient: client !== undefined,
          clientRev: client ? String(client.rev || '') : undefined,
          clientImmediately: client ? !!client.immediately : undefined,
          clientInject: client && Array.isArray(client.inject) ? client.inject.length : undefined,
          version: meta ? meta.version : undefined,
          description: meta ? meta.description : undefined,
        })
      }
      rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return rows
    }

    // ── 能力面板：技能 / MCP（2026-11-05）────────────────────────────────────
    // 技能只读：技能本体是磁盘上的 SKILL.md，面板不碰文件（开关状态存在天工自己的配置里，
    // 见 skill-toggle 一节）。目录口径照引擎的 skill-filesystem：项目根的 .dsh\skills 与
    // .agents\skills、家目录的 skills、用户目录的 .agents\skills；一级目录里找 SKILL.md，
    // 或同名的扁平 .md。同名先到先得，顺序与引擎的 rank 一致。
    // /init 每 5 秒来一次，扫盘结果缓存 5 秒，别让轮询一直读盘。
    const DSH_HOME_DIR = (() => {
      const env = String(process.env.DSH_HOME || '').trim()
      if (env) return env
      return path.resolve(profileDir, '..', '..', '..', '..')
    })()
    const USER_AGENTS_DIR = (() => {
      const env = String(process.env.DSH_AGENTS_HOME || '').trim()
      if (env) return env
      const home = String(process.env.USERPROFILE || process.env.HOME || '').trim()
      return home ? path.join(home, '.agents') : ''
    })()

    const SKILL_FM_LINE = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/
    const parseSkillFrontmatter = (text) => {
      const norm = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
      if (!norm.startsWith('---\n')) return undefined
      const end = norm.indexOf('\n---', 3)
      if (end < 0) return undefined
      const out = {}
      for (const line of norm.slice(4, end).split('\n')) {
        const m = SKILL_FM_LINE.exec(line)
        if (!m) continue
        let v = m[2].trim()
        if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1)
        out[m[1]] = v
      }
      return out
    }
    const SKILL_TRUTHY = /^(true|yes|on|1)$/i
    const skillRoots = async () => {
      const roots = []
      const root = await resolveRoot()
      if (root) {
        roots.push({ dir: path.join(root, '.dsh', 'skills'), source: 'project' })
        roots.push({ dir: path.join(root, '.agents', 'skills'), source: 'project' })
      }
      roots.push({ dir: path.join(DSH_HOME_DIR, 'skills'), source: 'user' })
      if (USER_AGENTS_DIR) roots.push({ dir: path.join(USER_AGENTS_DIR, 'skills'), source: 'user' })
      return roots
    }
    let skillCache = { at: 0, items: [] }
    const skillsForPanel = async () => {
      const now = Date.now()
      if (now - skillCache.at < 5000) return skillCache.items
      const capState = readCapabilityState()
      const items = []
      const seen = new Set()
      for (const r of await skillRoots()) {
        let names = []
        try { names = readdirSync(r.dir) } catch { continue }   // 目录不存在：这一根就当没有
        for (const name of names) {
          let file = path.join(r.dir, name, 'SKILL.md')
          let ok = false
          try { ok = statSync(file).isFile() } catch { ok = false }
          if (!ok) {
            file = path.join(r.dir, name.replace(/\.md$/i, '') + '.md')
            try { ok = statSync(file).isFile() } catch { ok = false }
          }
          if (!ok) continue
          let fm
          try { fm = parseSkillFrontmatter(readFileSync(file, 'utf8')) } catch { continue }
          // 与引擎同一条门槛：name + description 缺一个就不算技能（引擎那边也直接忽略）
          if (!fm || !fm.name || !fm.description) continue
          if (seen.has(fm.name)) continue
          seen.add(fm.name)
          const modelInvocable = !SKILL_TRUTHY.test(String(fm['disable-model-invocation'] || '').trim())
          const userInvocable = fm['user-invocable'] === undefined ? true : SKILL_TRUTHY.test(String(fm['user-invocable']).trim())
          const userOff = skillDisabledByUser(capState, fm.name)
          items.push({
            name: fm.name,
            displayName: fm.display_name || undefined,
            description: fm.description,
            whenToUse: fm.whenToUse || fm['when-to-use'] || undefined,
            path: file,
            root: r.dir,
            source: r.source,
            // enabled 是"面板上这个开关"，文件里的字段只说明作者声明的默认值
            enabled: !userOff && (modelInvocable || userInvocable),
            userDisabled: userOff,
            modelInvocable,
            userInvocable,
          })
        }
      }
      items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      skillCache = { at: now, items }
      return items
    }

    // MCP：一台服务器 = 装配单里一行 dsh-mcp-client。引擎不发布连接状态，
    // 面板能说的只有配置本身（连接与否靠工具数，见 /mcp-tools）。
    // ⚠ 只取能显示的字段，config.env / headers 里可能有凭证，一律不回传。
    // 引擎不发布 MCP 连接状态（连接态是插件闭包里的局部变量），唯一可信信号是
    // "这台服务器的工具有没有挂到工具表上"。工具名格式 mcp__<serverName>__<原名>。
    const mcpToolCounts = () => {
      const out = new Map()
      try {
        if (ctx.tools === undefined || typeof ctx.tools.schemas !== 'function') return out
        for (const schema of ctx.tools.schemas()) {
          const parts = String((schema && schema.name) || '').split('__')
          if (parts.length < 3 || parts[0] !== 'mcp') continue
          out.set(parts[1], (out.get(parts[1]) || 0) + 1)
        }
      } catch { /* 拿不到工具表就当一台都没挂上 */ }
      return out
    }
    const mcpForPanel = () => {
      const out = []
      const toolCounts = mcpToolCounts()
      let entries = []
      try { entries = [...ctx.loader.entries()] } catch { return out }
      for (const entry of entries) {
        let name = ''
        try { name = String((entry.options && entry.options.name) || '') } catch { continue }
        if (!/dsh-mcp-client$/.test(name)) continue
        const cfg = (entry.options && entry.options.config) || {}
        let id = ''
        let disabled = false
        try { id = String(entry.id || '') } catch { /* 忽略 */ }
        try { disabled = entry.disabled === true } catch { /* 忽略 */ }
        // 装配单 insert 进来的行会被挂在 include 组下（id 变成 include:xxx）；
        // 面板标记块用的是我们写入时的裸 id，剥掉前缀两边才对得上，否则改一次就多一条
        if (id.startsWith('include:')) id = id.slice('include:'.length)
        out.push({
          id: id || String(cfg.serverName || ''),
          serverName: String(cfg.serverName || ''),
          transport: String(cfg.transport || 'stdio'),
          command: cfg.command ? String(cfg.command) : undefined,
          args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
          url: cfg.url ? String(cfg.url) : undefined,
          disabled,
          toolCount: toolCounts.get(String(cfg.serverName || '')) || 0,
        })
      }
      out.sort((a, b) => (a.serverName < b.serverName ? -1 : a.serverName > b.serverName ? 1 : 0))
      return out
    }

    // ── 能力面板：技能开关与 MCP 条目（写侧，2026-11-05）──────────────────────
    // 两条硬口径：
    //   ① 技能文件只读 —— 开关记在天工自己的 capabilities.json，引擎取技能时按表过滤；
    //   ② MCP 只改装配单里我们自己的标记块，块外一个字不动（那份文件满是解释性注释，
    //      用 YAML 解析再序列化会把注释和顺序全冲掉）。
    const capabilityPath = () => path.join(DSH_HOME_DIR, 'capabilities.json')
    const readCapabilityState = () => {
      try {
        const j = JSON.parse(readFileSync(capabilityPath(), 'utf8'))
        return j && typeof j === 'object' ? j : {}
      } catch { return {} }
    }
    const writeCapabilityState = async (state) => {
      await mkdir(DSH_HOME_DIR, { recursive: true })
      await writeFile(capabilityPath(), JSON.stringify(state, null, 2) + '\n', 'utf8')
    }
    const skillDisabledByUser = (state, name) => {
      const s = state && state.skills && typeof state.skills === 'object' ? state.skills[name] : undefined
      return !!(s && s.enabled === false)
    }
    const setSkillEnabled = async (name, enabled) => {
      const key = String(name || '')
      if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw new Error('bad-skill-name: ' + key)
      const state = readCapabilityState()
      const skills = state.skills && typeof state.skills === 'object' ? { ...state.skills } : {}
      if (enabled) delete skills[key]
      else skills[key] = { enabled: false }
      state.skills = skills
      await writeCapabilityState(state)
      skillCache = { at: 0, items: [] }
      trace({ level: 'info', kind: 'skill-toggle', name: key, enabled: !!enabled })
      return { name: key, enabled: !!enabled }
    }

    const MCP_BLOCK_KEY = 'dsh-ide:mcp:'
    const mcpBlockStart = (id) => '# >>> ' + MCP_BLOCK_KEY + id
    const mcpBlockEnd = (id) => '# <<< ' + MCP_BLOCK_KEY + id
    const MCP_HEAD_PREFIX = '# ── 天工能力面板：MCP 服务器'
    /** 取 pos 所在行前面那一行（去掉行尾），没有就返回 null。 */
    const prevLineOf = (text, pos) => {
      const curStart = text.lastIndexOf('\n', pos - 1) + 1
      if (curStart <= 0) return null
      const prevEnd = curStart - 1
      const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1
      return { start: prevStart, text: text.slice(prevStart, prevEnd) }
    }
    const readMcpRawConfig = (id) => {
      let entries = []
      try { entries = [...ctx.loader.entries()] } catch { return undefined }
      for (const entry of entries) {
        let name = ''
        let eid = ''
        try { name = String((entry.options && entry.options.name) || '') } catch { continue }
        try { eid = String(entry.id || '') } catch { /* 忽略 */ }
        if (eid.startsWith('include:')) eid = eid.slice('include:'.length)
        if (!/dsh-mcp-client$/.test(name) || eid !== id) continue
        const cfg = (entry.options && entry.options.config) || {}
        return cfg && typeof cfg === 'object' ? { ...cfg } : {}
      }
      return undefined
    }
    const mcpBlockText = (row, baseConfig) => {
      const cfg = { ...(baseConfig || {}) }
      cfg.serverName = row.serverName
      cfg.transport = row.transport
      if (row.transport === 'streamable-http') {
        delete cfg.command
        delete cfg.args
        delete cfg.cwd
        cfg.url = row.url
      } else {
        delete cfg.url
        cfg.command = row.command
        cfg.args = Array.isArray(row.args) ? row.args : []
      }
      const lines = [
        MCP_HEAD_PREFIX + ' ' + row.serverName + '（改这一块请走能力面板）──',
        mcpBlockStart(row.id),
        '- insert:',
        '    - id: ' + JSON.stringify(row.id),
        "      name: '@deepseek-ai/dsh-mcp-client'",
      ]
      if (row.disabled) lines.push('      disabled: true')
      lines.push('      config: ' + JSON.stringify(cfg))
      lines.push(mcpBlockEnd(row.id))
      return lines.join('\n') + '\n'
    }
    const saveMcpEntry = async (row) => {
      const file = profilePatchPath()
      if (!file) throw new Error('no-dsh-home')
      let text = ''
      try { text = readFileSync(file, 'utf8') } catch { text = '' }
      const block = mcpBlockText(row, readMcpRawConfig(row.id))
      const start = mcpBlockStart(row.id)
      const end = mcpBlockEnd(row.id)
      const si = text.indexOf(start)
      const ei = text.indexOf(end)
      let next
      if (si >= 0 && ei > si) {
        // 块上面那行标题注释属于块，替换范围要连它一起盖掉，
        // 否则每改一次（启停也算）就多堆一行标题
        let from = si
        const p = prevLineOf(text, from)
        if (p && p.text.indexOf(MCP_HEAD_PREFIX) >= 0) from = p.start
        next = text.slice(0, from) + block + text.slice(ei + end.length).replace(/^\r?\n/, '')
      } else {
        const sep = text.length === 0 ? '' : (text.endsWith('\n') ? '\n' : '\n\n')
        next = text + sep + block
      }
      await writeFile(file, next, 'utf8')
      trace({ level: 'info', kind: 'mcp-save', id: row.id, serverName: row.serverName, transport: row.transport, disabled: !!row.disabled })
      return { id: row.id }
    }
    const deleteMcpEntry = async (id) => {
      const file = profilePatchPath()
      if (!file) throw new Error('no-dsh-home')
      let text = ''
      try { text = readFileSync(file, 'utf8') } catch { return { id, changed: false } }
      const start = mcpBlockStart(id)
      const end = mcpBlockEnd(id)
      const si = text.indexOf(start)
      const ei = text.indexOf(end)
      if (si < 0 || ei <= si) return { id, changed: false }
      // 块上面那行分隔注释和它前面的空行跟块是一体的，一起带走
      // （只删块本身会在文件尾留一条孤零零的标题和空行，反复增删会把空行越堆越多）
      let from = si
      let p = prevLineOf(text, from)
      if (p && p.text.indexOf(MCP_HEAD_PREFIX) >= 0) { from = p.start; p = prevLineOf(text, from) }
      if (p && p.text.trim() === '') from = p.start
      const next = text.slice(0, from) + text.slice(ei + end.length).replace(/^\r?\n/, '')
      await writeFile(file, next, 'utf8')
      trace({ level: 'info', kind: 'mcp-delete', id })
      return { id, changed: true }
    }
    const setMcpDisabled = async (id, disabled) => {
      const item = mcpForPanel().find((m) => m.id === id)
      if (!item) throw new Error('mcp-not-found: ' + id)
      return saveMcpEntry({ ...item, disabled: !!disabled })
    }

    // 用户编辑器的写路径 = **用户自己的动作，不受 Agent 沙箱约束**。
    // 2026-09-22 用户报障："桌面上的文件保存失败：file access denied under workspace-write mode" ——
    // 拖进编辑区的文件在工作区之外，而 fs-sandbox 的会话策略是 workspace-write，写就被拦了。
    // 与 VSCode 对齐（铁律①）：VSCode 里编辑器没有沙箱概念，保存任何打开的文件都直接写盘
    //（Workspace Trust 限制的是扩展能力，不是用户自己的编辑/保存）。
    // 边界不受影响：会话策略仍然原样作用于 **Agent 的工具链**（tool-fs / pwsh / 子进程），
    // 这里只改"用户编辑器"这一条写路径；Agent 要写工作区外，照旧得走它自己的升权审批。
    // ⚠ 别退回 `{ mode: base.mode, workspaceRoot: root }`（2026-08-25 踩坑 20 的补丁只解决一半：
    //   它把"用户工作区"当成唯一可写根，工作区外的文件照样存不了）。
    const writePolicy = async () => {
      if (sandboxPolicy === undefined) return undefined
      try {
        const base = sandboxPolicy.resolve()
        const root = await resolveRoot()
        const workspaceRoot = root || (base && base.workspaceRoot)
        return workspaceRoot ? { mode: 'danger-full-access', workspaceRoot } : { mode: 'danger-full-access' }
      } catch { return { mode: 'danger-full-access' } }
    }

    // ── 全量文件遍历（③ 快速打开 Ctrl+P / 全局搜索 Ctrl+Shift+F 共用）──
    // 忽略表写死公共项（③ 拍板：不做个性化设置界面）；遍历走 ctx.fs，
    // 输出 path = fsService.processPath，与 /list-dir、/read-file 同格式，
    // client 拿到的路径可直接 openTab / 读写，无需二次换算。
    const IGNORE_DIRS = {
      '.git': 1, 'node_modules': 1, 'dist': 1, 'build': 1, 'out': 1,
      'coverage': 1, '.next': 1, '.nuxt': 1, '.cache': 1, '.venv': 1,
      'venv': 1, '__pycache__': 1, '.idea': 1, '.DS_Store': 1,
      // 盘符根/系统目录专用（2026-09-20）：工作区可以是整块盘，这几个是系统垃圾且读不了
      '$RECYCLE.BIN': 1, 'System Volume Information': 1,
      '$WinREAgent': 1, 'Recovery': 1, 'Config.Msi': 1,
      '.pnpm-store': 1, 'pnpm-store': 1,
    }
    const MAX_WALK_FILES = 20000      // 单次遍历文件数上限（防超大目录拖死）
    const MAX_SEARCH_HITS = 200       // 单次搜索命中上限，超出置 truncated
    const MAX_SEARCH_BYTES = 2 * 1024 * 1024 // 超过此大小的文件跳过内容匹配
    const SEARCH_CONCURRENCY = 12     // 并行读文件数（读文本为主，适度并发）

    // ── ③/⑫ 搜索匹配器（/search 与 /replace 共用）──────────────────────
    // 支持：大小写敏感 · 正则 · 全词。返回**绝对字符偏移**（UTF-16，与 monaco 同源），
    // 这样 /replace 能精确到"某一处"而不是只按行。全词按标识符字符集判定（字母/数字/_/$）。
    const WORD_CHAR = /[A-Za-z0-9_$]/
    const isWordBoundaryAt = (text, index, len) => {
      const before = index > 0 ? text[index - 1] : ''
      const after = index + len < text.length ? text[index + len] : ''
      return !WORD_CHAR.test(before) && !WORD_CHAR.test(after)
    }
    const buildMatcher = (query, caseSensitive, useRegex, wholeWord) => {
      if (useRegex) {
        let re = null
        try { re = new RegExp(query, caseSensitive ? 'gm' : 'gim') } catch { return null } // m：^/$ 按行锚定（与 VSCode 的行式搜索一致；无 m 时 ^ 只匹配文件开头）
        return (text) => {
          const out = []
          re.lastIndex = 0
          let m = null
          while ((m = re.exec(text)) !== null) {
            if (m[0] === '') { re.lastIndex += 1; continue } // 零宽匹配防护（否则死循环）
            if (!wholeWord || isWordBoundaryAt(text, m.index, m[0].length)) {
              out.push({ offset: m.index, length: m[0].length, text: m[0], groups: m.slice(1) })
            }
            if (out.length >= 5000) break
          }
          return out
        }
      }
      const needle = caseSensitive ? query : query.toLowerCase()
      if (!needle) return () => []
      return (text) => {
        const hay = caseSensitive ? text : text.toLowerCase()
        const out = []
        let from = 0
        while (true) {
          const at = hay.indexOf(needle, from)
          if (at < 0) break
          if (!wholeWord || isWordBoundaryAt(text, at, needle.length)) out.push({ offset: at, length: needle.length, text: text.slice(at, at + needle.length) })
          from = at + needle.length
          if (out.length >= 5000) break
        }
        return out
      }
    }
    const lineStartsOf = (text) => {
      const starts = [0]
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
      return starts
    }
    const posFromOffset = (starts, offset) => { // 二分找行，1-based 行列（列按 UTF-16 码元，与 monaco 一致）
      let lo = 0
      let hi = starts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid] <= offset) lo = mid
        else hi = mid - 1
      }
      return { line: lo + 1, col: offset - starts[lo] + 1 }
    }
    const expandReplacement = (rep, m) => String(rep).replace(/\$(\d|&)/g, (all, g) => {
      if (g === '&') return m.text || ''
      const idx = Number(g) - 1
      const val = m.groups && m.groups[idx] !== undefined ? m.groups[idx] : ''
      return val === undefined ? '' : val
    })

    const collectFiles = async (rootTarget) => {
      const out = []
      const rec = async (target, depth) => {
        if (depth > 24 || out.length >= MAX_WALK_FILES) return
        let entries = null
        try {
          entries = await fsService.listDir(target)
        } catch {
          // 平台 listDir 会因为"某个孩子读不了"整次失败 —— 盘符根（D:\）必然如此，
          // 不给退路的话 /tree、/search、/@types 这些全都会返回空 ✗（2026-09-20）。
          // 退路：只 readdir 的容错列目录，再逐个拿回 fs target（读文件要用）。
          // 注意：这个目录**本身**若真读不了，listDirTolerant 返回 null → 与老行为一致地跳过。
          const tol = await listDirTolerant(fsService.processPath(target))
          if (tol === null) return
          entries = []
          for (const t of tol) {
            let childTarget = null
            try { childTarget = await fsService.resolve(t.path) } catch { continue }
            entries.push({ name: t.name, type: t.type, size: t.size, target: childTarget })
          }
        }
        for (const e of entries || []) {
          if (e.type === 'directory') {
            if (IGNORE_DIRS[e.name]) continue
            await rec(e.target, depth + 1)
          } else if (e.type === 'file') {
            out.push({
              path: fsService.processPath(e.target),
              name: e.name,
              size: typeof e.size === 'number' ? e.size : null,
              target: e.target, // 仅供本进程内部读文件用，不出响应体
            })
            if (out.length >= MAX_WALK_FILES) return
          }
        }
      }
      await rec(rootTarget, 0)
      return out
    }

    // ── 反悔药：快照引擎（增量 + 保留策略 + 差异 + 一键还原）──────────────
    const snapsDir = (root) => path.join(snapBaseDir(), snapWsKey(root))
    const manifestsDir = (root) => path.join(snapsDir(root), 'manifests')
    const blobsDir = (root) => path.join(snapsDir(root), 'blobs')
    const trashDir = (root, ts) => path.join(snapsDir(root), 'trash', String(ts))
    const indexPath = (root) => path.join(snapsDir(root), 'index.jsonl')
    const blobPath = (root, sha) => path.join(blobsDir(root), sha)

    const readIndex = async (root) => {
      const buf = await buffered(indexPath(root))
      if (!buf) return []
      const out = []
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line) continue
        try { out.push(JSON.parse(line)) } catch { /* 半行（进程被杀）忽略 */ }
      }
      return out
    }
    const readManifest = async (root, ts) => {
      const buf = await buffered(path.join(manifestsDir(root), ts + '.json'))
      if (!buf) return null
      try { return JSON.parse(buf.toString('utf8')) } catch { return null }
    }
    const writeAtomic = async (file, data) => {   // 先写临时文件再改名：断电/被杀不会留半份清单
      const tmp = file + '.' + process.pid + '.tmp'
      await writeFile(tmp, data)
      await rename(tmp, file)
    }
    const blobText = async (root, sha) => previewText(await buffered(blobPath(root, sha)))

    const snapshotStore = async (root) => {
      let bytes = 0, count = 0
      for (const b of await readDirSafe(blobsDir(root))) {
        try { const st = await stat(path.join(blobsDir(root), b.name)); bytes += st.size; count++ } catch { /* 忽略 */ }
      }
      return { bytes, blobs: count }
    }

    // 保留策略：先按份数，再按总容量（从最旧淘汰），最后删掉没人引用的内容块
    const gcSnapshots = async (root) => {
      const all = await readIndex(root)
      if (!all.length) return
      let idx = all.length > SNAP_KEEP ? all.slice(-SNAP_KEEP) : all
      const refsOf = async (list) => {
        const set = new Set()
        for (const s of list) {
          const m = await readManifest(root, s.ts)
          if (m && m.files) for (const k in m.files) set.add(m.files[k].sha)
        }
        return set
      }
      const blobs = await readDirSafe(blobsDir(root))
      const size = {}
      let total = 0
      for (const b of blobs) {
        try { const st = await stat(path.join(blobsDir(root), b.name)); size[b.name] = st.size; total += st.size } catch { /* 忽略 */ }
      }
      const keep = idx.slice()
      while (keep.length > 1 && total > SNAP_MAX_BYTES) {
        const gone = keep.shift()
        for (const sha of await refsOf([gone])) {
          if (size[sha] !== undefined) { total -= size[sha]; delete size[sha] }
        }
      }
      const keepTs = new Set(keep.map((s) => s.ts))
      const dropped = all.filter((s) => !keepTs.has(s.ts))
      for (const s of dropped) {
        await rm(path.join(manifestsDir(root), s.ts + '.json'), { force: true }).catch(() => {})
        await rm(trashDir(root, s.ts), { recursive: true, force: true }).catch(() => {})
      }
      if (dropped.length) await writeAtomic(indexPath(root), keep.map((s) => JSON.stringify(s)).join('\n') + '\n').catch(() => {})
      const referenced = await refsOf(keep)
      for (const b of blobs) if (!referenced.has(b.name)) await rm(path.join(blobsDir(root), b.name), { force: true }).catch(() => {})
    }

    const takeSnapshot = async (root, label, reason) => {
      if (!root) return { ok: false, code: 'no-workspace' }
      const idx = await readIndex(root)
      const last = idx.length ? idx[idx.length - 1] : null
      // 3 秒合并窗口：客户端会在"发送前 / 保存前 / 定时"多处触发，别重复扫盘 ——
      // 但 manual（用户手动）与 pre-restore（还原前的安全网）**永不合并**：
      // 前者是用户明确的动作，后者必须是一份独立、能在列表里找到并撤回的快照。
      if (last && reason !== 'manual' && reason !== 'pre-restore' && Date.now() - last.ts < SNAP_COALESCE_MS) {
        return { ok: true, coalesced: true, ...last }
      }
      const prev = last ? await readManifest(root, last.ts) : null
      // 超大工作区（盘符根那种）**在遍历之前**就判掉自动快照 —— 实测扫一遍 D:\ 要 97 秒
      // （撞 2 万文件上限），每发一条消息 / 每次保存都来一遍太亏。判据两条（都极便宜）：
      //   ① 工作区根看起来就是卷根（`D:\`、`/`）② 上一份快照本来就被截断过。
      // manual / pre-restore 不受此限（用户明确的动作），但面板上会显示"未记全"。
      const rootIsVolume = /^[A-Za-z]:[\\/]?$/.test(String(root)) || root === '/'
      const lastTruncated = !!(prev && prev.truncated)
      if (reason !== 'manual' && reason !== 'pre-restore' && (rootIsVolume || lastTruncated)) {
        trace({ level: 'info', kind: 'snapshot-skip', msg: 'workspace-too-large', root, rootIsVolume })
        const base = last ? { ...last } : {
          ts: 0, iso: new Date().toISOString(), label: '（工作区过大，已跳过自动快照）', reason,
          fileCount: 0, changed: 0, added: 0, deleted: 0, partial: true,
        }
        return { ok: true, unchanged: true, skipped: 'workspace-too-large', ...base }
      }
      const files = await walkTree(root, IGNORE_DIRS, MAX_WALK_FILES, snapExcludeRoots())
      const cache = (prev && prev.files) || {}
      const map = {}
      // 没进快照的文件（超大 / 读不到）必须**逐个记账**：否则还原时它们会被当成
      // "快照之后新增的文件"搬进回收站 —— 实战项目里一个大资源文件就这么没了。
      const skipMap = {}
      let skipOverflow = false
      let changed = 0, added = 0, skipped = 0, skippedBytes = 0
      const recordSkip = (rel, size) => {
        if (Object.keys(skipMap).length >= SNAP_SKIP_MAX) { skipOverflow = true; return }
        skipMap[rel] = size
      }
      for (const f of files) {
        if (f.size > SNAP_MAX_FILE) { skipped++; skippedBytes += f.size; recordSkip(f.rel, f.size); continue }
        const old = cache[f.rel]
        let sha = old && old.size === f.size && old.mtime === f.mtime ? old.sha : null
        if (sha !== null && !(await fileExists(blobPath(root, sha)))) sha = null   // 内容块被淘汰过就重算
        if (sha === null) {
          const buf = await buffered(f.abs)
          if (!buf) { skipped++; recordSkip(f.rel, f.size); continue }
          sha = createHash('sha1').update(buf).digest('hex')
          const bp = blobPath(root, sha)
          if (!(await fileExists(bp))) {
            await mkdir(blobsDir(root), { recursive: true })
            await writeAtomic(bp, buf)
          }
        }
        map[f.rel] = { sha, size: f.size, mtime: f.mtime }
        if (!prev) continue
        if (!old) added++
        else if (old.sha !== sha) changed++
      }
      const deleted = prev ? Object.keys(cache).filter((r) => map[r] === undefined).length : 0
      // 内容完全没变（且不是用户手动 / 还原前安全网）→ 不落新快照：定时兜底每 5 分钟跑一次，
      // 若每次都落一份，40 份的保留窗口只够 3 小时，会把真正有用的历史挤掉。
      if (prev && changed === 0 && added === 0 && deleted === 0 && reason !== 'manual' && reason !== 'pre-restore') {
        return { ok: true, unchanged: true, ...last }
      }
      const ts = Date.now()
      const manifest = {
        ts, iso: new Date(ts).toISOString(), label: label || '快照', reason: reason || 'manual',
        root, files: map, skipped: skipMap,
        skippedCount: skipped, skippedBytes,
        truncated: files.length >= MAX_WALK_FILES,
        // partial = 这份快照对"磁盘上都有什么"没有完整视野（遍历被截断 / 记账溢出）→
        // 还原时**不许搬走任何东西**（只做写回），否则会把没记录的文件误当"新增"处理
        partial: files.length >= MAX_WALK_FILES || skipOverflow,
      }
      await mkdir(manifestsDir(root), { recursive: true })
      await mkdir(blobsDir(root), { recursive: true })
      await writeAtomic(path.join(manifestsDir(root), ts + '.json'), JSON.stringify(manifest))
      const summary = {
        ts, iso: manifest.iso, label: manifest.label, reason: manifest.reason,
        fileCount: Object.keys(map).length, changed, added, deleted,
        skippedCount: skipped, truncated: manifest.truncated, partial: manifest.partial,
      }
      await appendFile(indexPath(root), JSON.stringify(summary) + '\n').catch(() => {})
      await gcSnapshots(root).catch(() => {})
      trace({ level: 'info', kind: 'snapshot-ok', msg: manifest.label, ts, fileCount: summary.fileCount, changed, added, deleted, skipped })
      return { ok: true, ...summary }
    }

    // 快照 vs 当前磁盘（只列真正变了的文件；内容没变的不进差异列表）
    const snapshotDiff = async (root, ts) => {
      const man = await readManifest(root, ts)
      if (!man) return { ok: false, code: 'snapshot-not-found' }
      const cur = await walkTree(root, IGNORE_DIRS, MAX_WALK_FILES, snapExcludeRoots())
      const now = {}
      for (const f of cur) now[f.rel] = f
      const items = []
      for (const rel in man.files) {
        const old = man.files[rel]
        const f = now[rel]
        if (!f) {
          const p = await blobText(root, old.sha)
          items.push({ path: path.join(root, rel), rel, status: 'deleted', leftText: p.text, leftSize: p.size, leftBinary: p.binary, rightText: '', rightSize: 0, rightBinary: false })
          continue
        }
        if (old.size === f.size && old.mtime === f.mtime) continue
        const buf = await buffered(f.abs)
        if (buf && createHash('sha1').update(buf).digest('hex') === old.sha) continue   // 时间戳变了但内容没变
        const p = await blobText(root, old.sha)
        const q = previewText(buf)
        items.push({ path: path.join(root, rel), rel, status: 'changed', leftText: p.text, leftSize: p.size, leftBinary: p.binary, rightText: q.text, rightSize: q.size, rightBinary: q.binary })
      }
      for (const rel in now) {
        if (man.files[rel]) continue
        if (man.skipped && man.skipped[rel] !== undefined) continue   // 快照时就没进去（超大/读不到）→ 不算"新增"
        const q = previewText(await buffered(now[rel].abs))
        items.push({ path: path.join(root, rel), rel, status: 'added', leftText: '', leftSize: 0, leftBinary: false, rightText: q.text, rightSize: q.size, rightBinary: q.binary })
      }
      return {
        ok: true, ts, iso: man.iso, label: man.label || '',
        partial: !!man.partial, skippedCount: man.skippedCount || 0,
        counts: {
          changed: items.filter((i) => i.status === 'changed').length,
          added: items.filter((i) => i.status === 'added').length,
          deleted: items.filter((i) => i.status === 'deleted').length,
        },
        items,
      }
    }

    // 一键还原：① 先自动存一份"还原前"快照（反悔药的反悔药）② 内容按块写回
    // ③ 快照之后新增的文件**移到回收目录**（不删）④ 每条路径都过工作空间根围栏
    const restoreSnapshot = async (root, ts, paths) => {
      const man = await readManifest(root, ts)
      if (!man) return { ok: false, code: 'snapshot-not-found' }
      const only = Array.isArray(paths) && paths.length ? new Set(paths.map((p) => path.resolve(p).toLowerCase())) : null
      const pre = await takeSnapshot(root, '还原前自动备份', 'pre-restore')
      // 回收目录按**这次还原**（= 还原前那份快照的 ts）分桶，而不是按被还原的快照 ——
      // 同一份快照可能被还原多次，各次的新增文件不能互相覆盖；这样也能顺着 preTs 找到它们。
      const rid = (pre && pre.ts) || Date.now()
      const cur = await walkTree(root, IGNORE_DIRS, MAX_WALK_FILES, snapExcludeRoots())
      let restored = 0, trashed = 0, failed = 0
      // 只有"这份快照对磁盘有完整视野"时才敢搬走文件：
      //   · 选了子集 → 只动选中的，其它一律不碰
      //   · partial / truncated → 快照没记全（遍历截断或记账溢出）→ 一律不搬
      //   · 快照时就没进去的文件（超大/读不到，记在 skipped 里）→ 一律不碰
      const canTrash = !only && !man.partial && !man.truncated
      for (const rel in man.files) {
        const abs = path.join(root, rel)
        if (only && !only.has(path.resolve(abs).toLowerCase())) continue
        if (!isInside(abs, root)) { failed++; continue }
        const buf = await buffered(blobPath(root, man.files[rel].sha))
        if (!buf) { failed++; trace({ level: 'warn', kind: 'snapshot-restore-skip', msg: 'blob-missing', rel }); continue }
        try {
          await mkdir(path.dirname(abs), { recursive: true })
          await writeFile(abs, buf)
          restored++
        } catch (e) { failed++; trace({ level: 'warn', kind: 'snapshot-restore-skip', msg: errOf(e), rel }) }
      }
      if (canTrash) {
        for (const f of cur) {
          if (man.files[f.rel]) continue
          if (man.skipped && man.skipped[f.rel] !== undefined) continue   // 没记账的文件不许动
          if (!isInside(f.abs, root)) continue
          const dest = path.join(trashDir(root, rid), f.rel)
          try {
            await mkdir(path.dirname(dest), { recursive: true })
            await rename(f.abs, dest)
            trashed++
          } catch {
            try { await copyFile(f.abs, dest); await rm(f.abs, { force: true }); trashed++ } catch { failed++ }
          }
        }
      }
      bumpFsRev(50)
      trace({ level: 'warn', kind: 'snapshot-restore', msg: 'restored', ts, restored, trashed, failed, subset: !!only, canTrash, skipped: man.skippedCount || 0, preTs: pre && pre.ts })
      return {
        ok: true, ts, restored, trashed, failed,
        preTs: pre && pre.ts, trashTs: rid, subset: !!only,
        trashSkipped: !canTrash && !only,                        // 因为快照没记全而没搬新增文件
        skippedCount: man.skippedCount || 0,
      }
    }

    // ── 对话回退：往会话里写"分隔条"（2026-10-14）────────────────────────────
    // 分隔条 = 一条**空内容的用户消息**（内容为空 ⇒ 没有占位）。为什么非它不可，两条硬约束：
    //   ① **回退发生在一条回复结束之后**，那一刻"轮次已经关闭"。而落盘回读的关系校验要求
    //      system/message 与 developer/message **必须落在开着的轮次+步骤里**
    //      （session-format-v3-to-v4\src\relationships.ts:8/269）⇒ 这两种此刻根本写不进去；
    //      能写在轮次外面的只有用户消息（官方压缩选它当载体就是这个原因）。
    //   ② 空内容的用户消息**在"发给模型"那一步被整条丢掉**（llm-deepseek\src\serialize.ts:123
    //      `if (message.role === 'user' && content.length === 0) continue`）⇒ 模型那边看不到它。
    // 来源位带我们自己的标记 'dsh-ide-rewind'：界面以后靠"这条覆盖事件是不是我们发的"认人，
    // 官方压缩的标记是 'compact-checkpoint'，两不相干。
    const REWIND_SOURCE_KIND = 'dsh-ide-rewind'
    let rewindCounter = 0
    function rewindMessage() {
      rewindCounter += 1
      return {
        id: 'dsh-ide-rewind-' + Date.now() + '-' + rewindCounter,
        role: 'user',
        content: [],
        source: { kind: REWIND_SOURCE_KIND },
      }
    }
    // 实测用的"体检读数"。
    // messages = deriveMessages 的条数（引擎视角）；effective = 真正会进请求的条数 ——
    // 按 llm-deepseek\src\serialize.ts:123 那条规则把"空内容的用户消息"扣掉，
    // 否则分隔条自己会被算成一条，读数就假了。
    function rewindDigest(session) {
      const messages = session.deriveMessages()
      const effective = messages.filter((m) => !(m.role === 'user'
        && (!Array.isArray(m.content) || m.content.length === 0)))
      return {
        events: session.snapshotEvents().length,
        nodes: session.surface.nodes.map((seq) => Number(seq)),
        messages: messages.length,
        effective: effective.length,
        tail: effective.slice(-3).map((m) => m.role + ':' + String((m.content && m.content[0] && m.content[0].text) || '').slice(0, 24)),
      }
    }

    // ── 对话回退：文件存底（"退回去"的另一半，2026-10-14）────────────────────
    // 为什么必须自己存：引擎自带的改动差异只是**每处改动 ±3 行的片段**
    // （fs\tool-fs\src\diff.ts:11/35-56），而且第三个改文件工具 str_replace_editor
    // 一点差异都不留（tool-str-replace-editor\src\index.ts:468-471）⇒ "把文件整份摆回去"没料可用。
    // 做法：**工具执行前**（tools/pre-execute 能拿到工具名与目标路径）把目标文件原样存一份；
    // 回退时按"这次改动是在检查点之后开始的吗"挑出**每个文件最早的那一份**摆回去
    // （最早那份 = 检查点当时的样子）。
    // 归位靠 atSeq = 这次改动开始时的日志长度 ⇒ 它跟检查点（一个事件序号）能直接比大小。
    const REWIND_STORE = path.join(process.env.DSH_HOME || '.', 'rewind-store')
    const REWIND_FILE_ARG = { write: 'file_path', edit: 'file_path', str_replace_editor: 'path' }
    const REWIND_MAX_FILE = 8 * 1024 * 1024
    const rewindStoreDir = (sessionId) => path.join(REWIND_STORE, String(sessionId || 'unknown'))
    function rewindRecordName(record) {
      const hash = createHash('sha1').update(String(record.path)).digest('hex').slice(0, 10)
      return 'r-' + String(record.atSeq).padStart(8, '0') + '-' + hash + '.json'
    }
    async function rewindSaveCopy(exec) {
      const key = REWIND_FILE_ARG[String((exec && exec.name) || '')]
      if (key === undefined) return
      const raw = ((exec && exec.arguments) || {})[key]
      if (typeof raw !== 'string' || raw === '') return
      const session = exec.agent && exec.agent.session
      const sessionId = session ? String(session.id) : 'unknown'
      const cwd = (session && session.header && session.header.cwd) || activeRoot || process.cwd()
      const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
      const atSeq = session ? session.snapshotEvents().length : 0
      const dir = rewindStoreDir(sessionId)
      await mkdir(dir, { recursive: true })
      const recordPath = path.join(dir, rewindRecordName({ atSeq, path: abs }))
      if (await fileExists(recordPath)) return     // 同一次改动里反复动同一个文件：留最早那份
      let existed = true
      let content = null
      try { content = await readFile(abs, 'utf8') } catch { existed = false }
      // 太大的文件不存底（存了也摆不干净，还会把盘吃满）—— 如实记账，回退时跳过并回报
      const tooBig = existed && Buffer.byteLength(String(content ?? ''), 'utf8') > REWIND_MAX_FILE
      const record = JSON.stringify({
        atSeq, path: abs, existed: existed && !tooBig, content: tooBig ? null : content, tooBig: !!tooBig, at: Date.now(),
      })
      await writeFile(recordPath, record)
      // 攒够一批再全扫（每次存底都扫一遍 store 太贵）；trim 是兜底上限，见下面的注释
      rewindUntrimmed += Buffer.byteLength(record, 'utf8')
      if (rewindUntrimmed > REWIND_TRIM_STEP) {
        rewindUntrimmed = 0
        try { await rewindTrim() } catch (err) { trace({ level: 'warn', kind: 'rewind-trim-failed', error: errOf(err) }) }
      }
      trace({ level: 'info', kind: 'rewind-save', sessionId, seq: atSeq, file: abs, existed, tooBig: !!tooBig })
    }
    async function rewindRecords(sessionId) {
      const dir = rewindStoreDir(sessionId)
      const names = await readdir(dir).catch(() => [])
      const out = []
      for (const n of names) {
        if (!String(n).startsWith('r-') || !String(n).endsWith('.json')) continue
        try { out.push(JSON.parse(await readFile(path.join(dir, n), 'utf8'))) } catch { /* 坏记录跳过 */ }
      }
      return out
    }
    /** 检查点之后被改过的文件：每个文件取最早那份存底（那是检查点当时的模样）。 */
    async function rewindAffected(sessionId, afterSeq) {
      const byPath = new Map()
      for (const r of await rewindRecords(sessionId)) {
        if (!(Number(r.atSeq) > Number(afterSeq))) continue
        const cur = byPath.get(r.path)
        if (cur === undefined || Number(r.atSeq) < Number(cur.atSeq)) byPath.set(r.path, r)
      }
      return [...byPath.values()].sort((a, b) => Number(a.atSeq) - Number(b.atSeq))
    }
    async function restoreRewindFiles(sessionId, afterSeq) {
      const affected = await rewindAffected(sessionId, afterSeq)
      const dir = rewindStoreDir(sessionId)
      const trash = path.join(dir, 'trash', String(afterSeq))
      let restored = 0
      let trashed = 0
      let skipped = 0
      for (const r of affected) {
        try {
          if (r.tooBig === true) { skipped += 1; continue }
          if (r.existed === true) { await writeFile(r.path, String(r.content ?? '')); restored += 1; continue }
          // 检查点之后**新建**的文件：退到回收目录（不真删，用户可能还要）
          await mkdir(trash, { recursive: true })
          const stamp = createHash('sha1').update(String(r.path)).digest('hex').slice(0, 8)
          await rename(r.path, path.join(trash, stamp + '-' + path.basename(r.path)))
          trashed += 1
        } catch { skipped += 1 }
      }
      if (affected.length > 0) {
        trace({ level: 'warn', kind: 'rewind-files', msg: 'restored', sessionId, afterSeq, restored, trashed, skipped })
      }
      return { restored, trashed, skipped, affected: affected.map((r) => ({ path: r.path, existed: r.existed })) }
    }

    // ── 存底清理（方案 §2.3 D.2）：不管就会只增不减、迟早吃盘 ──────────────────
    // ① 定局时释放"被砍掉那一段"的存底：那批记录的改动起点都在检查点之后，而引擎的遮蔽不可撤销
    //    （被遮的 seq 永久不可复用）⇒ 它们再也派不上用场，当场删掉。
    //    ⚠ 只在**定局**时删：取消之后还要能重新退一次，那批记录必须留着。
    async function rewindRelease(sessionId, afterSeq) {
      const dir = rewindStoreDir(sessionId)
      const names = await readdir(dir).catch(() => [])
      let removed = 0
      let bytes = 0
      for (const n of names) {
        const m = /^r-(\d+)-/.exec(String(n))
        if (m === null) continue
        if (!(Number(m[1]) > Number(afterSeq))) continue
        const p = path.join(dir, n)
        try {
          bytes += (await stat(p)).size
          await rm(p, { force: true })
          removed += 1
        } catch { /* 删不掉就留着，下一轮再来 */ }
      }
      if (removed > 0) trace({ level: 'info', kind: 'rewind-release', sessionId, afterSeq, removed, bytes })
      return { removed, bytes }
    }
    // ② 兜底上限：用户从不回退时，每轮改动都留一份，长会话照样能把盘吃满。
    //    超了就按"改动发生得最早"淘汰 —— 越旧的存底，对应"退到那么早"的代价越大、真用得上的可能越小。
    //    上限取得宽松，只当保险；每次淘汰都留痕，免得悄悄吃掉还能用的存底。
    const REWIND_STORE_MAX = 512 * 1024 * 1024
    const REWIND_TRIM_STEP = 32 * 1024 * 1024
    let rewindUntrimmed = 0
    async function rewindTrim(maxBytes) {
      const limit = Number(maxBytes) > 0 ? Number(maxBytes) : REWIND_STORE_MAX
      const files = []
      let total = 0
      const walk = async (dir) => {
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const p = path.join(dir, e.name)
          if (e.isDirectory()) { await walk(p); continue }
          if (!/^r-\d+-/.test(e.name)) continue
          const info = await stat(p).catch(() => null)
          if (info === null) continue
          files.push({ p, size: info.size, at: info.mtimeMs })
          total += info.size
        }
      }
      await walk(REWIND_STORE)
      files.sort((a, b) => a.at - b.at)
      let removed = 0
      let bytes = 0
      for (const f of files) {
        if (total <= limit) break
        try { await rm(f.p, { force: true }); total -= f.size; removed += 1; bytes += f.size } catch { /* 留着下一轮 */ }
      }
      if (removed > 0) trace({ level: 'warn', kind: 'rewind-trim', msg: 'trimmed', limit, removed, bytes, total })
      return { limit, removed, bytes, total }
    }

    // 口径："你当时那句话回填输入框" —— 填的是**被退掉的那一段里第一条真人说的话**（不是上一轮的提问）：
    // 退回去之后用户要改的正是它，填上一轮的等于让他重新打字。
    // 跳过空内容的用户消息（那是我们自己的分隔条，见上）。只取文本，附件不管（回填只回文字）。
    function rewindPromptAfter(session, afterSeq) {
      for (const e of session.snapshotEvents()) {
        if (Number(e.seq) <= Number(afterSeq)) continue
        if (e.type !== 'user/message') continue
        const data = e.data || {}
        if (data.source && data.source.kind === REWIND_SOURCE_KIND) continue
        const content = Array.isArray(data.content) ? data.content : []
        const text = content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('').trim()
        if (text !== '') return text
      }
      return ''
    }

    // ── 天工后端保命闸（2026-10-14 真机事故后的第一道防线）────────────────────
    // 事故原样：Agent 要"清理残留 node 进程"，跑 `Get-Process node | Stop-Process -Force`；
    // 而天工后端进程就是 node.exe（壳用 `node apps/cli/lib/bin.js web` 起它）⇒ 宿主被自己打死，
    // 界面从此点什么都只回 `Failed to fetch`、用户只能关软件重开，后端日志也就此断掉。
    // 只拦**必然误伤宿主**的两类，别的杀进程命令一律不碰（免得天天拦正常操作）：
    //   ① 同一段命令链里"杀进程动作"与 `node` 同时出现（Get-Process/Stop-Process/taskkill /IM/pkill…）
    //   ② 点名杀到后端自己的 PID
    // ⚠ 拦不住的（如实记）：run_code 里动态拼出来的杀法（`child_process.exec('taskkill /IM ' + 'node.exe')`）
    //    静态看不见 —— 那一档交给壳侧的"后端掉线自动拉起"兜底（`shell\main.js` 的 reviveBackend）。
    const BACKEND_PID = String(process.pid)
    function backendKillRisk(exec) {
      const args = (exec && exec.arguments) || {}
      const text = String(args.command || args.code || args.script || '')
      if (text === '') return ''
      try {
        if (new RegExp('(?:-id|-processid|/pid|\\bkill)\\s*' + BACKEND_PID + '\\b', 'i').test(text)) {
          return '命令点名要杀的进程 ID ' + BACKEND_PID + ' 就是天工后端自己'
        }
        // ⚠ 分段只用 `;` / 换行 / `&&` / `||`，**不能按 `|` 切**：`Get-Process node | Stop-Process`
        //   是同一条逻辑链，切开就两边都不中、闸门形同虚设。
        for (const seg of text.split(/[;\n]|&&|\|\|/)) {
          if (!/\bnode(?:\.exe)?\b/i.test(seg)) continue
          if (/(?:stop-process|taskkill|pkill|killall|\bkill\s+-?\d|\bkill\s+["'$])/i.test(seg)) {
            return '这一段里"杀进程"与"node"同时出现，会按名字把天工的后端进程一起杀掉'
          }
        }
      } catch { /* 闸门自己出错绝不拦工具 */ }
      return ''
    }

    // 挂上去：任何改文件工具执行前先存底；执行前先过保命闸。存底失败**绝不拦工具**（回退是补救，不是主流程）。
    ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
      const risk = backendKillRisk(exec)
      if (risk !== '') {
        trace({ level: 'warn', kind: 'backend-kill-blocked', tool: String((exec && exec.name) || ''), why: risk })
        // deny 会把 reason 交给模型 ⇒ 它下一轮自己换安全做法，不用用户去猜为什么失败
        return {
          kind: 'deny',
          reason: '这条命令被天工拦下了：' + risk + '。天工的桌面应用后端就是一个 node 进程'
            + '（壳用 `node apps/cli/lib/bin.js web` 启动它），杀掉它 = 整个应用当场瘫痪、用户只能重启软件。'
            + '要清理进程请点名具体 PID（可先用端口反查占用者），或换别的做法。',
        }
      }
      try { await rewindSaveCopy(exec) } catch (err) { trace({ level: 'warn', kind: 'rewind-save-failed', error: errOf(err) }) }
      return next()
    }), 'dsh-ide: tool gate + rewind pre-execute save')

    // 口径（用户定的）：确认回退**不等于**定局 —— 退完还能取消，**发出新消息那一刻**才永久定局。
    // 所以这里要分三件事：① 退（只动文件 + 界面暂不显示，**日志一个字不改**）② 取消（文件前滚回去）
    // ③ 定局（这时才往会话里写分隔条，遮蔽落下）。文件侧同理：退之前先把"当前模样"另存一份给取消用。
    async function rewindSaveCancelState(sessionId, afterSeq) {
      const affected = await rewindAffected(sessionId, afterSeq)
      const dir = path.join(rewindStoreDir(sessionId), 'cancel-' + afterSeq)
      await mkdir(dir, { recursive: true })
      const files = []
      for (const r of affected) {
        let existed = true
        let content = null
        try { content = await readFile(r.path, 'utf8') } catch { existed = false }
        files.push({ path: r.path, existed, content: existed ? content : null })
      }
      await writeFile(path.join(dir, 'state.json'), JSON.stringify({ at: Date.now(), afterSeq, files }))
      return files
    }
    async function rewindCancelRestore(sessionId, afterSeq) {
      const dir = path.join(rewindStoreDir(sessionId), 'cancel-' + afterSeq)
      const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
      let restored = 0
      let removed = 0
      let failed = 0
      for (const f of state.files) {
        try {
          if (f.existed === true) { await writeFile(f.path, String(f.content ?? '')); restored += 1 }
          else { await rm(f.path, { force: true }); removed += 1 }
        } catch { failed += 1 }
      }
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      return { restored, removed, failed, files: state.files.length }
    }
    // 口径 6（"关软件 = 默认取消"，2026-10-14 用户拍板走"盘上记一笔"这条）：
    // "待回退"本身仍然只在内存里；但**文件已经写盘回滚了**，此时直接关软件，下次开就成了
    // "对话完整、文件却停在退过之后"的脏状态。所以盘上只留**一笔账**（哪条会话、哪个检查点 ——
    // 不含任何文件内容，内容在 cancel-<seq>\state.json 里），下次启动拿它把文件前滚回去再销账。
    // 选这条路而不是"退出时前滚"：不依赖退出时机，关得快 / 崩了 / 断电都救得回来。
    const rewindPendingMarkPath = () => path.join(REWIND_STORE, 'pending-cancel.json')
    // 盘上那笔账的**内存镜像**：自动定局（见下面 session/event 的监听）要在事件回调里立刻问
    // "这条会话还有没有没定局的回退"，不能每次都去读盘。这个进程是唯一写它的地方，两边同步维护。
    let rewindPendingState = null
    // 最近一次自动定局的结果：留给前端显示用（定局失败**绝不允许**只写日志、用户一头雾水）
    let rewindCommitNote = ''
    async function rewindMarkPending(sessionId, afterSeq) {
      rewindPendingState = { sessionId: String(sessionId), afterSeq: Number(afterSeq) }
      await mkdir(REWIND_STORE, { recursive: true })
      await writeFile(rewindPendingMarkPath(), JSON.stringify({
        sessionId: String(sessionId), afterSeq: Number(afterSeq), at: Date.now(),
      }))
    }
    async function rewindClearPending() {
      rewindPendingState = null
      await rm(rewindPendingMarkPath(), { force: true }).catch(() => {})
    }
    /** 启动销账：上次没走完的回退（关软件/崩了）在这里把文件前滚回退之前。 */
    async function rewindRecoverOnBoot() {
      let mark = null
      try { mark = JSON.parse(await readFile(rewindPendingMarkPath(), 'utf8')) } catch { return null }
      // ⚠ 先销账再动手：前滚失败（比如 cancel 目录已被清）也不该每次启动都重试同一笔 ——
      //   文件早被用户或别的程序动过了，反复重放只会越弄越糟。
      await rewindClearPending()
      try {
        const out = await rewindCancelRestore(String(mark.sessionId), Number(mark.afterSeq))
        trace({ level: 'warn', kind: 'rewind-recover', msg: 'rolled forward on boot', sessionId: String(mark.sessionId), afterSeq: Number(mark.afterSeq), ...out })
        return out
      } catch (err) {
        trace({ level: 'warn', kind: 'rewind-recover-failed', error: errOf(err), sessionId: String(mark.sessionId), afterSeq: Number(mark.afterSeq) })
        return null
      }
    }
    // 后端一启动就销账（必须写在这些定义**之后**：ctx.effect 是立刻执行的，写在前面会撞上
    // 那些 const 的初始化前死区）。失败只记日志，绝不拖住启动。
    ctx.effect(() => {
      rewindRecoverOnBoot().catch((err) => trace({ level: 'warn', kind: 'rewind-recover-threw', error: errOf(err) }))
    }, 'dsh-ide: rewind boot recovery')
    // 定局：到这一刻才把分隔条写进会话（可以写在"轮次已经结束"的位置的只有用户消息，见上面那段注释）
    // opts.auto = 这次是"用户发了新消息"引发的自动定局（不是界面上那声喊话）。
    //   两条路的差别只有两处：① 没内容可砍时，自动路径算"定局完成、销账走人"，手动路径回
    //   "这里后面已经没有内容了"给用户看；② opts.cutBeforeSeq 给出遮蔽上界 —— 兜底那条路
    //   是在用户消息**已经落盘**之后补刀，必须砍到它之前，否则会把用户刚说的话一起遮掉。
    // 定局入口有多个（编辑器那声喊话 / 待办队列钩子 / 兜底），可能前后脚一起到。
    // 同一会话内串行化：后到的那个直接当无事发生，免得同一次回退写出两条分隔条。
    const rewindCommitBusy = new Set()
    async function rewindCommitCut(session, afterSeq, opts) {
      const key = String(session.id)
      if (rewindCommitBusy.has(key)) return { ok: true, skipped: true, code: 'commit-in-flight', sessionId: key }
      rewindCommitBusy.add(key)
      try {
        return await rewindCommitCutInner(session, afterSeq, opts)
      } finally {
        rewindCommitBusy.delete(key)
      }
    }
    async function rewindCommitCutInner(session, afterSeq, opts) {
      const auto = !!opts && opts.auto === true
      const cutBeforeSeq = opts ? opts.cutBeforeSeq : undefined
      const nodes = session.surface.nodes.map((seq) => Number(seq))
      const at = nodes.indexOf(Number(afterSeq))
      if (at < 0) return { ok: false, code: 'anchor-not-on-surface', afterSeq }
      // ⚠ 台面上的**位置顺序不等于序号大小**：我们自己写的遮蔽事件是"替换型"，它会被插在被替换的那一格上，
      //   于是它的序号比左右邻居都大（真机实测：88 后面紧跟 115，而 112、113 反而排在 115 之后）。
      //   所以遮蔽区间一律按**位置下标**算 —— 拿序号大小去 filter，只要这条会话被回退过一次，
      //   引擎就会拒（报 `sourceEventSeqs must include every shadowed surface node`）。
      let endAt = nodes.length - 1
      if (cutBeforeSeq !== undefined && cutBeforeSeq !== null) {
        const cutAt = nodes.indexOf(Number(cutBeforeSeq))
        // 那条消息不在台面上（兜底路径才会走到，正常它一定在）⇒ 当作"砍到末尾"，宁可多砍不漏砍
        endAt = cutAt < 0 ? nodes.length - 1 : cutAt - 1
      }
      // 回退点本身就是末尾（用户退到最后一轮末尾、直接发新消息就是这种）⇒ 没有要砍的东西。
      // 手动路径照旧回"这里后面已经没有内容了"；自动路径同样算定局完成，销账、不写分隔条。
      if (endAt <= at) {
        if (!auto) return { ok: false, code: 'nothing-after-checkpoint', afterSeq }
        await rm(path.join(rewindStoreDir(String(session.id)), 'cancel-' + afterSeq), { recursive: true, force: true }).catch(() => {})
        await rewindClearPending()
        rewindCommitNote = ''
        trace({
          level: 'info', kind: 'rewind-commit', msg: 'nothing to cut',
          sessionId: String(session.id), afterSeq: Number(afterSeq),
        })
        return {
          ok: true, empty: true, sessionId: String(session.id), checkpointSeq: Number(afterSeq),
          shadowed: [], released: { removed: 0, bytes: 0 },
        }
      }
      const startSeq = nodes[at + 1]
      const endSeq = nodes[endAt]
      // 被遮蔽的就是这一**段位置**上的全部节点（不是"序号落在某个区间里"的那些）
      const shadowed = nodes.slice(at + 1, endAt + 1)
      const eventsBefore = session.snapshotEvents()
      const detail = shadowed.map((seq) => {
        const e = eventsBefore.find((x) => Number(x.seq) === seq)
        const message = e ? session.deriveEventMessage(e) : null
        return {
          seq,
          type: e ? String(e.type) : '?',
          reachesRequest: message !== null
            && !(message.role === 'user' && (!Array.isArray(message.content) || message.content.length === 0)),
        }
      })
      const before = rewindDigest(session)
      const event = session.append('user/message', rewindMessage(), {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: shadowed,
      })
      // 内存里那笔账**同步**销掉：前端随时可能来问"定了没"，晚一步它就会以为还没定局、
      // 把用户刚发的那条并进"该藏"的名单里。磁盘上那份交给下面的 rewindClearPending（异步，够用）。
      rewindPendingState = null
      rewindCommitNote = ''
      const after = rewindDigest(session)
      await rm(path.join(rewindStoreDir(String(session.id)), 'cancel-' + afterSeq), { recursive: true, force: true }).catch(() => {})
      await rewindClearPending()   // 定局 ⇒ 不再有"取消"这回事，销账
      // 定局 ⇒ 被砍那段的存底当场释放（遮蔽不可撤销，那批再也用不到）。取消路径**不走这里**。
      const released = await rewindRelease(String(session.id), afterSeq)
      trace({
        level: 'warn', kind: 'rewind-commit', msg: 'cut written', sessionId: String(session.id),
        seq: Number(event.seq), startSeq, endSeq, shadowed: shadowed.length, released: released.removed,
      })
      return {
        ok: true, sessionId: String(session.id), shadowSeq: Number(event.seq),
        range: { startSeq, endSeq }, checkpointSeq: Number(afterSeq), shadowed, shadowedDetail: detail,
        expectedDrop: detail.filter((d) => d.reachesRequest).length, before, after, released,
      }
    }

    // ── 定局的接线（2026-10-16 修，这就是"回退没法用"的病根）──────────────────
    // 口径一个字没变：**用户发出新消息那一刻**才把分隔条落下、此后不可逆。两次报障修的都是
    // "那一刻到底钉在引擎的哪一步上"。引擎推进一轮的真实顺序（亲读源码 + 真机日志坐实）：
    //   ① 用户消息进 Agent 的待办队列 —— `agent/inbox/inserted`（此刻会话里还没有它）
    //   ② 引擎把消息写进会话           —— `user/message`
    //   ③ 组装这一轮的请求             —— `user/message(time-context)`、`request/header`
    //   ④ 把请求发给模型
    // 必须赶在 ③ 之前动手，唯一稳的落点是 ①：
    //   · 不能在 ② 上动手：那时引擎正处在"正在写会话"的状态里，往里插会被直接拒掉
    //     （实测报 `session append cannot reenter while another append is being published`）；
    //   · 更不能"等一拍再插"：等过 ③ 就白砍了 —— 2026-10-16 真机现场就是这样，砍是砍了、
    //     界面也对，可这一轮模型照样看见同一句话问了三遍，回一句"你重发了"。
    // 判据抄官方 session-controller 的写法：source.kind === 'user'
    //（我们自己的分隔条 kind 是 dsh-ide-rewind、官方压缩是 compact-checkpoint，都不会误中）。
    function rewindCommitOnInbox(agent, message) {
      const p = rewindPendingState
      if (p === null) return
      const source = message && message.source
      if (!source || String(source.kind) !== 'user') return
      const session = agent && agent.session
      if (!session || String(session.id) !== String(p.sessionId)) return
      // 此刻这条消息还没落进会话 ⇒ "砍到当前末尾"就等于"砍到这条新消息之前"，不需要额外上界。
      rewindCommitCut(session, p.afterSeq, { auto: true }).then((out) => {
        if (!out || out.ok !== true) {
          // 失败留着账、也留着话：前端在"待回退"期间会把它读出来显示（不许静默）
          rewindCommitNote = String((out && (out.code || out.error)) || 'unknown')
          trace({
            level: 'error', kind: 'rewind-auto-commit-failed', sessionId: String(session.id),
            afterSeq: Number(p.afterSeq), error: rewindCommitNote,
          })
          return
        }
        trace({
          level: 'warn', kind: 'rewind-auto-commit', msg: 'committed before the request was assembled',
          sessionId: String(session.id), afterSeq: Number(p.afterSeq),
          empty: out.empty === true, shadowed: (out.shadowed || []).length,
        })
      }).catch((err) => {
        rewindCommitNote = errOf(err)
        trace({ level: 'error', kind: 'rewind-auto-commit-threw', sessionId: String(session.id), error: rewindCommitNote })
      })
    }
    ctx.effect(() => ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      try { rewindCommitOnInbox(agent, message) } catch (err) {
        trace({ level: 'error', kind: 'rewind-auto-commit-crashed', error: errOf(err) })
      }
    }), 'dsh-ide: 回退定局（用户一发消息就把分隔条落下）')
    // 兜底：万一某条用户消息不是从待办队列进来的（引擎里还有别的入口能直接写会话），
    // 就在它落进会话之后补一刀。这条路**必然晚于**这一轮的请求，所以只当保险、不指望它解决问题；
    // 这里让出一拍也不是"用等待凑时序"，纯粹是绕开引擎的"正在发布、不许插队"限制。
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      try {
        const p = rewindPendingState
        if (p === null) return
        if (String(session.id) !== String(p.sessionId)) return
        if (!event || String(event.type) !== 'user/message') return
        const source = event.data && event.data.source
        if (!source || String(source.kind) !== 'user') return
        const userSeq = Number(event.seq)
        queueMicrotask(() => {
          const now = rewindPendingState
          if (now === null || String(now.sessionId) !== String(p.sessionId)) return
          trace({
            level: 'warn', kind: 'rewind-commit-late',
            msg: 'user message did not pass the inbox hook; cutting one beat late',
            sessionId: String(session.id), userSeq,
          })
          rewindCommitCut(session, now.afterSeq, { auto: true, cutBeforeSeq: userSeq }).then((out) => {
            if (!out || out.ok !== true) {
              rewindCommitNote = String((out && (out.code || out.error)) || 'unknown')
              trace({
                level: 'error', kind: 'rewind-auto-commit-failed', sessionId: String(session.id),
                afterSeq: Number(now.afterSeq), error: rewindCommitNote,
              })
            }
          }).catch((err) => {
            rewindCommitNote = errOf(err)
            trace({ level: 'error', kind: 'rewind-auto-commit-threw', sessionId: String(session.id), error: rewindCommitNote })
          })
        })
      } catch (err) {
        trace({ level: 'error', kind: 'rewind-auto-commit-crashed', error: errOf(err) })
      }
    }), 'dsh-ide: 回退定局兜底（非待办队列进来的用户消息）')

    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh-ide')
      if (!url.pathname.startsWith(ROUTE_PREFIX)) return
      const action = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      const q = url.searchParams

      // monaco 静态资源（编辑器本体，绕开 bundle 纯度门禁）
      if (action === '/monaco' || action.startsWith('/monaco/')) {
        return serveStatic(req, res, action.slice('/monaco'.length), MONACO_ROOT, 'monaco', true)
      }

      // ④ 编辑器主题 JSON（买的 VS Code 官方默认主题，随 dsh-ide 镜像分发）
      if (action === '/themes' || action.startsWith('/themes/')) {
        return serveStatic(req, res, action.slice('/themes'.length), THEMES_ROOT, 'themes', false)
      }

      // ⑬ 终端前端资源（xterm.js，同 monaco 路子：script 标签加载，绕开 bundle 纯度门禁）
      if (action === '/xterm' || action.startsWith('/xterm/')) {
        return serveStatic(req, res, action.slice('/xterm'.length), XTERM_ROOT, 'xterm', false)
      }

      try {
        // ── 概览 ────────────────────────────────────────────────
        if (action === '/init') {
          const root = await resolveRoot()
          return json(res, 200, {
            root: root || null,
            // 能力面板另外两区（2026-11-05）：技能清单靠扫目录，MCP 靠读装配单
            skills: await skillsForPanel(),
            mcp: mcpForPanel(),
            plugins: {
              // 全量插件树（后端为主 + 带前端半的标记 + 停用的行也在，2026-09-22 用户要求透明）
              rows: pluginRows(),
              dynamic: pluginInventory().map((p) => ({
                pluginId: p.pluginId,
                agentId: p.agentId,
                packages: (p.packages || []).map((d) => ({
                  packageId: d.packageId, name: d.name, purpose: d.purpose,
                  hasHostHalf: !!d.hasHostHalf, hasClientHalf: !!d.hasClientHalf,
                })),
                currentPackageId: p.currentPackageId,
                nextPackageId: p.nextPackageId,
                latestRun: p.latestRun
                  ? { status: p.latestRun.status, pluginRunId: p.latestRun.pluginRunId }
                  : undefined,
              })),
              formal: formalPlugins().map((e) => ({
                id: e.id, rev: e.rev, immediately: !!e.immediately, inject: e.inject,
              })),
            },
          })
        }

        // ── 文件系统变更计数（资源管理器自动刷新用：只回一个整数）────────
        // client 每 ~1.2s 轮询；rev 变了才去重列目录，平时响应只有几十字节。
        if (action === '/fs-rev' && req.method === 'GET') {
          const root = await resolveRoot()
          if (root) ensureWatch(root)
          return json(res, 200, { rev: fsRev, root: root || null, watching: watcher !== null })
        }

        // ── 历史对话内容搜索（见上面 searchSessionLogs：平台没有 host 侧索引，只能读会话日志）──
        if (action === '/session-search' && req.method === 'GET') {
          const q0 = String(q.get('q') || '').trim()
          const limit = Math.max(1, Math.min(100, Number(q.get('limit') || 40) || 40))
          if (!q0) return json(res, 200, { ok: true, items: [], hasMore: false, scanned: 0 })
          const home = process.env.DSH_HOME || ''
          if (!home) return json(res, 200, { ok: false, error: 'no-home', items: [], hasMore: false, scanned: 0 })
          try {
            return json(res, 200, searchSessionLogs(home, q0, limit))
          } catch (e) {
            console.warn('[dsh-ide] session-search failed:', (e && e.message) || e)
            return json(res, 500, { ok: false, error: String((e && e.message) || e), items: [], hasMore: false, scanned: 0 })
          }
        }

        // ── 文件 ─────────────────────────────────────────────────
        if (action === '/list-dir' && req.method === 'GET') {
          const path = q.get('path') || ''
          if (fsService === undefined || !path) return json(res, 400, { error: 'no-fs-or-path' })
          const target = await fsService.resolve(path)
          try {
            const entries = await fsService.listDir(target)
            return json(res, 200, {
              entries: entries.map((e) => ({
                name: e.name,
                type: e.type,
                size: typeof e.size === 'number' ? e.size : null,
                path: fsService.processPath(e.target),
              })),
            })
          } catch (e) {
            // 平台版失败时的退路：盘符根（D:\）必然踩到读不了的系统目录，
            // 不给退路就等于"文件树打不开这个工作区"（2026-09-20 用户实测）。
            const tol = await listDirTolerant(fsService.processPath(target) || String(path))
            if (tol === null) return json(res, 500, { error: errOf(e) })
            // 同一目录同一错误 60s 内只落一条（盘符根每次刷新都会踩同一个系统目录，之前 1 秒一条刷了 15 万条）
            traceThrottled('list-dir-tolerant|' + String(path) + '|' + errOf(e), 60000,
              { level: 'warn', kind: 'list-dir-tolerant', path: String(path), entries: tol.length, error: errOf(e) })
            return json(res, 200, { entries: tol, degraded: true })
          }
        }

        if (action === '/read-file' && req.method === 'GET') {
          const path = q.get('path') || ''
          // 远端文件（ssh://）：走 SFTP 读，回给编辑器的形状与本地完全一致
          const remote = parseSshPath(path)
          if (remote) {
            try {
              const r = await ssh.readText(remote.sid, remote.path)
              if (r.buf.includes(0)) {
                return json(res, 415, { error: '远端二进制文件，不能按文本打开', code: 'FS_NOT_TEXT', binary: true, size: r.size, path: remote.path })
              }
              return json(res, 200, {
                content: r.buf.toString('utf8'), size: r.size, path: remote.path,
                // 版本令牌用远端修改时间：它变了就说明这个文件在打开之后被别处改过（跟本地同一套守卫）
                version: String(r.mtime),
              })
            } catch (e) {
              return json(res, 500, { error: errOf(e), code: 'SSH_READ_FAILED', path: remote.path })
            }
          }
          if (fsService === undefined || !path) return json(res, 400, { error: 'no-fs-or-path' })
          const target = await fsService.resolve(path)
          const info = await fsService.stat(target)
          const size = info && typeof info.size === 'number' ? info.size : undefined
          const version = info && info.version !== undefined ? String(info.version) : null
          const display = fsService.processPath(target)

          // ── 「仍以文本打开」（= VSCode 二进制占位卡上的 Open Anyway）────────────
          // 平台 fs.readText 对二进制（含 \0）与非法 UTF-8 一律拒；force=1 时绕开它自己读字节，
          // 按 UTF-8 解码（无效序列变 U+FFFD），与 VSCode 的 allowBinary: ForceOpenAs.Text 同语义。
          if (q.get('force') === '1') {
            const buf = await readFile(display)
            if (buf.length > FORCE_TEXT_MAX) return json(res, 413, { error: 'file-too-large', code: 'FS_TOO_LARGE', size: buf.length })
            trace({ level: 'warn', kind: 'open-anyway', path: display, bytes: buf.length })
            return json(res, 200, {
              content: buf.toString('utf8'),
              size: buf.length, path: display, version,
              binary: buf.includes(0),
            })
          }

          if (typeof size === 'number' && size > 4 * 1024 * 1024) {
            return json(res, 413, { error: 'file-too-large', code: 'FS_TOO_LARGE', size })
          }
          let content
          try {
            content = await fsService.readText(target)
          } catch (e) {
            // 二进制 / 非法编码**不是错误**：它是 VSCode 那个"Binary Viewer"占位卡的正常分支。
            // 给 client 一个能分辨的 code，让它渲染占位卡而不是把标签关掉（2026-09-23 用户报障的根因）。
            const code = codeOf(e)
            if (code === 'FS_NOT_TEXT') {
              trace({ level: 'info', kind: 'read-file-binary', path: display, size: size ?? null })
              return json(res, 415, { error: errOf(e), code: 'FS_NOT_TEXT', binary: true, size: size ?? null, path: display, version })
            }
            throw e
          }
          return json(res, 200, {
            content,
            size: typeof size === 'number' ? size : content.length,
            path: display,
            // ⑥ 磁盘新鲜度令牌：client 存下来，保存时回传做乐观并发守卫
            version,
          })
        }

        // ── 原始字节（图片 / 音频 / 视频预览用）──────────────────────────────
        // 为什么不用 /read-file：平台 readText 对二进制直接拒，而图片必须原样给浏览器解码。
        // 行为对齐 VSCode 的 webview 资源加载：按扩展名给 Content-Type + **支持 Range 请求**
        // （<video>/<audio> 拖进度条时 Chromium 一定发 Range，不支持就整段失效）。
        // 路径仍经 fsService.resolve/processPath 归一化 —— 与 /read-file、/list-dir 同一套解析。
        if (action === '/raw-file' && (req.method === 'GET' || req.method === 'HEAD')) {
          // ⚠ 这里的变量**不能叫 path** —— 会遮蔽 node:path 模块（踩过的坑，见 /new-entry 那段注释）
          const raw = q.get('path') || ''
          if (fsService === undefined || !raw) return json(res, 400, { error: 'no-fs-or-path' })
          const target = await fsService.resolve(raw)
          const display = fsService.processPath(target)
          const info = await stat(display)
          if (!info.isFile()) return json(res, 404, { error: 'not-a-file' })
          const total = info.size
          const type = MEDIA_MIME[path.extname(display).toLowerCase()] || 'application/octet-stream'
          const range = String(req.headers.range || '').trim()
          const m = /^bytes=(\d*)-(\d*)$/.exec(range)
          let start = 0
          let end = total - 1
          if (m) {
            if (m[1]) start = Number(m[1])
            else if (m[2]) start = Math.max(0, total - Number(m[2]))   // 后缀写法 bytes=-N
            if (m[1] && m[2]) end = Math.min(Number(m[2]), total - 1)
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= total) {
              res.writeHead(416, { 'content-range': 'bytes */' + total })
              return res.end()
            }
            res.writeHead(206, {
              'content-type': type,
              'content-length': end - start + 1,
              'content-range': 'bytes ' + start + '-' + end + '/' + total,
              'accept-ranges': 'bytes',
              'cache-control': 'no-store',
            })
          } else {
            res.writeHead(200, {
              'content-type': type,
              'content-length': total,
              'accept-ranges': 'bytes',
              'cache-control': 'no-store',
            })
          }
          if (req.method === 'HEAD' || total === 0) return res.end()
          const stream = createReadStream(display, { start, end })
          stream.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
          return stream.pipe(res)
        }

        // ── ⑥ 磁盘新鲜度探测（外部改动侦测：Agent / 外部编辑器 / git 改了文件要能发现）──
        // 只回版本令牌 + 体积，不回内容 → 2.5s 轮询开销可忽略；version 是平台
        // FsInfo 的不透明令牌（fs-local = dev:ino:size:mtimeNs:ctimeNs），内容一变就变。
        if (action === '/stat' && req.method === 'GET') {
          const path = q.get('path') || ''
          // 远端文件：编辑器的外部改动轮询（每 2.5 秒一次 stat）落在这里
          const remoteStat = parseSshPath(path)
          if (remoteStat) {
            try {
              const st = await ssh.stat(remoteStat.sid, remoteStat.path)
              return json(res, 200, {
                exists: true, path: remoteStat.path, ssh: true,
                type: st.dir ? 'directory' : 'file', size: st.size,
                version: String(st.mtime), birthMs: null,
              })
            } catch (e) {
              return json(res, 200, { exists: false, path: remoteStat.path, error: errOf(e) })
            }
          }
          if (fsService === undefined || !path) return json(res, 400, { error: 'no-fs-or-path' })
          try {
            const target = await fsService.resolve(path)
            const info = await fsService.stat(target)
            if (info === undefined) return json(res, 200, { exists: false, path })
            // ⑥ 第二刀：判定"这个文件是不是刚被新建的"要用创建时间（平台 FsInfo 只有
            // version/type/size），补一个 node:fs 的 birthtime —— 撤销新建=删除，判错会误删
            let birthMs = null
            try { birthMs = (await stat(fsService.processPath(target))).birthtimeMs } catch { /* 后端不支持就算了 */ }
            return json(res, 200, {
              exists: true,
              path: fsService.processPath(target),
              type: info.type,
              size: typeof info.size === 'number' ? info.size : null,
              version: info.version !== undefined ? String(info.version) : null,
              birthMs,
            })
          } catch (e) {
            return json(res, 200, { exists: false, path, error: errOf(e) })
          }
        }

        // ── 编辑器会话 / Hot Exit：磁盘副本（对齐 VSCode 的 hot exit 备份）──────────────
        // GET  = 读回上次的"标签形态 + 脏缓冲区正文"（没有文件就回 data:null，页面退回本机记忆）
        // POST = 原子落盘（先写 .tmp 再 rename，绝不留下半个文件）；超过 4MB 拒绝，页面会自行瘦身
        if (action === '/session' && req.method === 'GET') {
          try {
            const raw = await readFile(sessionFilePath(), 'utf8')
            const data = JSON.parse(raw)
            return json(res, 200, { ok: true, data })
          } catch (e) {
            return json(res, 200, { ok: true, data: null, reason: String((e && e.code) || (e && e.message) || '') })
          }
        }
        if (action === '/session' && req.method === 'POST') {
          const body = await readBody(req)
          const data = body && body.data
          if (!data || typeof data !== 'object') return json(res, 400, { error: 'no-data' })
          let text = ''
          try { text = JSON.stringify(data) } catch (e) { return json(res, 400, { error: 'bad-json' }) }
          if (text.length > SESSION_MAX_BYTES) return json(res, 413, { error: 'too-large', bytes: text.length })
          const file = sessionFilePath()
          const tmp = file + '.tmp'
          try {
            await mkdir(path.dirname(file), { recursive: true })
            await writeFile(tmp, text)
            await rename(tmp, file)
            return json(res, 200, { ok: true, bytes: text.length })
          } catch (e) {
            trace({ level: 'warn', kind: 'session', msg: 'write-failed', meta: { error: String((e && e.message) || e) } })
            return json(res, 500, { error: 'write-failed', detail: String((e && e.message) || e) })
          }
        }
        if (action === '/write-file' && req.method === 'POST') {
          const body = await readBody(req)
          const path = String(body.path || '')
          const content = String(body.content ?? '')
          // ⑥ 乐观并发（数据安全）：client 回传读到的版本令牌，写前由平台自校验。
          // 磁盘在编辑器不知情的情况下被改过（Agent 写 / 外部编辑器 / git checkout）
          // → FS_STALE_VERSION，绝不静默覆盖；force=true 表示用户在冲突条上明确选了覆盖。
          const baseVersion = typeof body.baseVersion === 'string' && body.baseVersion ? body.baseVersion : null
          const force = body.force === true
          // 远端文件：同一套版本守卫（远端修改时间当令牌），冲突时照旧回 stale-version 让界面弹冲突条
          const remote = parseSshPath(path)
          if (remote) {
            try {
              if (baseVersion && !force) {
                const cur = await ssh.stat(remote.sid, remote.path)
                if (String(cur.mtime) !== String(baseVersion)) {
                  return json(res, 409, { ok: false, code: 'stale-version', error: '远端文件在你打开之后被改过了' })
                }
              }
              await ssh.writeText(remote.sid, remote.path, content)
              const after = await ssh.stat(remote.sid, remote.path)
              trace({ level: 'info', kind: 'ssh', msg: 'save', meta: { sid: remote.sid, path: remote.path, bytes: content.length } })
              return json(res, 200, { ok: true, operation: 'remote-write', version: String(after.mtime) })
            } catch (e) {
              trace({ level: 'error', kind: 'ssh', msg: 'save-failed', meta: { sid: remote.sid, path: remote.path, error: errOf(e) } })
              return json(res, 500, { error: errOf(e) })
            }
          }
          if (fsService === undefined || !path) return json(res, 400, { error: 'no-fs-or-path' })
          try {
            const target = await fsService.resolve(path)
            const intent = baseVersion && !force ? { kind: 'replaceIfVersion', version: baseVersion } : undefined
            const outcome = await fsService.writeText(target, content, intent, undefined, await writePolicy())
            trace({ level: 'info', kind: 'save', path, bytes: content.length, guarded: !!intent })
            return json(res, 200, {
              ok: true,
              operation: outcome.operation,
              version: outcome && outcome.version !== undefined ? String(outcome.version) : null,
            })
          } catch (e) {
            const code = codeOf(e)
            if (code === 'FS_STALE_VERSION') {
              trace({ level: 'warn', kind: 'save-conflict', path, code })
              return json(res, 409, { ok: false, code: 'stale-version', error: errOf(e) })
            }
            trace({ level: 'error', kind: 'save-failed', path, message: errOf(e) })
            return json(res, 500, { error: errOf(e) })
          }
        }

        // ── ⑥ 撤销"Agent 新建的文件" ─────────────────────────────
        // 平台 ctx.fs 没有删除方法（只有 resolve/stat/read/list/write/edit，
        // 见 packages/fs/fs/src/index.ts 抽象方法表）→ 这里用 node:fs 直删，
        // 但加两道闸：① 路径必须落在当前工作空间根内（防越界删系统文件）；
        // ② 可选版本令牌比对：磁盘内容在审阅之后又变过就拒绝（409）。
        if (action === '/delete-file' && req.method === 'POST') {
          const body = await readBody(req)
          const path = String(body.path || '')
          const baseVersion = typeof body.baseVersion === 'string' && body.baseVersion ? body.baseVersion : null
          if (fsService === undefined || !path) return json(res, 400, { error: 'no-fs-or-path' })
          try {
            const target = await fsService.resolve(path)
            const display = fsService.processPath(target)
            const root = await resolveRoot()
            if (!root || !isInside(display, root)) {
              trace({ level: 'warn', kind: 'delete-refused', path: display, reason: 'outside-root' })
              return json(res, 403, { error: 'outside-workspace' })
            }
            const info = await fsService.stat(target)
            if (info === undefined) return json(res, 404, { error: 'not-found' })
            // 目录删除要显式 recursive（client 会为"删整个文件夹"再确认一次）；文件/空目录不走
            const wantRecursive = body.recursive === true
            if (info.type === 'directory' && !wantRecursive) {
              return json(res, 400, { ok: false, code: 'is-directory', error: 'directory needs recursive:true' })
            }
            if (baseVersion && String(info.version) !== baseVersion) {
              trace({ level: 'warn', kind: 'delete-refused', path: display, reason: 'stale' })
              return json(res, 409, { ok: false, code: 'stale-version', error: 'file changed since it was read' })
            }
            await rm(display, wantRecursive ? { recursive: true, force: true } : undefined)
            trace({ level: 'warn', kind: 'delete-ok', path: display })
            return json(res, 200, { ok: true })
          } catch (e) {
            trace({ level: 'error', kind: 'delete-failed', path, message: errOf(e) })
            return json(res, 500, { error: errOf(e) })
          }
        }

        // ── ⑫ 文件树三件套：新建 / 重命名 / 删除（2026-09-16）──────────────────
        // 与 /delete-file 同一套闸：**路径必须落在当前工作空间根内**（防越界动系统文件）+
        // 不覆盖已有内容（新建/重命名撞已有文件一律拒绝，让用户自己改名）+ 每次操作都埋点。
        // 平台 ctx.fs 没有创建/重命名能力（写入只有 writeText），所以这三个走 node:fs 直操作。
        if (action === '/new-entry' && req.method === 'POST') {
          const body = await readBody(req)
          // 注意：**别把这个变量叫 path** —— 会遮蔽 node:path 模块（踩过的坑：path.dirname is not a function）
          const reqPath = String(body.path || '')
          const kind = body.kind === 'dir' ? 'dir' : 'file'
          if (fsService === undefined || !reqPath) return json(res, 400, { error: 'no-fs-or-path' })
          try {
            const target = await fsService.resolve(reqPath)
            const display = fsService.processPath(target)
            const root = await resolveRoot()
            if (!root || !isInside(display, root)) {
              trace({ level: 'warn', kind: 'new-entry-refused', path: display, reason: 'outside-root' })
              return json(res, 403, { error: 'outside-workspace' })
            }
            const info = await fsService.stat(target)
            if (info !== undefined) return json(res, 409, { ok: false, code: 'exists', error: 'already exists' })
            if (kind === 'dir') {
              await mkdir(display, { recursive: true })
            } else {
              await mkdir(path.dirname(display), { recursive: true })
              await writeFile(display, '', { flag: 'wx' }) // wx：已存在就失败，绝不覆盖
            }
            trace({ level: 'info', kind: 'new-entry-ok', path: display, entry: kind })
            return json(res, 200, { ok: true, path: display })
          } catch (e) {
            trace({ level: 'error', kind: 'new-entry-failed', path: reqPath, message: errOf(e) })
            return json(res, 500, { error: errOf(e) })
          }
        }

        if (action === '/rename' && req.method === 'POST') {
          const body = await readBody(req)
          const from = String(body.from || '')
          const to = String(body.to || '')
          if (fsService === undefined || !from || !to) return json(res, 400, { error: 'no-fs-or-path' })
          try {
            const fromTarget = await fsService.resolve(from)
            const toTarget = await fsService.resolve(to)
            const fromDisplay = fsService.processPath(fromTarget)
            const toDisplay = fsService.processPath(toTarget)
            const root = await resolveRoot()
            if (!root || !isInside(fromDisplay, root) || !isInside(toDisplay, root)) {
              trace({ level: 'warn', kind: 'rename-refused', from: fromDisplay, to: toDisplay, reason: 'outside-root' })
              return json(res, 403, { error: 'outside-workspace' })
            }
            const fromInfo = await fsService.stat(fromTarget)
            if (fromInfo === undefined) return json(res, 404, { error: 'not-found' })
            const toInfo = await fsService.stat(toTarget)
            // 目标已存在 → 拒绝（**只允许"仅大小写不同"的重命名**，Windows 上那是在改大小写）
            if (toInfo !== undefined && toDisplay.toLowerCase() !== fromDisplay.toLowerCase()) {
              trace({ level: 'warn', kind: 'rename-refused', from: fromDisplay, to: toDisplay, reason: 'target-exists' })
              return json(res, 409, { ok: false, code: 'exists', error: 'target already exists' })
            }
            await rename(fromDisplay, toDisplay)
            trace({ level: 'info', kind: 'rename-ok', from: fromDisplay, to: toDisplay })
            return json(res, 200, { ok: true, from: fromDisplay, to: toDisplay })
          } catch (e) {
            trace({ level: 'error', kind: 'rename-failed', from, to, message: errOf(e) })
            return json(res, 500, { error: errOf(e) })
          }
        }

        // ── ⑬ 集成终端（自建 PTY）────────────────────────────────────────
        if (action === '/term-create' && req.method === 'POST') {
          if (!ptyMod) {
            trace({ level: 'error', kind: 'terminal', msg: 'pty-unavailable', meta: { error: ptyLoadError } })
            return json(res, 500, { error: 'pty-unavailable', detail: ptyLoadError })
          }
          const body = await readBody(req)
          const cols = Math.max(20, Math.min(400, body.cols | 0 || 100))
          const rows = Math.max(5, Math.min(200, body.rows | 0 || 30))
          const root = await resolveRoot()
          const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : (root || process.cwd())
          const candidates = process.platform === 'win32'
            ? [process.env.DSH_TERM_SHELL, 'pwsh.exe', 'powershell.exe'].filter(Boolean)
            : [process.env.DSH_TERM_SHELL, process.env.SHELL, 'bash', 'sh'].filter(Boolean)
          let pty = null
          let lastErr = null
          for (const sh of candidates) {
            try {
              pty = ptyMod.spawn(sh, [], {
                name: 'xterm-256color', cols, rows, cwd,
                useConpty: process.platform === 'win32',
                env: { ...process.env, TERM: 'xterm-256color' },
              })
              break
            } catch (e) { lastErr = e; pty = null }
          }
          if (!pty) {
            trace({ level: 'error', kind: 'terminal', msg: 'create-failed', meta: { error: errOf(lastErr) } })
            return json(res, 500, { error: errOf(lastErr) || 'spawn-failed' })
          }
          const id = 'term-' + (++termSeq) + '-' + Date.now().toString(36)
          const t = { id, pty, cwd, chunks: [], seq: 0, bytes: 0, droppedUntil: 0, exited: false, exitCode: null, startedAt: Date.now(), lastRead: Date.now(), cols, rows, cmdBuf: '', cmdEsc: false }
          pty.onData((d) => termAppend(t, d))
          pty.onExit((e) => {
            t.exited = true
            t.exitCode = e && e.exitCode !== undefined ? e.exitCode : null
            termFlushCommand(t)   // 退出前最后一行没回车的命令也别丢
            trace({ level: 'info', kind: 'terminal', msg: 'exit', meta: { id: t.id, code: t.exitCode, bytes: t.bytes } })
            termAppend(t, '\r\n\x1b[90m[进程已退出' + (t.exitCode !== null ? '，退出码 ' + t.exitCode : '') + ']\x1b[0m\r\n')
          })
          terminals.set(id, t)
          trace({ level: 'info', kind: 'terminal', msg: 'create', meta: { id, cwd, cols, rows } })
          return json(res, 200, { ok: true, id, cwd })
        }

        if (action === '/term-read' && req.method === 'GET') {
          const id = q.get('id') || ''
          const since = Number(q.get('since') || 0) | 0
          const t = terminals.get(id)
          if (!t) return json(res, 404, { error: 'no-session' })
          t.lastRead = Date.now()
          const chunks = t.chunks.filter((c) => c.seq > since)
          return json(res, 200, {
            ok: true, seq: t.seq, exited: t.exited, exitCode: t.exitCode,
            // 客户端要的块已经被环形缓冲丢掉 → 让它清屏重来（reset:true）
            reset: since > 0 && since < t.droppedUntil,
            data: chunks.map((c) => c.data).join(''),
          })
        }

        if (action === '/term-input' && req.method === 'POST') {
          const body = await readBody(req)
          const t = terminals.get(String(body.id || ''))
          if (!t) return json(res, 404, { error: 'no-session' })
          if (t.exited) return json(res, 200, { ok: true, exited: true })
          const input = String(body.data === undefined ? '' : body.data)
          try { termTrackInput(t, input) } catch { /* 记账失败不影响输入 */ }
          try { t.pty.write(input) } catch (e) { return json(res, 500, { error: errOf(e) }) }
          return json(res, 200, { ok: true })
        }

        if (action === '/term-resize' && req.method === 'POST') {
          const body = await readBody(req)
          const t = terminals.get(String(body.id || ''))
          if (!t) return json(res, 404, { error: 'no-session' })
          const cols = Math.max(20, Math.min(400, body.cols | 0 || t.cols))
          const rows = Math.max(5, Math.min(200, body.rows | 0 || t.rows))
          try { t.pty.resize(cols, rows) } catch { /* 进程刚退时 resize 会抛，忽略 */ }
          t.cols = cols
          t.rows = rows
          return json(res, 200, { ok: true, cols, rows })
        }

        if (action === '/term-close' && req.method === 'POST') {
          const body = await readBody(req)
          const id = String(body.id || '')
          const t = terminals.get(id)
          if (t) { termKill(t, 'client-close'); terminals.delete(id) }
          return json(res, 200, { ok: true })
        }

        if (action === '/term-list' && req.method === 'GET') {
          const list = []
          for (const t of terminals.values()) {
            list.push({ id: t.id, cols: t.cols, rows: t.rows, exited: t.exited, exitCode: t.exitCode, bytes: t.bytes, startedAt: t.startedAt })
          }
          return json(res, 200, { ok: true, pty: !!ptyMod, ptyError: ptyLoadError, terminals: list })
        }

        // ── ㉒ 服务器控制台：SSH（连/列/读写/传/交互终端）────────────────────
        // 契约与本地终端同形（open/read/input/resize/close），客户端那套"按块读、seq 递增"
        // 的处理可以原样复用；区别只在会话活在 SSH 通道上。
        if (action === '/ssh-status' && req.method === 'GET') {
          return json(res, 200, {
            ok: true, available: sshAvailable(), loadError: sshLoadError(),
            servers: await readSshServers(), sessions: ssh.list(),
          })
        }

        if (action === '/ssh-servers-save' && req.method === 'POST') {
          const body = await readBody(req)
          const saved = await writeSshServers(body.servers)
          trace({ level: 'info', kind: 'ssh', msg: 'servers-saved', meta: { count: saved.length } })
          return json(res, 200, { ok: true, servers: saved })
        }

        if (action === '/ssh-connect' && req.method === 'POST') {
          const body = await readBody(req)
          const host = String(body.host || '')
          const port = Number(body.port) || 22
          const servers = await readSshServers()
          const savedIdx = servers.findIndex((s) => s.id === String(body.id || ''))
          const stored = savedIdx >= 0 && servers[savedIdx] && servers[savedIdx].fp ? servers[savedIdx].fp : null
          const sys = readKnownHosts(host, port)
          const trust = String(body.trustFingerprint || '')
          let seen = null
          // 三道判据，从强到弱：记住过 → 系统 known_hosts → 用户显式认领
          const checkHostKey = (info) => {
            seen = info
            if (stored && stored.fingerprint) {
              if (info.fingerprint === stored.fingerprint) return { ok: true, from: 'remembered' }
              if (trust && trust === info.fingerprint) return { ok: true, from: 'user-override' }
              return { ok: false, code: 'host-key-changed', from: 'remembered' }
            }
            const hit = sys.keys.find((k) => k.type === info.type && k.base64 === info.base64)
            if (hit) return { ok: true, from: 'known_hosts' }
            if (trust && trust === info.fingerprint) return { ok: true, from: 'user-accepted' }
            return { ok: false, code: 'host-key-unknown', from: sys.keys.length ? 'known_hosts-mismatch' : 'no-record' }
          }
          try {
            const r = await ssh.connect({
              id: body.id, host, port,
              user: String(body.user || 'root'), keyPath: body.keyPath || undefined,
              password: body.password || undefined, name: String(body.name || ''),
              checkHostKey,
            })
            // 认下来之后就记住这台机器的公钥（下次直接对账，不再问）
            if (seen && savedIdx >= 0) {
              const next = servers.slice()
              next[savedIdx] = Object.assign({}, next[savedIdx], { fp: { fingerprint: seen.fingerprint, type: seen.type, base64: seen.base64, at: Date.now() } })
              await writeSshServers(next).catch(() => {})
            }
            return json(res, 200, Object.assign({ ok: true }, r, {
              hostKey: seen ? { type: seen.type, fingerprint: seen.fingerprint } : null,
            }))
          } catch (e) {
            return json(res, 500, {
              ok: false, error: errOf(e), code: e && e.code ? String(e.code) : null,
              fingerprint: (e && e.fingerprint) || (seen && seen.fingerprint) || null,
              hostKeyType: (e && e.hostKeyType) || (seen && seen.type) || null,
            })
          }
        }

        if (action === '/ssh-disconnect' && req.method === 'POST') {
          const body = await readBody(req)
          return json(res, 200, Object.assign({ ok: true }, ssh.disconnect(body.id)))
        }

        if (action === '/ssh-exec' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            const r = await ssh.exec(body.id, String(body.cmd || ''), { timeoutMs: Number(body.timeoutMs) || undefined })
            trace({ level: 'info', kind: 'ssh', msg: 'exec', meta: { sid: body.id, code: r.code, ms: r.ms, plain: maskTermLine(String(body.cmd || '')).slice(0, 200) } })
            return json(res, 200, Object.assign({ ok: true }, r))
          } catch (e) { return json(res, 500, { ok: false, error: errOf(e) }) }
        }

        if (action === '/ssh-ls' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            const r = await ssh.ls(body.id, String(body.path || '.'))
            return json(res, 200, Object.assign({ ok: true }, r))
          } catch (e) { return json(res, 500, { ok: false, error: errOf(e) }) }
        }

        if (action === '/ssh-read' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            const r = await ssh.readText(body.id, String(body.path || ''))
            return json(res, 200, { ok: true, text: r.buf.toString('utf8'), size: r.size, mtime: r.mtime })
          } catch (e) { return json(res, 500, { ok: false, error: errOf(e) }) }
        }

        if (action === '/ssh-write' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            await ssh.writeText(body.id, String(body.path || ''), String(body.text === undefined ? '' : body.text))
            trace({ level: 'info', kind: 'ssh', msg: 'write', meta: { sid: body.id, path: String(body.path || ''), bytes: String(body.text || '').length } })
            return json(res, 200, { ok: true })
          } catch (e) { return json(res, 500, { ok: false, error: errOf(e) }) }
        }

        if (action === '/ssh-upload' && req.method === 'POST') {
          const body = await readBody(req)
          try { return json(res, 200, Object.assign({ ok: true }, await ssh.upload(body.id, String(body.local || ''), String(body.remote || '')))) }
          catch (e) { return json(res, 500, { ok: false, error: errOf(e) }) }
        }

        // 下载落到本机临时目录：远端大文件不进内存，也不用把 base64 塞进 JSON
        if (action === '/ssh-download' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            // 用户在下拉框里选了落点就照他选的写；没选（浏览器里没壳桥）就落到家目录 temp
            let local = String(body.local || '')
            if (!local) {
              const base = body.localDir ? String(body.localDir) : path.join(process.env.DSH_HOME || process.cwd(), 'temp')
              await mkdir(base, { recursive: true })
              const name = path.basename(String(body.remote || 'download')).replace(/[\\/:*?"<>|]/g, '_')
              local = path.join(base, name)
            } else {
              await mkdir(path.dirname(local), { recursive: true }).catch(() => {})
            }
            const r = await ssh.download(body.id, String(body.remote || ''), local)
            return json(res, 200, Object.assign({ ok: true, local }, r))
          } catch (e) { return json(res, 500, { ok: false, error: errOf(e) }) }
        }

        // 整目录下载：落到用户选的目录下（再套一层远端目录名，避免文件散一地）
        if (action === '/ssh-download-dir' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            const remote = String(body.remote || '/')
            let base = String(body.local || '')
            if (!base) {
              base = path.join(process.env.DSH_HOME || process.cwd(), 'temp')
              await mkdir(base, { recursive: true })
            }
            const leaf = path.basename(remote.replace(/\/+$/, '')) || 'root'
            const local = path.join(base, leaf)
            const r = await ssh.downloadDir(body.id, remote, local)
            trace({ level: 'info', kind: 'ssh', msg: 'download-dir', meta: { sid: body.id, remote, local, files: r.files, bytes: r.bytes, truncated: r.truncated } })
            return json(res, 200, Object.assign({ ok: true, local }, r))
          } catch (e) { return json(res, 500, { ok: false, error: errOf(e) }) }
        }

        if (action === '/ssh-mkdir' && req.method === 'POST') {
          const body = await readBody(req)
          try { return json(res, 200, Object.assign({ ok: true }, await ssh.mkdirp(body.id, String(body.path || '')))) }
          catch (e) { return json(res, 500, { ok: false, error: errOf(e) }) }
        }

        if (action === '/ssh-remove' && req.method === 'POST') {
          const body = await readBody(req)
          try { return json(res, 200, Object.assign({ ok: true }, await ssh.remove(body.id, String(body.path || ''), !!body.dir))) }
          catch (e) { return json(res, 500, { ok: false, error: errOf(e) }) }
        }

        if (action === '/ssh-rename' && req.method === 'POST') {
          const body = await readBody(req)
          try { return json(res, 200, Object.assign({ ok: true }, await ssh.rename(body.id, String(body.from || ''), String(body.to || '')))) }
          catch (e) { return json(res, 500, { ok: false, error: errOf(e) }) }
        }

        if (action === '/ssh-term-open' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            const r = await ssh.openTerm(body.id, {
              cols: Number(body.cols) || 100, rows: Number(body.rows) || 30,
              owner: body.owner === 'agent' ? 'agent' : 'user',
              title: String(body.title || ''),
              onData: (t, chunk) => sshFeedKeys(body.id, t.id, chunk, t.owner),
            })
            return json(res, 200, Object.assign({ ok: true }, r))
          } catch (e) { return json(res, 500, { ok: false, error: errOf(e) }) }
        }

        if (action === '/ssh-term-read' && req.method === 'GET') {
          const r = ssh.readTerm(q.get('id'), q.get('term'), Number(q.get('since') || 0) | 0)
          if (!r) return json(res, 404, { ok: false, error: 'no-session' })
          return json(res, 200, Object.assign({ ok: true }, r))
        }

        if (action === '/ssh-term-input' && req.method === 'POST') {
          const body = await readBody(req)
          const r = ssh.inputTerm(body.id, body.term, String(body.data === undefined ? '' : body.data))
          return json(res, 200, Object.assign({ ok: true }, r))
        }

        if (action === '/ssh-term-resize' && req.method === 'POST') {
          const body = await readBody(req)
          const r = ssh.resizeTerm(body.id, body.term, Number(body.cols) || 0, Number(body.rows) || 0)
          return json(res, 200, Object.assign({ ok: true }, r))
        }

        if (action === '/ssh-term-close' && req.method === 'POST') {
          const body = await readBody(req)
          return json(res, 200, Object.assign({ ok: true }, ssh.closeTerm(body.id, body.term, 'client-close')))
        }

        // ── ㉓ Agent 侧的上下文与审批（2026-10-21）─────────────────────────
        // 界面把"现在在哪台机器、哪个目录、选中了什么"推过来 ⇒ Agent 不用问路径就能干活。
        if (action === '/ssh-context' && req.method === 'POST') {
          const body = await readBody(req)
          sshCtx.sid = body.id ? String(body.id) : null
          sshCtx.path = String(body.path || '/')
          sshCtx.sel = body.sel ? String(body.sel) : null
          // 界面上正在看的那个终端：Agent 不点名时就读它（要读自己的那条会显式说 agent）
          sshCtx.term = body.term ? String(body.term) : null
          sshCtx.at = Date.now()
          return json(res, 200, { ok: true })
        }
        if (action === '/ssh-approvals' && req.method === 'GET') {
          const list = [...sshApprovals.values()].map((a) => ({
            id: a.id, tool: a.entry.tool, target: a.entry.target || '', reason: a.entry.reason || '', detail: a.entry.detail || '',
          }))
          return json(res, 200, { ok: true, approvals: list })
        }
        if (action === '/ssh-approvals/answer' && req.method === 'POST') {
          const body = await readBody(req)
          return json(res, 200, Object.assign({ ok: true }, answerSshApproval(body.id, body.allow === true)))
        }

        // ── ⑭-② inline 建议（ghost text）：一次性模型调用 ────────────────────
        // **只在显式触发时调用**（Alt+\ 或命令面板），不跟着敲键自动跑 —— 成本可控：
        // 一次请求 = 一次模型调用（maxTokens 160、temperature 0、10s 超时）。
        if (action === '/inline-suggest' && req.method === 'POST') {
          const body = await readBody(req)
          const prefix = String(body.prefix || '').slice(-4000)
          const suffix = String(body.suffix || '').slice(0, 1500)
          if (!prefix.trim() && !suffix.trim()) return json(res, 400, { error: 'no-context' })
          if (ctx.llm === undefined) return json(res, 503, { error: 'no-llm-service' })
          const cfg = readModelConfig()
          if (!cfg) return json(res, 503, { error: 'no-model-config', detail: 'settings.yaml 里没有 agent-default-model' })
          const started = Date.now()
          const ac = new AbortController()
          const timer = setTimeout(() => { try { ac.abort() } catch { /* ignore */ } }, 10000)
          let text = ''
          try {
            const stream = ctx.llm.stream({
              provider: cfg.provider,
              model: cfg.model,
              system: INLINE_SYSTEM,
              messages: [{
                role: 'user',
                content: [{ type: 'text', text: buildInlinePrompt(body.path, body.language, prefix, suffix) }],
              }],
              temperature: 0,
              maxTokens: 160,
              signal: ac.signal,
            })
            for await (const chunk of stream) {
              if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
              if (text.length > 1500) break
            }
          } catch (e) {
            clearTimeout(timer)
            trace({ level: 'warn', kind: 'inline-suggest', msg: 'failed', meta: { error: errOf(e), ms: Date.now() - started } })
            return json(res, 502, { error: errOf(e) })
          }
          clearTimeout(timer)
          // 模型偶尔会包一层 Markdown 围栏 → 剥掉（只剥整段就是一整个围栏的情况）
          let out = String(text).trim()
          const fence = out.match(/^```[a-zA-Z0-9+-]*\n([\s\S]*?)\n?```$/)
          if (fence) out = fence[1]
          trace({
            level: 'info', kind: 'inline-suggest', msg: 'done',
            meta: { provider: cfg.provider, model: cfg.model, ms: Date.now() - started, chars: out.length, aborted: ac.signal.aborted },
          })
          return json(res, 200, { ok: true, text: out, ms: Date.now() - started, provider: cfg.provider, model: cfg.model })
        }

        // ── 插件管理 ────────────────────────────────────────────
        if (action === '/plugin-stop' && req.method === 'POST') {
          const body = await readBody(req)
          const pluginId = String(body.pluginId || '')
          const row = pluginInventory().find((p) => p.pluginId === pluginId)
          const agent = row ? agentsService && agentsService.get(row.agentId) : undefined
          if (!row || !agent) return json(res, 404, { error: 'plugin-or-agent-missing' })
          const result = await runner.stop(agent, pluginId)
          return json(res, 200, result)
        }

        if (action === '/plugin-run' && req.method === 'POST') {
          const body = await readBody(req)
          const pluginId = String(body.pluginId || '')
          const row = pluginInventory().find((p) => p.pluginId === pluginId)
          const agent = row ? agentsService && agentsService.get(row.agentId) : undefined
          if (!row || !agent) return json(res, 404, { error: 'plugin-or-agent-missing' })
          const packageId = row.nextPackageId ?? row.currentPackageId
            ?? (row.packages.length > 0 ? row.packages[row.packages.length - 1].packageId : undefined)
          if (!packageId) return json(res, 400, { error: 'no-package' })
          const result = await runner.runHostHalf(agent, pluginId, packageId, 'run', null, true)
          return json(res, 200, result)
        }

        if (action === '/plugin-remove' && req.method === 'POST') {
          const body = await readBody(req)
          const pluginId = String(body.pluginId || '')
          const row = pluginInventory().find((p) => p.pluginId === pluginId)
          const agent = row ? agentsService && agentsService.get(row.agentId) : undefined
          if (!row || !agent) return json(res, 404, { error: 'plugin-or-agent-missing' })
          const result = await runner.undefine(agent, pluginId)
          return json(res, 200, result)
        }

        // ── 能力面板：技能开关（2026-11-05）────────────────────────
        if (action === '/skill-toggle' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            const out = await setSkillEnabled(String(body.name || ''), body.enabled !== false)
            return json(res, 200, out)
          } catch (e) {
            return json(res, 400, { error: errOf(e) })
          }
        }

        // ── 能力面板：MCP 服务器（写装配单，改完引擎自己热生效）──────
        if (action === '/mcp-save' && req.method === 'POST') {
          const body = await readBody(req)
          const serverName = String(body.serverName || '').trim()
          if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) return json(res, 400, { error: 'bad-server-name' })
          const transport = body.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
          const id = String(body.id || '').trim() || ('mcp-' + serverName.toLowerCase())
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) return json(res, 400, { error: 'bad-entry-id' })
          const exists = mcpForPanel().some((m) => m.id === id)
          const clash = mcpForPanel().some((m) => m.id !== id && m.serverName.toLowerCase() === serverName.toLowerCase())
          if (clash) return json(res, 409, { error: 'server-name-taken' })
          const row = {
            id, serverName, transport,
            disabled: body.disabled === true,
            command: transport === 'stdio' ? String(body.command || '').trim() : undefined,
            args: transport === 'stdio' && Array.isArray(body.args) ? body.args.map(String) : undefined,
            url: transport === 'streamable-http' ? String(body.url || '').trim() : undefined,
          }
          if (transport === 'stdio' && !row.command) return json(res, 400, { error: 'command-required' })
          if (transport === 'streamable-http' && !/^https?:\/\//i.test(String(row.url || ''))) return json(res, 400, { error: 'url-required' })
          try {
            const out = await saveMcpEntry(row)
            return json(res, 200, { ...out, created: !exists })
          } catch (e) {
            return json(res, 500, { error: errOf(e) })
          }
        }

        if (action === '/mcp-toggle' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            const out = await setMcpDisabled(String(body.id || ''), body.enabled === false)
            return json(res, 200, out)
          } catch (e) {
            return json(res, 400, { error: errOf(e) })
          }
        }

        if (action === '/mcp-delete' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            const out = await deleteMcpEntry(String(body.id || ''))
            return json(res, 200, out)
          } catch (e) {
            return json(res, 500, { error: errOf(e) })
          }
        }

        // ── 工作空间全量文件（③ Ctrl+P 快速打开：本地 fuzzy 过滤）──
        if (action === '/tree' && req.method === 'GET') {
          const root = await resolveRoot()
          if (!root || fsService === undefined) return json(res, 200, { root: null, files: [] })
          try {
            const started = Date.now()
            const files = await collectFiles(await fsService.resolve(root))
            trace({ level: 'info', kind: 'tree', files: files.length, ms: Date.now() - started })
            return json(res, 200, {
              root,
              files: files.map((f) => ({ path: f.path, name: f.name })),
            })
          } catch (e) {
            return json(res, 500, { error: errOf(e) })
          }
        }

        // ── ⑤ 项目源文件（喂给 monaco 内建 TS worker：未打开的文件也能跨文件跳转/补全）──
        // worker 只认识"编辑器打开过的模型"，所以只打开 b.ts 时，b.ts 里 import 的 ./a 里的
        // 符号既不能跳转也不能补全。这里把项目源码一次性打包回去，client 用 addExtraLib 喂进 worker。
        // 复用 /tree、/search 的 collectFiles（同一份忽略表 + 遍历上限），再套一层"喂 worker"预算：
        // 文件数 / 单文件 / 总量三道上限；超出的只计入 skipped 并在响应里标 truncated。
        if (action === '/project-files' && req.method === 'GET') {
          const root = q.get('root') || await resolveRoot()
          if (!root || fsService === undefined) return json(res, 200, { root: null, files: [], truncated: false })
          try {
            const started = Date.now()
            const SRC_EXT = { '.ts': 1, '.tsx': 1, '.js': 1, '.jsx': 1, '.mjs': 1, '.cjs': 1 }
            const MAX_SRC_FILES = 400
            const MAX_SRC_FILE_BYTES = 200 * 1024
            const MAX_SRC_TOTAL_BYTES = 6 * 1024 * 1024
            const all = await collectFiles(await fsService.resolve(root))
            const out = []
            let total = 0
            let skipped = 0
            for (const f of all) {
              const lower = f.name.toLowerCase()
              const dot = lower.lastIndexOf('.')
              const ext = dot >= 0 ? lower.slice(dot) : ''
              if (!SRC_EXT[ext]) continue
              const size = typeof f.size === 'number' ? f.size : 0
              if (size > MAX_SRC_FILE_BYTES || out.length >= MAX_SRC_FILES || total + size > MAX_SRC_TOTAL_BYTES) {
                skipped += 1
                continue
              }
              try {
                const content = await fsService.readText(f.target)
                out.push({ path: f.path, content })
                total += content.length
              } catch { skipped += 1 }
            }
            trace({ level: 'info', kind: 'project-files', files: out.length, skipped, bytes: total, ms: Date.now() - started })
            return json(res, 200, { root, files: out, truncated: skipped > 0, bytes: total })
          } catch (e) {
            return json(res, 500, { error: errOf(e) })
          }
        }

        // ── ⑤ 第三方类型（node_modules/@types/**/*.d.ts → 喂给 TS worker）──
        // collectFiles 的忽略表会跳过 node_modules（对 /tree、/search 是对的），所以这里单独走一趟。
        // **关键（2026-09-16 实测实验定案）**：monaco 的 TS worker 里，`node_modules/@types/<pkg>`
        // 这条**作用域**查找走不通（喂了文件、typeRoots 也显式给了，仍然报 cannot find module），
        // 而 `node_modules/<pkg>/index.d.ts` 这条**逐级上溯**查找是通的（一行 addExtraLib 即可）。
        // 所以这里把 `@types/<pkg>/<rest>` 的声明**镜像成** `node_modules/<pkg>/<rest>` 再回给 client。
        // 作用域包按 DefinitelyTyped 约定换算：`@types/babel__core` → `@babel/core`。
        // 预算独立：文件数/单文件/总量；超了标 truncated。已知边界：**自带类型的包**（package.json
        // 的 types 指向 dist/*.d.ts，不经 @types）这一轮不扫 —— 见 §5 ⑤ 待办。
        if (action === '/type-files' && req.method === 'GET') {
          const root = q.get('root') || await resolveRoot()
          if (!root || fsService === undefined) return json(res, 200, { root: null, files: [], truncated: false })
          try {
            const started = Date.now()
            const MAX_TYPES_FILES = 500
            const MAX_TYPE_FILE_BYTES = 600 * 1024
            const MAX_TYPES_TOTAL_BYTES = 8 * 1024 * 1024
            const SRC_EXT = { '.ts': 1, '.tsx': 1, '.js': 1, '.jsx': 1, '.mjs': 1, '.cjs': 1 }
            const nmRoot = path.join(String(root), 'node_modules')
            const out = []
            let total = 0
            let skipped = 0
            const walk = async (target, rel, depth) => {
              if (depth > 6 || out.length >= MAX_TYPES_FILES) return
              let entries = null
              try { entries = await fsService.listDir(target) } catch { return } // 没有 @types 就空手而归
              for (const e of entries || []) {
                if (out.length >= MAX_TYPES_FILES) return
                const name = String(e.name || '')
                if (e.type === 'directory') { await walk(e.target, rel ? rel + '/' + name : name, depth + 1); continue }
                if (e.type !== 'file' || !name.toLowerCase().endsWith('.d.ts')) continue // 只喂声明文件
                const size = typeof e.size === 'number' ? e.size : 0
                if (size > MAX_TYPE_FILE_BYTES || total + size > MAX_TYPES_TOTAL_BYTES) { skipped += 1; continue }
                try {
                  const content = await fsService.readText(e.target)
                  const segs = rel ? rel.split('/') : []
                  const pkg = segs.shift() || ''
                  const rest = segs.length ? segs.join('/') + '/' + name : name
                  const plain = pkg.indexOf('__') >= 0
                    ? '@' + pkg.slice(0, pkg.indexOf('__')) + '/' + pkg.slice(pkg.indexOf('__') + 2)
                    : pkg
                  // path = 镜像后的"普通包"路径（TS 真正能解析到的形态）；from = 声明文件真实位置（排查用）
                  out.push({ path: path.join(nmRoot, plain, rest), content, from: fsService.processPath(e.target) })
                  total += content.length
                } catch { skipped += 1 }
              }
            }
            try {
              await walk(await fsService.resolve(path.join(nmRoot, '@types')), '', 0)
            } catch { /* 路径不存在 → 当作没有第三方类型 */ }

            // ── 自带类型的包（package.json 的 types/typings → 包内 *.d.ts）──
            // 这类包（vite / zod / typescript…）不走 @types，光扫 @types 目录覆盖不到。
            // **只查"项目源码里真的 import 过"的包**：一个中型项目 node_modules 上千个包，
            // 全扫 package.json 又慢又没意义；import 驱动一般只有几十个。
            // 喂法：① 该包 package.json **原样喂进去**（TS 解析时要读 types 字段；.json 不会进
            // TS program，所以不会当源码解析报错）② 包内所有 *.d.ts 按真实路径喂（入口里的
            // 相对 re-export 靠它们）。全走真实路径 → 转到定义直接开真实文件，不需要 from 映射。
            const MAX_PKGS = 120
            const MAX_PKG_DTS_FILES = 60
            const MAX_PKG_FILE_BYTES = 400 * 1024
            const MAX_SRC_READ_BYTES = 400 * 1024
            const specifiers = new Set()
            let srcScanned = 0
            try {
              const srcs = await collectFiles(await fsService.resolve(root))
              for (const f of srcs) {
                if (specifiers.size >= MAX_PKGS) break
                const lower = f.name.toLowerCase()
                const dot = lower.lastIndexOf('.')
                const ext = dot >= 0 ? lower.slice(dot) : ''
                if (!SRC_EXT[ext]) continue
                if ((typeof f.size === 'number' ? f.size : 0) > MAX_SRC_READ_BYTES) continue
                let text = ''
                try { text = await fsService.readText(f.target) } catch { continue }
                srcScanned += 1
                const re = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
                let m = null
                while ((m = re.exec(text)) !== null) {
                  const s = m[1]
                  if (!s || s.charAt(0) === '.' || s.charAt(0) === '/') continue // 相对/绝对路径不算包名
                  const segs = s.split('/')
                  const pkg = s.charAt(0) === '@' ? (segs[0] + '/' + (segs[1] || '')) : segs[0]
                  if (pkg) specifiers.add(pkg)
                  if (specifiers.size >= MAX_PKGS) break
                }
              }
            } catch { /* 源码扫不动就只留 @types 那部分 */ }

            let pkgFed = 0
            const fedPkgs = []
            for (const pkg of specifiers) {
              if (out.length >= MAX_TYPES_FILES) break
              const pkgDir = path.join(nmRoot, ...pkg.split('/'))
              let raw = null
              try { raw = await fsService.readText(await fsService.resolve(path.join(pkgDir, 'package.json'))) } catch { continue }
              let meta = null
              try { meta = JSON.parse(raw) } catch { continue }
              const entry = meta && (meta.types || meta.typings)
              if (typeof entry !== 'string' || !entry) continue // 没自带类型 → 交给上面 @types 那部分
              out.push({ path: path.join(pkgDir, 'package.json'), content: raw })
              let n = 0
              const walkPkg = async (target, depth) => {
                if (depth > 8 || n >= MAX_PKG_DTS_FILES || out.length >= MAX_TYPES_FILES) return
                let entries = null
                try { entries = await fsService.listDir(target) } catch { return }
                for (const e of entries || []) {
                  if (n >= MAX_PKG_DTS_FILES || out.length >= MAX_TYPES_FILES) return
                  if (e.type === 'directory') {
                    if (e.name === 'node_modules') continue
                    await walkPkg(e.target, depth + 1)
                    continue
                  }
                  if (e.type !== 'file' || !String(e.name || '').toLowerCase().endsWith('.d.ts')) continue
                  const size = typeof e.size === 'number' ? e.size : 0
                  if (size > MAX_PKG_FILE_BYTES || total + size > MAX_TYPES_TOTAL_BYTES) { skipped += 1; continue }
                  try {
                    const content = await fsService.readText(e.target)
                    out.push({ path: fsService.processPath(e.target), content })
                    total += content.length
                    n += 1
                  } catch { skipped += 1 }
                }
              }
              try { await walkPkg(await fsService.resolve(pkgDir), 0) } catch { /* 单个包失败不影响其它 */ }
              pkgFed += 1
              fedPkgs.push(pkg + '(' + n + ')')
            }

            trace({
              level: 'info', kind: 'type-files', msg: 'scan',
              meta: {
                files: out.length, skipped, bytes: total, ms: Date.now() - started,
                srcScanned, specifiers: specifiers.size, pkgs: pkgFed, fed: fedPkgs.slice(0, 20).join(','),
              },
            })
            return json(res, 200, { root, files: out, truncated: skipped > 0, bytes: total })
          } catch (e) {
            return json(res, 500, { error: errOf(e) })
          }
        }

        // ── ⑤ 项目 tsconfig（读项目真实编译选项，让诊断/补全与 `tsc` 一致）──
        // 只回"配置文件的原文 + extends 链"（按 base → 派生 的顺序），**解析与映射交给 client**
        // （tsconfig 的值是字符串，要映射成 monaco 的 ScriptTarget/ModuleKind 等枚举，只有 client
        // 拿得到那些枚举）。tsconfig 是 JSONC（带注释/尾逗号），extends 还能是包名
        // （@tsconfig/node20/tsconfig.json）或数组（TS 5+），这里都处理掉。
        if (action === '/tsconfig' && req.method === 'GET') {
          const root = q.get('root') || await resolveRoot()
          if (!root || fsService === undefined) return json(res, 200, { root: null, files: [], base: null })
          try {
            const MAX_CFG_BYTES = 200 * 1024
            const MAX_EXTENDS_DEPTH = 5
            const stripJsonc = (s) => String(s)
              .replace(/\/\*[\s\S]*?\*\//g, '')
              .replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, '$1')
              .replace(/,(\s*[}\]])/g, '$1')
            const readCfg = async (absPath) => {
              try {
                const target = await fsService.resolve(absPath)
                const info = await fsService.stat(target)
                if (!info) return null
                if (typeof info.size === 'number' && info.size > MAX_CFG_BYTES) return null
                return await fsService.readText(target)
              } catch { return null }
            }
            const extendsToPath = (spec, fromDir) => {
              let p = String(spec)
              if (p.startsWith('.') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
                p = p.startsWith('.') ? path.resolve(fromDir, p) : p
              } else {
                p = path.join(fromDir, 'node_modules', ...p.split('/')) // 包形式
              }
              if (!/\.json$/i.test(p)) p = path.join(p, 'tsconfig.json') // 目录形式
              return p
            }
            const collected = []
            const seen = new Set()
            const walkCfg = async (absPath, depth) => {
              if (depth > MAX_EXTENDS_DEPTH) return
              const key = String(absPath).toLowerCase()
              if (seen.has(key)) return // extends 环
              seen.add(key)
              const text = await readCfg(absPath)
              if (text === null) return
              let json = null
              try { json = JSON.parse(stripJsonc(text)) } catch { json = null }
              const ext = json && json.extends
              if (ext !== undefined && ext !== null) {
                const specs = Array.isArray(ext) ? ext : [ext]
                for (const s of specs) {
                  if (typeof s !== 'string') continue
                  await walkCfg(extendsToPath(s, path.dirname(absPath)), depth + 1)
                }
              }
              collected.push({ path: absPath, content: text }) // base 先入，派生后入
            }
            let base = null
            for (const name of ['tsconfig.json', 'jsconfig.json']) {
              const p = path.join(String(root), name)
              const text = await readCfg(p)
              if (text !== null) { base = p; await walkCfg(p, 0); break }
            }
            trace({ level: 'info', kind: 'tsconfig', msg: 'read', meta: { base, files: collected.length } })
            return json(res, 200, { root, base, files: collected })
          } catch (e) {
            return json(res, 500, { error: errOf(e) })
          }
        }

        // ── 全局内容搜索（③ Ctrl+Shift+F；③ 拍板：范围=工作空间全部文件）──
        // q: 关键词（默认忽略大小写，case=1 敏感）；响应 hits 每项一行命中：
        // path/name 可直接 openTab；line/column 为原文件 1-based 行列（monaco
        // 定位用，UTF-16 码元与 monaco 列定义一致）；text/start 为展示用行片段。
        if (action === '/search' && req.method === 'GET') {
          const query = String(q.get('q') || '')
          if (!query) return json(res, 400, { error: 'no-query' })
          const root = await resolveRoot()
          if (!root || fsService === undefined) return json(res, 200, { root: null, hits: [], searched: 0, truncated: false })
          const caseSensitive = q.get('case') === '1'
          const useRegex = q.get('regex') === '1'
          const wholeWord = q.get('word') === '1'
          const matcher = buildMatcher(query, caseSensitive, useRegex, wholeWord)
          if (matcher === null) return json(res, 400, { error: 'bad-regex' })
          try {
            const started = Date.now()
            const files = await collectFiles(await fsService.resolve(root))
            const hits = []
            let searched = 0
            let truncated = false
            await new Promise((doneAll) => {
              let idx = 0
              let pending = 0
              const pump = () => {
                while (pending < SEARCH_CONCURRENCY && idx < files.length && !truncated) {
                  pending += 1
                  worker(files[idx])
                  idx += 1
                }
                if (pending === 0) doneAll()
              }
              const worker = (f) => {
                (async () => {
                  try {
                    searched += 1
                    if (typeof f.size === 'number' && f.size > MAX_SEARCH_BYTES) return
                    const info = await fsService.stat(f.target)
                    const content = await fsService.readText(f.target)
                    if (content.indexOf('\u0000') >= 0) return // 二进制嗅探
                    const ms = matcher(content)
                    if (!ms.length) return
                    const starts = lineStartsOf(content)
                    const lines = content.split(/\r?\n/)
                    const version = info && info.version !== undefined ? String(info.version) : null
                    let lastLine = 0
                    for (const m of ms) {
                      const pos = posFromOffset(starts, m.offset)
                      if (pos.line === lastLine) continue // 每行只报第一处（保持原行为；替换按整文件处理）
                      lastLine = pos.line
                      const line = lines[pos.line - 1] || ''
                      const col0 = pos.col - 1
                      // 超长行截窗口：命中点前 80 / 后 220 字符，避免 UI 撑爆
                      let start = 0
                      let text = line
                      if (line.length > 400) {
                        start = Math.max(0, col0 - 80)
                        text = line.slice(start, Math.min(line.length, col0 + m.length + 220))
                      }
                      hits.push({ path: f.path, name: f.name, line: pos.line, column: pos.col, start, text, offset: m.offset, version })
                      if (hits.length >= MAX_SEARCH_HITS) { truncated = true; break }
                    }
                  } catch { /* 读不了（二进制/编码）跳过该文件 */ }
                })().then(() => { pending -= 1; pump() })
              }
              pump()
            })
            const versions = {}
            for (const h of hits) if (h.version) versions[h.path] = h.version
            trace({
              level: 'info', kind: 'search', query: query.slice(0, 200),
              caseSensitive, regex: useRegex, word: wholeWord, files: files.length, hits: hits.length,
              truncated, ms: Date.now() - started,
            })
            return json(res, 200, { root, hits, searched, truncated, versions })
          } catch (e) {
            return json(res, 500, { error: errOf(e) })
          }
        }

        // ── ⑫ 全局替换（Ctrl+Shift+H）────────────────────────────────────
        // 与 /search 共用同一个匹配器（大小写/正则/全词），所以"看到的"和"替换的"是同一套语义。
        // 两种粒度：给了 offset → 只替换那一处；否则替换该文件全部命中。
        // 数据安全：client 回传 /search 给出的**版本令牌**，写盘走平台的 replaceIfVersion
        // （磁盘在搜索之后又变过 → 该文件跳过并回 stale-version，绝不静默覆盖别处的改动）。
        if (action === '/replace' && req.method === 'POST') {
          const body = await readBody(req)
          const query = String(body.query || '')
          const replacement = String(body.replacement === undefined ? '' : body.replacement)
          const caseSensitive = body.case === true
          const useRegex = body.regex === true
          const wholeWord = body.word === true
          const onlyOffset = typeof body.offset === 'number' ? body.offset : null
          const paths = Array.isArray(body.paths) ? body.paths.map((x) => String(x)) : []
          const versions = body.versions && typeof body.versions === 'object' ? body.versions : {}
          if (fsService === undefined || !query || !paths.length) return json(res, 400, { error: 'no-query-or-paths' })
          const matcher = buildMatcher(query, caseSensitive, useRegex, wholeWord)
          if (matcher === null) return json(res, 400, { error: 'bad-regex' })
          const root = await resolveRoot()
          if (!root) return json(res, 400, { error: 'no-root' })
          const started = Date.now()
          const out = []
          let totalReplaced = 0
          let changedFiles = 0
          for (const p of paths) {
            const one = { path: p, ok: false, replaced: 0 }
            try {
              const target = await fsService.resolve(p)
              const display = fsService.processPath(target)
              if (!isInside(display, root)) { one.error = 'outside-workspace'; out.push(one); continue }
              const info = await fsService.stat(target)
              if (info === undefined) { one.error = 'not-found'; out.push(one); continue }
              const want = versions[p]
              if (want && String(info.version) !== String(want)) { one.error = 'stale-version'; out.push(one); continue }
              const content = await fsService.readText(target)
              let chosen = matcher(content)
              if (onlyOffset !== null) chosen = chosen.filter((m) => m.offset === onlyOffset)
              if (!chosen.length) { one.error = 'no-match'; out.push(one); continue }
              // 从后往前替换：前面的偏移不会被后面的改动带偏
              let next = content
              for (let i = chosen.length - 1; i >= 0; i--) {
                const m = chosen[i]
                const rep = useRegex ? expandReplacement(replacement, m) : replacement
                next = next.slice(0, m.offset) + rep + next.slice(m.offset + m.length)
              }
              const outcome = await fsService.writeText(target, next, { kind: 'replaceIfVersion', version: info.version }, undefined, await writePolicy())
              one.ok = true
              one.replaced = chosen.length
              one.version = outcome && outcome.version !== undefined ? String(outcome.version) : null
              totalReplaced += chosen.length
              changedFiles += 1
            } catch (e) {
              one.error = codeOf(e) === 'FS_STALE_VERSION' ? 'stale-version' : errOf(e)
            }
            out.push(one)
          }
          trace({
            level: 'info', kind: 'replace', msg: 'done',
            meta: { files: out.length, changed: changedFiles, replaced: totalReplaced, single: onlyOffset !== null, regex: useRegex, word: wholeWord, ms: Date.now() - started },
          })
          return json(res, 200, { ok: true, replaced: totalReplaced, changedFiles, results: out })
        }

        // ── 活动工作空间上报（多工作空间下 root 跟随当前会话 cwd，
        // 2026-09-02：曾死取 workspaceRegistry.list()[0] → 切空间后树不变）──
        if (action === '/active-root' && req.method === 'POST') {
          const body = await readBody(req)
          const p = String(body.path || '').trim()
          if (!p) return json(res, 400, { error: 'no-path' })
          activeRoot = p
          ensureWatch(p) // 换工作空间 = 换观察目标
          bumpFsRev(0)   // 立刻让客户端重列（切空间后树必须跟着变）
          trace({ level: 'info', kind: 'active-root', path: p })
          return json(res, 200, { ok: true, root: p })
        }

        // ── 代码导航：状态 + 加语言（同一个实现，工具与路由共用）──────────
        if (action === '/tools-status' && req.method === 'GET') {
          try { return json(res, 200, { ok: true, ...installedComponents() }) }
          catch (err) { return json(res, 200, { ok: false, error: String((err && err.message) || err) }) }
        }
        // ⑤：Agent 现在能查哪些语言（覆盖口径见 codeNavCoverage 的注释）
        if (action === '/nav-coverage' && req.method === 'GET') {
          try { return json(res, 200, { ok: true, ...(await codeNavCoverage()) }) }
          catch (err) { return json(res, 200, { ok: false, error: String((err && err.message) || err) }) }
        }
        if (action === '/nav-install' && req.method === 'POST') {
          const body = await readBody(req)
          try { return json(res, 200, { ok: true, ...(await addCodeNavLanguage(body)) }) }
          catch (err) {
            trace({ level: 'error', kind: 'code-nav-add-failed', error: String((err && err.message) || err) })
            return json(res, 200, { ok: false, error: String((err && err.message) || err) })
          }
        }

        // ── 使用轨迹 / 错误日志上报（client 半批量提交）─────────
        // ── 反悔药：工作区快照（列表 / 立即快照 / 差异 / 还原）──────────────
        if (action === '/snapshots' && req.method === 'GET') {
          const root = await resolveRoot()
          if (!root) return json(res, 200, { ok: false, code: 'no-workspace' })
          const idx = await readIndex(root)
          return json(res, 200, {
            ok: true, root, items: idx.slice().reverse(),   // 新的在前
            store: await snapshotStore(root), keep: SNAP_KEEP, maxBytes: SNAP_MAX_BYTES,
          })
        }
        if (action === '/snapshot' && req.method === 'POST') {
          const body = await readBody(req)
          return json(res, 200, await takeSnapshot(await resolveRoot(), body.label, body.reason || 'manual'))
        }
        if (action === '/snapshot-diff' && req.method === 'GET') {
          const root = await resolveRoot()
          if (!root) return json(res, 200, { ok: false, code: 'no-workspace' })
          return json(res, 200, await snapshotDiff(root, Number(url.searchParams.get('ts') || 0)))
        }
        if (action === '/snapshot-restore' && req.method === 'POST') {
          const body = await readBody(req)
          const root = await resolveRoot()
          if (!root) return json(res, 200, { ok: false, code: 'no-workspace' })
          return json(res, 200, await restoreSnapshot(root, Number(body.ts || 0), body.paths))
        }
        // ── 对话回退：把一段对话从模型视野里切掉（2026-10-14 实测入口）──────
        // body: { sessionId? , seed? , take? , startSeq? , endSeq? , dryRun? }
        //   sessionId 缺省 + seed=N → 现造一条会话并灌 N 条种子消息（不碰模型、不花钱）
        //   take = 从尾巴上切掉几个"界面格子"（缺省 1）
        // 返回 before/after 两份体检读数：messages 是模型视角的消息条数，少了 = 遮蔽生效；
        // stillLogged 是被切掉的那些事件仍留在原始日志里（不可逆 ≠ 物理删除）。
        if (action === '/rewind-shadow' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            if (sessionsService === undefined) return json(res, 200, { ok: false, error: 'no-sessions-service' })
            let session = body.sessionId ? sessionsService.get(String(body.sessionId)) : undefined
            if (session === undefined && body.seed) {
              session = sessionsService.create()
              const n = Math.min(15, Math.max(1, Number(body.seed) || 3))
              // 种一轮"提问 / 回答 / 工具结果"三格：真实对话的尾巴就是这三种，
              // 只用提问去测会把"尾巴上通常是回答或工具结果"这个常态漏掉。
              for (let i = 1; i <= n; i += 1) {
                session.append('user/message', {
                  id: 'rewind-seed-u' + i, role: 'user',
                  content: [{ type: 'text', text: '种子提问 ' + i }], source: { kind: 'user' },
                }, { surfaceOp: 'append' })
                session.append('assistant/message', {
                  turn: i, step: 1, stream: [],
                  message: {
                    id: 'rewind-seed-a' + i, role: 'assistant',
                    content: [{ type: 'text', text: '种子回答 ' + i }],
                    source: { kind: 'model', provider: 'seed', model: 'seed' },
                  },
                }, { surfaceOp: 'append' })
                session.append('tool/result', {
                  turn: i, step: 1,
                  message: {
                    id: 'rewind-seed-t' + i, role: 'tool', toolCallId: 'rewind-call-' + i,
                    content: [{ type: 'text', text: '种子工具结果 ' + i }],
                    source: { kind: 'tool', toolName: 'read_file' },
                  },
                }, { surfaceOp: 'append' })
              }
            }
            if (session === undefined) {
              return json(res, 200, {
                ok: false, error: 'session-not-found',
                live: sessionsService.list().map((s) => String(s.id)),
              })
            }
            const before = rewindDigest(session)
            const nodes = before.nodes
            let startSeq
            let endSeq
            if (body.afterSeq !== undefined) {
              // 界面那条横线走这一支：它给的是"这一轮回复的收尾格"，要切掉的是它**之后**的整段
              const afterSeq = Number(body.afterSeq)
              const at = nodes.indexOf(afterSeq)
              if (at < 0) return json(res, 200, { ok: false, code: 'anchor-not-on-surface', afterSeq })
              if (at >= nodes.length - 1) return json(res, 200, { ok: false, code: 'nothing-after-checkpoint', afterSeq })
              startSeq = nodes[at + 1]
              endSeq = nodes[nodes.length - 1]
            } else {
              const take = Math.min(nodes.length, Math.max(1, Number(body.take) || 1))
              startSeq = body.startSeq !== undefined ? Number(body.startSeq) : nodes[nodes.length - take]
              endSeq = body.endSeq !== undefined ? Number(body.endSeq) : nodes[nodes.length - 1]
            }
            // 文件那半用的"检查点"：界面点的那条横线给的就是它；测试用的按段切则取被切段之前一刻
            const checkpointSeq = body.afterSeq !== undefined ? Number(body.afterSeq) : Number(startSeq) - 1
            if (body.dryRun) {
              // 连"这一段里都是些什么格子"一起给出来，界面探针才能挑一段"肯定含可见文字"的来切
              const detail = nodes.filter((seq) => seq >= startSeq && seq <= endSeq).map((seq) => {
                const e = session.snapshotEvents().find((x) => Number(x.seq) === seq)
                return { seq, type: e ? String(e.type) : '?' }
              })
              return json(res, 200, {
                ok: true, dryRun: true, sessionId: String(session.id),
                range: { startSeq, endSeq }, checkpointSeq, shadowedDetail: detail, before,
                // 这一退会动到哪些文件（界面要拿它弹"会撤销对 N 个文件的改动"那段确认）
                affected: (await rewindAffected(String(session.id), checkpointSeq)).map((r) => ({ path: r.path, existed: r.existed })),
              })
            }
            // 被切掉的那批 = 覆盖范围内当前还在台面上的格子，逐个都要在来源里点名（引擎的硬要求）
            const shadowed = nodes.filter((seq) => seq >= startSeq && seq <= endSeq)
            const eventsBefore = session.snapshotEvents()
            const shadowedDetail = shadowed.map((seq) => {
              const e = eventsBefore.find((x) => Number(x.seq) === seq)
              const message = e ? session.deriveEventMessage(e) : null
              // projected = 它在引擎视角里占一条；reachesRequest = 它真会进模型请求。
              // 两者要分开：空内容的用户消息在引擎视角里占一条、但发请求时被丢掉
              // （serialize.ts:123）—— 拿 projected 当"会少几条"算，就会把上一条分隔条也算进去。
              return {
                seq,
                type: e ? String(e.type) : '?',
                projected: message !== null,
                reachesRequest: message !== null
                  && !(message.role === 'user' && (!Array.isArray(message.content) || message.content.length === 0)),
              }
            })
            const event = session.append('user/message', rewindMessage(), {
              surfaceOp: { op: 'replace', startSeq, endSeq },
              sourceEventSeqs: shadowed,
            })
            const after = rewindDigest(session)
            const stillLogged = session.snapshotEvents()
              .filter((e) => shadowed.indexOf(Number(e.seq)) >= 0)
              .map((e) => ({ seq: Number(e.seq), type: String(e.type) }))
            // 文件那半：把检查点之后被改过的文件摆回去（这一步失败不回滚对话——对话已经切了，
            // 如实把失败数报出来，别假装成功）
            const files = await restoreRewindFiles(String(session.id), checkpointSeq)
            trace({
              level: 'info', kind: 'rewind-shadow', msg: 'shadowed',
              sessionId: String(session.id), seq: Number(event.seq), startSeq, endSeq,
              shadowed: shadowed.length, messages: before.messages + '->' + after.messages,
              restored: files.restored, trashed: files.trashed, skipped: files.skipped,
            })
            return json(res, 200, {
              ok: true, sessionId: String(session.id), shadowSeq: Number(event.seq),
              range: { startSeq, endSeq }, checkpointSeq, shadowed, shadowedDetail,
              expectedDrop: shadowedDetail.filter((d) => d.reachesRequest).length,
              stillLogged, before, after, files,
            })
          } catch (err) {
            trace({ level: 'error', kind: 'rewind-shadow-failed', error: errOf(err) })
            return json(res, 200, { ok: false, error: errOf(err) })
          }
        }

        // ── 对话回退 · 产品三个动作（界面那条横线走这里）───────────────────────
        // ① 退：把检查点之后改过的文件摆回去 + 另存一份"当前模样"给取消用。
        //    **日志一个字不改** ⇒ 此刻还能取消（口径：发出新消息才算定局）。
        if (action === '/rewind-apply' && req.method === 'POST') {
          const body = await readBody(req)
          const session = body.sessionId ? sessionsService.get(String(body.sessionId)) : undefined
          if (session === undefined) return json(res, 200, { ok: false, error: 'session-not-found' })
          const afterSeq = Number(body.afterSeq)
          try {
            const nodes = session.surface.nodes.map((seq) => Number(seq))
            const at = nodes.indexOf(afterSeq)
            if (at < 0) return json(res, 200, { ok: false, code: 'anchor-not-on-surface', afterSeq })
            if (at >= nodes.length - 1) return json(res, 200, { ok: false, code: 'nothing-after-checkpoint', afterSeq })
            await rewindSaveCancelState(String(session.id), afterSeq)
            const files = await restoreRewindFiles(String(session.id), afterSeq)
            await rewindMarkPending(String(session.id), afterSeq)   // 口径 6：记一笔，防"退了就关软件"
            return json(res, 200, {
              ok: true, sessionId: String(session.id), checkpointSeq: afterSeq, files,
              prompt: rewindPromptAfter(session, afterSeq),
            })
          } catch (err) {
            trace({ level: 'error', kind: 'rewind-apply-failed', error: errOf(err) })
            return json(res, 200, { ok: false, error: errOf(err) })
          }
        }
        // ①' 退之前先问一句：这次会动到哪些文件（口径里的"第二段确认弹框"靠它决定弹不弹）
        if (action === '/rewind-preview' && req.method === 'POST') {
          const body = await readBody(req)
          const session = body.sessionId ? sessionsService.get(String(body.sessionId)) : undefined
          if (session === undefined) return json(res, 200, { ok: false, error: 'session-not-found' })
          try {
            const afterSeq = Number(body.afterSeq)
            const nodes = session.surface.nodes.map((seq) => Number(seq))
            const at = nodes.indexOf(afterSeq)
            if (at < 0) return json(res, 200, { ok: false, code: 'anchor-not-on-surface', afterSeq })
            if (at >= nodes.length - 1) return json(res, 200, { ok: false, code: 'nothing-after-checkpoint', afterSeq })
            const affected = await rewindAffected(String(session.id), afterSeq)
            return json(res, 200, {
              ok: true, sessionId: String(session.id), afterSeq,
              count: affected.length,
              files: affected.map((r) => ({ path: r.path, existed: r.existed })),
            })
          } catch (err) {
            trace({ level: 'error', kind: 'rewind-preview-failed', error: errOf(err) })
            return json(res, 200, { ok: false, error: errOf(err) })
          }
        }
        // ② 取消：把刚才那份"当前模样"写回去（文件前滚），界面那半由前端恢复显示
        if (action === '/rewind-cancel' && req.method === 'POST') {
          const body = await readBody(req)
          const session = body.sessionId ? sessionsService.get(String(body.sessionId)) : undefined
          if (session === undefined) return json(res, 200, { ok: false, error: 'session-not-found' })
          try {
            const out = await rewindCancelRestore(String(session.id), Number(body.afterSeq))
            await rewindClearPending()   // 用户自己取消了 ⇒ 销账，免得下次启动又前滚一次
            trace({ level: 'info', kind: 'rewind-cancel', sessionId: String(session.id), afterSeq: Number(body.afterSeq), ...out })
            return json(res, 200, { ok: true, sessionId: String(session.id), ...out })
          } catch (err) {
            trace({ level: 'error', kind: 'rewind-cancel-failed', error: errOf(err) })
            return json(res, 200, { ok: false, error: errOf(err) })
          }
        }
        // ③ 定局：编辑器入口发消息时由前端叫一声（用户平时打字的输入框走引擎侧自动定局，
        //    见上面 session/event 那个监听）—— 两条路都落到 rewindCommitCut，谁先到谁算
        if (action === '/rewind-commit' && req.method === 'POST') {
          const body = await readBody(req)
          const session = body.sessionId ? sessionsService.get(String(body.sessionId)) : undefined
          if (session === undefined) return json(res, 200, { ok: false, error: 'session-not-found' })
          try {
            const out = await rewindCommitCut(session, Number(body.afterSeq))
            if (!out || out.ok !== true) rewindCommitNote = String((out && (out.code || out.error)) || 'unknown')
            return json(res, 200, out)
          } catch (err) {
            rewindCommitNote = errOf(err)
            trace({ level: 'error', kind: 'rewind-commit-failed', error: rewindCommitNote })
            return json(res, 200, { ok: false, error: rewindCommitNote })
          }
        }

        // ③'' 免费复现"用户发出了一条消息"这一刻（自动定局的验收入口；**不触发模型**）──────
        // 为什么需要它：真机上"发新消息"必然要真调模型（烧钱），而自动定局要认的恰恰是
        // "一条真实用户消息落进会话"这件事。这里按同样的形状写一条（user/message、
        // source.kind='user'、append 到台面），等价于官方输入框那一下，但不惊动模型。
        if (action === '/rewind-probe-user' && req.method === 'POST') {
          const body = await readBody(req)
          const session = body.sessionId ? sessionsService.get(String(body.sessionId)) : undefined
          if (session === undefined) return json(res, 200, { ok: false, error: 'session-not-found' })
          try {
            const event = session.append('user/message', {
              id: 'rewind-probe-user-' + Date.now(), role: 'user',
              content: [{ type: 'text', text: String(body.text || '（实测）退回之后重新发的一句话') }],
              source: { kind: 'user' },
            }, { surfaceOp: 'append' })
            // ★ 时序判据：引擎紧接着会 append 它"准备这一轮"的事件（真机实测顺序
            //   user/message → time-context → request/header）。这里**同步**补一条同形状的，
            //   用序号先后证明我们的分隔条落在了它之前 —— 也就是落在模型请求组装之前。
            //   这条链不需要模型，零花费；修之前（延后一拍）这里必然是反的。
            const pendingRightAfter = rewindPendingState !== null
            const cutEvent = session.snapshotEvents()
              .filter((e) => String(e.type) === 'user/message'
                && e.data && e.data.source && e.data.source.kind === REWIND_SOURCE_KIND)
              .pop()
            const marker = session.append('user/message', {
              id: 'rewind-probe-time-' + Date.now(), role: 'user',
              content: [{ type: 'text', text: 'Time sampled while preparing turn (probe)' }],
              source: { kind: 'time-context' },
            }, { surfaceOp: 'append' })
            // 兜底：万一同步没成，这里再等一会儿（最多 1.5 秒）
            const deadline = Date.now() + 1500
            while (rewindPendingState !== null && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 25))
            }
            return json(res, 200, {
              ok: true, sessionId: String(session.id), userSeq: Number(event.seq),
              pendingRightAfter, pending: rewindPendingState !== null, note: rewindCommitNote,
              cutSeq: cutEvent === undefined ? 0 : Number(cutEvent.seq),
              markerSeq: Number(marker.seq),
              digest: rewindDigest(session),
              stillLogged: session.snapshotEvents().map((e) => ({ seq: Number(e.seq), type: String(e.type) })),
            })
          } catch (err) {
            trace({ level: 'error', kind: 'rewind-probe-user-failed', error: errOf(err) })
            return json(res, 200, { ok: false, error: errOf(err) })
          }
        }

        // ⑤ 免费复现"用户消息进 Agent 待办队列"（定局主路径的验收入口）──────────────────
        // 走 Agent 的真入口（和界面上发消息同一条路），所以引擎会真的往下跑到"组装这一轮请求"。
        // 隔离环境里的模型凭证已换成假值 ⇒ 请求必然失败、**零花费**；我们要看的只是"分隔条落在
        // 请求组装之前没有"。⚠ 只有被平台激活过（有 agent）的会话能用这个口子。
        if (action === '/rewind-probe-inbox' && req.method === 'POST') {
          const body = await readBody(req)
          const id = String(body.sessionId || '')
          const agent = agentsService.get(id)
          if (!agent) return json(res, 200, { ok: false, error: 'agent-not-found', sessionId: id })
          const message = {
            id: 'rewind-probe-inbox-' + Date.now(), role: 'user',
            content: [{ type: 'text', text: String(body.text || '（实测）走待办队列的一句话') }],
            source: { kind: 'user' },
          }
          agent.followup(message)
          return json(res, 200, { ok: true, sessionId: id, messageId: message.id })
        }
        // ⑤' 时序体检：分隔条 / 这一轮的请求头，谁的序号在前（前者必须在后者的前面）
        if (action === '/rewind-probe-order' && req.method === 'POST') {
          const body = await readBody(req)
          const session = body.sessionId ? sessionsService.get(String(body.sessionId)) : undefined
          if (session === undefined) return json(res, 200, { ok: false, error: 'session-not-found' })
          try {
            const events = session.snapshotEvents()
            const lastSeqOf = (pred) => {
              const hit = events.filter(pred).pop()
              return hit === undefined ? 0 : Number(hit.seq)
            }
            const kindIs = (e, kind) => e.data && e.data.source && String(e.data.source.kind) === kind
            const cutSeqNum = lastSeqOf((e) => String(e.type) === 'user/message' && kindIs(e, REWIND_SOURCE_KIND))
            // ⚠ 入队那一刻要取"分隔条之前最近的那次"：引擎取走消息时也会记一次 inbox/spliced，
            // 取"最后一次"就会拿成取走那次（那已经在分隔条之后了）。
            const splicedBeforeCut = cutSeqNum > 0
              ? events.filter((e) => String(e.type) === 'agent/inbox/spliced' && Number(e.seq) < cutSeqNum).pop()
              : undefined
            return json(res, 200, {
              ok: true, sessionId: String(session.id),
              cutSeq: cutSeqNum,
              // 这一轮的基准点：用户消息入队 → 我们落分隔条 → 引擎开工（turn/start），
              // 正序应当就是 spliced（入队那次）< cut < turn。请求头只在真调到模型那一步才写，
              // 假凭证环境下可能永远不出现，所以不能拿它当唯一基准。
              splicedSeq: splicedBeforeCut === undefined ? 0 : Number(splicedBeforeCut.seq),
              splicedLastSeq: lastSeqOf((e) => String(e.type) === 'agent/inbox/spliced'),
              turnSeq: lastSeqOf((e) => String(e.type) === 'turn/start'),
              headSeq: lastSeqOf((e) => String(e.type) === 'request/header'),
              pending: rewindPendingState !== null, note: rewindCommitNote,
              digest: rewindDigest(session),
            })
          } catch (err) {
            trace({ level: 'error', kind: 'rewind-probe-order-failed', error: errOf(err) })
            return json(res, 200, { ok: false, error: errOf(err) })
          }
        }

        // ③' 状态查询：前端在"待回退"期间靠它确认"后端有没有替我定局 / 定局失败没有"。
        //     为什么非要问：自动定局发生在引擎侧，界面那半自己不知道账销没销；不问就会一直
        //     停在"暂不显示"里（2026-10-16 那次整轮对话在界面上消失就是这么来的）。
        if (action === '/rewind-state') {
          const sid = String(q.get('sessionId') || '')
          const p = rewindPendingState
          const mine = p !== null && (sid === '' || String(p.sessionId) === sid)
          return json(res, 200, {
            ok: true,
            pending: mine,
            sessionId: mine ? String(p.sessionId) : null,
            afterSeq: mine ? Number(p.afterSeq) : null,
            note: mine ? rewindCommitNote : '',
          })
        }

        // ── 对话回退：实测用的"让引擎真跑一次改文件工具"（2026-10-14）──────────
        // 为什么要这个口子：文件存底挂在 tools/pre-execute 上，而"真跑一次改文件工具"平时只有
        // 模型调工具才会发生 —— 那样验一次就要花钱。这里直接让引擎的工具注册表跑一次（不经过模型、零花费），
        // 存底钩子照常触发，整条链（存底 → 改动 → 回退摆回去）就能免费验。
        if (action === '/rewind-store-probe' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            const session = body.sessionId ? sessionsService.get(String(body.sessionId)) : undefined
            if (session === undefined) {
              return json(res, 200, { ok: false, error: 'session-not-found', live: sessionsService.list().map((s) => String(s.id)) })
            }
            if (body.action === 'list') {
              return json(res, 200, { ok: true, sessionId: String(session.id), records: await rewindRecords(String(session.id)) })
            }
            // 兜底上限的手动触发（探针用：造不出 512MB 真数据，就把它调小来验淘汰顺序）
            if (body.action === 'trim') {
              return json(res, 200, { ok: true, ...(await rewindTrim(body.maxBytes)) })
            }
            // 造一次"Agent 改了文件"：走**与存底钩子同一段**的存底代码，再直接写盘。
            // 为什么不真跑引擎的 write 工具：工具是按作用域（预设/agent）注册的，这里没有那个作用域，
            // 直调会报 unknown tool（实测）。钩子本身接没接上，由下面的 'write' 那一支单独证。
            if (body.action === 'apply') {
              const agent = { session }
              await rewindSaveCopy({ name: 'write', arguments: { file_path: String(body.path) }, agent })
              if (body.remove === true) await rm(String(body.path), { force: true })
              else await writeFile(String(body.path), String(body.content ?? ''))
              return json(res, 200, {
                ok: true, records: (await rewindRecords(String(session.id))).map((r) => ({ atSeq: r.atSeq, path: r.path, existed: r.existed })),
              })
            }
            if (body.action !== 'write') return json(res, 200, { ok: false, error: 'unknown-action' })
            if (ctx.tools === undefined || typeof ctx.tools.execute !== 'function') {
              return json(res, 200, { ok: false, error: 'no-tools-service' })
            }
            // 只给 hook 与工具看会话这一面（它们都只读 session）；模型侧完全不参与。
            // 必须带 signal：工具注册表会读它判"这次调用有没有被取消"（缺了会报 reading 'aborted'）。
            const agent = { session }
            const signal = new AbortController().signal
            const stamp = Date.now()
            if (body.readFirst === true) {
              await ctx.tools.execute({ callId: 'probe-read-' + stamp, name: 'read', arguments: { file_path: String(body.path) }, agent, signal })
            }
            const result = await ctx.tools.execute({
              callId: 'probe-write-' + stamp, name: 'write',
              arguments: { file_path: String(body.path), content: String(body.content ?? '') },
              agent, signal,
            })
            return json(res, 200, {
              ok: true, isError: result.isError === true,
              content: (result.content || []).map((b) => String(b.text || '')).join(' ').slice(0, 400),
              records: (await rewindRecords(String(session.id))).map((r) => ({ atSeq: r.atSeq, path: r.path, existed: r.existed })),
            })
          } catch (err) {
            trace({ level: 'error', kind: 'rewind-store-probe-failed', error: errOf(err) })
            return json(res, 200, { ok: false, error: errOf(err) })
          }
        }

        // ── 天工后端保命闸 · 实测入口（2026-10-14，临时）─────────────────────────
        // 闸门挂在 tools/pre-execute 上，平时只有模型调工具才会经过；这里直接让工具注册表跑一次
        // （不经过模型、零花费）就能免费验"拦没拦住、放没放过"。
        // ⚠ 探针**只喂带 -WhatIf 或不存在 PID 的命令**：闸门若真有 bug，喂真命令会把隔离后端
        //   连同探针进程（也是 node）一起杀掉，连报告都看不到。
        if (action === '/tool-gate-probe' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            const session = body.sessionId ? sessionsService.get(String(body.sessionId)) : undefined
            if (session === undefined) return json(res, 200, { ok: false, error: 'session-not-found' })
            if (ctx.tools === undefined || typeof ctx.tools.execute !== 'function') {
              return json(res, 200, { ok: false, error: 'no-tools-service' })
            }
            const signal = new AbortController().signal
            const result = await ctx.tools.execute({
              callId: 'probe-gate-' + Date.now(),
              name: String(body.tool || 'pwsh'),
              arguments: { command: String(body.command ?? ''), description: 'tool gate probe' },
              agent: { session }, signal,
            })
            return json(res, 200, {
              ok: true, isError: result.isError === true,
              content: (result.content || []).map((b) => String(b.text || '')).join(' ').slice(0, 600),
              backendPid: process.pid,
            })
          } catch (err) {
            trace({ level: 'error', kind: 'tool-gate-probe-failed', error: errOf(err) })
            return json(res, 200, { ok: false, error: errOf(err) })
          }
        }

        // ── Agent 铁律（「Agent 设置」页读写）──────────────────────────────
        if (action === '/agent-rules' && req.method === 'GET') {
          const rules = readIronRules()
          return json(res, 200, { ok: true, text: rules.text })
        }
        if (action === '/agent-rules' && req.method === 'POST') {
          const body = await readBody(req)
          try {
            const out = await writeIronRules(body)
            trace({
              level: 'info', kind: 'agent-rules', msg: 'save',
              meta: { chars: String((body && body.text) || '').length },
            })
            return json(res, 200, out)
          } catch (err) {
            trace({ level: 'error', kind: 'agent-rules', msg: 'save-failed', error: errOf(err) })
            return json(res, 200, { ok: false, error: errOf(err) })
          }
        }

        // ── 审批放权记录（「Agent 设置」页读写）──────────────────────────────
        if (action === '/approval-grants' && req.method === 'GET') {
          const state = readGrants()
          return json(res, 200, { ok: true, grants: state.grants, denials: state.denials })
        }
        if (action === '/approval-grants/revoke' && req.method === 'POST') {
          const body = await readBody(req)
          const target = body !== null && typeof body === 'object' ? body : {}
          const key = String(target.key || '')
          const scope = String(target.scope || '')
          const sessionId = String(target.sessionId || '')
          if (key === '' || scope === '') return json(res, 200, { ok: false, error: 'bad-target' })
          try {
            const state = await queueGrants((current) => {
              const kept = current.grants.filter((g) => !(g.key === key && g.scope === scope
                && String(g.sessionId || '') === sessionId))
              return kept.length === current.grants.length
                ? null                       // 没这条：别白写一次盘
                : { grants: kept, denials: current.denials }
            })
            trace({ level: 'info', kind: 'approval', msg: 'revoke', meta: { key, scope } })
            return json(res, 200, { ok: true, grants: state.grants, denials: state.denials })
          } catch (err) {
            trace({ level: 'error', kind: 'approval', msg: 'revoke-failed', error: errOf(err) })
            return json(res, 200, { ok: false, error: errOf(err) })
          }
        }

        if (action === '/trace' && req.method === 'POST') {
          const body = await readBody(req)
          // client 一批最多攒 100 条：这里必须收得下（旧值 50 会把后半批静默丢掉）
          const items = Array.isArray(body.entries) ? body.entries.slice(0, 200) : [body]
          let recorded = 0
          for (const it of items) {
            if (!it || typeof it !== 'object') continue
            trace({
              ts: it.ts,
              src: 'client',
              level: it.level === 'warn' ? 'warn' : (it.level === 'error' ? 'error' : 'info'),
              kind: String(it.kind || 'client').slice(0, 64),
              msg: String(it.msg || '').slice(0, 2000),
              root: it.root === undefined ? undefined : String(it.root).slice(0, 400),
              sessionId: it.sessionId === undefined ? undefined : String(it.sessionId).slice(0, 120),
              meta: it.meta !== undefined && it.meta !== null ? it.meta : undefined,
            })
            recorded += 1
          }
          return json(res, 200, { ok: true, recorded })
        }

        return json(res, 404, { error: 'not-found' })
      } catch (e) {
        trace({ level: 'error', kind: 'api-error', action, message: errOf(e) })
        // code 一起回：client 要据此把「二进制」这种正常分支与真错误区分开（见 /read-file）
        return json(res, 500, { error: errOf(e), code: codeOf(e) })
      }
    }

    // ── Agent 铁律：每轮注入（2026-10-20，用户定稿）──────────────────────────
    // 用户在「Agent 设置」页写一大段自由文本，每轮对话前原样塞进上下文最前面。
    // 存独立 json 而不塞 settings.yaml / 装配单：这是天工的业务配置，跟着引擎版本走的东西不掺进来。
    // 读盘按 mtime+size 缓存（每轮都会调到，别每轮真读盘）；写盘直接刷新缓存。
    const IRON_RULES_PATH = process.env.DSH_HOME === undefined
      ? null
      : path.join(process.env.DSH_HOME, 'agent-iron-rules.json')
    // 只有一段文本，没有开关（用户口径：默认恒开，想停就清空）
    let ironRulesCache = { key: '', text: '' }
    let ironRulesSeq = 0

    function readIronRules() {
      if (IRON_RULES_PATH === null) return { text: '' }
      try {
        const st = statSync(IRON_RULES_PATH)
        const key = st.mtimeMs + ':' + st.size
        if (key === ironRulesCache.key) return ironRulesCache
        const raw = JSON.parse(readFileSync(IRON_RULES_PATH, 'utf8'))
        ironRulesCache = {
          key,
          text: raw !== null && typeof raw === 'object' && typeof raw.text === 'string' ? raw.text : '',
        }
        return ironRulesCache
      } catch {
        // 没写过 / 文件坏了：都当"没有铁律"，绝不让它拖累对话
        ironRulesCache = { key: '', text: '' }
        return ironRulesCache
      }
    }

    async function writeIronRules(patch) {
      if (IRON_RULES_PATH === null) return { ok: false, error: 'no-dsh-home' }
      const next = {
        text: patch !== null && typeof patch === 'object' && typeof patch.text === 'string'
          ? patch.text
          : readIronRules().text,
      }
      await mkdir(path.dirname(IRON_RULES_PATH), { recursive: true })
      await writeFile(IRON_RULES_PATH, JSON.stringify(next, null, 2), 'utf8')
      try {
        const st = statSync(IRON_RULES_PATH)
        ironRulesCache = { key: st.mtimeMs + ':' + st.size, text: next.text }
      } catch { ironRulesCache = { key: '', text: next.text } }
      return { ok: true, text: next.text }
    }

    // ── 审批放权记录（2026-10-20）────────────────────────────────────────────
    // 引擎审批卡回四种答案，其中「本对话允许」「永久允许」要**记住**才谈得上"不再问"。
    // 记住这件事放在这里、不放引擎：记录要显示在「Agent 设置」页，而那是本插件的地盘；
    // 引擎那边只把这两答案当成"这一次放行"（user-approval 的 normalizeAnswer）。
    // 命中记录的请求在本监听里直接放行 —— 卡片根本不弹，所以撤销当场生效、不用重开。
    // 身份（grantKey）= 同一个工具 + 同样的权限提升（形态见 sandbox 的 approveEscalation）。
    const GRANTS_PATH = process.env.DSH_HOME === undefined
      ? null
      : path.join(process.env.DSH_HOME, 'approval-grants.json')
    const GRANT_CAP = 50
    const DENIAL_CAP = 100
    const GRANT_SCOPES = { 'allowed-session': 'session', 'allowed-always': 'always' }
    let grantsCache = { key: '', grants: [], denials: [] }
    let grantsQueue = Promise.resolve()

    const grantRecords = (value) => (Array.isArray(value)
      ? value.filter((x) => x !== null && typeof x === 'object' && typeof x.key === 'string')
      : [])

    function readGrants() {
      if (GRANTS_PATH === null) return grantsCache
      try {
        const st = statSync(GRANTS_PATH)
        const key = st.mtimeMs + ':' + st.size
        if (key === grantsCache.key) return grantsCache
        const raw = JSON.parse(readFileSync(GRANTS_PATH, 'utf8'))
        grantsCache = {
          key,
          grants: grantRecords(raw && raw.grants),
          denials: grantRecords(raw && raw.denials),
        }
        return grantsCache
      } catch {
        // 没写过 / 文件坏了：都当"没有任何放权记录"，绝不让它拖累审批
        grantsCache = { key: '', grants: [], denials: [] }
        return grantsCache
      }
    }

    async function saveGrants(state) {
      if (GRANTS_PATH === null) return
      const next = {
        grants: state.grants.slice(-GRANT_CAP),
        denials: state.denials.slice(-DENIAL_CAP),
      }
      await mkdir(path.dirname(GRANTS_PATH), { recursive: true })
      await writeFile(GRANTS_PATH, JSON.stringify(next, null, 2), 'utf8')
      try {
        const st = statSync(GRANTS_PATH)
        grantsCache = { key: st.mtimeMs + ':' + st.size, grants: next.grants, denials: next.denials }
      } catch { grantsCache = { key: '', grants: next.grants, denials: next.denials } }
    }

    // 串行写盘：撤销连点、两条审批几乎同时落记录时，别互相盖掉
    function queueGrants(mutate) {
      const run = grantsQueue.then(async () => {
        const current = readGrants()
        const next = mutate({ grants: current.grants.slice(), denials: current.denials.slice() })
        if (next !== null) await saveGrants(next)
        return readGrants()
      })
      grantsQueue = run.catch(() => {})
      return run
    }

    // 同一类、同一档只留一行（再点一次 = 刷新时间，不是堆两行）
    function upsertGrant(list, entry) {
      const kept = list.filter((g) => !(g.key === entry.key && g.scope === entry.scope
        && String(g.sessionId || '') === String(entry.sessionId || '')))
      kept.push(entry)
      return kept
    }

    function sessionIdOf(req) {
      const agent = req !== null && typeof req === 'object' ? req.agent : null
      const session = agent !== null && typeof agent === 'object' ? agent.session : null
      return session !== null && typeof session === 'object' && typeof session.id === 'string' ? session.id : ''
    }

    function grantCovers(grants, key, sessionId) {
      for (const g of grants) {
        if (g.key !== key) continue
        if (g.scope === 'always') return g
        // 会话档必须两边都有会话 id 才算命中（无会话的请求不许被任何会话档吃掉）
        if (g.scope === 'session' && sessionId !== '' && String(g.sessionId || '') === sessionId) return g
      }
      return null
    }

    // prepend：抢在"把请求转发给浏览器"那个答复者之前，所以命中记录时卡片不会弹
    ctx.effect(() => ctx.on('approval/request', async (req, next) => {
      const key = req !== null && typeof req === 'object' && typeof req.grantKey === 'string' ? req.grantKey : ''
      if (key === '') return next()        // 没有可重复的身份：原样交给后面的答复者
      const sessionId = sessionIdOf(req)
      if (grantCovers(readGrants().grants, key, sessionId) !== null) {
        trace({ level: 'info', kind: 'approval', msg: 'auto-allow', meta: { key, session: sessionId } })
        return 'allowed-once'
      }
      const outcome = await next()
      if (outcome === 'allowed-session' || outcome === 'allowed-always') {
        const scope = GRANT_SCOPES[outcome]
        await queueGrants((state) => {
          state.grants = upsertGrant(state.grants, { key, scope, sessionId, at: Date.now() })
          return state
        })
        trace({ level: 'info', kind: 'approval', msg: 'grant', meta: { key, scope, session: sessionId } })
        return 'allowed-once'
      }
      if (outcome === 'rejected') {
        await queueGrants((state) => {
          const hit = state.denials.find((d) => d.key === key && String(d.sessionId || '') === sessionId)
          state.denials = state.denials.filter((d) => d !== hit)
          state.denials.push({ key, sessionId, at: Date.now(), count: (hit ? Number(hit.count) || 1 : 0) + 1 })
          return state
        })
        trace({ level: 'info', kind: 'approval', msg: 'deny', meta: { key, session: sessionId } })
      }
      return outcome
    }, { prepend: true }), 'dsh-ide: approval grants')

    // 挂 `agent/pre-step`（引擎每步请求前唯一能改上下文的地方；请求内容随后由会话日志推导，
    // 事后改请求数组无效）。返回的消息形状必须满足会话落盘校验：id/role/source.kind/content。
    // 走 next() 之后追加，是为了排在其它监听之后、贴着用户消息 —— 越近注意越强。
    ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
      // 只在这一步真认领到用户消息时注入。pre-step 每一步都跑（工具调用后也算一步），
      // 不挡这一下 → 一轮里几次工具调用就塞几条铁律，会话直接被撑爆。
      if (payload === undefined || payload === null
        || !Array.isArray(payload.messages) || payload.messages.length === 0) return next()
      const downstream = await next()
      if (downstream === undefined || downstream === null || downstream.kind !== 'enter') return downstream
      const rules = readIronRules()
      const text = typeof rules.text === 'string' ? rules.text.trim() : ''
      if (text === '') return downstream
      ironRulesSeq += 1
      const message = {
        id: 'dsh-ide-iron-rules-' + Date.now() + '-' + ironRulesSeq,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'dsh-ide-iron-rules' },
      }
      trace({ level: 'info', kind: 'agent-rules', msg: 'inject', meta: { chars: text.length } })
      return { ...downstream, messages: [...downstream.messages, message] }
    }), 'dsh-ide: agent iron rules')

    ctx.effect(() => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), 'dsh-ide: api routes')

    // 观察句柄属于本 fiber：卸载/热重载时关掉，别留悬挂的 watcher
    ctx.effect(() => () => {
      if (watcher !== null) {
        try { watcher.close() } catch { /* 忽略 */ }
        watcher = null
        watchRoot = null
      }
      if (watchTimer !== null) { clearTimeout(watchTimer); watchTimer = null }
    }, 'dsh-ide: fs watch')
  },
}
