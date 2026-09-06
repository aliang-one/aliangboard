import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { makeAuthzDb } from './authz.test.mjs'
import { createAuditSchema, writeAudit } from './audit.mjs'
import { createK8sGate } from './k8s-gate.mjs'
import { canAccessNs } from './authz.mjs'

function seed(db) {
  db.prepare(`INSERT INTO platform_users (id, username, role, disabled, createdAt) VALUES (?,?,?,?,?)`)
    .run('u1', 'alice', 'user', 0, Date.now())
  db.prepare(`INSERT INTO platform_users (id, username, role, disabled, createdAt) VALUES (?,?,?,?,?)`)
    .run('u2', 'bob', 'user', 0, Date.now())
  db.prepare(`INSERT INTO platform_users (id, username, role, disabled, createdAt) VALUES (?,?,?,?,?)`)
    .run('admin1', 'root', 'admin', 0, Date.now())
  db.prepare(`INSERT INTO clusters (id, name, apiServer, nsAuthMode) VALUES (?,?,?,?)`)
    .run('c-open', 'open-cluster', 'https://a', 'open')
  db.prepare(`INSERT INTO clusters (id, name, apiServer, nsAuthMode) VALUES (?,?,?,?)`)
    .run('c-allow', 'allow-cluster', 'https://b', 'allowlist')
  db.prepare(`INSERT INTO user_clusters (userId, clusterId) VALUES (?,?)`).run('u1', 'c-allow')
  db.prepare(`INSERT INTO user_clusters (userId, clusterId) VALUES (?,?)`).run('u2', 'c-allow')
  db.prepare(`INSERT INTO user_clusters (userId, clusterId) VALUES (?,?)`).run('u1', 'c-open')
  // u1: view on team-a (c-allow); nothing on team-b
  db.prepare(`INSERT INTO ns_grants (id, subjectType, subjectId, clusterId, namespace, level, grantedAt) VALUES (?,?,?,?,?,?,?)`)
    .run('g1', 'user', 'u1', 'c-allow', 'team-a', 'view', Date.now())
}

function makeGateDb() {
  const db = makeAuthzDb()
  createAuditSchema(db)
  seed(db)
  return db
}
const auditRows = db => db.prepare('SELECT * FROM audit_log WHERE tool=?').all('k8s_gate')

test('open cluster → true, zero audit', () => {
  const db = makeGateDb()
  const gate = createK8sGate({ db, writeAudit })
  assert.equal(gate.gateK8sSession({ userId: 'u1', clusterId: 'c-open' }, { namespace: 'any', level: 'operate', path: '/api/v1/x', method: 'POST' }), true)
  assert.equal(auditRows(db).length, 0)
})

test('legacy session (!session.userId) → true, zero audit', () => {
  const db = makeGateDb()
  const gate = createK8sGate({ db, writeAudit })
  assert.equal(gate.gateK8sSession({ clusterId: 'c-allow' }, { namespace: 'team-a', level: 'operate' }), true)
  assert.equal(gate.gateK8sSession(undefined, { namespace: 'team-a' }), true)
  assert.equal(auditRows(db).length, 0)
})

test('allowlist + view grant → GET ok, POST denied + audit', () => {
  const db = makeGateDb()
  const gate = createK8sGate({ db, writeAudit })
  assert.equal(gate.gateK8sSession({ userId: 'u1', clusterId: 'c-allow' }, { namespace: 'team-a', level: 'view', path: '/api/v1/namespaces/team-a/pods', method: 'GET' }), true)
  assert.equal(gate.gateK8sSession({ userId: 'u1', clusterId: 'c-allow' }, { namespace: 'team-a', level: 'operate', path: '/api/v1/namespaces/team-a/pods', method: 'POST' }), false)
  const rows = auditRows(db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].result, 'denied')
  assert.equal(rows[0].namespace, 'team-a')
  assert.equal(rows[0].owner, 'u1')
  assert.equal(rows[0].clusterId, 'c-allow')
  assert.equal(rows[0].source, 'platform') // controller 裁决:平台侧审计口径
})

test('view session requesting operate level → false + audit', () => {
  const db = makeGateDb()
  const gate = createK8sGate({ db, writeAudit })
  assert.equal(gate.gateK8sSession({ userId: 'u1', clusterId: 'c-allow' }, { namespace: 'team-a', level: 'operate' }), false)
  assert.equal(auditRows(db).length, 1)
})

test('no grant on namespace → false + audit', () => {
  const db = makeGateDb()
  const gate = createK8sGate({ db, writeAudit })
  assert.equal(gate.gateK8sSession({ userId: 'u1', clusterId: 'c-allow' }, { namespace: 'team-b', level: 'view' }), false)
  assert.equal(auditRows(db).length, 1)
})

test('disabled user → false + audit', () => {
  const db = makeGateDb()
  db.prepare('UPDATE platform_users SET disabled=1 WHERE id=?').run('u1')
  const gate = createK8sGate({ db, writeAudit })
  assert.equal(gate.gateK8sSession({ userId: 'u1', clusterId: 'c-allow' }, { namespace: 'team-a', level: 'view' }), false)
  assert.equal(auditRows(db).length, 1)
})

test('cluster row missing → true, zero audit', () => {
  const db = makeGateDb()
  const gate = createK8sGate({ db, writeAudit })
  assert.equal(gate.gateK8sSession({ userId: 'u1', clusterId: 'c-missing' }, { namespace: 'team-a' }), true)
  assert.equal(auditRows(db).length, 0)
})

test('namespace=null (cluster-level outlet) on allowlist → false + audit; admin ok', () => {
  const db = makeGateDb()
  const gate = createK8sGate({ db, writeAudit })
  assert.equal(gate.gateK8sSession({ userId: 'u1', clusterId: 'c-allow' }, { namespace: null, level: 'view', path: '/api/v1/nodes', method: 'GET' }), false)
  const rows = auditRows(db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].result, 'denied')
  // admin passes cluster-level outlet
  db.prepare(`INSERT INTO user_clusters (userId, clusterId) VALUES (?,?)`).run('admin1', 'c-allow')
  assert.equal(gate.gateK8sSession({ userId: 'admin1', clusterId: 'c-allow' }, { namespace: null, level: 'view' }), true)
})

test('db throw → false + audit reason=db-error (fail-closed, controller ruling)', () => {
  const db = makeGateDb()
  const audits = []
  const gate = createK8sGate({ db, writeAudit: (d, e) => audits.push(e) })
  // 模拟运行时基础设施故障:gate 已 prepare 后底层表消失 → 调用时 get/all 抛
  db.exec('DROP TABLE user_clusters')
  assert.equal(gate.gateK8sSession({ userId: 'u1', clusterId: 'c-allow' }, { namespace: 'team-a', level: 'view' }), false)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].result, 'denied')
  assert.equal(audits[0].reason, 'db-error')
})

test('hoisted prepares: gate-owned SQL prepared exactly once across calls', () => {
  const db = makeGateDb()
  const preparedSql = []
  const countingDb = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql) => { preparedSql.push(sql); return target.prepare(sql) }
      }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  const gate = createK8sGate({ db: countingDb, writeAudit })
  const clusterSql = 'SELECT nsAuthMode FROM clusters WHERE id=?'
  gate.gateK8sSession({ userId: 'u1', clusterId: 'c-allow' }, { namespace: 'team-a', level: 'view' })
  const afterFirst = preparedSql.filter(s => s === clusterSql).length
  gate.gateK8sSession({ userId: 'u1', clusterId: 'c-allow' }, { namespace: 'team-a', level: 'view' })
  gate.gateK8sSession({ userId: 'u1', clusterId: 'c-allow' }, { namespace: 'team-a', level: 'view' })
  const afterThird = preparedSql.filter(s => s === clusterSql).length
  assert.equal(afterFirst, 1) // prepared once at first call
  assert.equal(afterThird, 1) // never re-prepared
})

test('unknown/missing level → deny + audit reason=bad-level (fail-closed, incl. admin)', () => {
  const db = makeGateDb()
  const audits = []
  const gate = createK8sGate({ db, writeAudit: (d, e) => audits.push(e) })
  const s = { userId: 'u1', clusterId: 'c-allow' }
  assert.equal(gate.gateK8sSession(s, { namespace: 'team-a', level: 'admin' }), false)
  assert.equal(gate.gateK8sSession(s, { namespace: 'team-a' }), false) // level 缺失
  // fail-closed 先于 admin 短路:调用方契约坏了宁可全拒
  assert.equal(gate.gateK8sSession({ userId: 'admin1', clusterId: 'c-allow' }, { namespace: 'team-a', level: 'write' }), false)
  assert.equal(gate.gateK8sSession({ userId: 'admin1', clusterId: 'c-allow' }, { namespace: 'team-a', level: 'view' }), true)
  assert.equal(audits.length, 3)
  assert.ok(audits.every(e => e.reason === 'bad-level'))
  // open/legacy 路径在 mode 检查即返回,level 校验不参与(ruling ② 顺序)
  assert.equal(gate.gateK8sSession({ userId: 'u1', clusterId: 'c-open' }, { namespace: 'x', level: 'nope' }), true)
  assert.equal(audits.length, 3)
})

test('equivalence matrix: hoisted decision == canAccessNs on allowlist clusters', () => {
  // 矩阵用户:授权覆盖 admin、disabled、无分配、有分配无授权、direct view、group operate、
  // direct view + group operate 同 ns 取高档(merge-takes-higher pin)。
  const db = makeGateDb()
  const insertUser = (id, name, disabled = 0) =>
    db.prepare(`INSERT INTO platform_users (id, username, role, disabled, createdAt) VALUES (?,?,?,?,?)`)
      .run(id, name, 'user', disabled, Date.now())
  insertUser('u3', 'carol')
  insertUser('u4', 'dan')
  insertUser('u5', 'eve') // 有授权但无 user_clusters 分配 → 两实现都必须 false
  insertUser('u6', 'fred', 1) // 禁用但有分配+授权 → 两实现都必须 false
  for (const [u, c] of [['u3', 'c-allow'], ['u4', 'c-allow'], ['u6', 'c-allow'], ['u2', 'c-open'], ['u3', 'c-open'], ['u4', 'c-open'], ['u5', 'c-open']]) {
    db.prepare(`INSERT INTO user_clusters (userId, clusterId) VALUES (?,?)`).run(u, c)
  }
  db.prepare(`INSERT INTO ns_grants (id, subjectType, subjectId, clusterId, namespace, level, grantedAt) VALUES (?,?,?,?,?,?,?)`)
    .run('g2', 'user', 'u3', 'c-allow', 'team-a', 'operate', Date.now())
  db.prepare(`INSERT INTO ns_grants (id, subjectType, subjectId, clusterId, namespace, level, grantedAt) VALUES (?,?,?,?,?,?,?)`)
    .run('g5', 'user', 'u5', 'c-allow', 'team-a', 'operate', Date.now()) // 无分配:不抬权
  db.prepare(`INSERT INTO ns_grants (id, subjectType, subjectId, clusterId, namespace, level, grantedAt) VALUES (?,?,?,?,?,?,?)`)
    .run('g6', 'user', 'u6', 'c-allow', 'team-a', 'operate', Date.now()) // 禁用:全拒
  db.prepare(`INSERT INTO groups (id, name, createdAt, createdBy) VALUES (?,?,?,?)`).run('grp1', 'g1', Date.now(), 'admin1')
  db.prepare(`INSERT INTO group_members (groupId, userId, addedBy, createdAt) VALUES (?,?,?,?)`).run('grp1', 'u4', 'admin1', Date.now())
  // u4 同 ns 双源:direct view + group operate → merge 取高档 operate(两实现一致)
  db.prepare(`INSERT INTO ns_grants (id, subjectType, subjectId, clusterId, namespace, level, grantedAt) VALUES (?,?,?,?,?,?,?)`)
    .run('g3', 'group', 'grp1', 'c-allow', 'team-b', 'operate', Date.now())
  db.prepare(`INSERT INTO ns_grants (id, subjectType, subjectId, clusterId, namespace, level, grantedAt) VALUES (?,?,?,?,?,?,?)`)
    .run('g4', 'user', 'u4', 'c-allow', 'team-b', 'view', Date.now())
  const gate = createK8sGate({ db, writeAudit })
  const enabledAssignedOpen = ['u1', 'u2', 'u3', 'u4', 'admin1'] // open 集群上与 canAccessNs 等价的集合

  for (const userId of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'admin1', 'ghost']) {
    for (const ns of ['team-a', 'team-b', 'team-c', null]) {
      for (const level of ['view', 'operate']) {
        // (a) allowlist 集群:逐点等价(含 null-ns 的 admin-only gate 语义)
        const expected = ns == null
          ? (canAccessNs(db, { userId, role: undefined }, 'c-allow', 'team-a', level) && userId === 'admin1')
          : canAccessNs(db, { userId, role: undefined }, 'c-allow', ns, level)
        const got = gate.gateK8sSession({ userId, clusterId: 'c-allow' }, { namespace: ns, level })
        assert.equal(got, expected, `allowlist ${userId}/${ns}/${level}: gate=${got} canAccessNs=${expected}`)
        // (c) open 集群行:enabled+assigned 用户两实现同为 true;u5/u6/ghost 是裁决②的
        //     有意分歧(gate 在 mode 检查即 true,不看用户;open 集群的用户筛选归上游会话有效性)
        const gateOpen = gate.gateK8sSession({ userId, clusterId: 'c-open' }, { namespace: ns, level })
        assert.equal(gateOpen, true, `open ${userId}/${ns}/${level} 必须恒 true(ruling ②)`)
        if (enabledAssignedOpen.includes(userId)) {
          const expectedOpen = ns == null
            ? canAccessNs(db, { userId, role: undefined }, 'c-open', 'team-a', level)
            : canAccessNs(db, { userId, role: undefined }, 'c-open', ns, level)
          assert.equal(expectedOpen, true, `open 等价前提:canAccessNs(${userId}) 应为 true`)
        }
      }
    }
  }
  // merge-takes-higher 显式钉点:u4 在 team-b 是 direct view + group operate → operate 通过
  assert.equal(gate.gateK8sSession({ userId: 'u4', clusterId: 'c-allow' }, { namespace: 'team-b', level: 'operate' }), true)
  assert.equal(canAccessNs(db, { userId: 'u4', role: undefined }, 'c-allow', 'team-b', 'operate'), true)
  // 无分配的授权不抬权(两实现一致 false)
  assert.equal(gate.gateK8sSession({ userId: 'u5', clusterId: 'c-allow' }, { namespace: 'team-a', level: 'operate' }), false)
  assert.equal(canAccessNs(db, { userId: 'u5', role: undefined }, 'c-allow', 'team-a', 'operate'), false)
})

// ===== W2 Phase B Batch B (Task 3/4): 接线辅助纯函数 =====
import { gateParsedPath, filterNamespaceList, gateWatchResources, applyDocNamespaces } from './k8s-gate.mjs'
import { levelForRequest as lfr } from './authz.mjs'
import { parseApiPath } from './k8s-path.mjs'

test('gateParsedPath: unparseable path → false for ALL session users (fail-closed)', () => {
  const db = makeGateDb()
  const gate = createK8sGate({ db, writeAudit })
  // admin session 也拒:admin console 走专用端点,透传面 session-only 裁决
  assert.equal(gateParsedPath(gate, { userId: 'admin1', clusterId: 'c-allow' }, parseApiPath('/api/v1/../pods'), { path: '/api/v1/../pods', method: 'GET' }), false)
  assert.equal(gateParsedPath(gate, { userId: 'u1', clusterId: 'c-open' }, parseApiPath('/api/v1/%2e%2e/x'), { path: 'x', method: 'GET' }), false)
})

test('gateParsedPath: ns-type view GET granted → true; operate with view grant → false + audit', () => {
  const db = makeGateDb()
  const gate = createK8sGate({ db, writeAudit })
  const sess = { userId: 'u1', clusterId: 'c-allow' }
  assert.equal(gateParsedPath(gate, sess, parseApiPath('/api/v1/namespaces/team-a/pods'), { path: '/api/v1/namespaces/team-a/pods', method: 'GET' }), true)
  assert.equal(gateParsedPath(gate, sess, parseApiPath('/api/v1/namespaces/team-a/pods'), { path: '/x', method: 'POST' }), false)
  assert.equal(auditRows(db).length, 1)
})

test('gateParsedPath: exec subresource on GET method still operate', () => {
  const db = makeGateDb()
  const gate = createK8sGate({ db, writeAudit })
  // u1 只有 view → exec(GET 语义上是读,但交互面恒 operate)拒
  assert.equal(gateParsedPath(gate, { userId: 'u1', clusterId: 'c-allow' }, parseApiPath('/api/v1/namespaces/team-a/pods/foo/exec'), { path: '/x', method: 'GET' }), false)
})

test('gateParsedPath: clusterScope GET passes; clusterScope non-GET → admin ok / allowlist user denied', () => {
  const db = makeGateDb()
  const gate = createK8sGate({ db, writeAudit })
  assert.equal(gateParsedPath(gate, { userId: 'u1', clusterId: 'c-allow' }, parseApiPath('/api/v1/nodes'), { path: '/api/v1/nodes', method: 'GET' }), true)
  assert.equal(gateParsedPath(gate, { userId: 'u1', clusterId: 'c-allow' }, parseApiPath('/api/v1/nodes'), { path: '/api/v1/nodes', method: 'POST' }), false)
  db.prepare(`INSERT INTO user_clusters (userId, clusterId) VALUES (?,?)`).run('admin1', 'c-allow')
  assert.equal(gateParsedPath(gate, { userId: 'admin1', clusterId: 'c-allow' }, parseApiPath('/api/v1/nodes'), { path: '/api/v1/nodes', method: 'POST' }), true)
})

test('gateParsedPath: namespaces collection GET → true (response filtered separately)', () => {
  const db = makeGateDb()
  const gate = createK8sGate({ db, writeAudit })
  assert.equal(gateParsedPath(gate, { userId: 'u1', clusterId: 'c-allow' }, parseApiPath('/api/v1/namespaces'), { path: '/api/v1/namespaces', method: 'GET' }), true)
})

test('filterNamespaceList: keeps granted ns, drops others; null grants → unchanged', () => {
  const items = [
    { metadata: { namespace: 'team-a', name: 'a' } },
    { metadata: { namespace: 'team-b', name: 'b' } },
    { metadata: { name: 'no-ns' } },
  ]
  const out = filterNamespaceList(items, new Set(['team-a']))
  assert.deepEqual(out.map(i => i.metadata.name || null), ['a'])
  assert.equal(filterNamespaceList(items, null), items) // admin/非 allowlist:不滤
})

test('gateWatchResources: any ungranted (cluster-wide watch = null ns) → false; legacy session → true; open cluster → true', () => {
  const db = makeGateDb()
  const gate = createK8sGate({ db, writeAudit })
  const list = [{ resource: 'pods', path: '/api/v1/pods' }, { resource: 'events', path: '/api/v1/events' }]
  // watch 白名单路径都是集群级 list(ns 过滤靠 fieldSelector)→ parse 出 namespace=null → allowlist 非 admin 拒
  assert.equal(gateWatchResources(gate, { userId: 'u1', clusterId: 'c-allow' }, list), false)
  assert.equal(gateWatchResources(gate, { clusterId: 'c-allow' }, list), true) // legacy 会话
  assert.equal(gateWatchResources(gate, { userId: 'u1', clusterId: 'c-open' }, list), true)
})

test('levelForRequest: outlet method mapping (terminals/podfile/pvcfile 按 method 分档)', () => {
  assert.equal(lfr('GET'), 'view')
  assert.equal(lfr('HEAD'), 'view')
  assert.equal(lfr('POST'), 'operate')
  assert.equal(lfr('PATCH'), 'operate')
  assert.equal(lfr('DELETE'), 'operate')
  assert.equal(lfr('GET', 'exec'), 'operate')
  assert.equal(lfr('GET', 'logs'), 'operate')
  assert.equal(lfr('GET', 'portforward'), 'operate')
  assert.equal(lfr('GET', 'attach'), 'operate')
})

// ===== 评审 R1:/api/apply 门与 applyYaml 解析链同源(显式 ns > defaultNs > 'default';
// 集群级 kind(discovery namespaced=false)→ undefined → null-ns 门;不可发现 kind → null → 不拦,apply 原语义失败) =====
const NS_P = { namespaced: true }, CS_P = { namespaced: false }

test('applyDocNamespaces: chain mirrors resolveApplyNamespace exactly (explicit > defaultNs > default; cluster-scoped → undefined; undiscoverable → null)', () => {
  const rf = o => o.kind === 'ClusterRole' ? CS_P : o.kind === 'Mystery' ? null : NS_P
  const docs = [
    { kind: 'Pod', metadata: { namespace: 'team-a' } },
    { kind: 'Pod', metadata: {} },
    { kind: 'ClusterRole', metadata: { name: 'cr' } },
    { kind: 'Mystery', metadata: {} },
  ]
  assert.deepEqual(applyDocNamespaces(docs, 'team-b', rf), ['team-a', 'team-b', undefined, null])
  assert.deepEqual(applyDocNamespaces([{ kind: 'Pod', metadata: {} }], undefined, rf), ['default'])
})

test('apply gate A (red): no-ns doc + defaultNs=team-b → team-b required; default-only operate user DENIED', () => {
  const db = makeGateDb()
  db.prepare(`INSERT INTO ns_grants (id, subjectType, subjectId, clusterId, namespace, level, grantedAt) VALUES (?,?,?,?,?,?,?)`)
    .run('g2', 'user', 'u2', 'c-allow', 'default', 'operate', Date.now())
  const gate = createK8sGate({ db, writeAudit })
  const sess = { userId: 'u2', clusterId: 'c-allow' }
  const nss = applyDocNamespaces([{ kind: 'Pod', metadata: {} }], 'team-b', () => NS_P)
  assert.deepEqual(nss, ['team-b']) // 修复前这里是 ['default'] → 误放行
  assert.equal(gate.gateK8sSession(sess, { namespace: nss[0], level: 'operate', path: '/api/apply', method: 'POST' }), false)
})

test('apply gate B (red): cluster-scoped doc (ClusterRole) → null-ns branch denies allowlist non-admin; admin passes', () => {
  const db = makeGateDb()
  db.prepare(`INSERT INTO ns_grants (id, subjectType, subjectId, clusterId, namespace, level, grantedAt) VALUES (?,?,?,?,?,?,?)`)
    .run('g2', 'user', 'u2', 'c-allow', 'default', 'operate', Date.now())
  const gate = createK8sGate({ db, writeAudit })
  const nss = applyDocNamespaces([{ kind: 'ClusterRole', metadata: { name: 'x' } }], undefined, () => CS_P)
  assert.deepEqual(nss, [undefined]) // 集群级:undefined(修复前被误当成 'default' ns 门 → 绕过)
  assert.equal(gate.gateK8sSession({ userId: 'u2', clusterId: 'c-allow' }, { namespace: nss[0] ?? null, level: 'operate' }), false)
  db.prepare(`INSERT INTO user_clusters (userId, clusterId) VALUES (?,?)`).run('admin1', 'c-allow')
  assert.equal(gate.gateK8sSession({ userId: 'admin1', clusterId: 'c-allow' }, { namespace: nss[0] ?? null, level: 'operate' }), true)
})

test('apply gate C: operate on team-a + doc ns=team-a + no defaultNs → allowed (no unconditional-default over-block)', () => {
  const db = makeGateDb()
  db.prepare(`INSERT INTO ns_grants (id, subjectType, subjectId, clusterId, namespace, level, grantedAt) VALUES (?,?,?,?,?,?,?)`)
    .run('g2', 'user', 'u2', 'c-allow', 'team-a', 'operate', Date.now())
  const gate = createK8sGate({ db, writeAudit })
  const nss = applyDocNamespaces([{ kind: 'Pod', metadata: { namespace: 'team-a' } }], undefined, () => NS_P)
  assert.deepEqual(nss, ['team-a'])
  assert.equal(gate.gateK8sSession({ userId: 'u2', clusterId: 'c-allow' }, { namespace: nss[0], level: 'operate' }), true)
})
