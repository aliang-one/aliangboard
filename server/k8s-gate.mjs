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

import { parseApiPath } from './k8s-path.mjs'
import { levelForRequest } from './authz.mjs'
// re-export:apply 门解析辅助定义在 apply-yaml.mjs(与 resolveApplyNamespace 同文件防漂移),此处转出口供接线方/测试统一从 k8s-gate 引入。
export { applyDocNamespaces } from './apply-yaml.mjs'

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

  // M1(final-review):透传面遇到无法解析的路径 → 拒绝 + 审计 reason='unparseable-path'。
  // 与 gateK8sSession 的 deny 同 shape(含 legacy/open 会话也记:路径解析失败本身是异常信号)。
  function noteUnparseable(session, { path, method } = {}) {
    try {
      writeAudit(db, {
        tool: 'k8s_gate',
        result: 'denied',
        source: 'platform',
        reason: 'unparseable-path',
        owner: session?.userId ?? null,
        clusterId: session?.clusterId ?? null,
        namespace: null,
        verb: method ?? null,
        resource: path ?? null,
        requestSummary: path ?? null,
      })
    } catch { /* 审计写失败不改变拒绝结论 */ }
  }

  return { gateK8sSession, noteUnparseable }
}

// ===== Batch B (Task 3) 接线辅助纯函数:index.mjs 透传/watch 的判定收口 =====

// 透传判定:parsed = parseApiPath(path)。规则(controller 裁决 2026-09-06;final-review
// I1 修订 2026-09-06:clusterScope GET 不再放行,GET/非 GET 一律过 null-ns 门 —— 修复
// events/CRD 等集群级读泄漏,并与 k8s-watch 口径一致):
//   - parsed === null(无法解析)→ false,**对所有 session 用户一律拒**(含 admin:
//     admin console 走专用端点,透传面是 session-only 面;调用方返回 403)+ 审计
//     reason='unparseable-path'(M1)。
//   - clusterScope(namespace=null,allNamespaces=false)→ gateK8sSession(namespace=null,
//     levelForRequest(method, subresource)):admin/open/legacy 过,allowlist 非 admin 拒。
//   - ns 型(含 allNamespaces=true 的 null-ns 全 ns list,spec §2.4)→
//     gateK8sSession(namespace, levelForRequest(method, subresource))。
export function gateParsedPath(gate, session, parsed, { path, method } = {}) {
  if (!parsed) {
    gate.noteUnparseable?.(session, { path, method })
    return false
  }
  // 复审修订(2026-09-06):namespace 对象生命周期写(DELETE/PATCH /api/v1/namespaces/<name>)
  // = 集群级操作 → 改走 null-ns 门(allowlist 非 admin 拒;K8s 惯例 ns 生命周期归 cluster-admin,
  // ns 型 operate 授权不应外溢到 Namespace 对象本身)。GET 仍按 namespace=<name> 的 ns view 门。
  if (parsed.resource === 'namespaces' && parsed.name && method !== 'GET') parsed = { ...parsed, namespace: null }
  return gate.gateK8sSession(session, {
    namespace: parsed.namespace ?? null,
    level: levelForRequest(method, parsed.subresource),
    path, method,
  })
}

// namespaces 集合列表的响应面过滤:grantedNs = Set<namespace>(null/undefined = 不过滤,
// 即 admin 会话或非 allowlist 集群——是否滤由调用方按 effectiveGrants+cluster mode 决定)。
export function filterNamespaceList(items, grantedNs) {
  if (!Array.isArray(items) || grantedNs == null) return items
  return items.filter(it => grantedNs.has(it?.metadata?.namespace))
}

// watch 多路复用通道:每条资源 watch 建流前逐项过 view 门。WATCH_RESOURCES 白名单路径都是
// 集群级 list(ns 过滤由前端 fieldSelector 追加)→ stream 内容覆盖全集群 → namespace=null 口径:
// allowlist 非 admin 拒(admin 短路;open/legacy 集群照常放行)。任一项不过 → 整流拒。
export function gateWatchResources(gate, session, list) {
  for (const item of list) {
    const p = parseApiPath(String(item?.path || '').split('?')[0])
    if (!gate.gateK8sSession(session, { namespace: p?.namespace ?? null, level: 'view', path: item?.path, method: 'GET' })) return false
  }
  return true
}