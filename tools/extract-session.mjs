// Extract a DSH session log (.jsonl.zstd) to plain JSONL for inspection.
// Usage: node extract-session.mjs <session.zstd> [out.jsonl]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, normalize, resolve, sep } from 'node:path'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'

const zstdDecompressAsync = promisify(zstdDecompress)

const ZSTD_MAGIC = 0xFD2FB528

// Locate complete zstd frames by scanning block headers (mirror of DSH scanZstdFrames).
// Refuse to drop a decompressed artifact into any live sessions tree: the JSONL
// backend matches its configured compression, and one wrong-suffix file turns
// "list every session" into a hard failure for the whole home (2026-09-20).
function assertOutsideSessionsTree(target) {
  const parts = normalize(resolve(target)).split(sep).filter(Boolean)
  const at = parts.findIndex(p => p.toLowerCase() === 'sessions')
  if (at >= 0) {
    throw new Error(
      `refusing to write ${target}: path is inside a sessions tree (…${sep}${parts[at]}${sep}…); `
      + 'pass an explicit output path outside the session store',
    )
  }
}

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error('reserved header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('reserved block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

const src = process.argv[2]
const out = process.argv[3]
// No default output path on purpose. The old default wrote the decompressed
// .jsonl right next to the .zstd, i.e. INSIDE a live session directory, and one
// such artifact makes session/list throw an encoding mismatch that empties the
// whole history list (2026-09-20). Output must be named explicitly.
if (!src || !out) {
  console.error('usage: node extract-session.mjs <session.v3.jsonl.zstd> <output.jsonl outside any sessions tree>')
  process.exit(2)
}
const data = readFileSync(src)
const frames = scanZstdFrames(data)
console.error(`frames: ${frames.length}`)
let plain = Buffer.alloc(0)
for (const f of frames) {
  const dec = await zstdDecompressAsync(data.subarray(f.start, f.end))
  plain = Buffer.concat([plain, dec])
}
assertOutsideSessionsTree(out)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, plain)
console.error(`wrote ${plain.length} bytes -> ${out}`)
