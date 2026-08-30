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

// 每用户会话数量上限(2026-08-30 设计 §3.1):登录建新会话后调用,超 max 从最久未活跃开始踢。
// keepToken(刚登录的会话)永不踢;max<1 视作关闭。被踢会话经 removeSessionRecord 三处同清。
export function enforceSessionCap({ platformSessions, db, sessions, userId, owner, max, keepToken, now = Date.now(), writeAudit }) {
  if (!max || max < 1) return { evicted: 0 }
  const mine = []
  for (const [token, rec] of platformSessions) {
    if (rec.userId !== userId) continue
    mine.push({ token, lastActive: rec.lastSeenAt ?? rec.createdAt ?? 0 })
  }
  if (mine.length <= max) return { evicted: 0 }
  mine.sort((a, b) => a.lastActive - b.lastActive)  // 最久未活跃在前
  let evicted = 0
  for (const { token } of mine) {
    if (mine.length - evicted <= max) break
    if (token === keepToken) continue
    try {
      removeSessionRecord(platformSessions, db, sessions, token)
      evicted++
    } catch { /* 单条失败不中断 */ }
  }
  if (evicted > 0) {
    try {
      writeAudit?.(db, { owner: owner ?? String(userId ?? ''), verb: 'revoke', tool: 'platform_session_evict',
        result: 'ok', requestSummary: `evicted=${evicted} max=${max}`, source: 'platform' })
    } catch { /* 审计失败不阻断 */ }
  }
  return { evicted }
}
