// server/secret-scrub.mjs
// 存量明文清洗(spec §3.3,2026-08-28):扫对话级+消息级 trace,对 result.resource.kind==='Secret'
// 的事件重掩。幂等(重掩后 JSON 不变的事件不计不写);损坏行跳过。audit_log 不动(凭证+hash 链)。启动后异步跑,不阻塞。
import { maskSecretResource } from './secret-mask.mjs'

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

export function scrubSecrets(db) {
  const stats = { rowsScanned: 0, eventsMasked: 0 }
  for (const row of db.prepare("SELECT id, trace FROM workbench_conversations WHERE trace IS NOT NULL AND trace != '[]'").all()) {
    stats.rowsScanned++
    const r = scrubTraceJson(row.trace)
    if (r) { stats.eventsMasked += r.masked; db.prepare('UPDATE workbench_conversations SET trace=? WHERE id=?').run(r.json, row.id) }
  }
  // 主键核对:workbench_messages 为 id TEXT PRIMARY KEY(seq 只是单调序号+索引,非主键)
  for (const row of db.prepare("SELECT id, trace FROM workbench_messages WHERE trace IS NOT NULL AND trace != '[]'").all()) {
    stats.rowsScanned++
    const r = scrubTraceJson(row.trace)
    if (r) { stats.eventsMasked += r.masked; db.prepare('UPDATE workbench_messages SET trace=? WHERE id=?').run(r.json, row.id) }
  }
  return stats
}
