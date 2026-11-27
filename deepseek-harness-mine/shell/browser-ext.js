'use strict'
// 内置浏览器的扩展运行时（跑在壳主进程）。
//
// 为什么不是 Chrome 那套扩展：天工的内置浏览器是 Electron 的 WebContentsView，
// Electron 只实现了 Chrome 扩展 API 的一个子集（没有工具栏按钮、没有声明式规则引擎、
// 没有 contextMenus/downloads），商店里的插件装进来基本是哑的。所以这里自己定一套
// 够用的格式：规则表 + 注入脚本 + 常驻脚本 + 设置页，全部以**文件**形态放在家目录，
// 改完不用重启天工（目录一变就重载，见 watch）。
//
// 目录：<家目录>\browser-extensions\<扩展名>\
//   extension.json   { name, description, enabled, matches, scripts, rules, background, settings }
//   rules.json       { subscriptions: [{ name, url, format }], rules: ["||ads.example.com^", ...] }
//   scripts\*.js     注入脚本（按 runAt: document-start / document-idle）
//   background.js    常驻脚本（在壳里跑，能收事件、能定时、能联网、能写自己的规则表）
//   settings.html    设置页（管理页里点「设置」→ 浏览器新开一页）
//   state.json      扩展自己的数据（注入脚本与常驻脚本共用）
//
// 安全边界（2026-11-27 用户定）：注入脚本只能操作网页 —— 它跑在页面主世界，
// 拿到的是 window 与一个只有 get/set/send 的桥，碰不到天工的文件、凭证、Agent。
// 常驻脚本跑在 vm 沙箱里，只有定时器 / fetch / 存储 / 事件 / 写自己的规则表，没有 require、没有 process。

const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const EXT_DIR_NAME = 'browser-extensions'
// 一次加载的规则上限：两张中文规则表约 5 万条，留够余量；再多就是有人在塞整站镜像，直接截断
const MAX_RULES_PER_EXT = 80000

function extensionsRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, EXT_DIR_NAME)
}

// 扩展运行时自己的落盘日志。
// 为什么不用壳的 note：壳传进来的回调只接两个参数（message, meta），扩展这边是四个，
// 消息在传递中全丢了；更关键的是主进程一旦抛未捕获异常，Electron 只弹一个 Windows 红叉框、
// 什么都不留（2026-11-27 就这么瞎了一次）。这里自己写一份，崩了也能查最后一步在干嘛。
function extLogFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'logs', 'browser-ext.log')
}

let logBytes = 0
function fileLog(entry) {
  try {
    const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry)) + '\n'
    const file = extLogFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 单文件超过 2MB 就重开一份，避免常驻脚本每小时的日志把盘写满
    if (logBytes === 0) { try { logBytes = fs.statSync(file).size } catch { logBytes = 0 } }
    if (logBytes > 2 * 1024 * 1024) { try { fs.renameSync(file, file + '.1') } catch { /* 忽略 */ }; logBytes = 0 }
    fs.appendFileSync(file, line)
    logBytes += Buffer.byteLength(line)
  } catch { /* 日志写不了不能影响功能 */ }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

// 注入脚本的 chrome.* 垫片：外面搬来的现成脚本几乎都用 chrome.storage.local，
// 有它就能原样用（2026-11-27 迁知乎那个扩展时定的做法）。
// 只映射 storage.local 与 runtime 的两个空实现 —— 别的**故意不实现**：
// 给个假功能比没有更坏，脚本会以为能用然后走进死路。
const CHROME_SHIM = '(function(){'
  + 'var api=window.__tiangongExt;if(!api)return;'
  + 'var id=window.__tiangongExtId||(api.ids&&api.ids[0]);'
  + 'function read(){try{return api.get(id)||{}}catch(e){return{}}}'
  + 'window.chrome=window.chrome||{};'
  + 'window.chrome.storage=window.chrome.storage||{};'
  + 'window.chrome.storage.local={'
  + 'get:function(keys,cb){var all=read(),out={};'
  + 'if(keys===null||keys===undefined){out=all}'
  + 'else if(typeof keys==="string"){out[keys]=all[keys]}'
  + 'else if(Object.prototype.toString.call(keys)==="[object Array]"){keys.forEach(function(k){out[k]=all[k]})}'
  + 'else if(typeof keys==="object"){Object.keys(keys).forEach(function(k){out[k]=(k in all)?all[k]:keys[k]})}'
  + 'if(typeof cb==="function"){cb(out);return out}return Promise.resolve(out)},'
  + 'set:function(obj,cb){var all=read();Object.keys(obj||{}).forEach(function(k){all[k]=obj[k]});'
  + 'try{api.set(id,all)}catch(e){}if(typeof cb==="function")cb()}'
  + '};'
  + 'window.chrome.runtime=window.chrome.runtime||{};'
  + 'window.chrome.runtime.onMessage=window.chrome.runtime.onMessage||{addListener:function(){},removeListener:function(){}};'
  + 'window.chrome.runtime.sendMessage=window.chrome.runtime.sendMessage||function(){};'
  + '})();\n'

// ── 规则：Adblock Plus 的一个够用子集 ─────────────────────────────────────────
// 支持：||域名^ · |前缀 · 结尾| · * 通配 · /正则/ · @@ 例外 · $domain= / 类型限定
// 不支持（宁可整条跳过也不"大概拦一下"）：$replace / $csp / $redirect 那些带副作用的动作。
const TYPE_MAP = {
  script: 'script', image: 'image', stylesheet: 'stylesheet', object: 'object',
  xmlhttprequest: 'xhr', subdocument: 'subFrame', document: 'mainFrame',
  font: 'font', media: 'media', websocket: 'webSocket', ping: 'ping', other: 'other',
}
const ABP_TYPES = Object.keys(TYPE_MAP)

// a.b.example.com → [b.example.com, example.com]
function domainSuffixes(host) {
  const out = []
  const parts = String(host || '').toLowerCase().split('.')
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(i).join('.'))
  return out
}

function escapeRe(s) {
  return String(s).replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

// 规则里的通配 → 正则。返回 null 表示这条规则没法编译（直接跳过）
function wildcardRegex(pattern) {
  const hasStar = pattern.includes('*')
  const src = pattern.split('*').map(escapeRe).join('[^]*')
  try { return new RegExp(hasStar ? src : escapeRe(pattern)) } catch { return null }
}

// 规则里最长的字面片段，用来做"便宜的先否掉"：不含这个子串就不可能命中。
// 没有它的话，几万条通用规则每条都要跑一次正则，一个页面几十个请求就卡住了。
function fastToken(pattern) {
  let best = ''
  for (const part of String(pattern).split(/[*^|()[\]]/)) {
    if (part.length > best.length) best = part
  }
  return best.length >= 4 ? best.toLowerCase() : ''
}

function parseOptions(text) {
  if (!text) return {}
  const out = { types: null, thirdParty: null, domains: null, domainsNegated: false }
  const names = new Set()
  for (const part of text.split(',')) {
    if (!part) continue
    if (part === 'third-party' || part === '3p') { out.thirdParty = true; continue }
    if (part === '~third-party' || part === '~3p') { out.thirdParty = false; continue }
    if (part.startsWith('domain=')) {
      out.domainsNegated = part.includes('~=')
      out.domains = new Set(part.slice(7).split('|').map((d) => d.replace(/^~/, '').toLowerCase()).filter(Boolean))
      continue
    }
    if (part.startsWith('~')) continue
    if (ABP_TYPES.includes(part)) { names.add(TYPE_MAP[part]); continue }
    // 带副作用的选项：整条不要（拦不住比拦错强）
    if (part.startsWith('csp=') || part.startsWith('replace=') || part.startsWith('rewrite=') || part.startsWith('redirect=') || part.startsWith('removeparam')) return false
    if (part.startsWith('domain=')) continue
    // 认不出的其它选项：保留规则但忽略该选项（ABP 的行为也是忽略未知选项）
  }
  out.types = names.size ? names : null
  return out
}

// 一条规则编译成 { test, exception, bucket, token, source }
// bucket = 域名后缀（走桶索引）；没有 bucket 的进通用列表
function compileRule(line) {
  let raw = String(line || '').trim()
  if (!raw || raw.startsWith('!') || raw.startsWith('#') || raw.startsWith('[')) return null
  let exception = false
  if (raw.startsWith('@@')) { exception = true; raw = raw.slice(2) }
  let optionsText = null
  const dollar = raw.lastIndexOf('$')
  if (dollar > 0 && !raw.endsWith('/')) { optionsText = raw.slice(dollar + 1); raw = raw.slice(0, dollar) }
  const opt = parseOptions(optionsText)
  if (opt === false) return null

  let regex = null
  let bucket = null
  let hostRest = null      // ||host^ 后面的部分
  let prefix = null
  let suffix = null
  let pattern = raw

  if (raw.length > 2 && raw.startsWith('/') && raw.endsWith('/')) {
    try { regex = new RegExp(raw.slice(1, -1), 'i') } catch { return null }
    pattern = ''
  } else if (raw.startsWith('||')) {
    const rest = raw.slice(2)
    const m = /^([a-z0-9][a-z0-9.-]*[a-z0-9])(\^)?(.*)$/i.exec(rest)
    if (!m) return null
    bucket = m[1].toLowerCase()
    // `^` 表示"域名到此为止"，后面还有内容时才需要继续比
    hostRest = m[3] || ''
    pattern = hostRest
  } else if (raw.startsWith('|')) {
    prefix = raw.slice(1)
    pattern = prefix
  } else if (raw.endsWith('|')) {
    suffix = raw.slice(0, -1)
    pattern = suffix
  }

  const mainRe = regex || (pattern ? wildcardRegex(pattern) : null)
  if (!regex && pattern && !mainRe) return null
  const token = regex ? '' : fastToken(pattern || '')

  const test = (url, host, type, thirdParty) => {
    if (opt.types && !opt.types.has(type)) return false
    if (opt.thirdParty === true && !thirdParty) return false
    if (opt.thirdParty === false && thirdParty) return false
    if (opt.domains) {
      const hit = [host].concat(domainSuffixes(host)).some((d) => opt.domains.has(d))
      if (opt.domainsNegated ? hit : !hit) return false
    }
    if (regex) return regex.test(url)
    if (bucket) {
      if (host !== bucket && !host.endsWith('.' + bucket)) return false
      if (!hostRest) return true
      // 从域名之后的位置开始比，避免 `||a.com/x` 匹配到 query 里的同名片段
      const at = url.toLowerCase().indexOf(bucket)
      const tail = at >= 0 ? url.slice(at) : url
      return mainRe.test(tail)
    }
    if (prefix !== null && !url.startsWith(prefix)) return false
    if (suffix !== null && !url.endsWith(suffix)) return false
    return mainRe ? mainRe.test(url) : false
  }

  return { test, exception, bucket, token, source: line }
}

// ── 扩展目录读取 ─────────────────────────────────────────────────────────────
function loadExtensions(note) {
  const root = extensionsRoot()
  const list = []
  let names = []
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return list }
  for (const dirName of names) {
    if (dirName.startsWith('.')) continue
    const dir = path.join(root, dirName)
    const manifest = readJson(path.join(dir, 'extension.json'), null)
    if (!manifest) { note('warn', 'ext-load', '扩展缺少 extension.json，跳过', { dir: dirName }); continue }
    const ext = {
      id: dirName,
      dir,
      name: String(manifest.name || dirName),
      description: String(manifest.description || ''),
      enabled: manifest.enabled !== false,
      matches: Array.isArray(manifest.matches) ? manifest.matches : [],
      scripts: Array.isArray(manifest.scripts) ? manifest.scripts : [],
      settings: manifest.settings ? String(manifest.settings) : '',
      rulesFile: manifest.rules ? String(manifest.rules) : '',
      // 状态文件可以指到扩展目录外面（2026-11-27：知乎那份数据在 Syncthing 同步盘上，
      // Chrome 扩展和天工要共用同一份，各读各的一份副本就等于没同步）。
      // 只认 .json —— 这个字段能让注入脚本读到文件内容，别给它开任意文件的权限。
      stateFile: manifest.stateFile && /\.json$/i.test(String(manifest.stateFile)) ? String(manifest.stateFile) : '',
      backgroundFile: manifest.background ? String(manifest.background) : '',
      subscriptions: [],
      byBucket: new Map(),     // 域名后缀 → 规则[]
      general: [],             // 没有域名锚点的规则（少，靠 token 先否掉）
      ruleTotal: 0,
    }
    if (ext.rulesFile) {
      const rulesData = readJson(path.join(dir, ext.rulesFile), null)
      if (rulesData) {
        ext.subscriptions = Array.isArray(rulesData.subscriptions) ? rulesData.subscriptions : []
        const lines = Array.isArray(rulesData.rules) ? rulesData.rules : []
        for (const line of lines) {
          if (ext.ruleTotal >= MAX_RULES_PER_EXT) break
          const rule = compileRule(line)
          if (!rule) continue
          ext.ruleTotal += 1
          if (rule.bucket) {
            const arr = ext.byBucket.get(rule.bucket)
            if (arr) arr.push(rule)
            else ext.byBucket.set(rule.bucket, [rule])
          } else {
            ext.general.push(rule)
          }
        }
      }
    }
    list.push(ext)
  }
  return list
}

// URL 是否命中扩展的作用域（支持 * 通配）
function urlMatches(patterns, url) {
  if (!patterns || !patterns.length) return false
  for (const p of patterns) {
    if (p === '<all_urls>' || p === '*') return true
    const src = '^' + String(p).split('*').map(escapeRe).join('[^]*') + '$'
    try { if (new RegExp(src, 'i').test(url)) return true } catch { /* 坏模式跳过 */ }
  }
  return false
}

// ── 运行时 ───────────────────────────────────────────────────────────────────
function createExtRuntime(options) {
  const o = options || {}
  const noteFn = typeof o.note === 'function' ? o.note : () => { }
  // 所有日志都走这一个口子：壳那边照旧通知，同时落一份盘（见文件顶部 fileLog 的注释）
  const note = (level, kind, msg, meta) => {
    try { noteFn(level, kind, msg, meta) } catch { /* 壳的日志通道坏了不能影响扩展 */ }
    fileLog({ level, kind, msg, meta })
  }
  const root = extensionsRoot()
  let extensions = []
  let watcher = null
  let reloadTimer = null
  const stats = new Map()      // extId -> { blocked, injected, lastAt }
  const contexts = new Map()   // extId -> { ctx, emit }
  const timers = new Map()     // extId -> Set<timer>

  const bump = (extId, key) => {
    if (!extId) return
    const s = stats.get(extId) || { blocked: 0, injected: 0, lastAt: 0 }
    s[key] += 1
    s.lastAt = Date.now()
    stats.set(extId, s)
  }

  // 天工自己的请求一律不许拦：管理页与引擎 API 走的就是这条通道，拦了等于把自己锁在门外
  const isOwnTraffic = (url) => /\/dsh-ide\//.test(url) && /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)

  function matchRequest(url, resourceType, frameHost) {
    if (!url || !/^https?:/i.test(url)) return null
    if (isOwnTraffic(url)) return null
    // 主文档永远放行：拦主文档等于"页面打不开"，那不是拦广告
    if (resourceType === 'mainFrame') return null
    let host = ''
    try { host = new URL(url).hostname.toLowerCase() } catch { return null }
    const thirdParty = !!(frameHost && host !== frameHost && !host.endsWith('.' + frameHost))
    const onePass = (rules) => {
      for (const rule of rules) {
        if (rule.token && url.toLowerCase().indexOf(rule.token) === -1) continue
        if (!rule.test(url, host, resourceType, thirdParty)) continue
        return rule
      }
      return null
    }
    let hit = null
    for (const ext of extensions) {
      if (!ext.enabled) continue
      if (!ext.byBucket.size && !ext.general.length) continue
      let found = null
      // 先查域名后缀桶（绝大多数命中都在这里），再跑通用列表
      for (const suffix of [host].concat(domainSuffixes(host))) {
        const arr = ext.byBucket.get(suffix)
        if (!arr) continue
        found = onePass(arr)
        if (found) break
      }
      if (!found) found = onePass(ext.general)
      if (!found) continue
      if (found.exception) continue      // 例外规则命中 = 这个请求放行（不再看别的扩展）
      hit = { extId: ext.id, rule: found.source }
      break
    }
    if (hit) bump(hit.extId, 'blocked')
    return hit
  }

  // 某个 URL 该跑哪些脚本（按 runAt 分组，保持声明顺序）
  function scriptsFor(url, runAt) {
    const out = []
    for (const ext of extensions) {
      if (!ext.enabled) continue
      if (!urlMatches(ext.matches, url)) continue
      for (const s of ext.scripts) {
        if (String(s.runAt || 'document-idle') !== runAt) continue
        if (Array.isArray(s.matches) && s.matches.length && !urlMatches(s.matches, url)) continue
        const file = path.join(ext.dir, String(s.file || ''))
        let code
        try { code = fs.readFileSync(file, 'utf8') } catch (e) {
          note('warn', 'ext-script', '注入脚本读不出', { ext: ext.id, file: String(s.file || ''), error: String((e && e.message) || e) })
          continue
        }
        // 垫片放最前面：外面那批现成脚本几乎都用 chrome.storage.local，
        // 有它就能原样搬过来（2026-11-27 迁知乎扩展时定的）。
        out.push({ extId: ext.id, file: String(s.file || ''), code: CHROME_SHIM + code })
      }
    }
    for (const id of Array.from(new Set(out.map((x) => x.extId)))) bump(id, 'injected')
    return out
  }

  // 只有**带注入脚本**的扩展才需要页面桥：纯规则类扩展（广告拦截）不该往页面里暴露任何东西
  function activeExtFor(url) {
    const ids = []
    for (const ext of extensions) {
      if (!ext.enabled || !ext.scripts.length) continue
      if (urlMatches(ext.matches, url)) ids.push(ext.id)
    }
    return ids
  }

  function statePath(extId) {
    const ext = extensions.find((e) => e.id === extId)
    return (ext && ext.stateFile) ? ext.stateFile : path.join(root, extId, 'state.json')
  }

  function readState(extId) {
    return readJson(statePath(extId), {})
  }

  // 合并写而不是整份覆盖：外部文件（Chrome 那边也在写）里有 version / updatedAt 这些字段，
  // 整份覆盖会把它们弄丢，Chrome 扩展一读就当成坏数据。
  function writeState(extId, value) {
    const file = statePath(extId)
    const prev = readJson(file, {})
    const next = Object.assign({}, prev, value || {})
    if (Object.prototype.hasOwnProperty.call(next, 'updatedAt')) next.updatedAt = new Date().toISOString()
    const tmp = file + '.tmp'
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, file)
  }

  // 常驻脚本专用的写入口：只能改自己 rules.json 的 rules 数组，不能碰别人的文件、不能改别的字段。
  // 为什么要给它这个能力：广告规则表必须能自动更新（订阅），否则得人肉贴几万行。
  function writeRules(extId, lines) {
    const ext = extensions.find((e) => e.id === extId)
    if (!ext || !ext.rulesFile) return false
    const file = path.join(ext.dir, ext.rulesFile)
    const data = readJson(file, {}) || {}
    const clean = (Array.isArray(lines) ? lines : [])
      .map((l) => String(l || '').trim())
      .filter((l) => l && !l.startsWith('!') && !l.startsWith('[') && l.length < 2000)
      .slice(0, MAX_RULES_PER_EXT)
    data.rules = clean
    data.updatedAt = new Date().toISOString()
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
    note('info', 'ext-rules', '规则表已更新', { ext: extId, count: clean.length })
    return true
  }

  // ── 常驻脚本：每个扩展一个 vm 上下文 ─────────────────────────────────────
  // 只给定时器 / fetch / 存储 / 事件 / 写自己的规则表；没有 require、没有 process、没有 fs。
  function stopContext(extId) {
    const set = timers.get(extId)
    if (set) { for (const t of set) { clearTimeout(t); clearInterval(t) } timers.delete(extId) }
    contexts.delete(extId)
  }

  function startContext(ext) {
    stopContext(ext.id)
    if (!ext.backgroundFile) return
    const file = path.join(ext.dir, ext.backgroundFile)
    let code
    try { code = fs.readFileSync(file, 'utf8') } catch { return }
    const localTimers = new Set()
    timers.set(ext.id, localTimers)
    const listeners = new Map()
    const emitLocal = (name, payload) => {
      for (const fn of (listeners.get(name) || [])) {
        try { fn(payload) } catch (e) { note('warn', 'ext-bg', '常驻脚本回调抛错', { ext: ext.id, event: name, error: String((e && e.message) || e) }) }
      }
    }
    const sandbox = {
      console: {
        log: (...a) => note('info', 'ext-bg', a.map(String).join(' '), { ext: ext.id }),
        error: (...a) => note('warn', 'ext-bg', a.map(String).join(' '), { ext: ext.id }),
      },
      on: (name, fn) => { if (typeof fn === 'function') { const arr = listeners.get(name) || []; arr.push(fn); listeners.set(name, arr) } },
      state: {
        get: () => readState(ext.id),
        set: (v) => { try { writeState(ext.id, v) } catch { /* 忽略 */ } },
        patch: (v) => { const next = Object.assign(readState(ext.id), v || {}); try { writeState(ext.id, next) } catch { /* 忽略 */ } return next },
      },
      writeRules: (lines) => { try { return writeRules(ext.id, lines) } catch (e) { note('warn', 'ext-bg', '规则写入失败', { ext: ext.id, error: String((e && e.message) || e) }); return false } },
      // 只允许 http/https：常驻脚本不需要 file:// 那些
      fetch: async (url, init) => {
        const u = String(url || '')
        if (!/^https?:\/\//i.test(u)) throw new Error('只允许 http/https')
        return fetch(u, init)
      },
      setTimeout: (fn, ms, ...args) => { const t = setTimeout(() => { localTimers.delete(t); try { fn(...args) } catch { /* 忽略 */ } }, ms); localTimers.add(t); return t },
      setInterval: (fn, ms, ...args) => { const t = setInterval(() => { try { fn(...args) } catch { /* 忽略 */ } }, ms); localTimers.add(t); return t },
      clearTimeout: (t) => { clearTimeout(t); localTimers.delete(t) },
      clearInterval: (t) => { clearInterval(t); localTimers.delete(t) },
      pages: () => (typeof o.pages === 'function' ? o.pages() : []),
      notify: (msg) => note('info', 'ext-bg', String(msg), { ext: ext.id }),
    }
    sandbox.globalThis = sandbox
    try {
      const ctx = vm.createContext(sandbox, { name: 'ext:' + ext.id })
      vm.runInContext(code, ctx, { filename: `ext:${ext.id}/${ext.backgroundFile}`, timeout: 5000 })
      contexts.set(ext.id, { ctx, emit: emitLocal })
    } catch (e) {
      note('warn', 'ext-bg', '常驻脚本加载失败', { ext: ext.id, error: String((e && e.message) || e) })
      stopContext(ext.id)
    }
  }

  function emitEvent(name, payload) {
    for (const entry of contexts.values()) {
      try { entry.emit(name, payload) } catch { /* 单个扩展坏了不影响其它 */ }
    }
  }

  function reload(reason) {
    const started = Date.now()
    try {
      const next = loadExtensions(note)
      extensions = next
      for (const ext of extensions) startContext(ext)
      for (const extId of Array.from(contexts.keys())) {
        if (!extensions.some((e) => e.id === extId)) stopContext(extId)
      }
      note('info', 'ext-reload', '扩展已重载', {
        reason: String(reason || 'manual'),
        count: extensions.length,
        rules: extensions.reduce((n, e) => n + e.ruleTotal, 0),
        home: process.env.DSH_HOME || null,
        ms: Date.now() - started,
      })
    } catch (e) {
      // 一个坏扩展不能把整套拖垮：保留上一次的清单继续跑
      note('warn', 'ext-reload', '加载失败，保留上一次的扩展', { reason: String(reason || 'manual'), error: String((e && e.message) || e) })
    }
    return { ok: true, count: extensions.length, extensions: extensions.map(publicExt) }
  }

  function publicExt(ext) {
    const s = stats.get(ext.id) || { blocked: 0, injected: 0, lastAt: 0 }
    return {
      id: ext.id, name: ext.name, description: ext.description, enabled: ext.enabled,
      matches: ext.matches, hasBackground: !!ext.backgroundFile, hasSettings: !!ext.settings,
      ruleCount: ext.ruleTotal, subscriptions: ext.subscriptions.length,
      blocked: s.blocked, injected: s.injected, lastAt: s.lastAt,
    }
  }

  function list() {
    return extensions.map(publicExt)
  }

  // 目录监听：任何扩展文件一变就重载。Windows 的 fs.watch 支持 recursive。
  // 去抖 400ms —— 一次保存会连着报好几条事件。
  function watch() {
    try { fs.mkdirSync(root, { recursive: true }) } catch { /* 家目录不可写时下面会报 */ }
    try {
      watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        // state.json 是扩展自己存的数据、不是配置：它一变就重载，会让"写状态"自己触发"重载"
        if (filename && /(^|[\\/])state\.json$/.test(String(filename))) return
        if (reloadTimer) clearTimeout(reloadTimer)
        reloadTimer = setTimeout(() => {
          reloadTimer = null
          // 这里是定时器回调，抛出去就是主进程未捕获异常（Electron 会弹一个什么都不说的红叉框）
          try { reload('fs-change') } catch (e) {
            note('warn', 'ext-reload', '热重载失败', { error: String((e && e.message) || e) })
          }
        }, 400)
      })
    } catch (e) {
      note('warn', 'ext-watch', '扩展目录监听挂不上，改完需手动重载', { root, error: String((e && e.message) || e) })
    }
  }

  function dispose() {
    if (reloadTimer) clearTimeout(reloadTimer)
    try { if (watcher) watcher.close() } catch { /* 忽略 */ }
    for (const extId of Array.from(contexts.keys())) stopContext(extId)
  }

  reload('startup')
  watch()

  return {
    root, list, reload, matchRequest, scriptsFor, activeExtFor,
    readState, writeState, emitEvent, dispose,
    paths: () => ({ root }),
  }
}

module.exports = { createExtRuntime, extensionsRoot, compileRule, urlMatches, EXT_DIR_NAME }
