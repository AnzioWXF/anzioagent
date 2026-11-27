import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// 会话「轮次」探针（只看结构不看内容）：每个事件的 type / seq / data.turn / data.step / source.kind
// 用法: node --import tsx/esm tools/probe-turns.mjs [session.v3.jsonl.zstd] [尾部条数]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scanZstdFrames, decompressZstdFrame } from 'file:///D:/99DSH/deepseek-harness-mine/harness/packages/session/session-persistence-jsonl/src/zstd.ts'

let file = process.argv[2]
const tail = Number(process.argv[3] || 60)
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
const { frames } = scanZstdFrames(bytes)
const parts = []
for (const f of frames) parts.push((await decompressZstdFrame(bytes.subarray(f.start, f.end))).toString('utf8'))
const lines = parts.join('').trim().split('\n')
console.log('file: ' + file + '  events: ' + lines.length)
const turns = new Map()
for (const l of lines.slice(-tail)) {
  let o = null
  try { o = JSON.parse(l) } catch { continue }
  const d = o.data || {}
  const src = (d.source && d.source.kind) || (d.message && d.message.source && d.message.source.kind) || ''
  const t = d.turn === undefined ? '-' : String(d.turn)
  if (d.turn !== undefined) turns.set(t, (turns.get(t) || 0) + 1)
  console.log('  seq=' + o.seq + ' ' + (o.type || '?') + ' turn=' + t + ' step=' + (d.step === undefined ? '-' : d.step)
    + ' src=' + src + ' keys=' + Object.keys(d).join(','))
}
console.log('distinct turns: ' + JSON.stringify([...turns.entries()]))
