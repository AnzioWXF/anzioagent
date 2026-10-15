// 拍平 VS Code theme-defaults 的 include 链 → 自包含 monaco 主题 JSON。
// 用法: node tools/flatten-theme.mjs <dark|light>
// 输出: D:\99DSH\dev-home\profiles\web\ide\dsh-ide\static\themes\<mode>-modern.json
// include 语义: colors 沿链由深到浅合并(浅层覆盖深层);
// tokenColors 取链上第一个自带该键的文件(与 VS Code 继承语义一致)。
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const mode = process.argv[2]
if (mode !== 'dark' && mode !== 'light') {
  console.error('usage: node flatten-theme.mjs <dark|light>')
  process.exit(1)
}

const BASE = 'https://cdn.jsdelivr.net/gh/microsoft/vscode@main/extensions/theme-defaults/themes'
const chain = mode === 'dark'
  ? ['dark_vs.json', 'dark_plus.json', 'dark_modern.json']
  : ['light_vs.json', 'light_plus.json', 'light_modern.json']

// VS Code 主题文件是 JSONC：允许 // 注释与尾逗号（vscode 用 jsonc 解析）。
function stripJsonc(text) {
  const lines = String(text).split('\n')
  const out = []
  for (let line of lines) {
    // 行内注释剥离：只在字符串外生效（主题文件无转义引号干扰，够用）
    let inStr = false
    for (let i = 0; i < line.length - 1; i++) {
      const c = line[i]
      if (c === '"') inStr = !inStr
      else if (!inStr && c === '/' && line[i + 1] === '/') {
        line = line.slice(0, i)
        break
      }
    }
    out.push(line)
  }
  // 尾逗号清理（主题数据值都是颜色/字符串，不会含 "xxx," 紧跟 } 的字符串字面量）
  return out.join('\n').replace(/,(\s*[}\]])/g, '$1')
}

async function load(name) {
  const res = await fetch(`${BASE}/${name}`)
  if (!res.ok) throw new Error(`fetch ${name}: ${res.status}`)
  return { name, doc: JSON.parse(stripJsonc(await res.text())) }
}

;(async () => {
  const docs = []
  for (const n of chain) docs.push(await load(n))

  // colors: 深→浅合并，浅层赢
  const colors = {}
  for (const { doc } of docs) Object.assign(colors, doc.colors || {})

  // tokenColors: 链上第一个自带的文件（own 优先，沿 include 向上找）
  let tokenColors = null
  for (const { doc } of docs) {
    if (Array.isArray(doc.tokenColors) && doc.tokenColors.length) {
      tokenColors = doc.tokenColors
      break
    }
  }
  if (!tokenColors) throw new Error('no tokenColors found in chain')

  const out = {
    name: docs[docs.length - 1].doc.name,
    type: mode,
    colors,
    tokenColors,
  }
  out.tokenColors = tokenColors.filter((r) => r && typeof r === 'object' && r.scope && r.settings)
  // 2026-10-12 目录搬迁：插件真源已挪到 -mine\plugin（家目录里那份只是指向它的目录链接）
  const file = join(__dirname, '..', 'deepseek-harness-mine', 'plugin', 'static', 'themes', `${mode}-modern.json`)
  writeFileSync(file, JSON.stringify(out, null, 1))
  console.log('wrote', file)
  console.log('colors:', Object.keys(colors).length,
    '| tokenColors:', tokenColors.length,
    '| editor.background:', colors['editor.background'],
    '| editor.foreground:', colors['editor.foreground'])
  const comment = tokenColors.find((t) => {
    const s = t.scope
    const arr = Array.isArray(s) ? s : String(s || '').split(',')
    return arr.some((x) => String(x).trim() === 'comment')
  })
  console.log('comment rule:', comment ? JSON.stringify(comment.settings) : '(scope 写法不是裸 comment)')
})().catch((e) => { console.error('FAIL', e); process.exit(1) })
