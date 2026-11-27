// fetch-vscode-src.mjs — 把 **VSCode 官方源码（指定稳定版）** 下载并解压到本地，供以后"复刻 VSCode 某某"
// 时**直接本地 grep**，不必上网搜（搜索结果可能过时/出错，见 00devCore §6 71/58）。
//
// 用法：
//   node tools\fetch-vscode-src.mjs                       # 自动取最新 stable，装到 D:\04other\vscode-src
//   node tools\fetch-vscode-src.mjs --version 1.138.0     # 指定版本
//   node tools\fetch-vscode-src.mjs --out D:\04other\vscode-src --keep   # 保留 tar.gz
// 装完会写 `<out>\.vscode-version.txt`（版本/提交/日期/来源），并在结尾打印关键文件自检。
// ⚠ 网络：本机 git/curl/PS 直连 GitHub 都不通（schannel 握手失败），**只有 Node 的 fetch 通**，
//   所以这个脚本用 Node 流式下载（这也是它存在的理由，别改成 Invoke-WebRequest）。
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def
}
const OUT = arg('out', 'D:\\04other\\vscode-src')
const KEEP = process.argv.includes('--keep')
const DL_DIR = path.join(path.dirname(OUT), '_download')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 这几个文件是过去几轮真用过/引过的（装完自检一下，少一个就报出来）
const MUST_HAVE = [
  'src/vs/workbench/contrib/files/browser/explorerViewlet.ts',
  'src/vs/workbench/contrib/files/browser/fileActions.contribution.ts',
  'src/vs/workbench/contrib/files/browser/views/explorerView.ts',
  'src/vs/workbench/contrib/files/browser/views/explorerViewer.ts',
  'src/vs/workbench/browser/parts/panel/panelActions.ts',
  'src/vs/base/browser/ui/tree/media/tree.css',
  'src/vs/platform/keybinding/common/keybindingsRegistry.ts',
  'src/vs/workbench/browser/actions/layoutActions.ts',
  'extensions/theme-defaults/themes/dark_modern.json',
  'package.json',
]

async function latestStable() {
  const r = await fetch('https://update.code.visualstudio.com/api/update/win32-x64-user/stable/latest')
  const j = await r.json()
  return { version: j.productVersion, commit: j.version }
}

async function main() {
  let version = arg('version', '')
  let commit = ''
  if (!version) {
    const s = await latestStable()
    version = s.version
    commit = s.commit
    console.log('最新 stable =', version)
  }
  const url = `https://codeload.github.com/microsoft/vscode/tar.gz/refs/tags/${version}`
  mkdirSync(DL_DIR, { recursive: true })
  const tarPath = path.join(DL_DIR, `vscode-${version}.tar.gz`)

  // 1) 下载（流式 + 进度）
  if (existsSync(tarPath) && statSync(tarPath).size > 1024 * 1024) {
    console.log('已存在 tar.gz，跳过下载：', tarPath, (statSync(tarPath).size / 1048576).toFixed(1) + 'MB')
  } else {
    console.log('下载', url)
    const res = await fetch(url)
    if (!res.ok) throw new Error('下载失败 HTTP ' + res.status)
    const total = Number(res.headers.get('content-length') || 0)
    let got = 0, lastLog = 0
    const rs = Readable.fromWeb(res.body)
    rs.on('data', (c) => {
      got += c.length
      if (got - lastLog > 5 * 1048576) { lastLog = got; console.log(`  ${(got / 1048576).toFixed(1)}MB` + (total ? ` / ${(total / 1048576).toFixed(1)}MB` : '')) }
    })
    await pipeline(rs, createWriteStream(tarPath))
    console.log('下载完成：', (statSync(tarPath).size / 1048576).toFixed(1) + 'MB')
  }

  // 2) 解压（Windows 自带 bsdtar；--strip-components=1 去掉 vscode-<tag>/ 这一层）
  if (existsSync(OUT)) {
    console.log('目标目录已存在，先清掉：', OUT)
    rmSync(OUT, { recursive: true, force: true })
  }
  mkdirSync(OUT, { recursive: true })
  console.log('解压到', OUT, '（这一步要一两分钟）')
  const r = spawnSync('tar', ['-xzf', tarPath, '-C', OUT, '--strip-components=1'], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('tar 解压失败，status=' + r.status)

  // 3) 自检 + 版本标记
  const missing = MUST_HAVE.filter((f) => !existsSync(path.join(OUT, f)))
  writeFileSync(path.join(OUT, '.vscode-version.txt'),
    `VSCode 源码本地副本\nversion: ${version}\ncommit: ${commit || '(未取)'}\nsource: ${url}\nfetched: ${new Date().toISOString()}\n` +
    `用途: 复刻 VSCode 行为时**先本地 grep 这里的源码**（见 00devCore §7「规格优先本地副本」）\n`,
    'utf8')
  const pkg = JSON.parse(readFileSync(path.join(OUT, 'package.json'), 'utf8'))
  console.log('\n=== 完成 ===')
  console.log('版本    :', version, '(package.json version =', pkg.version + ')')
  console.log('路径    :', OUT)
  console.log('关键文件:', missing.length ? ('缺 ' + missing.join(', ')) : '全部就位 ✓')
  if (!KEEP) { rmSync(tarPath, { force: true }); console.log('已删除 tar.gz（要留加 --keep）') }
}
main().catch((e) => { console.log('FETCH ERROR: ' + (e && e.stack ? e.stack : e)); process.exit(1) })
