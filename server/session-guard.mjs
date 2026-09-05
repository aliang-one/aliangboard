// K8s session 逐请求归属复检(W2-0 §0.4):会话凭据是 bearer 型,归属列让服务端能判
// 「持有人是否仍有效」。对齐 resolveApiKey 的实时收权语义(请求时求值,公理 4)。
// 无归属的存量会话(升级前落库)兼容放行——活到 TTL,升级不批量杀会话。
export function sessionOwnerValid(db, session) {
  if (!db || !session?.userId) return true
  try {
    const u = db.prepare('SELECT role, disabled FROM platform_users WHERE id=?').get(session.userId)
    if (!u || u.disabled) return false
    if (u.role !== 'admin' && session.clusterId) {
      const assigned = db.prepare('SELECT 1 FROM user_clusters WHERE userId=? AND clusterId=?').get(session.userId, session.clusterId)
      if (!assigned) return false
    }
    return true
  } catch { return false }
}
