// W2 Phase A (Task 2): 授权单一决策源。
// 纯函数 + db 参数,不挂任何端点/数据面(Batch B / Phase B,C 接线)。
// 语义(spec §3 + 裁决):
//   - effectiveGrants(db, principal):合成用户有效授权。admin → 内部态
//     { role:'admin', clusters:'ALL' };禁用/匿名 → 空 grants(全拒)。
//   - canAccessCluster:admin 短路 true;其余须在 user_clusters 有分配行。
//   - canAccessNs:先过 canAccessCluster(分配/管理),再按集群 nsAuthMode:
//     open → 任意 ns 全通;allowlist → 直接授权 ∪ 组授权 取高档,不足即拒。
//   - levelForRequest(method, subresource):GET/HEAD → view,写 → operate;
//     exec/logs/portforward/attach/log 子资源恒 operate(交互/流式面;spec §4,log 是 pod-log 真实形态)。
const SUBRESOURCE_OPERATE = new Set(['exec', 'logs', 'portforward', 'attach', 'log'])
const LEVEL_RANK = { view: 0, operate: 1 }

export function levelForRequest(method, subresource) {
  if (subresource && SUBRESOURCE_OPERATE.has(subresource)) return 'operate'
  return (method === 'GET' || method === 'HEAD') ? 'view' : 'operate'
}

function userDisabled(db, userId) {
  const row = db.prepare('SELECT disabled FROM platform_users WHERE id=?').get(userId)
  return !row || !!row.disabled
}

export function effectiveGrants(db, principal) {
  if (!principal?.userId) return { role: 'user', clusters: new Map() }
  const row = db.prepare('SELECT role FROM platform_users WHERE id=? AND disabled=0').get(principal.userId)
  if (!row) return { role: 'user', clusters: new Map() } // 不存在/禁用 → 空 grants
  if (row.role === 'admin') return { role: 'admin', clusters: 'ALL' }
  const clusterRows = db.prepare(`SELECT c.id AS id, c.nsAuthMode AS mode FROM user_clusters uc JOIN clusters c ON c.id=uc.clusterId WHERE uc.userId=?`).all(principal.userId)
  const clusters = new Map()
  for (const { id, mode } of clusterRows) clusters.set(id, { mode, ns: new Map() })
  // 直接授权(user)+ 组授权(member),同 ns 取高档
  const grantRows = db.prepare(`
    SELECT g.clusterId AS clusterId, g.namespace AS ns, g.level AS level
    FROM ns_grants g WHERE g.subjectType='user' AND g.subjectId=?
    UNION ALL
    SELECT g.clusterId, g.namespace, g.level
    FROM ns_grants g JOIN group_members m ON m.groupId=g.subjectId AND m.userId=?
    WHERE g.subjectType='group'`).all(principal.userId, principal.userId)
  for (const { clusterId, ns, level } of grantRows) {
    const entry = clusters.get(clusterId)
    if (!entry) continue // 授权指向未分配集群:不抬权(分配是可见性前提)
    const prev = entry.ns.get(ns)
    if (prev === undefined || LEVEL_RANK[level] > LEVEL_RANK[prev]) entry.ns.set(ns, level)
  }
  return { role: 'user', clusters }
}

export function canAccessCluster(db, principal, clusterId) {
  if (!principal?.userId) return false
  const row = db.prepare('SELECT role FROM platform_users WHERE id=? AND disabled=0').get(principal.userId)
  if (!row) return false
  if (row.role === 'admin') return true
  return !!db.prepare('SELECT 1 FROM user_clusters WHERE userId=? AND clusterId=?').get(principal.userId, clusterId)
}

export function canAccessNs(db, principal, clusterId, namespace, needLevel = 'view') {
  if (!principal?.userId) return false
  if (!canAccessCluster(db, principal, clusterId)) return false
  const row = db.prepare('SELECT role FROM platform_users WHERE id=? AND disabled=0').get(principal.userId)
  if (row.role === 'admin') return true
  const cluster = db.prepare('SELECT nsAuthMode FROM clusters WHERE id=?').get(clusterId)
  const mode = cluster?.nsAuthMode || 'open'
  if (mode === 'open') return true
  const best = effectiveGrants(db, principal).clusters.get(clusterId)?.ns.get(namespace)
  return best !== undefined && LEVEL_RANK[best] >= LEVEL_RANK[needLevel]
}

// 删 subject 已不存在的残留行(用户删除漏清 group_members;组删除/用户删除漏清 ns_grants)。
// 返回 { members, grants } 清理计数。幂等,可挂在周期 sweep。
export function sweepOrphanGrants(db) {
  const members = db.prepare('DELETE FROM group_members WHERE userId NOT IN (SELECT id FROM platform_users)').run().changes
  const grants = db.prepare(`DELETE FROM ns_grants WHERE
    (subjectType='user' AND subjectId NOT IN (SELECT id FROM platform_users))
    OR (subjectType='group' AND subjectId NOT IN (SELECT id FROM groups))`).run().changes
  return { members, grants }
}
