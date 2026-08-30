// 平台会话保留策略(2026-08-30 设计 §3):过期回收 + 每用户数量上限。
// 纯函数模块,platformSessions/sessions/db 显式注入,便于单测(auth-selfservice 同款模式)。
// 过期判据与 index.mjs platformUserFromRequest 的懒删除完全一致:now - createdAt > ttl(绝对寿命)。

// 单会话三处回收:内存 platformSessions + platform_sessions 表 + 该会话接入的 K8s 凭据。
// 与改密/吊销路径同款;懒删除此前缺第 3 步,这里统一补齐。单条 DB 失败不抛(内存已清,下轮 sweep 兜底)。
function removeSessionRecord(platformSessions, db, sessions, token) {
  const rec = platformSessions.get(token)
  platformSessions.delete(token)
  try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(token) } catch { /* 表缺失/库不可用 */ }
  const k8sTok = rec?.k8sSessionToken
  if (k8sTok) {
    sessions.delete(k8sTok)
    try { db.prepare('DELETE FROM sessions WHERE token=?').run(k8sTok) } catch { /* 同上 */ }
  }
}

// 回收全部过期会话(启动一次 + 60s sweep 兜底),返回清理条数。
export function reapExpiredSessions({ platformSessions, db, sessions, now = Date.now(), ttlMs }) {
  let expired = 0
  for (const [token, rec] of Array.from(platformSessions)) {
    try {
      if (now - rec.createdAt > ttlMs) { removeSessionRecord(platformSessions, db, sessions, token); expired++ }
    } catch { /* 单条失败不中断整批 */ }
  }
  return { expired }
}
