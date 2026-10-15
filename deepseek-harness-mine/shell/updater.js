'use strict'
// AnzioAgent 内置更新器（壳里的"检测到新版本 → 下载安装"）
//
// 模型：安装目录是固定路径（默认 D:\000AnzioAgent），目录里放一个 version.json 记录
// **已安装版本**；更新源（feed）是一个目录或 HTTP 地址，里面 latest.json 描述最新版本
// 与文件清单。更新包按"逐文件 sha256"下发，比上一版变化的文件才进包（publish 脚本负责算）。
//
// 落盘策略（Windows 上运行中的 exe/asar 不能覆盖）：
//   1) 下载/校验 → 拷进 <install>\_staging\v<ver>\
//   2) 写 apply.json，然后拉起一个**脱离父进程**的 PowerShell 小脚本
//   3) 小脚本等本进程退出 → 按 apply.json 覆盖文件/删文件/更新 version.json → 重新启动 exe
//   所以"立即安装"的语义是"下载完 → 重启并安装"（跟普通 PC 软件一样）。
//
// 2026-09-16 新增（用户要求：固定安装位置 + 内置更新程序）

const { app } = require('electron')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

const FEED_DEFAULT = 'D:\\000AnzioAgent\\_updates'

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
}
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(file)
    s.on('error', reject)
    s.on('data', (b) => h.update(b))
    s.on('end', () => resolve(h.digest('hex')))
  })
}
// 语义化版本比较：返回 a>b ? 1 : (a<b ? -1 : 0)
function compareVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

class Updater {
  constructor(opts) {
    this.installDir = opts.installDir
    this.homeDir = opts.homeDir
    this.exePath = opts.exePath
    this.configFile = path.join(this.installDir, 'updater.json')
    this.versionFile = path.join(this.installDir, 'version.json')
    this.onState = opts.onState || (() => {})
    this.state = {
      phase: 'idle',            // idle | checking | available | downloading | ready | error
      installed: this.installedVersion(),
      latest: null,             // { version, notes, builtAt, files, totalBytes }
      error: null,
      progress: 0,              // 0..1（下载/校验进度）
      checkedAt: 0,
    }
    this._installing = false
  }

  installedVersion() {
    const v = readJson(this.versionFile, null)
    if (v && v.version) return String(v.version)
    return String(app.getVersion() || '0.0.0')
  }

  config() {
    const c = readJson(this.configFile, {})
    return {
      feed: c.feed || FEED_DEFAULT,
      autoCheck: c.autoCheck !== false,
      checkIntervalMs: c.checkIntervalMs || 30 * 60 * 1000,
      source: c.source || 'local',      // local=目录；http=以后接自建注册表
      // 启动时自动更新（2026-09-20 用户要求："像常见软件一样，先更新再打开软件"）：
      // 启动 → 检查 → 有新版就下载校验 → 自重启安装 → 再自重启 → 新版本打开。
      // 关掉它的办法：这里设 autoApply: false，或启动参数 --no-update / 环境变量 ANZIO_NO_UPDATE=1。
      autoApply: c.autoApply !== false,
      // 自动更新阶段的兜底时限：超时就不装了、**照常启动**（包已下好，标题栏仍可手动装）
      autoApplyTimeoutMs: c.autoApplyTimeoutMs || 120000,
    }
  }

  setState(patch) {
    Object.assign(this.state, patch)
    try { this.onState(this.state) } catch { /* 通知失败不影响流程 */ }
  }

  // ── 读更新源（本地目录 / 以后可扩 HTTP）──
  async readLatest() {
    const cfg = this.config()
    if (cfg.source === 'local') {
      const file = path.join(cfg.feed, 'latest.json')
      const doc = readJson(file, null)
      if (!doc || !doc.version) throw new Error('更新源里没有 latest.json（' + file + '）')
      doc._base = path.join(cfg.feed, 'v' + doc.version)
      return doc
    }
    const url = cfg.feed.replace(/\/$/, '') + '/latest.json'
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error('更新源请求失败 HTTP ' + res.status)
    const doc = await res.json()
    doc._base = cfg.feed.replace(/\/$/, '') + '/v' + doc.version
    doc._http = true
    return doc
  }

  // 把更新源里的一个文件取到本地（本地源=拷贝，HTTP 源=下载）
  async fetchFile(doc, rel, destFile) {
    await fsp.mkdir(path.dirname(destFile), { recursive: true })
    if (doc._http) {
      const res = await fetch(doc._base + '/' + rel.split('\\').join('/'))
      if (!res.ok) throw new Error('下载失败 HTTP ' + res.status + ' :: ' + rel)
      const buf = Buffer.from(await res.arrayBuffer())
      await fsp.writeFile(destFile, buf)
      return
    }
    await fsp.copyFile(path.join(doc._base, rel), destFile)
  }

  async check() {
    this.setState({ phase: 'checking', error: null, checkedAt: Date.now() })
    try {
      const doc = await this.readLatest()
      const installed = this.installedVersion()
      const available = compareVersion(doc.version, installed) > 0
      this.setState({
        phase: available ? 'available' : 'idle',
        installed,
        latest: {
          version: String(doc.version),
          notes: String(doc.notes || ''),
          builtAt: doc.builtAt || null,
          totalBytes: doc.totalBytes || 0,
          fileCount: Array.isArray(doc.files) ? doc.files.length : 0,
        },
        error: null,
      })
      return { ok: true, available, installed, latest: this.state.latest }
    } catch (e) {
      this.setState({ phase: 'error', error: String((e && e.message) || e) })
      return { ok: false, available: false, installed: this.installedVersion(), error: this.state.error }
    }
  }

  expandDest(dest) {
    return String(dest)
      .split('${INSTALL}').join(this.installDir)
      .split('${HOME}').join(this.homeDir)
  }

  // ── 下载 + 校验 + 落地（不改动现有安装，只写 staging）──
  async install() {
    if (this._installing) return { ok: false, error: '正在安装中' }
    this._installing = true
    try {
      this.setState({ phase: 'downloading', progress: 0, error: null })
      const doc = await this.readLatest()
      if (compareVersion(doc.version, this.installedVersion()) <= 0) {
        this.setState({ phase: 'idle', progress: 0 })
        return { ok: true, upToDate: true, version: doc.version }
      }
      const version = String(doc.version)
      const staging = path.join(this.installDir, '_staging', 'v' + version)
      await fsp.rm(staging, { recursive: true, force: true })
      await fsp.mkdir(staging, { recursive: true })

      const files = Array.isArray(doc.files) ? doc.files : []
      let done = 0
      const planFiles = []
      for (const f of files) {
        if (!f || !f.src || !f.dest) continue
        const destFile = path.join(staging, f.src)
        await this.fetchFile(doc, f.src, destFile)
        if (f.sha256) {
          const got = await sha256File(destFile)
          if (got !== f.sha256) throw new Error('校验失败（sha256 不一致）:: ' + f.src)
        }
        planFiles.push({ src: f.src, dest: this.expandDest(f.dest), sha256: f.sha256 || null, size: f.size || 0 })
        done += 1
        this.setState({ progress: files.length ? done / files.length : 1 })
      }

      const plan = {
        version,
        staging,
        exe: this.exePath,
        files: planFiles,
        deletions: (Array.isArray(doc.deletions) ? doc.deletions : []).map((d) => this.expandDest(d)),
        versionSource: path.join(staging, 'install-version.json'),
        versionTarget: this.versionFile,
      }
      writeJson(plan.versionSource, {
        version,
        installedAt: new Date().toISOString(),
        previous: this.installedVersion(),
        notes: doc.notes || '',
      })
      writeJson(path.join(staging, 'apply.json'), plan)
      // 落地即写 pending 标记：这样"直接关掉再打开"也会在下次启动时自动装上（不用非得点重启）
      writeJson(this.pendingFile(), { staging, version, at: new Date().toISOString() })
      this.setState({ phase: 'ready', progress: 1, latest: Object.assign({}, this.state.latest, { version }) })
      return { ok: true, version, staged: staging, files: planFiles.length, deletions: plan.deletions.length }
    } catch (e) {
      this.setState({ phase: 'error', error: String((e && e.message) || e) })
      return { ok: false, error: this.state.error }
    } finally {
      this._installing = false
    }
  }

  pendingFile() {
    return path.join(this.installDir, '_staging', 'pending.json')
  }

  // ── 退出后由"下一次启动的自己"应用（不依赖外部助手进程）──
  // Windows 上运行中的 exe/文件可能被占用，所以真正的替换放在下一次启动的最开头：
  // 那时没有旧实例在跑，谁都不锁文件。装完再自重启一次，第二次启动才是新代码。
  // 2026-09-16：最初用 detached powershell 助手，实测从 Electron 里 spawn 出来的助手
  // 根本没执行（静默丢），改为这套自应用机制。
  applyAndRestart() {
    if (!fs.existsSync(this.pendingFile())) {
      this.setState({ phase: 'error', error: '还没有下载好的更新包' })
      return { ok: false, error: '还没有下载好的更新包' }
    }
    console.log('[anzio] apply pending update on restart, version=' + String(this.state.latest && this.state.latest.version))
    setTimeout(() => {
      // 带上原本的命令行参数重启（例如 --remote-debugging-port，调试/自动化要用）
      try { app.relaunch({ args: process.argv.slice(1) }) } catch { /* 忽略 */ }
      try { app.quit() } catch { process.exit(0) }
    }, 300)
    return { ok: true, restarting: true }
  }

  // ── "稍后"记忆：同一个版本不再每次启动都弹窗（标题栏徽标仍然提示）──
  stateFile() { return path.join(this.installDir, 'updater-state.json') }
  skippedVersion() { const s = readJson(this.stateFile(), {}); return s && s.skippedVersion ? String(s.skippedVersion) : '' }
  skipVersion(version) {
    if (!version) return
    const s = readJson(this.stateFile(), {}) || {}
    s.skippedVersion = String(version)
    s.skippedAt = new Date().toISOString()
    writeJson(this.stateFile(), s)
  }

  // ── 自动更新的"失败记忆"（2026-09-20）──
  // 启动自动更新最怕的死循环：某版本下载/校验总是失败 → 每次开机都重来一遍（白等）。
  // 记下失败版本与时间，6 小时内不再自动重试（手动检查更新不受影响）。
  FAIL_RETRY_MS = 6 * 60 * 60 * 1000
  failedRecently(version) {
    if (!version) return false
    const s = readJson(this.stateFile(), {}) || {}
    if (String(s.failedVersion || '') !== String(version)) return false
    const at = Date.parse(s.failedAt || '')
    if (!at) return false
    return Date.now() - at < this.FAIL_RETRY_MS
  }
  markFailed(version, error) {
    if (!version) return
    const s = readJson(this.stateFile(), {}) || {}
    s.failedVersion = String(version)
    s.failedAt = new Date().toISOString()
    s.failedError = String(error || '').slice(0, 500)
    writeJson(this.stateFile(), s)
  }
  clearFailed() {
    const s = readJson(this.stateFile(), {}) || {}
    if (!s.failedVersion) return
    delete s.failedVersion
    delete s.failedAt
    delete s.failedError
    writeJson(this.stateFile(), s)
  }

  /**
   * 启动时调用：有待安装的更新就先替换文件（此时没有任何实例占用），
   * 然后自重启一次让新代码接管。返回 true 表示"已接管流程，调用方应立即退出"。
   */
  applyPending() {
    const marker = this.pendingFile()
    const pending = readJson(marker, null)
    if (!pending || !pending.staging) return { applied: false }
    const plan = readJson(path.join(pending.staging, 'apply.json'), null)
    if (!plan) {
      try { fs.rmSync(marker, { force: true }) } catch { /* 忽略 */ }
      return { applied: false, error: 'apply.json 缺失' }
    }
    const failures = []
    for (const f of plan.files || []) {
      try {
        const src = path.join(pending.staging, f.src)
        fs.mkdirSync(path.dirname(f.dest), { recursive: true })
        fs.copyFileSync(src, f.dest)
      } catch (e) {
        failures.push(f.dest + ' :: ' + String((e && e.message) || e))
      }
    }
    for (const d of plan.deletions || []) {
      try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 删除失败不致命 */ }
    }
    if (failures.length === 0) {
      // 版本记录 + **文件基线合并**：manifest 里的 src 就是基线键（publish 用的同一套键），
      // 把这次写进去的文件算一遍 sha256 记上，下次发布才能算出增量（别把基线丢了，
      // 丢了会导致以后每次发布都全量重发 —— 2026-09-16 空包测试踩到）
      const prev = readJson(this.versionFile, {}) || {}
      const merged = {
        version: pending.version,
        installedAt: new Date().toISOString(),
        previous: prev.version || null,
        source: 'updater',
        notes: (plan && plan.notes) || '',
        files: Object.assign({}, prev.files || {}),
      }
      for (const f of plan.files || []) {
        try {
          merged.files[f.src] = crypto.createHash('sha256').update(fs.readFileSync(f.dest)).digest('hex')
        } catch { /* 单个文件算不出哈希不影响版本记录 */ }
      }
      for (const d of plan.deletions || []) {
        // 删除项在 manifest 里是展开后的绝对路径，反推回键不划算 → 清掉任何指向已不存在文件的键
        for (const k of Object.keys(merged.files)) {
          if (String(d).indexOf(k.split('/').pop()) >= 0) delete merged.files[k]
        }
      }
      try { writeJson(this.versionFile, merged) } catch (e) {
        failures.push('version.json :: ' + String((e && e.message) || e))
      }
    }
    if (failures.length === 0) {
      try { fs.rmSync(pending.staging, { recursive: true, force: true }) } catch { /* 忽略 */ }
      this.clearFailed()   // 装成功了就把"失败记忆"清掉（下次有新版本照常自动更新）
    }
    try { fs.rmSync(marker, { force: true }) } catch { /* 忽略 */ }
    return { applied: failures.length === 0, version: pending.version, failures, relaunch: true }
  }
}

module.exports = { Updater, compareVersion, FEED_DEFAULT }
