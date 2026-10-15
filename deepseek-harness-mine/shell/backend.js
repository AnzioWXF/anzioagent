'use strict'

// DSH IDE 应用后端管理器：DSH IDE 是一个独立的 DSH 实例（默认端口 3081），
// 与 Web 开发台（3080）完全隔离：
//   - 独立数据目录 DSH_HOME（默认 D:\99DSH\app-home）：会话、存储、设置各自独立
//   - 配置目录与开发台共享（profiles\web 为 junction 链接）：开发台的改进即时进应用
// 职责：初始化独立 home → 探测端口 → 按需启动后端 → 轮询就绪 → 退出时树杀。
// 独立于 Electron（只依赖 node 内置模块），可单独测试。

const { spawn, execFileSync } = require('child_process')
const net = require('net')
const fs = require('fs')
const path = require('path')

const DEFAULT_URL = 'http://127.0.0.1:3081'
const DEFAULT_HOME = 'D:\\99DSH\\app-home'
const DEFAULT_PROFILE_SOURCE = 'D:\\99DSH\\dev-home\\profiles\\web'

function probePort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseUrl(url) {
  try {
    const u = new URL(url)
    return { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) }
  } catch {
    return { host: '127.0.0.1', port: 3081 }
  }
}

/** 组装启动命令：确保携带 --port（命令已显式带则不重复）。 */
function buildLaunchCommand(command, port) {
  const trimmed = command.trim()
  if (!/\s--port\b/.test(trimmed) && !trimmed.endsWith('--port')) {
    return `${trimmed} --port ${port}`
  }
  return trimmed
}

/**
 * 初始化独立实例的数据目录：profiles\web 与开发台共享（junction），
 * settings.yaml 首次复制。其余（sessions/storages）由 DSH 首次启动创建。
 */
function ensureIdeHome(homeDir, profileSource) {
  try {
    if (!fs.existsSync(homeDir)) fs.mkdirSync(homeDir, { recursive: true })
    const profilesDir = path.join(homeDir, 'profiles')
    const webLink = path.join(profilesDir, 'web')
    if (!fs.existsSync(webLink)) {
      fs.mkdirSync(profilesDir, { recursive: true })
      try {
        execFileSync('cmd', ['/c', 'mklink', '/J', webLink, profileSource], { stdio: 'ignore' })
      } catch {
        // junction 失败（权限等）：退化为完整复制
        fs.cpSync(profileSource, webLink, { recursive: true, errorOnExist: true })
      }
    }
    const settings = path.join(homeDir, 'settings.yaml')
    if (!fs.existsSync(settings) && fs.existsSync(path.join(profileSource, '..', '..', 'settings.yaml'))) {
      fs.copyFileSync(path.join(profileSource, '..', '..', 'settings.yaml'), settings)
    }
    return true
  } catch (e) {
    console.error(`[dsh-ide] home init failed: ${(e && e.message) || e}`)
    return false
  }
}

class BackendManager {
  constructor(options = {}) {
    this.url = options.url || DEFAULT_URL
    this.dir = options.dir || ''
    // 默认 tsdown 构建产物（冷启动 ~2s；tsx 源码模式冷启动 ~38s，见 main.js）
    this.command = options.command || 'node apps/cli/lib/bin.js web'
    this.dshHome = options.dshHome || DEFAULT_HOME
    this.profileSource = options.profileSource || DEFAULT_PROFILE_SOURCE
    this.logFile = options.logFile || null
    this.timeoutMs = options.timeoutMs || 60000
    this.proc = null
    this.owned = false
    // 主动停止（退出应用 / 重启后端）与"掉线"必须分开：前者不该触发自动拉起，
    // 否则关软件时会把后端又拉回来（2026-10-14 加后端掉线自动拉起时一起加的开关）。
    this.stopping = false
    this.logStream = null
    this.onExit = options.onExit || null
    this.readyUrl = null   // 后端 stdout 报出的就绪 URL（带认证 token）
    // 天工壳桥（内置浏览器的驱动层）：把地址与口令交给**我们自己起的**后端，
    // 让跑在后端里的 Agent 工具能指挥壳里的浏览器（见 bridge.js）
    this.bridge = options.bridge || null
  }

  /** 确保后端可用：端口已有服务则直连；否则启动子进程并等待就绪。 */
  async ensure() {
    const { host, port } = parseUrl(this.url)
    if (await probePort(host, port, 1200)) {
      this.owned = false
      return { started: false, reason: null }
    }

    // 独立数据目录（共享配置）
    ensureIdeHome(this.dshHome, this.profileSource)

    // 启动命令：确保携带 --port（从 url 解析；命令已显式带 --port 则不重复）
    const command = buildLaunchCommand(this.command, port)
    const parts = command.split(/\s+/)
    const cmd = parts[0]
    const args = parts.slice(1)

    if (this.logFile) {
      try {
        this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' })
      } catch {
        this.logStream = null
      }
    }

    const env = { ...process.env }
    // 剔除所有继承来的 DSH_* 会话/环境变量（从开发台终端启动时，DSH_HOME 等会
    // 把应用后端指到开发台的 home/profile 上：表现为"打开是标准 Web 界面、
    // dsh-ide 不挂载"）。应用自己只认下面的 DSH_HOME。
    for (const k of Object.keys(env)) { if (k.startsWith('DSH_')) delete env[k] }
    if (this.dshHome) env.DSH_HOME = this.dshHome
    // 遥测硬关：官方 launcher 就是靠这个变量给 session-telemetry-otel 行打禁用补丁（apps/cli/lib
    // profile-boot → boot/app-boot 的 resolveTelemetryPatch，**非空即关**）。不设它，官方那行按
    // FEEDBACK_ONLY 默认生效，而消息行的 👍/👎 就在界面上 —— 用户点一下，会话日志前缀就外发到
    // dsh-otel-collector.deepseeksvc.com，与"我们的壳不带遥测"的口径直接相悖。
    env.DSH_TELEMETRY_DISABLED = '1'
    // 壳桥（内置浏览器）：地址与口令只在这一对父子进程之间用环境变量传递 —— 不落盘、不写配置文件
    // （写文件会有"上一次运行留下的过期端口/口令"这种坑）。复用别人的后端时（端口已有服务）走不到这里。
    if (this.bridge && this.bridge.url && this.bridge.token) {
      env.ANZIO_BROWSER_BRIDGE = this.bridge.url
      env.ANZIO_BROWSER_TOKEN = this.bridge.token
    }

    this.proc = spawn(cmd, args, {
      cwd: this.dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.owned = true

    const write = (chunk) => {
      if (this.logStream) {
        try {
          this.logStream.write(chunk)
        } catch { /* ignore */ }
      }
      // 从后端 stdout 抓"就绪 URL"（带 token）：DSH 的 shell 页面需要认证，
      // 带 ?token= 首访会种 cookie 并 303 到 /（2026-09-16 修空白页）。
      // stdout 分片到达 → 用累积缓冲找，别用单块正则（会漏）
      try {
        this.stdoutTail = ((this.stdoutTail || '') + String(chunk)).slice(-8192)
        const m = /dsh web:\s+(http:\/\/\S+)/.exec(this.stdoutTail)
        if (m && m[1]) this.readyUrl = m[1]
      } catch { /* ignore */ }
    }
    this.proc.stdout.on('data', write)
    this.proc.stderr.on('data', (chunk) => write(chunk))
    this.proc.on('exit', (code, signal) => {
      this.proc = null
      const intentional = this.stopping          // 我们自己停的（关软件 / Ctrl+Shift+R）≠ 掉线
      const wasOwned = this.owned                // ⚠ 必须在清 owned **之前**取：拉起那一侧要拿它判断
      this.stopping = false
      this.owned = false
      if (this.onExit) this.onExit(code, signal, intentional, wasOwned)
    })

    const deadline = Date.now() + this.timeoutMs
    while (Date.now() < deadline) {
      if (this.proc === null) return { started: false, reason: 'exited' }
      if (await probePort(host, port, 600)) return { started: true, reason: null }
      await sleep(400)
    }
    return { started: false, reason: 'timeout' }
  }

  /** 停止由本管理器启动的后端进程（Windows 树杀）。 */
  stop() {
    const proc = this.proc
    if (proc && this.owned) {
      this.stopping = true                      // 见 exit 回调：这一停是**有意的**，别触发自动拉起
      try {
        execFileSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' })
      } catch { /* 进程已退出 */ }
      this.proc = null
      this.owned = false
    }
    if (this.logStream) {
      try {
        this.logStream.end()
      } catch { /* ignore */ }
      this.logStream = null
    }
  }

  isOwned() {
    return this.owned
  }
}

module.exports = { BackendManager, probePort, parseUrl, ensureIdeHome, buildLaunchCommand }
