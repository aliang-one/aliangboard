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
