// 任务栏窗口记录(terminals / file_browsers)的归属迁移与孤儿清理(2026-09-03)。
// 背景:两类记录以 K8s session token 为归属键,token 因 8h TTL 过期/集群重连而轮换后,
// 新 token 查不到旧记录 → 任务栏「记录消失」且旧行永久变孤儿(网络差→频繁重连是常见诱因)。
// rekeyWindowRecords:客户端重连同一集群后出示旧 token,把其名下记录迁到新 token——
// 授权语义(2026-09-04 加固):出示的旧 token 必须是网关见过的会话行(isKnownSessionToken),
// 否则「出示 ≈ 持有凭据」不成立——任意有效会话可凭一段猜来的 token 吸收他人记录。
// purgeOrphanWindowRecords:超龄记录无条件清理,防孤儿无界增长(不按 token 判——
// 旧 token 的 session 行可能已被过期回收,按归属判会误删可迁移数据)。

const REKEY_TABLES = ['terminals', 'file_browsers']

// from token 是否为网关见过的会话行。过期行由 sessionSweeper 周期删除(默认 8h TTL):
// 轮换后长时间(>TTL)才回来的迁移会被拒——记录按 30d 兜底清扫,不无限等待。
export function isKnownSessionToken(db, token) {
  const t = String(token || '')
  if (!t) return false
  try { return !!db.prepare('SELECT token FROM sessions WHERE token = ?').get(t) } catch { return false }
}

export function rekeyWindowRecords(db, fromToken, toToken) {
  const from = String(fromToken || '')
  const to = String(toToken || '')
  if (!from || !to || from === to) throw new Error('rekey: from/to 必须为非空且不同的 token')
  const moved = {}
  for (const t of REKEY_TABLES) {
    // 同 id 冲突(极小概率:两端各自创建过同 id)跳过该行,不中断整体迁移
    const r = db.prepare(`UPDATE OR IGNORE ${t} SET sessionToken = ? WHERE sessionToken = ?`).run(to, from)
    moved[t] = r.changes
  }
  return moved
}

export function purgeOrphanWindowRecords(db, maxAgeMs, now = Date.now()) {
  const cutoff = now - maxAgeMs
  const purged = {}
  for (const t of REKEY_TABLES) {
    const r = db.prepare(`DELETE FROM ${t} WHERE createdAt < ?`).run(cutoff)
    purged[t] = r.changes
  }
  return purged
}
