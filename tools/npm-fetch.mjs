// npm-fetch.mjs — 从 npm 源（默认国内镜像）取一个包，**校验哈希**后解到指定目录，并留一条安装记录。
//
// 为什么自己写：天工的"第三方工具按需取用"这条腿要一个**可复用**的取包器 ——
//   源可换（默认 npmmirror，可换官方源/私有源）、必须核哈希（信任锚）、必须留痕（谁/从哪/多大/什么许可）。
//   官方更新器那套是"给我们自己的程序用的"（启动时替换、动程序目录、要重启），与这里**物理隔离**（见 00devCore §3）。
//
// 用法:
//   node tools\npm-fetch.mjs typescript-language-server@5.3.0 typescript@6.0.3 --into D:\99DSH\app-home\tools\lsp
//   可选: --source https://registry.npmmirror.com   （默认；官方源 https://registry.npmjs.org）
//        --force                                     （已存在同版本时重装）
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const pkgs = []
let into = null
let source = 'https://registry.npmmirror.com'
let force = false
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--into') { into = args[++i]; continue }
  if (a === '--source') { source = args[++i].replace(/\/+$/, ''); continue }
  if (a === '--force') { force = true; continue }
  pkgs.push(a)
}
if (pkgs.length === 0 || into === null) {
  console.error('usage: node npm-fetch.mjs <name>@<version> [...] --into <dir> [--source <registry>] [--force]')
  process.exit(2)
}
into = path.resolve(into)
const modulesDir = path.join(into, 'node_modules')
const manifestPath = path.join(into, 'manifest.json')

/** 读旧的安装记录（没有就是空表）。 */
function readManifest() {
  try { return JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { return { entries: [] } }
}

/** 跑一个子进程并等它结束（tar 解包用）。 */
function run(cmd, argv, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (b) => { err += String(b) })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 400)}`)))
  })
}

const manifest = readManifest()
for (const spec of pkgs) {
  const at = spec.lastIndexOf('@')
  if (at <= 0) { console.error(`[skip] 需要 name@version 形式: ${spec}`); process.exitCode = 2; continue }
  const name = spec.slice(0, at)
  const version = spec.slice(at + 1)
  const target = path.join(modulesDir, ...name.split('/'))
  if (existsSync(target) && !force) {
    console.log(`[keep] ${name}@${version} 已存在（要重装加 --force）`)
    continue
  }
  const metaUrl = `${source}/${name.replace('/', '%2f')}/${version}`
  console.log(`[get ] ${name}@${version}  ← ${metaUrl}`)
  const meta = await (await fetch(metaUrl)).json()
  const dist = meta.dist || {}
  if (typeof dist.tarball !== 'string') throw new Error(`${name}@${version}: 元数据里没有 tarball`)
  const expected = typeof dist.integrity === 'string' && dist.integrity.startsWith('sha512-')
    ? dist.integrity.slice('sha512-'.length)
    : null
  if (expected === null) throw new Error(`${name}@${version}: 元数据没有 sha512 校验值，拒绝安装`)
  const bytes = Buffer.from(await (await fetch(dist.tarball)).arrayBuffer())
  const actual = createHash('sha512').update(bytes).digest('base64')
  if (actual !== expected) throw new Error(`${name}@${version}: 哈希不符，拒绝安装（期望 ${expected.slice(0, 12)}… 实得 ${actual.slice(0, 12)}…）`)
  // 解包暂存目录必须与目标**同一个盘**：跨盘 rename 会 EXDEV（C:\Temp → D:\ 实测踩到）
  mkdirSync(into, { recursive: true })
  const tmp = await mkdtemp(path.join(into, '.staging-'))
  const tgz = path.join(tmp, 'pkg.tgz')
  writeFileSync(tgz, bytes)
  try {
    await run('tar', ['-xzf', tgz, '-C', tmp], tmp)
    const unpacked = path.join(tmp, 'package')
    if (!existsSync(unpacked)) throw new Error(`${name}@${version}: 解包后没有 package/ 目录`)
    mkdirSync(path.dirname(target), { recursive: true })
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    renameSync(unpacked, target)
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  manifest.entries = manifest.entries.filter((e) => !(e.name === name && e.version === version))
  manifest.entries.push({
    name, version, source,
    tarball: dist.tarball,
    integrity: `sha512-${expected}`,
    license: typeof meta.license === 'string' ? meta.license : (meta.license && meta.license.type) || undefined,
    packedBytes: bytes.length,
    installedAt: new Date().toISOString(),
  })
  console.log(`[ok  ] ${name}@${version}  ${(bytes.length / 1048576).toFixed(2)} MB  → ${target}  (license ${manifest.entries[manifest.entries.length - 1].license || '未知'})`)
}
mkdirSync(into, { recursive: true })
writeFileSync(manifestPath, JSON.stringify({ source, into, entries: manifest.entries }, null, 2) + '\n')
console.log(`[done] 安装记录: ${manifestPath}（共 ${manifest.entries.length} 条）`)
