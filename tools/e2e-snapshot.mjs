// e2e-snapshot.mjs — 工作区快照 / 一键还原（"反悔药"）E2E
// 前置：起一个测试后端（3082），例：
//   pwsh -File D:\99DSH\tools\dev-testhome.ps1
//   $env:DSH_HOME='D:\99DSH\.smoke-home'; node D:\99DSH\deepseek-harness-mine\harness\apps\cli\lib\bin.js web --port 3082 --no-open
// 用法：node tools/e2e-snapshot.mjs [base]        （默认 http://127.0.0.1:3082）
// 全程真磁盘：建 fixture → 快照 → 改/增/删 → 差异 → 还原 → 反悔药的反悔药，逐项核对磁盘真值。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:3082'
const API = BASE + '/dsh-ide'
const FIX = join('D:\\99DSH', '.snap-fix')
// ⚠ 别读 process.env.DSH_HOME：harness 的 shell 里带着 DSH_HOME=D:\99DSH\dev-home（开发台家目录，
// 见 §6 31 同源坑），会把快照库算到错的地方去 —— 被测后端用的是 DSH_E2E_HOME。
const SNAP = join(process.env.DSH_E2E_HOME || 'D:\\99DSH\\.smoke-home', 'snapshots')
// 本工作空间的快照库（键算法与 host 半一致）：开头/结尾都清掉，保证可重复跑且不留残留
const WS = join(SNAP, createHash('sha1').update(FIX.toLowerCase()).digest('hex').slice(0, 16))

const results = []
function check(name, ok, extra) {
  results.push([name, !!ok])
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra)))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function get(p, q) {
  const u = new URL(API + p)
  for (const k in (q || {})) if (q[k] !== undefined) u.searchParams.set(k, q[k])
  const r = await fetch(u)
  return r.json()
}
async function post(p, body) {
  const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  return r.json()
}
const read = (rel) => { try { return readFileSync(join(FIX, rel), 'utf8') } catch { return null } }

// ── 自建 fixture（自清）──────────────────────────────────────────────
rmSync(FIX, { recursive: true, force: true })
rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
mkdirSync(join(FIX, 'sub'), { recursive: true })
writeFileSync(join(FIX, 'a.txt'), 'AAAA-1\n')
writeFileSync(join(FIX, 'sub', 'b.txt'), 'BBBB-1\n')

try {
  const up = await get('/snapshots').catch(() => null)
  check('P1 后端在跑且 /snapshots 可用', up && up.ok === true, up && up.code)

  const act = await post('/active-root', { path: FIX })
  check('P2 指向 fixture 工作空间', act && act.ok !== false, act)
  await sleep(300)

  // ① 第一份快照
  const s1 = await post('/snapshot', { label: '测试第 1 份', reason: 'manual' })
  check('P3 快照成功且登记 2 个文件', s1.ok === true && s1.fileCount === 2, s1)
  check('P4 首份快照没有"变化"（无上一份可比）', s1.changed === 0 && s1.added === 0 && s1.deleted === 0, s1)

  // ② 改 / 增 / 删
  writeFileSync(join(FIX, 'a.txt'), 'AAAA-2-改过了\n')
  writeFileSync(join(FIX, 'c.txt'), 'CCCC-新增\n')
  rmSync(join(FIX, 'sub', 'b.txt'))
  await sleep(1100)                                   // 躲开 3s 合并窗口
  const s2 = await post('/snapshot', { label: '测试第 2 份', reason: 'manual' })
  check('P5 第二份快照识别 改1/增1/删1', s2.ok === true && s2.changed === 1 && s2.added === 1 && s2.deleted === 1, s2)

  // ③ 差异（第 1 份快照 vs 当前磁盘）
  const d1 = await get('/snapshot-diff', { ts: s1.ts })
  const byRel = {}
  for (const it of (d1.items || [])) byRel[String(it.rel).replace(/\\/g, '/')] = it
  check('P6 差异: 3 项（改/增/删各一）', d1.ok === true && (d1.items || []).length === 3, d1.counts)
  check('P7 改动项左右文本正确', byRel['a.txt'] && byRel['a.txt'].status === 'changed'
    && byRel['a.txt'].leftText === 'AAAA-1\n' && byRel['a.txt'].rightText === 'AAAA-2-改过了\n', byRel['a.txt'] && byRel['a.txt'].status)
  check('P8 新增项: 左空右有', byRel['c.txt'] && byRel['c.txt'].status === 'added' && byRel['c.txt'].leftText === '' && byRel['c.txt'].rightText === 'CCCC-新增\n')
  check('P9 删除项: 左有右空', byRel['sub/b.txt'] && byRel['sub/b.txt'].status === 'deleted' && byRel['sub/b.txt'].leftText === 'BBBB-1\n' && byRel['sub/b.txt'].rightText === '')

  // ④ 还原到第 1 份快照
  const r1 = await post('/snapshot-restore', { ts: s1.ts })
  check('P10 还原成功: 2 个文件写回 / 1 个新增进回收 / 0 失败', r1.ok === true && r1.restored === 2 && r1.trashed === 1 && r1.failed === 0, r1)
  check('P11 磁盘真值: a.txt 回到第 1 版', read('a.txt') === 'AAAA-1\n', read('a.txt'))
  check('P12 磁盘真值: 被删的 sub/b.txt 回来了', read('sub/b.txt') === 'BBBB-1\n', read('sub/b.txt'))
  check('P13 磁盘真值: 新增的 c.txt 已移走（不在工作区）', read('c.txt') === null)
  // 新增文件是"移到回收目录"，不是删除（回收目录按**这次还原**分桶 = trashTs）
  const trashedFile = join(WS, 'trash', String(r1.trashTs), 'c.txt')
  check('P14 新增的文件确实躺在回收目录里（没被真删）', existsSync(trashedFile), trashedFile)

  // ⑤ 反悔药的反悔药：还原前自动备份 → 可以再撤回去
  check('P15 还原前自动存了一份快照', r1.preTs > 0, { preTs: r1.preTs })
  const list = await get('/snapshots')
  const pre = (list.items || []).find((s) => s.ts === r1.preTs)
  check('P16 该快照标签为「还原前自动备份」', pre && pre.label === '还原前自动备份', pre && pre.label)
  const r2 = await post('/snapshot-restore', { ts: r1.preTs })
  check('P17 二次还原成功（撤回还原本身）', r2.ok === true && r2.restored >= 2, r2)
  check('P18 磁盘真值: c.txt 又回来了', read('c.txt') === 'CCCC-新增\n')
  check('P19 磁盘真值: a.txt 回到改过的版本', read('a.txt') === 'AAAA-2-改过了\n', read('a.txt'))

  // ⑥ 单文件还原（只还原选中的那个）
  const r3 = await post('/snapshot-restore', { ts: s1.ts, paths: [join(FIX, 'a.txt')] })
  check('P20 单文件还原: 只写回 1 个、不动其它、不进回收', r3.ok === true && r3.restored === 1 && r3.trashed === 0 && r3.subset === true, r3)
  check('P21 单文件还原后 a.txt 回到第 1 版，c.txt 仍在', read('a.txt') === 'AAAA-1\n' && read('c.txt') === 'CCCC-新增\n')

  // ⑦ 边界
  const bad = await get('/snapshot-diff', { ts: 1 })
  check('P22 不存在的快照: 优雅报错不崩', bad.ok === false && bad.code === 'snapshot-not-found', bad)
  const manual = await post('/snapshot', { label: '手动不合并', reason: 'manual' })
  const manual2 = await post('/snapshot', { label: '手动不合并2', reason: 'manual' })
  check('P23 manual 不被 3 秒合并窗口吃掉（两份不同 ts）', manual.ok === true && manual2.ok === true && manual2.ts !== manual.ts, { a: manual.ts, b: manual2.ts })

  // ⑧ 自动快照的三个语义（客户端发送前/保存后/定时都用 reason='auto'）
  const a1 = await post('/snapshot', { label: '自动1', reason: 'auto' })
  const a2 = await post('/snapshot', { label: '自动2', reason: 'auto' })
  check('P24 auto 连发两次走 3 秒合并（第二次 coalesced）', a1.ok === true && a2.ok === true && a2.coalesced === true, { a1: a1.ts, a2: a2.ts, coalesced: a2.coalesced })
  const before = (await get('/snapshots')).items.length
  await sleep(3200)                                        // 躲开合并窗口
  const a3 = await post('/snapshot', { label: '自动3', reason: 'auto' })
  check('P25 内容没变时 auto 不落新快照（unchanged）', a3.ok === true && a3.unchanged === true, a3)
  const after = (await get('/snapshots')).items.length
  check('P26 unchanged 的 auto 没有污染历史列表', after === before, { before, after })
  writeFileSync(join(FIX, 'a.txt'), 'AAAA-3-又改了\n')
  await sleep(200)
  const a4 = await post('/snapshot', { label: '自动4', reason: 'auto' })
  check('P27 内容变了 auto 正常落一份（changed=1）', a4.ok === true && a4.changed === 1 && !a4.unchanged, a4)

  // ⑨ 边界：超过 8MB 的文件不进快照 —— 但**绝不能被"还原"当成新增文件搬走**（会真丢数据的坑）
  const bigPath = join(FIX, 'big.bin')
  writeFileSync(bigPath, Buffer.alloc(9 * 1024 * 1024, 7))
  await sleep(1100)
  const sb = await post('/snapshot', { label: '带大文件', reason: 'manual' })
  check('P28 大文件被逐个记账为 skipped（不静默漏）', sb.ok === true && sb.skippedCount === 1, sb)
  writeFileSync(join(FIX, 'a.txt'), 'AAAA-4-大文件之后改的\n')
  await sleep(200)
  const rb = await post('/snapshot-restore', { ts: sb.ts })
  check('P29 还原时大文件没被搬走（磁盘真值仍在）', existsSync(bigPath) === true, { exists: existsSync(bigPath), trashed: rb.trashed })
  check('P30 该还原没有搬走任何文件（trashed=0）', rb.ok === true && rb.trashed === 0, rb)
  const db = await get('/snapshot-diff', { ts: sb.ts })
  check('P31 大文件不会被误报成"快照后新增"', (db.items || []).every((it) => String(it.rel).indexOf('big.bin') < 0), (db.items || []).map((i) => i.rel))
} finally {
  rmSync(FIX, { recursive: true, force: true })
  rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
}

const pass = results.filter((r) => r[1]).length
console.log(`\n[e2e-snapshot] ${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
