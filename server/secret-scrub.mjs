// server/secret-scrub.mjs
// 存量明文清洗(spec §3.3,2026-08-28):扫对话级+消息级 trace,对 result.resource.kind==='Secret'
// 的事件重掩;另扫 user 消息 content 里历史版本烤入的 refsCtx 块(终审 I2)。幂等(重掩后
// 逐字不变的不计不写);损坏行跳过(一句 warn)。audit_log 不动(凭证+hash 链)。启动后异步跑,不阻塞。
import { maskSecretResource } from './secret-mask.mjs'
import { REFS_CTX_HEADER } from './refs-context.mjs'

function scrubTraceJson(json) {
  let events
  try { events = JSON.parse(json) } catch { return null }
  if (!Array.isArray(events)) return null
  let masked = 0
  const out = events.map(e => {
    const r = e?.result?.resource
    if (r && r.kind === 'Secret') {
      const ev = { ...e, result: { ...e.result, resource: maskSecretResource(r) } }
      // 幂等:重掩后与原事件逐字相同(已掩码短路)→不计不写
      if (JSON.stringify(ev) === JSON.stringify(e)) return e
      masked++
      return ev
    }
    return e
  })
  return masked ? { json: JSON.stringify(out), masked } : null
}

// user content 烤入的 refsCtx(历史版本格式;现役落库已干净,格式单源见 refs-context.mjs):
//   REFS_CTX_HEADER + 块(\n\n 连接) + \n\n + 用户正文
//   块 = `[kind/ns/name]:\n{...JSON.stringify(body, null, 2)...}` 或 `[...]: (not found)` 单行备注
// 只重掩 kind==='Secret' 的 JSON 块(label 保留、JSON 重序列化缩进 null,2 与产出侧一致);
// 其余块/用户正文原样;整块 JSON.parse 失败跳过该块;结构残缺(未闭合/块后无 \n\n)剩余原样收尾。
// 块边界扫描与 stripRefsContext 同款平衡花括号算法(字符串字面量内的 {} 与转义不计数)。
// 返回 { text, masked } 或 null(无需改动)。
function scrubRefsCtxContent(content) {
  if (typeof content !== 'string' || !content.startsWith(REFS_CTX_HEADER)) return null
  let i = REFS_CTX_HEADER.length
  let out = content.slice(0, i)
  let masked = 0
  while (i < content.length) {
    if (content[i] !== '[') { out += content.slice(i); break } // 用户正文:原样收尾
    const labelEnd = content.indexOf(']:', i)
    if (labelEnd < 0) { out += content.slice(i); break }
    const j = labelEnd + 2
    let blockEnd = -1
    if (content[j] === '\n') {
      // JSON 块
      if (content[j + 1] !== '{') { out += content.slice(i); break }
      let depth = 0, inStr = false, esc = false
      for (let k = j + 1; k < content.length; k++) {
        const c = content[k]
        if (esc) { esc = false; continue }
        if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
        if (c === '"') { inStr = true; continue }
        if (c === '{') depth++
        else if (c === '}') { depth--; if (depth === 0) { blockEnd = k + 1; break } }
      }
      if (blockEnd < 0) { out += content.slice(i); break } // 未闭合:剩余原样
    } else {
      // 单行备注块((not found) 等):吃到行尾
      const nl = content.indexOf('\n', j)
      if (nl < 0) { out += content.slice(i); break }
      blockEnd = nl
    }
    // 块结束必须是 \n\n(块间分隔,或与用户正文的分界)
    if (!content.startsWith('\n\n', blockEnd)) { out += content.slice(i); break }
    let blockText = content.slice(i, blockEnd)
    if (content[j] === '\n') {
      try {
        const obj = JSON.parse(content.slice(j + 1, blockEnd))
        if (obj && obj.kind === 'Secret') {
          const re = `${content.slice(i, labelEnd + 2)}\n${JSON.stringify(maskSecretResource(obj), null, 2)}`
          // 幂等:重掩后逐字相同(已掩码短路)→不计
          if (re !== blockText) { blockText = re; masked++ }
        }
      } catch { /* 整块解析失败:跳过该块,原样保留 */ }
    }
    out += `${blockText}\n\n`
    i = blockEnd + 2
  }
  return masked ? { text: out, masked } : null
}

function isBadJson(text) {
  try { JSON.parse(text); return false } catch { return true }
}

export function scrubSecrets(db) {
  // 注:eventsMasked 计数含 trace 的 Secret 工具事件 + refsCtx 的 Secret 块(终审 I2 并入口径)
  const stats = { rowsScanned: 0, eventsMasked: 0 }
  for (const row of db.prepare("SELECT id, trace FROM workbench_conversations WHERE trace IS NOT NULL AND trace != '[]'").all()) {
    stats.rowsScanned++
    const r = scrubTraceJson(row.trace)
    if (r) { stats.eventsMasked += r.masked; db.prepare('UPDATE workbench_conversations SET trace=? WHERE id=?').run(r.json, row.id) }
    else if (isBadJson(row.trace)) console.warn(`[secret-scrub] workbench_conversations/${row.id}: trace 损坏 JSON,跳过`)
  }
  // 主键核对:workbench_messages 为 id TEXT PRIMARY KEY(seq 只是单调序号+索引,非主键)
  for (const row of db.prepare("SELECT id, trace FROM workbench_messages WHERE trace IS NOT NULL AND trace != '[]'").all()) {
    stats.rowsScanned++
    const r = scrubTraceJson(row.trace)
    if (r) { stats.eventsMasked += r.masked; db.prepare('UPDATE workbench_messages SET trace=? WHERE id=?').run(r.json, row.id) }
    else if (isBadJson(row.trace)) console.warn(`[secret-scrub] workbench_messages/${row.id}: trace 损坏 JSON,跳过`)
  }
  // 历史版本烤进 user content 的 refsCtx(终审 I2):只动 role='user' 且以 REFS_CTX_HEADER 起头的行
  for (const row of db.prepare("SELECT id, content FROM workbench_messages WHERE role='user' AND content IS NOT NULL AND content != ''").all()) {
    stats.rowsScanned++
    const r = scrubRefsCtxContent(row.content)
    if (r) { stats.eventsMasked += r.masked; db.prepare('UPDATE workbench_messages SET content=? WHERE id=?').run(r.text, row.id) }
  }
  return stats
}
