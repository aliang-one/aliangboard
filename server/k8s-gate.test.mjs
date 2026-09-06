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

test('equivalence matrix: hoisted decision == canAccessNs on allowlist clusters', () => {
  // 追加用户/授权,覆盖矩阵:admin、disabled、无分配、有分配无授权、view、operate、组授权
  const db = makeGateDb()
  db.prepare(`INSERT INTO platform_users (id, username, role, disabled, createdAt) VALUES (?,?,?,?,?)`)
    .run('u3', 'carol', 'user', 0, Date.now())
  db.prepare(`INSERT INTO platform_users (id, username, role, disabled, createdAt) VALUES (?,?,?,?,?)`)
    .run('u4', 'dan', 'user', 0, Date.now())
  db.prepare(`INSERT INTO user_clusters (userId, clusterId) VALUES (?,?)`).run('u3', 'c-allow')
  db.prepare(`INSERT INTO user_clusters (userId, clusterId) VALUES (?,?)`).run('u4', 'c-allow')
  db.prepare(`INSERT INTO ns_grants (id, subjectType, subjectId, clusterId, namespace, level, grantedAt) VALUES (?,?,?,?,?,?,?)`)
    .run('g2', 'user', 'u3', 'c-allow', 'team-a', 'operate', Date.now())
  db.prepare(`INSERT INTO groups (id, name, createdAt, createdBy) VALUES (?,?,?,?)`).run('grp1', 'g1', Date.now(), 'admin1')
  db.prepare(`INSERT INTO group_members (groupId, userId, addedBy, createdAt) VALUES (?,?,?,?)`).run('grp1', 'u4', 'admin1', Date.now())
  db.prepare(`INSERT INTO ns_grants (id, subjectType, subjectId, clusterId, namespace, level, grantedAt) VALUES (?,?,?,?,?,?,?)`)
    .run('g3', 'group', 'grp1', 'c-allow', 'team-b', 'view', Date.now())
  const gate = createK8sGate({ db, writeAudit })
  const cases = []
  for (const userId of ['u1', 'u2', 'u3', 'u4', 'admin1', 'ghost', 'u1-disabled']) {
    if (userId === 'u1-disabled') {
      db.prepare('UPDATE platform_users SET disabled=1 WHERE id=?').run('u1')
    }
    for (const ns of ['team-a', 'team-b', 'team-c', null]) {
      for (const level of ['view', 'operate']) {
        cases.push([userId, 'c-allow', ns, level])
      }
    }
  }
  for (const [userId, clusterId, ns, level] of cases) {
    // canAccessNs 无 namespace=null 语义(等价矩阵只比 ns 非空情形;null 分支由 gate 独有语义覆盖)
    const expected = ns == null ? (canAccessNs(db, { userId, role: undefined }, clusterId, 'team-a', level) && userId === 'admin1')
      : canAccessNs(db, { userId, role: undefined }, clusterId, ns, level)
    const got = gate.gateK8sSession({ userId, clusterId }, { namespace: ns, level })
    assert.equal(got, expected, `${userId}/${ns}/${level}: gate=${got} canAccessNs=${expected}`)
  }
})
