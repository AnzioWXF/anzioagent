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
      if (sessions.has(sid)) return reject(new Error('session-exists: ' + sid))

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
  function openTerm(id, { cols = 100, rows = 30, onData = null } = {}) {
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
        note('info', 'ssh', 'term-open', { id: t.id, sid: rec.id, cols, rows })
        resolve({ id: t.id, sid: rec.id, cols, rows })
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
      terms: [...r.terms.values()].map((t) => ({ id: t.id, cols: t.cols, rows: t.rows, exited: t.exited, exitCode: t.exitCode })),
      lastError: r.lastError,
    }))
  }

  function disposeAll() {
    for (const id of [...sessions.keys()]) disconnect(id)
  }

  return {
    connect, exec, ls, stat, readText, writeText, upload, download, downloadDir, mkdirp, remove, rename,
    openTerm, readTerm, inputTerm, resizeTerm, closeTerm,
    disconnect, list, disposeAll, get,
  }
}
