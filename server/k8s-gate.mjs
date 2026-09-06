// W2 Phase B (Task 2): K8s 会话执行门(session enforcement gate)。
// createK8sGate({ db, writeAudit }) → { gateK8sSession(session, { namespace, level, path, method }) }。
// 语义(controller rulings):
//   ① !session.userId(legacy 会话)→ true(零审计);
//   ② clusters 行不存在或 nsAuthMode!=='allowlist' → true(零审计);
//   ③ namespace=null(集群级出口)在 allowlist 集群上 → 非 admin 拒 + 审计;admin 短路通过
//      (裁决 2026-09-06:admin 是平台操作者,canAccessNs 全路径 admin 短路,集群级出口同口径放行);
//      open/legacy → true;
//   ④ allowlist ns 决策:与 canAccessNs(authz.mjs)语义逐点一致——admin 短路 true;
//      禁用/不存在用户 false;须有 user_clusters 分配;直接授权 ∪ 组授权 取高档 ≥ 需求档。
//      热路径上全部查询用提升语句(equivalence 由 k8s-gate.test.mjs 对 canAccessNs 矩阵钉住)。
//   ⑤ level 不在 {view,operate}(未知/缺失)→ 拒 + reason='bad-level'(fail-closed,先于
//      admin 短路——调用方契约坏了宁可全拒);
//   ⑥ db 抛异常 → false + 审计 reason='db-error'(fail-closed——控制器裁决:网关拒绝路径
//      fail-open 等于放行,与 sessionOwnerValid 口径一致)。
// 拒绝审计 shape:tool='k8s_gate', result='denied', source='platform'(平台侧会话口径),
// owner/clusterId/namespace/verb/resource/path。

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
        source: 'platform', // 平台会话口径(controller 裁决:与 platform 侧审计约定对齐)
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

  // allowlist 集群上的 ns/集群级决策(与 canAccessNs 语义一致)。
  function allow(session, clusterId, namespace, level) {
    const u = stmts.user.get(session.userId)
    if (!u) return false // 不存在/禁用用户
    if (u.role === 'admin') return true // admin 是平台操作者:全路径短路,含 namespace=null 集群级出口(裁决)
    if (namespace == null) return false // 集群级出口:非 admin 一律拒
    if (!stmts.assignment.get(session.userId, clusterId)) return false
    const need = LEVEL_RANK[level] // bad-level 已在 gateK8sSession 前置拒绝,这里无需兜底
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
      // 调用方契约:level 必须是 {view,operate} 之一;未知/缺失 → 拒(先于 admin 短路,fail-closed)。
      if (level !== 'view' && level !== 'operate') {
        return deny(session, { namespace, level, path, method }, 'bad-level')
      }
      return allow(session, session.clusterId, namespace, level)
        || deny(session, { namespace, level, path, method },
          namespace == null ? 'cluster-level-op' : 'ns-denied')
    } catch {
      return deny(session, { namespace, level, path, method }, 'db-error') // fail-closed(控制器裁决)
    }
  }

  return { gateK8sSession }
}
