// W2 Phase B (Task 2): K8s 会话执行门(session enforcement gate)。
// createK8sGate({ db, writeAudit }) → { gateK8sSession(session, { namespace, level, path, method }) }。
// 语义(controller rulings):
//   ① !session.userId(legacy 会话)→ true(零审计);
//   ② clusters 行不存在或 nsAuthMode!=='allowlist' → true(零审计);
//   ③ namespace=null(集群级出口)在 allowlist 集群上 → false + 审计(集群级操作需 admin,
//      admin 短路通过);open/legacy → true;
//   ④ allowlist ns 决策:与 canAccessNs(authz.mjs)语义逐点一致——admin 短路 true;
//      禁用/不存在用户 false;须有 user_clusters 分配;直接授权 ∪ 组授权 取高档 ≥ 需求档。
//      热路径上全部查询用提升语句(equivalence 由 k8s-gate.test.mjs 对 canAccessNs 矩阵钉住)。
//   ⑤ db 抛异常 → false + 审计 reason='db-error'(fail-closed——控制器裁决:网关拒绝路径
//      fail-open 等于放行,与 sessionOwnerValid 口径一致)。
// 拒绝审计 shape:tool='k8s_gate', result='denied', owner/clusterId/namespace/verb/resource/path。
import { canAccessNs } from './authz.mjs' // 语义参考(等价测试对照实现)

const LEVEL_RANK = { view: 0, operate: 1 }

export function createK8sGate({ db, writeAudit }) {
  if (!db) throw new Error('createK8sGate: db is required')
  // Prepare 提升:全部语句在 create 时一次准备,热路径只 get/all。
  const stmts = {
    clusterMode: db.prepare('SELECT nsAuthMode FROM clusters WHERE id=?'),
    user: db.prepare('SELECT role FROM platform_users WHERE id=? AND disabled=0'),
    assignment: db.prepare('SELECT 1 FROM user_clusters WHERE userId=? AND clusterId=?'),
    grants: db.prepare(`
      SELECT g.namespace AS ns, g.level AS level FROM ns_grants g
      WHERE g.subjectType='user' AND g.subjectId=? AND g.clusterId=?
      UNION ALL
      SELECT g.namespace, g.level FROM ns_grants g
      JOIN group_members m ON m.groupId=g.subjectId AND m.userId=?
      WHERE g.subjectType='group' AND g.clusterId=?`),
  }

  function deny(session, { namespace, level, path, method }, reason) {
    try {
      writeAudit(db, {
        tool: 'k8s_gate',
        result: 'denied',
        reason,
        owner: session?.userId ?? null,
        clusterId: session?.clusterId ?? null,
        namespace: namespace ?? null,
        verb: method ?? null,
        resource: path ?? null,
        requestSummary: path ?? null,
      })
    } catch { /* 审计写失败不改变拒绝结论 */ }
    return false
  }

  // allowlist 集群上的 ns/集群级决策(与 canAccessNs 语义一致;namespace=null 仅 admin 过)。
  function allow(session, clusterId, namespace, level) {
    const u = stmts.user.get(session.userId)
    if (!u) return false // 不存在/禁用用户
    if (u.role === 'admin') return true
    if (namespace == null) return false // 集群级出口:非 admin 一律拒
    if (!stmts.assignment.get(session.userId, clusterId)) return false
    const need = LEVEL_RANK[level] ?? LEVEL_RANK.view
    let best
    for (const { ns, level: lv } of stmts.grants.all(session.userId, clusterId, session.userId, clusterId)) {
      if (ns === namespace && (best === undefined || LEVEL_RANK[lv] > LEVEL_RANK[best])) best = lv
    }
    return best !== undefined && LEVEL_RANK[best] >= need
  }

  function gateK8sSession(session, { namespace, level, path, method } = {}) {
    if (!session?.userId) return true // legacy 会话:W2 前存量行为,零审计
    try {
      const cluster = stmts.clusterMode.get(session.clusterId)
      if (!cluster || cluster.nsAuthMode !== 'allowlist') return true
      return allow(session, session.clusterId, namespace, level || 'view')
        || deny(session, { namespace, level, path, method },
          namespace == null ? 'cluster-level-op' : 'ns-denied')
    } catch {
      return deny(session, { namespace, level, path, method }, 'db-error') // fail-closed(控制器裁决)
    }
  }

  return { gateK8sSession }
}
