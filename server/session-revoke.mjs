// CSO 2026-08-30 #3/#11:会话与 K8s 凭据此前只在「用户自己」的路径上吊销 ——
// 管理员删除/禁用/降级/重置密码对存量会话全部无效。本模块是唯一的级联吊销收口。
export function revokeUserSessions({ db, platformSessions, sessions }, userId, { exceptToken } = {}) {
  let revoked = 0
  let rows = []
  try { rows = db.prepare('SELECT token, k8sSessionToken FROM platform_sessions WHERE userId=?').all(userId) } catch { return 0 }
  for (const r of rows) {
    if (exceptToken && r.token === exceptToken) continue
    try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(r.token) } catch { /* noop */ }
    if (r.k8sSessionToken) {
      sessions?.delete(r.k8sSessionToken)
      try { db.prepare('DELETE FROM sessions WHERE token=?').run(r.k8sSessionToken) } catch { /* noop */ }
    }
    revoked++
  }
  if (platformSessions) for (const [tok, s] of Array.from(platformSessions)) {
    if (s?.userId === userId && !(exceptToken && tok === exceptToken)) platformSessions.delete(tok)
  }
  return revoked
}

// W2-0 §0.4-2:取消集群分配 → 吊销该用户在指定集群上的全部 K8s session。双路径:
// ①新归属列直查;②存量无归属行走 platform_sessions.k8sSessionToken 链 + 内存 clusterId 兜底。
// 被吊 token 若是某 platform_session 的 k8sSessionToken,置 NULL(platform session 本身存活)。
export function revokeUserClusterSessions({ db, sessions, platformSessions }, userId, clusterIds) {
  const targets = (clusterIds || []).filter(Boolean)
  if (!db || !targets.length) return 0
  const removed = new Set()
  let rows = []
  try { rows = db.prepare(`SELECT token FROM sessions WHERE userId=? AND clusterId IN (${targets.map(() => '?').join(',')})`).all(userId, ...targets) } catch { rows = [] }
  for (const r of rows) removed.add(r.token)
  // platform 链兜底:该用户全部 platform session 的 k8s token,内存对象 clusterId 命中即吊(存量行表里可能无)
  let ps = []
  try { ps = db.prepare('SELECT token, k8sSessionToken FROM platform_sessions WHERE userId=?').all(userId) } catch { ps = [] }
  for (const r of ps) {
    if (!r.k8sSessionToken || removed.has(r.k8sSessionToken)) continue
    const mem = sessions?.get(r.k8sSessionToken)
    if (mem && targets.includes(mem.clusterId)) removed.add(r.k8sSessionToken)
  }
  for (const tok of removed) {
    try { db.prepare('DELETE FROM sessions WHERE token=?').run(tok) } catch { /* noop */ }
    sessions?.delete(tok)
    try { db.prepare('UPDATE platform_sessions SET k8sSessionToken=NULL WHERE k8sSessionToken=?').run(tok) } catch { /* noop */ }
    if (platformSessions) for (const s of platformSessions.values()) if (s?.k8sSessionToken === tok) s.k8sSessionToken = null
  }
  return removed.size
}

// W2-0 §0.4-3:删除集群 → 吊销所有用户在该集群的 session(同款双路径,不限 user)。
export function revokeClusterSessions({ db, sessions, platformSessions }, clusterId) {
  if (!db || !clusterId) return 0
  const removed = new Set()
  let rows = []
  try { rows = db.prepare('SELECT token FROM sessions WHERE clusterId=?').all(clusterId) } catch { rows = [] }
  for (const r of rows) removed.add(r.token)
  if (sessions) for (const [tok, s] of Array.from(sessions)) if (s?.clusterId === clusterId) removed.add(tok)
  for (const tok of removed) {
    try { db.prepare('DELETE FROM sessions WHERE token=?').run(tok) } catch { /* noop */ }
    sessions?.delete(tok)
    try { db.prepare('UPDATE platform_sessions SET k8sSessionToken=NULL WHERE k8sSessionToken=?').run(tok) } catch { /* noop */ }
    if (platformSessions) for (const s of platformSessions.values()) if (s?.k8sSessionToken === tok) s.k8sSessionToken = null
  }
  return removed.size
}
