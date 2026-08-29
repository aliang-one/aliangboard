// 平台会话 lastSeenAt 节流回写(2026-08-29 用户中心设计 §4.1)。
// 热路径约束:requirePlatform 每请求都会走这里——内存(ps.lastSeenAt)即时更新,
// SQLite 同步写按 minIntervalMs 节流(默认 60s,单会话 ≤1 写/分钟)。
export function touchSession(db, ps, { now = Date.now(), minIntervalMs = 60_000 } = {}) {
  if (!ps?.token) return false
  if (ps.lastSeenAt && now - ps.lastSeenAt < minIntervalMs) return false
  ps.lastSeenAt = now
  try {
    db.prepare('UPDATE platform_sessions SET lastSeenAt=? WHERE token=?').run(now, ps.token)
    return true
  } catch { return false }
}
