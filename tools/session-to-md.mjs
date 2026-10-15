// Convert a DSH session JSONL (decompressed) into a readable Markdown transcript.
// Usage: node session-to-md.mjs <session.jsonl> <out.md>
import { readFileSync, writeFileSync } from 'node:fs'

const [, , src, out] = process.argv
const lines = readFileSync(src, 'utf8').split('\n').filter(Boolean)
const events = lines.map((l) => JSON.parse(l))

// Merge assistant/chunk text deltas into their final assistant/message if present,
// otherwise reconstruct from chunks. Simpler: rely on assistant/message which holds
// the full content, and only fall back to chunk assembly when no final message exists.
const bySeq = new Map(events.map((e) => [e.seq, e]))

function renderContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const c of content) {
    if (c.type === 'text') parts.push(c.text)
    else if (c.type === 'reasoning') parts.push(`> [思考] ${c.text}`)
    else if (c.type === 'tool_use' || c.type === 'tool-use') {
      const name = c.name ?? c.toolName ?? 'tool'
      const input = c.input ?? c.arguments ?? {}
      parts.push(`\n\`\`\`tool\n[调用 ${name}] ${JSON.stringify(input)}\n\`\`\``)
    } else if (c.type === 'tool_result') {
      const r = c.content ?? c.output ?? ''
      parts.push(`\n\`\`\`result\n${typeof r === 'string' ? r : JSON.stringify(r)}\n\`\`\``)
    }
  }
  return parts.join('\n\n')
}

const md = []
let userCount = 0
let assistCount = 0
let toolCount = 0

for (const e of events) {
  if (e.type === 'user/message') {
    userCount++
    const text = renderContent(e.data?.content)
    md.push(`\n\n---\n\n## 用户 (${userCount})\n\n${text}`)
  } else if (e.type === 'assistant/message') {
    assistCount++
    const content = e.data?.message?.content ?? e.data?.content
    const text = renderContent(content)
    // Count tool calls embedded in the assistant message
    const tools = (content ?? []).filter((c) => c.type === 'tool_use' || c.type === 'tool-use')
    toolCount += tools.length
    const toolNote = tools.length > 0 ? `\n> *(本轮调用了 ${tools.length} 个工具)*` : ''
    md.push(`\n\n---\n\n## 助手 (${assistCount})${toolNote}\n\n${text}`)
  } else if (e.type === 'tool/call') {
    toolCount++
    const name = e.data?.name ?? e.data?.toolName ?? 'tool'
    const input = e.data?.arguments ?? e.data?.input ?? {}
    md.push(`\n\n> 🔧 **工具调用: ${name}**\n>\n> \`\`\`json\n> ${JSON.stringify(input).replace(/\n/g, '\n> ')}\n> \`\`\``)
  } else if (e.type === 'tool/result') {
    const r = e.data?.result ?? e.data?.output ?? e.data
    const s = typeof r === 'string' ? r : JSON.stringify(r)
    const brief = s.length > 2000 ? s.slice(0, 2000) + '\n...（截断）' : s
    md.push(`\n\n> ⚙️ **工具结果**\n>\n> \`\`\`text\n> ${brief.replace(/\n/g, '\n> ')}\n> \`\`\``)
  } else if (e.type === 'turn/start') {
    // no-op marker
  }
}

const header = `# 会话导出（DSH）

- 会话 ID: ${events[0]?.id ?? 'unknown'}
- 创建时间: ${new Date(events[0]?.createdAt ?? Date.now()).toLocaleString('zh-CN')}
- 消息统计: 用户 ${userCount} 条 / 助手 ${assistCount} 条 / 工具调用 ${toolCount} 次
`

writeFileSync(out, header + md.join('\n'), 'utf8')
console.error(`done: ${md.length} blocks, user=${userCount} assistant=${assistCount} tools=${toolCount}`)
