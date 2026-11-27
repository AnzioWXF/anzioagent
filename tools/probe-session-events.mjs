import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// 会话事件结构探针：只看结构（键名/长度），不打印文件内容 —— 用于确认 tool/result 里到底带了什么
// 用法: node --import tsx/esm tools/probe-session-events.mjs [会话根目录] [事件类型,逗号分隔]
// 注意：workdir 必须在检出目录 deepseek-harness-mine\harness（框架 ts 源码 import 约束）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scanZstdFrames, decompressZstdFrame } from 'file:///D:/99DSH/deepseek-harness-mine/harness/packages/session/session-persistence-jsonl/src/zstd.ts'

const base = process.argv[2] || `${__TIANGONG_ROOT}\\dev-home\\sessions`
const want = String(process.argv[3] || 'tool/result').split(',')

function newest(dir) {
  const out = []
  const walk = (d, depth) => {
    if (depth > 3) return
    let ents = []
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name === 'session.v3.jsonl.zstd') { try { out.push({ p, m: statSync(p).mtimeMs }) } catch { /* skip */ } }
    }
  }
  walk(dir, 0)
  out.sort((a, b) => b.m - a.m)
  return out[0] && out[0].p
}

const file = newest(base)
if (!file) { console.log('no session file under ' + base); process.exit(1) }
const bytes = readFileSync(file)
const { frames } = scanZstdFrames(bytes)
const parts = []
for (const f of frames) parts.push((await decompressZstdFrame(bytes.subarray(f.start, f.end))).toString('utf8'))
const lines = parts.join('').trim().split('\n')
const counts = new Map()
for (const l of lines) {
  let o = null
  try { o = JSON.parse(l) } catch { continue }
  counts.set(o.type, (counts.get(o.type) || 0) + 1)
}
console.log('file=' + file)
console.log('events=' + lines.length + '  types=' + JSON.stringify([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)))

const seen = new Set()
const callNames = new Map()   // callId -> 工具名（tool/result 的 source 里只有 callId）
for (const l of lines) {
  let o = null
  try { o = JSON.parse(l) } catch { continue }
  if (o.type === 'tool/call' && o.data && o.data.callId) callNames.set(o.data.callId, o.data.name)
  if (!want.includes(o.type)) continue
  const d = o.data || {}
  const msg = d.message || {}
  const src = msg.source || {}
  const toolName = src.toolName || src.name || d.name || callNames.get(src.callId) || d.callId || '?'
  const key = o.type + '|' + String(toolName)
  if (seen.has(key)) continue
  seen.add(key)
  const dmeta = d.meta && typeof d.meta === 'object' ? d.meta : null
  const diffs = dmeta && Array.isArray(dmeta.diffs) ? dmeta.diffs : null
  const c0 = Array.isArray(msg.content) && msg.content[0] ? msg.content[0] : null
  console.log('--- ' + key)
  console.log(JSON.stringify({
    dataKeys: Object.keys(d),
    dataMetaKeys: dmeta ? Object.keys(dmeta) : typeof d.meta,
    dataDiffsLen: diffs ? diffs.length : null,
    firstDiffKeys: diffs && diffs[0] ? Object.keys(diffs[0]) : null,
    firstDiffLens: diffs && diffs[0] ? { path: diffs[0].path, old: typeof diffs[0].oldText === 'string' ? diffs[0].oldText.length : diffs[0].oldText, next: typeof diffs[0].newText === 'string' ? diffs[0].newText.length : diffs[0].newText } : null,
    sourceKeys: Object.keys(src),
    messageKeys: Object.keys(msg),
    contentTypes: (Array.isArray(msg.content) ? msg.content : []).map((b) => b && b.type),
    content0Keys: c0 ? Object.keys(c0) : null,
    argKeys: o.type === 'tool/call' && d.arguments ? Object.keys(d.arguments) : null,
  }, null, 1))
}
console.log('distinct shapes: ' + seen.size)

// TAIL=<n>：逐条打印最后 n 条 tool/call | tool/result 的工具名 / 参数键 /
// 呈现文本前缀 / meta.diffs 长度 —— 用于定位"改动没被登记"这类问题
if (process.env.TAIL) {
  const n = Number(process.env.TAIL)
  const names = new Map()
  const rows = []
  for (const l of lines) {
    let o = null
    try { o = JSON.parse(l) } catch { continue }
    if (o.type === 'tool/call') {
      if (o.data && o.data.callId) names.set(o.data.callId, o.data.name)
      rows.push({ t: 'call', tool: o.data && o.data.name, argKeys: o.data && o.data.arguments ? Object.keys(o.data.arguments).join(',') : '', diffs: '', text: '' })
    } else if (o.type === 'tool/result') {
      const d = o.data || {}
      const msg = d.message || {}
      const src = msg.source || {}
      const c0 = Array.isArray(msg.content) ? msg.content[0] : null
      let text = ''
      if (c0) {
        const fc = c0.content
        if (typeof fc === 'string') text = fc
        else if (Array.isArray(fc) && fc[0] && typeof fc[0].text === 'string') text = fc[0].text
      }
      rows.push({
        t: 'result', tool: names.get(src.callId) || '?',
        argKeys: '',
        diffs: d.meta && Array.isArray(d.meta.diffs) ? String(d.meta.diffs.length) : 'none',
        text: String(text).replace(/\s+/g, ' ').slice(0, 70),
      })
    }
  }
  console.log('--- last ' + n + ' tool events ---')
  for (const r of rows.slice(-n)) {
    console.log('  ' + r.t + ' | ' + r.tool + ' | args=' + r.argKeys + ' | diffs=' + r.diffs + ' | ' + r.text)
  }
}
