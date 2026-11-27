import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// 会话文件诊断（用框架自己的 zstd 帧扫描器；会话是「头帧 + 事件批帧」的多帧 zstd）
// 用法: node --import tsx/esm tools/dump-session.mjs [session.v3.jsonl.zstd 路径] [尾部事件数]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scanZstdFrames, decompressZstdFrame } from 'file:///D:/99DSH/deepseek-harness-mine/harness/packages/session/session-persistence-jsonl/src/zstd.ts'

let file = process.argv[2]
const tail = Number(process.argv[3] || 10)
if (!file) {
  const base = `${__TIANGONG_ROOT}\\app-home\\sessions`
  const all = []
  for (const ws of readdirSync(base)) {
    for (const s of readdirSync(join(base, ws))) {
      const p = join(base, ws, s, 'session.v3.jsonl.zstd')
      try { all.push({ p, m: statSync(p).mtimeMs }) } catch { /* skip */ }
    }
  }
  all.sort((a, b) => b.m - a.m)
  file = all[0].p
}
const bytes = readFileSync(file)
const { frames, tornStart } = scanZstdFrames(bytes)
console.log('file: ' + file)
console.log('bytes: ' + bytes.length + '  frames: ' + frames.length + '  tornStart: ' + String(tornStart))
const parts = []
for (const f of frames) parts.push((await decompressZstdFrame(bytes.subarray(f.start, f.end))).toString('utf8'))
const lines = parts.join('').trim().split('\n')
console.log('events: ' + lines.length)
if (process.env.RAW === '1') {
  for (const l of lines.slice(-tail)) console.log('  RAW ' + l.slice(0, 420))
  process.exit(0)
}
for (const l of lines.slice(-tail)) {
  let o = null
  try { o = JSON.parse(l) } catch { console.log('  <unparsable> ' + l.slice(0, 120)); continue }
  const bits = []
  for (const k of ['role', 'source', 'status', 'turnId', 'reason']) {
    if (o[k] !== undefined) bits.push(k + '=' + JSON.stringify(o[k]).slice(0, 50))
  }
  let text = ''
  const c = o.content || o.text || (o.message && o.message.content)
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) text = c.map((b) => (b && b.type === 'text' ? b.text : (b && b.type) || '')).join(' ')
  console.log('  [' + (o.type || '?') + '] ' + bits.join(' ') + (text ? ' :: ' + text.replace(/\s+/g, ' ').slice(0, 220) : ''))
}
