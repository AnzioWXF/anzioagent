// ── SSH 会话层（服务器控制台 / 阶段 0-2）────────────────────────────────
// 只做"一条 SSH 连接上的几件事"：单次命令、SFTP、交互式 shell 通道。
// 不负责持久化配置、不负责回收、不负责界面 —— 那些在 index.js 与 client.js。
//
// 为什么 ssh2 是**单文件**（lib/ssh2.bundle.cjs）而不装 node_modules：
//   publish-update.ps1 明确排除 `\node_modules\`，装目录形式进不了更新包；
//   打成一个 CJS 文件（esbuild --bundle --platform=node）就随插件普通文件一起发。
//   重新打包配方见 reference。

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
let ssh2 = null
let loadError = null
try {
  ssh2 = require('./ssh2.bundle.cjs')
} catch (e) {
  loadError = String((e && e.message) || e)
}

const CONNECT_TIMEOUT = 15000
const EXEC_TIMEOUT = 60000
const TERM_MAX_CHUNKS = 4000
const TERM_MAX_BYTES = 512 * 1024
// 读/写远端文件的上限：超过就不往编辑器里塞（2G 的机器上大文件走下载，别走内存）
const FILE_MAX_BYTES = 4 * 1024 * 1024

const errOf = (e) => String((e && (e.message || e.code)) || e)

const fingerprintOf = (keyBuf) => 'SHA256:' + createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '')

export function sshAvailable() {
  return ssh2 !== null
}

export function sshLoadError() {
  return loadError
}

export function createSshManager({ trace } = {}) {
  const sessions = new Map()   // id -> { conn, sftp, host, port, user, name, status, fingerprint, terms, connectedAt, lastError }
  let termSeq = 0

  const note = (level, kind, msg, meta) => {
    try { if (trace) trace({ level, kind, msg, meta }) } catch { /* 留痕失败不影响连接 */ }
  }

  const get = (id) => sessions.get(String(id)) || null

  // 主机密钥（RAW blob）的前 4 字节是长度、紧跟类型名（ssh-ed25519 / rsa-sha2-512 …）。
  // known_hosts 里存的正是同一个 blob 的 base64 —— 所以可以直接逐字对账，不用另存一份指纹表。
  function parseHostKey(keyBuf) {
    const buf = Buffer.isBuffer(keyBuf) ? keyBuf : Buffer.from(keyBuf || [])
    let type = ''
    try {
      const len = buf.readUInt32BE(0)
      type = buf.slice(4, 4 + len).toString('utf8')
    } catch { /* 畸形密钥：交给上层当"不认识"处理 */ }
    return { type, base64: buf.toString('base64'), fingerprint: fingerprintOf(buf) }
  }

  function connect({ id, host, port = 22, user = 'root', keyPath, password, passphrase, name = '', checkHostKey = null }) {
    return new Promise(async (resolve, reject) => {
      if (!ssh2) return reject(new Error('ssh2-unavailable: ' + (loadError || 'unknown')))
      const sid = String(id || ('s' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)))
      if (sessions.has(sid)) {
        // 断线只把状态改成 closed、不动登记记录（列表要留着显示"已断开"），而界面上的
        // "重新连接"恰好只在断开后才给 —— 不先把残壳摘掉，同一个 id 永远撞 session-exists。
        if (sessions.get(sid).status === 'open') return reject(new Error('session-exists: ' + sid))
        disconnect(sid)
      }

      let privateKey = null
      if (keyPath) {
        try { privateKey = await readFile(keyPath) } catch (e) { return reject(new Error('key-unreadable: ' + errOf(e))) }
      }
      if (!privateKey && !password) return reject(new Error('no-credential: 需要密钥或口令'))

      const conn = new ssh2.Client()
      const rec = {
        id: sid, conn, sftp: null, host, port, user, name,
        status: 'connecting', fingerprint: null, terms: new Map(),
        connectedAt: null, lastError: null,
      }
      let settled = false
      const fail = (e) => {
        rec.status = 'error'
        rec.lastError = errOf(e)
        note('error', 'ssh', 'connect-failed', { id: sid, host, user, error: rec.lastError })
        try { conn.end() } catch { /* 已断 */ }
        if (!settled) { settled = true; reject(e) }
      }

      const timer = setTimeout(() => fail(new Error('connect-timeout')), CONNECT_TIMEOUT)

      conn.on('ready', () => {
        clearTimeout(timer)
        rec.status = 'open'
        rec.connectedAt = Date.now()
        sessions.set(sid, rec)
        note('info', 'ssh', 'connect', { id: sid, host, user, name, ms: CONNECT_TIMEOUT - 0 })
        if (!settled) { settled = true; resolve({ id: sid, host, user, port, fingerprint: rec.fingerprint }) }
      })
      conn.on('error', (e) => {
        // 指纹被拒时 ssh2 只会说"verification failed"，把真正的结论换成语义明确的错误抛给上层
        if (!settled) {
          const v = rec.hostKeyVerdict
          if (v && v.ok !== true) {
            const err = new Error(v.code || 'host-key-rejected')
            err.code = v.code || 'host-key-rejected'
            err.fingerprint = rec.fingerprint || null
            err.hostKeyType = rec.hostKey ? rec.hostKey.type : null
            err.hostKeyBase64 = rec.hostKey ? rec.hostKey.base64 : null
            return fail(err)
          }
          return fail(e)
        }
        rec.lastError = errOf(e)
        note('error', 'ssh', 'conn-error', { id: sid, error: rec.lastError })
      })
      conn.on('close', () => {
        const wasOpen = rec.status === 'open'
        rec.status = 'closed'
        rec.sftp = null
        for (const t of rec.terms.values()) t.exited = true
        if (wasOpen) note('info', 'ssh', 'closed', { id: sid, host, reason: rec.lastError || 'peer-close' })
      })
      conn.on('end', () => { if (rec.status === 'open') note('info', 'ssh', 'ended', { id: sid }) })

      try {
        conn.connect({
          host, port: Number(port) || 22, username: user,
          privateKey: privateKey || undefined,
          password: privateKey ? undefined : password,
          passphrase: passphrase || undefined,
          readyTimeout: CONNECT_TIMEOUT,
          // 保活用协议级心跳，不做界面轮询：NAT/防火墙会静默掐掉空闲连接
          keepaliveInterval: 15000,
          keepaliveCountMax: 4,
          // 主机指纹校验（TOFU）：认不认识这台机器由上层拍板，这里只负责"报上去、按结论放行或拒连"。
          // 拒连时 ssh2 只给一句通用错误，所以结论留在这里，连接失败时换成有意义的错误抛出去。
          hostVerifier: (key) => {
            const info = parseHostKey(key)
            rec.fingerprint = info.fingerprint
            rec.hostKey = info
            let verdict = { ok: true }
            try { verdict = checkHostKey ? (checkHostKey(info) || { ok: true }) : { ok: true } } catch (e) { verdict = { ok: false, code: 'host-key-error', error: errOf(e) } }
            rec.hostKeyVerdict = verdict
            if (verdict.ok !== true) {
              note('warn', 'ssh', 'host-key-rejected', { id: sid, host, code: verdict.code, fingerprint: info.fingerprint })
            }
            return verdict.ok === true
          },
        })
      } catch (e) { clearTimeout(timer); fail(e) }
    })
  }

  function require_(id) {
    const rec = get(id)
    if (!rec) throw new Error('no-session: ' + id)
    if (rec.status !== 'open') throw new Error('session-not-open: ' + rec.status)
    return rec
  }

  const getSftp = (rec) => new Promise((resolve, reject) => {
    if (rec.sftp) return resolve(rec.sftp)
    rec.conn.sftp((err, s) => {
      if (err) return reject(err)
      rec.sftp = s
      s.on('close', () => { rec.sftp = null })
      s.on('error', () => { rec.sftp = null })
      resolve(s)
    })
  })

  // 单次命令（也给 Agent 用）：一次性执行、收全量输出、带超时
  function exec(id, cmd, { timeoutMs = EXEC_TIMEOUT } = {}) {
    return new Promise((resolve, reject) => {
      let rec
      try { rec = require_(id) } catch (e) { return reject(e) }
      const started = Date.now()
      let done = false
      const finish = (out) => { if (!done) { done = true; resolve(out) } }
      rec.conn.exec(String(cmd), (err, stream) => {
        if (err) return reject(err)
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          // 超时不代表命令停了：明确说明"已放弃等待"，不假装它结束
          try { stream.destroy() } catch { /* 已关 */ }
          finish({ code: null, stdout, stderr, ms: Date.now() - started, timeout: true })
        }, timeoutMs)
        stream.on('data', (d) => { stdout += d })
        stream.stderr.on('data', (d) => { stderr += d })
        stream.on('close', (code, signal) => {
          clearTimeout(timer)
          finish({ code: typeof code === 'number' ? code : null, signal: signal || null, stdout, stderr, ms: Date.now() - started, timeout: false })
        })
        stream.on('error', (e) => { clearTimeout(timer); finish({ code: null, stdout, stderr: stderr + errOf(e), ms: Date.now() - started, timeout: false }) })
      })
    })
  }

  async function ls(id, dir) {
    const rec = require_(id)
    const sftp = await getSftp(rec)
    return new Promise((resolve, reject) => {
      sftp.readdir(String(dir || '.'), (err, list) => {
        if (err) return reject(err)
        const entries = (Array.isArray(list) ? list : Object.values(list || {})).map((it) => {
          const a = it.attrs || {}
          return {
            name: it.filename,
            dir: typeof a.isDirectory === 'function' ? a.isDirectory() : false,
            link: typeof a.isSymbolicLink === 'function' ? a.isSymbolicLink() : false,
            size: Number(a.size || 0),
            mtime: Number(a.mtime || 0) * 1000,
            mode: Number(a.mode || 0),
          }
        })
        entries.sort((x, y) => (x.dir === y.dir ? x.name.localeCompare(y.name) : (x.dir ? -1 : 1)))
        resolve({ path: String(dir || '.'), entries })
      })
    })
  }

  async function stat(id, remote) {
    const rec = require_(id)
    const sftp = await getSftp(rec)
    const st = await new Promise((resolve, reject) => sftp.stat(String(remote), (e, s) => e ? reject(e) : resolve(s)))
    return {
      size: Number(st.size || 0),
      mtime: Number(st.mtime || 0) * 1000,
      dir: typeof st.isDirectory === 'function' ? st.isDirectory() : false,
      mode: Number(st.mode || 0),
    }
  }

  async function readText(id, remote) {
    const rec = require_(id)
    const sftp = await getSftp(rec)
    const st = await new Promise((resolve, reject) => sftp.stat(remote, (e, s) => e ? reject(e) : resolve(s)))
    if (Number(st.size) > FILE_MAX_BYTES) throw new Error('file-too-large: ' + st.size)
    const buf = await new Promise((resolve, reject) => sftp.readFile(remote, (e, b) => e ? reject(e) : resolve(b)))
    return { buf, size: Number(st.size), mtime: Number(st.mtime || 0) * 1000 }
  }

  async function writeText(id, remote, content) {
    const rec = require_(id)
    const sftp = await getSftp(rec)
    await new Promise((resolve, reject) => sftp.writeFile(remote, content, (e) => e ? reject(e) : resolve()))
    return { ok: true }
  }

  async function upload(id, local, remote) {
    const rec = require_(id)
    const sftp = await getSftp(rec)
    const started = Date.now()
    await new Promise((resolve, reject) => sftp.fastPut(local, remote, (e) => e ? reject(e) : resolve()))
    note('info', 'ssh', 'put', { id: rec.id, remote, ms: Date.now() - started })
    return { ok: true, ms: Date.now() - started }
  }

  async function download(id, remote, local) {
    const rec = require_(id)
    const sftp = await getSftp(rec)
    const started = Date.now()
    await new Promise((resolve, reject) => sftp.fastGet(remote, local, (e) => e ? reject(e) : resolve()))
    note('info', 'ssh', 'get', { id: rec.id, remote, ms: Date.now() - started })
    return { ok: true, ms: Date.now() - started }
  }

  // 整目录下载：先走一遍远端树再逐个落盘。**不并发**（那台 2核2G 经不起一次开几十个请求），
  // 符号链接一律跳过（跟下去可能成环），文件数与深度都有上限，超了就回报"只下了一部分"。
  async function downloadDir(id, remote, local, { maxFiles = 2000, maxDepth = 12 } = {}) {
    const rec = require_(id)
    const sftp = await getSftp(rec)
    const listDir = (dir) => new Promise((resolve, reject) => {
      sftp.readdir(dir, (e, list) => e ? reject(e) : resolve(list || []))
    })
    let files = 0
    let bytes = 0
    let skipped = 0
    let truncated = false
    const walk = async (rdir, ldir, depth) => {
      if (depth > maxDepth) { truncated = true; return }
      await mkdir(ldir, { recursive: true })
      const items = await listDir(rdir)
      for (const it of items) {
        const name = it.filename
        if (!name || name === '.' || name === '..') continue
        const rpath = rdir.replace(/\/+$/, '') + '/' + name
        const lpath = path.join(ldir, name)
        const isDir = typeof it.attrs.isDirectory === 'function' ? it.attrs.isDirectory() : false
        const isLink = typeof it.attrs.isSymbolicLink === 'function' ? it.attrs.isSymbolicLink() : false
        if (isLink) { skipped += 1; continue }
        if (isDir) { await walk(rpath, lpath, depth + 1); continue }
        if (files >= maxFiles) { truncated = true; return }
        await new Promise((res, rej) => sftp.fastGet(rpath, lpath, (e) => e ? rej(e) : res()))
        files += 1
        bytes += Number(it.attrs.size || 0)
      }
    }
    await walk(String(remote), String(local), 0)
    return { files, bytes, skipped, truncated }
  }

  // 逐级建目录：SFTP 的 mkdir 不支持 recursive（早先那次 {recursive:true} 是无效参数，
  // 建两层以上会直接 No such file），所以这里自己按段往下建，已存在的当成功。
  async function mkdirp(id, dir) {
    const rec = require_(id)
    const sftp = await getSftp(rec)
    const target = String(dir || '').replace(/\/+$/, '')
    if (!target || target === '/') return { ok: true }
    const segs = target.split('/').filter(Boolean)
    let cur = target.startsWith('/') ? '' : '.'
    for (const seg of segs) {
      cur = cur + '/' + seg
      await new Promise((resolve, reject) => {
        sftp.mkdir(cur, (e) => {
          if (!e) return resolve()
          sftp.stat(cur, (e2, st) => {
            if (!e2 && st && (typeof st.isDirectory !== 'function' || st.isDirectory())) return resolve()
            reject(e)
          })
        })
      })
    }
    return { ok: true }
  }

  async function remove(id, remote, isDir) {
    const rec = require_(id)
    const sftp = await getSftp(rec)
    const fn = isDir ? 'rmdir' : 'unlink'
    await new Promise((resolve, reject) => sftp[fn](remote, (e) => e ? reject(e) : resolve()))
    note('info', 'ssh', 'remove', { id: rec.id, remote, dir: !!isDir })
    return { ok: true }
  }

  async function rename(id, from, to) {
    const rec = require_(id)
    const sftp = await getSftp(rec)
    await new Promise((resolve, reject) => sftp.rename(from, to, (e) => e ? reject(e) : resolve()))
    note('info', 'ssh', 'rename', { id: rec.id, from, to })
    return { ok: true }
  }

  // ── 交互式 shell 通道（中栏的服务器终端）──────────────────────────────
  // 与本地终端同形：按块缓冲、seq 递增、超限丢最老并给 reset 标识。
  function openTerm(id, { cols = 100, rows = 30, onData = null, owner = 'user', title = '' } = {}) {
    return new Promise((resolve, reject) => {
      let rec
      try { rec = require_(id) } catch (e) { return reject(e) }
      rec.conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) return reject(err)
        termSeq += 1
        const t = {
          id: 't' + termSeq, sid: rec.id, stream,
          cols, rows, seq: 0, bytes: 0, chunks: [], droppedUntil: 0,
          exited: false, exitCode: null, startedAt: Date.now(), lastRead: Date.now(),
          tail: '', buf: '',
          // 谁开的这条终端：user = 界面按钮开的，agent = 工具自己开的（标签上要区分）
          owner: owner === 'agent' ? 'agent' : 'user',
          title: String(title || ''),
          busy: false,
          // 最近一次被 Agent 用来执行命令的时刻：界面靠它把画面自动切过去
          // （busy 只在一两百毫秒内为真，轮询抓不住，时间戳才抓得住）
          lastRunAt: 0,
        }
        stream.on('data', (d) => {
          const s = d.toString('utf8')
          t.seq += 1
          t.chunks.push({ seq: t.seq, data: s })
          t.bytes += s.length
          while (t.chunks.length > TERM_MAX_CHUNKS || t.bytes > TERM_MAX_BYTES) {
            const dropped = t.chunks.shift()
            if (!dropped) break
            t.bytes -= dropped.data.length
            t.droppedUntil = dropped.seq
          }
          if (onData) { try { onData(t, s) } catch { /* 跟踪失败不影响终端 */ } }
        })
        stream.stderr.on('data', (d) => {
          t.seq += 1
          t.chunks.push({ seq: t.seq, data: d.toString('utf8') })
        })
        stream.on('close', (code) => {
          t.exited = true
          t.exitCode = typeof code === 'number' ? code : null
          note('info', 'ssh', 'term-exit', { id: t.id, sid: rec.id, code: t.exitCode })
        })
        rec.terms.set(t.id, t)
        note('info', 'ssh', 'term-open', { id: t.id, sid: rec.id, cols, rows, owner: t.owner })
        resolve({ id: t.id, sid: rec.id, cols, rows, owner: t.owner, title: t.title })
      })
    })
  }

  function termOf(sid, tid) {
    const rec = get(sid)
    if (!rec) return null
    return rec.terms.get(String(tid)) || null
  }

  function readTerm(sid, tid, since = 0) {
    const t = termOf(sid, tid)
    if (!t) return null
    t.lastRead = Date.now()
    return {
      id: t.id, exited: t.exited, exitCode: t.exitCode,
      reset: since > 0 && since < t.droppedUntil,
      seq: t.seq,
      data: t.chunks.filter((c) => c.seq > since).map((c) => c.data).join(''),
    }
  }

  function inputTerm(sid, tid, data) {
    const t = termOf(sid, tid)
    if (!t || t.exited) return { ok: true, exited: true }
    t.stream.write(String(data))
    t.lastRead = Date.now()
    return { ok: true }
  }

  function resizeTerm(sid, tid, cols, rows) {
    const t = termOf(sid, tid)
    if (!t) return { ok: false }
    t.cols = Math.max(20, Math.min(400, cols | 0 || t.cols))
    t.rows = Math.max(5, Math.min(200, rows | 0 || t.rows))
    try { t.stream.setWindow(t.rows, t.cols, 0, 0) } catch { /* 会话刚断 */ }
    return { ok: true, cols: t.cols, rows: t.rows }
  }

  function closeTerm(sid, tid, reason = 'client') {
    const rec = get(sid)
    const t = rec && rec.terms.get(String(tid))
    if (!t) return { ok: false }
    try { t.stream.end() } catch { /* 已结束 */ }
    rec.terms.delete(String(tid))
    note('info', 'ssh', 'term-close', { id: t.id, sid, reason })
    return { ok: true }
  }

  // ── 让 Agent 在真终端里干活（2026-10-21）────────────────────────────────
  // 为什么不再单用 exec：exec 是另一条通道，界面上看不见 Agent 敲了什么都看不到；
  // 写进真终端才是"你看到的就是真实回显"。代价是要自己判一条命令什么时候结束，
  // 现成的 PTY 没有命令边界（没有 shell 集成），所以写入时补一行哨兵读 `$?`。
  const quoteSh = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"

  const stripAnsi = (s) => String(s)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[=>]/g, '')

  // 终端是画布：提示符、进度条都靠 `\r` 回行首重画来"覆盖"，屏幕上只看得见一份。
  // 直接删掉 `\r` 等于把覆盖变成并排 —— 同一行提示符会并出两份（2026-10-21 实测：
  // `root@host:~# root@host:~# echo ...`）。所以按终端语义行内覆盖：后写的段压在
  // 前面的内容上，超出前段长度的尾巴保留。
  function applyCr(text) {
    if (text.indexOf('\r') < 0) return text
    const out = []
    for (const line of text.split('\n')) {
      let cur = ''
      for (const seg of line.split('\r')) cur = seg + cur.slice(seg.length)
      out.push(cur)
    }
    return out.join('\n')
  }

  /** Terminal bytes → the plain text a person would see on screen. */
  function plainTermText(raw) {
    return applyCr(stripAnsi(raw).replace(/\r\n/g, '\n'))
  }

  // 终端里读到的是"给人看的画面"：命令回显、ANSI、\r 覆盖都混在里面。交给人看别动，
  // 交给模型（或当命令输出回填）要摘干净，否则模型会把转义序列当成内容。
  // 回显前面可能还挂着上一轮的提示符或噪声，所以按"写入的脚本行"去定位，不靠"第一行"猜。
  function cleanTermText(raw, script) {
    const lines = plainTermText(raw).split('\n')
    // 每条写入的行最多删一次（按出现顺序消耗）：回显总在最前面，所以先删的是回显；
    // 输出里恰好有一行和命令一样时，那条不会被当成回显删掉。
    const pending = String(script).split('\n').map((l) => l.trim()).filter(Boolean)
    const hit = (line, target) => {
      const head = line.trim()
      return head === target || (target !== '' && head.endsWith(target.slice(0, 80)))
    }
    const kept = []
    for (const line of lines) {
      let matched = -1
      for (let i = 0; i < pending.length; i++) if (hit(line, pending[i])) { matched = i; break }
      if (matched >= 0) { pending.splice(matched, 1); continue }
      kept.push(line)
    }
    return kept.join('\n').replace(/\n{3,}$/, '\n').trimEnd()
  }

  /** The terminal currently held by the Agent on this connection, if any. */
  function agentTerm(id) {
    const rec = get(String(id))
    if (!rec) return null
    for (const t of rec.terms.values()) if (t.owner === 'agent' && !t.exited) return t
    return null
  }

  /**
   * Run one command inside an already-open interactive terminal and wait for it
   * to finish. The command, its prompt echo, and its output all reach the same
   * PTY the user is watching, which is the whole point: nothing happens off-screen.
   * @param id - connection id.
   * @param tid - terminal id on that connection.
   * @param cmd - shell command line(s) to type.
   * @param opts - timeout, optional working directory, chunk observer.
   * @returns exit code plus the cleaned output, or `timeout: true` with what arrived.
   */
  async function runInTerm(id, tid, cmd, { timeoutMs = EXEC_TIMEOUT, cwd = '', onChunk = null } = {}) {
    const t = termOf(id, tid)
    if (!t) throw new Error('no-term: ' + tid)
    if (t.exited) throw new Error('term-exited: ' + tid)
    if (t.busy) throw new Error('term-busy: ' + tid)
    // 跑之前这条终端上已经发生过什么（用户敲过什么、出过什么错）：随结果一起带回去，
    // 这样 Agent 不必靠敲 history 去"看"终端 —— 看是读，不该产生新的输入。
    const prior = termText(id, tid) || ''
    t.busy = true
    const nonce = Math.random().toString(16).slice(2, 8)
    const started = Date.now()
    try {
      // 写入的原文留着：命令回显要按它对账剔除，别拿"第一行"猜。
      // cd 与命令串成一行并加 &&：目录进不去就整条不跑（和旧的 exec 语义一致，
      // 别出现"cd 失败还照跑、结果删错目录"这种事）。
      const sentinel = "printf '\\n__DSH_DONE_" + nonce + "__%s\\n' \"$?\""
      const written = cwd ? ('cd ' + quoteSh(cwd) + ' && ' + String(cmd)) : String(cmd)
      const script = written + '\n' + sentinel
      t.stream.write(written + '\n')
      t.stream.write(sentinel + '\n')
      let since = t.seq
      let acc = ''
      // 行尾是硬条件：命令回显里也带着这串标记（后面跟的是 %s），不认行尾会把回显当跑完。
      // 退出码留可空：远端不是 bash/zsh 时（fish 用 $status）`$?` 展开为空，哨兵照样到 ——
      // 有输出就先交出去，别为一个数字把整条命令判死。
      const done = new RegExp('__DSH_DONE_' + nonce + '__(-?\\d*)\\r?\\n')
      for (;;) {
        await new Promise((r) => setTimeout(r, 80))
        const snap = readTerm(id, tid, since)
        if (!snap) throw new Error('no-term: ' + tid)
        since = snap.seq
        if (snap.data) {
          acc += snap.data
          if (onChunk) { try { onChunk(snap.data) } catch { /* 观察者失败不影响执行 */ } }
        }
        const m = acc.match(done)
        if (m) {
          const ms = Date.now() - started
          const code = m[1] === '' ? null : Number(m[1])
          note('info', 'ssh', 'term-run', { id: t.id, sid: t.sid, code, ms })
          return { code, output: cleanTermText(acc.slice(0, m.index), script), prior, ms, timeout: false }
        }
        if (snap.exited) {
          const ms = Date.now() - started
          return { code: snap.exitCode, output: cleanTermText(acc, script), prior, ms, timeout: false, exited: true }
        }
        if (Date.now() - started > timeoutMs) {
          // 超时不等于命令停了：终端里它还在跑，后续输出可以接着读
          const ms = Date.now() - started
          note('warn', 'ssh', 'term-run-timeout', { id: t.id, sid: t.sid, ms })
          return { code: null, output: cleanTermText(acc, script), prior, ms, timeout: true }
        }
      }
    } finally {
      t.busy = false
      t.lastRunAt = Date.now()
    }
  }

  /** Text a terminal already printed, oldest first, as a person would see it on screen. */
  function termText(sid, tid) {
    const t = termOf(sid, tid)
    if (!t) return null
    return plainTermText(t.chunks.map((c) => c.data).join(''))
  }

  function disconnect(id) {
    const rec = get(String(id))
    if (!rec) return { ok: false, error: 'no-session' }
    for (const t of [...rec.terms.keys()]) closeTerm(rec.id, t, 'disconnect')
    rec.terms.clear()
    try { rec.conn.end() } catch { /* 已断 */ }
    sessions.delete(String(id))
    note('info', 'ssh', 'disconnect', { id: rec.id, host: rec.host })
    return { ok: true }
  }

  function list() {
    return [...sessions.values()].map((r) => ({
      id: r.id, name: r.name, host: r.host, port: r.port, user: r.user,
      status: r.status, fingerprint: r.fingerprint, connectedAt: r.connectedAt,
      terms: [...r.terms.values()].map((t) => ({
        id: t.id, cols: t.cols, rows: t.rows, exited: t.exited, exitCode: t.exitCode,
        owner: t.owner, title: t.title, bytes: t.bytes, startedAt: t.startedAt,
        // 正在跑命令 / 最近一次执行的时刻：界面据此把画面自动切到这条（Agent 干活要看得见）
        busy: !!t.busy,
        lastRunAt: t.lastRunAt || 0,
      })),
      lastError: r.lastError,
    }))
  }

  function disposeAll() {
    for (const id of [...sessions.keys()]) disconnect(id)
  }

  return {
    connect, exec, ls, stat, readText, writeText, upload, download, downloadDir, mkdirp, remove, rename,
    openTerm, readTerm, inputTerm, resizeTerm, closeTerm,
    runInTerm, termText, agentTerm,
    disconnect, list, disposeAll, get,
  }
}
