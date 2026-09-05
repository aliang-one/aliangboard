// W2 Phase A Task 3: admin 组/成员/授权/集群 ns 模式管理端点路由级测试。
// 工厂照 admin-clusters-revoke.test.mjs;表结构照 index.mjs/authz.test.mjs(内存库)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createAdminRoutes } from './routes/admin.mjs'

function makeHarness() {
  const sent = []
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', displayName TEXT, createdAt INTEGER NOT NULL, disabled INTEGER DEFAULT 0)`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, assignedBy TEXT, assignedAt INTEGER)`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT, nsAuthMode TEXT DEFAULT 'open')`)
  db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, createdBy TEXT)`)
  db.exec(`CREATE TABLE group_members (groupId TEXT NOT NULL, userId TEXT NOT NULL, addedBy TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY (groupId, userId))`)
  db.exec(`CREATE TABLE ns_grants (id TEXT PRIMARY KEY, subjectType TEXT NOT NULL, subjectId TEXT NOT NULL, clusterId TEXT NOT NULL, namespace TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'view', grantedBy TEXT, grantedAt INTEGER NOT NULL, UNIQUE(subjectType,subjectId,clusterId,namespace))`)
  db.exec(`CREATE TABLE api_keys (id TEXT PRIMARY KEY, ownerUserId TEXT, revokedAt INTEGER)`)
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u1','alice','x','user',1)").run()
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('adm','admin','x','admin',1)").run()
  db.prepare("INSERT INTO clusters (id,name,nsAuthMode) VALUES ('c1','cluster-one','open')").run()
  const routes = createAdminRoutes({
    db, sendJson: (r, s, j) => sent.push({ status: s, json: j }),
    readBody: async () => harness._body, requireAdmin: () => ({ userId: 'adm', role: 'admin', username: 'admin' }),
    getSetting: () => null, setSetting: () => {}, randomUUID: () => `id-${seq++}`,
    writeAudit: () => {}, sessions: new Map(), platformSessions: new Map(),
  })
  let seq = 0
  const harness = { sent, db, _body: {}, seq: () => seq,
    call: (m, p, body) => { harness._body = body || {}; return routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) } }
  return harness
}

test('组生命周期:创建→列表含 memberCount→重名 409→删成员→删组级联', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/admin/groups', { name: 'devs' })
  assert.equal(h.sent[0].status, 200)
  const gid = h.sent[0].json.group.id
  await h.call('POST', `/api/admin/groups/${gid}/members`, { userIds: ['u1'] })
  assert.equal(h.sent[1].status, 200)
  await h.call('POST', '/api/admin/groups', { name: 'devs' })
  assert.equal(h.sent[2].status, 409)
  assert.equal(h.sent[2].json.message.length > 0, true)
  await h.call('GET', '/api/admin/groups')
  assert.equal(h.sent[3].status, 200)
  const g0 = h.sent[3].json.groups[0]
  assert.equal(g0.id, gid); assert.equal(g0.name, 'devs'); assert.equal(g0.memberCount, 1); assert.equal(g0.grants, 0)
  assert.equal(g0.createdAt, h.sent[0].json.group.createdAt)
  await h.call('DELETE', `/api/admin/groups/${gid}/members/u1`)
  assert.equal(h.sent[4].status, 200)
  // 授权行级联:先发一笔 grant 再删组
  await h.call('PUT', '/api/admin/grants', { subjectType: 'group', subjectId: gid, clusterId: 'c1', namespaces: [{ namespace: 'app', level: 'operate' }] })
  assert.equal(h.sent[5].status, 200)
  await h.call('DELETE', `/api/admin/groups/${gid}`)
  assert.equal(h.sent[6].status, 200)
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM groups').get().c, 0)
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM group_members').get().c, 0)
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM ns_grants').get().c, 0, '组删除须级联清该组全部 ns_grants')
})

test('成员操作:不存在的用户/组 → 404', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/admin/groups', { name: 'devs' })
  await h.call('POST', '/api/admin/groups/g-0/members', { userIds: ['ghost'] })
  assert.equal(h.sent[1].status, 404)
  await h.call('POST', '/api/admin/groups/nope/members', { userIds: ['u1'] })
  assert.equal(h.sent[2].status, 404)
  await h.call('DELETE', '/api/admin/groups/g-0/members/ghost')
  assert.equal(h.sent[3].status, 404)
})

test('PUT /api/admin/grants:全量替换 + 非法 ns/level/subject/cluster → 400', async () => {
  const h = makeHarness()
  await h.call('PUT', '/api/admin/grants', { subjectType: 'user', subjectId: 'u1', clusterId: 'c1', namespaces: [{ namespace: 'app', level: 'view' }, { namespace: 'ops', level: 'operate' }] })
  assert.equal(h.sent[0].status, 200)
  // 全量替换:新集合只留 ops
  await h.call('PUT', '/api/admin/grants', { subjectType: 'user', subjectId: 'u1', clusterId: 'c1', namespaces: [{ namespace: 'ops', level: 'view' }] })
  assert.equal(h.sent[1].status, 200)
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM ns_grants WHERE subjectType='user' AND subjectId='u1' AND clusterId='c1'").get().c, 1)
  assert.equal(h.db.prepare("SELECT level FROM ns_grants WHERE subjectId='u1' AND namespace='ops'").get().level, 'view')
  // 非法 ns(DNS 标签)
  await h.call('PUT', '/api/admin/grants', { subjectType: 'user', subjectId: 'u1', clusterId: 'c1', namespaces: [{ namespace: 'Bad_Ns', level: 'view' }] })
  assert.equal(h.sent[2].status, 400)
  // 非法 level
  await h.call('PUT', '/api/admin/grants', { subjectType: 'user', subjectId: 'u1', clusterId: 'c1', namespaces: [{ namespace: 'app', level: 'root' }] })
  assert.equal(h.sent[3].status, 400)
  // subject 不存在
  await h.call('PUT', '/api/admin/grants', { subjectType: 'user', subjectId: 'ghost', clusterId: 'c1', namespaces: [] })
  assert.equal(h.sent[4].status, 400)
  // cluster 不存在
  await h.call('PUT', '/api/admin/grants', { subjectType: 'user', subjectId: 'u1', clusterId: 'nope', namespaces: [] })
  assert.equal(h.sent[5].status, 400)
})

test('PUT /api/admin/clusters/:id/ns-auth-mode:open↔allowlist 切换,非法 mode 400', async () => {
  const h = makeHarness()
  await h.call('PUT', '/api/admin/clusters/c1/ns-auth-mode', { mode: 'allowlist' })
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.db.prepare('SELECT nsAuthMode FROM clusters WHERE id=?').get('c1').nsAuthMode, 'allowlist')
  await h.call('PUT', '/api/admin/clusters/c1/ns-auth-mode', { mode: 'chaos' })
  assert.equal(h.sent[1].status, 400)
  await h.call('PUT', '/api/admin/clusters/nope/ns-auth-mode', { mode: 'open' })
  assert.equal(h.sent[2].status, 404)
  await h.call('PUT', '/api/admin/clusters/c1/ns-auth-mode', { mode: 'open' })
  assert.equal(h.sent[3].status, 200)
})

test('普通用户访问 admin 组端点 → 401(requireAdmin 拒)', async () => {
  const sent = []
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, createdBy TEXT)`)
  db.exec(`CREATE TABLE ns_grants (id TEXT PRIMARY KEY, subjectType TEXT NOT NULL, subjectId TEXT NOT NULL, clusterId TEXT NOT NULL, namespace TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'view', grantedBy TEXT, grantedAt INTEGER NOT NULL, UNIQUE(subjectType,subjectId,clusterId,namespace))`)
  const routes = createAdminRoutes({
    db, sendJson: (r, s, j) => sent.push({ status: s, json: j }),
    readBody: async () => ({}), requireAdmin: (req, res) => { sent.push({ status: 401, json: {} }); return null },
    getSetting: () => null, setSetting: () => {}, randomUUID: () => 'id-x', writeAudit: () => {},
    sessions: new Map(), platformSessions: new Map(),
  })
  await routes.handle({ method: 'GET', on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL('http://x/api/admin/groups'))
  assert.equal(sent[0].status, 401)
})

// ===== Review round 1:事务原子性 + 400 语义收窄 =====

// db 代理:指定 SQL(如 'COMMIT')首次执行即抛,其余透传真库 —— 用于验证写路径的事务回滚。
function dbWithFailingExec(db, failSql) {
  let thrown = false
  const realExec = db.exec.bind(db)
  return new Proxy(db, {
    get(t, k) {
      if (k === 'exec') {
        return (sql) => {
          if (sql === failSql && !thrown) { thrown = true; throw new Error(`stub ${failSql} failure`) }
          return realExec(sql)
        }
      }
      const v = t[k]
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}

// 与 makeHarness 同库另起一个 router(db 走代理;prepare/delete 均透传真库)
function makeProxiedHarness(proxyDb) {
  const sent = []
  const routes = createAdminRoutes({
    db: proxyDb, sendJson: (r, s, j) => sent.push({ status: s, json: j }),
    readBody: async () => h._body, requireAdmin: () => ({ userId: 'adm', role: 'admin', username: 'admin' }),
    getSetting: () => null, setSetting: () => {}, randomUUID: () => 'id-p',
    writeAudit: () => {}, sessions: new Map(), platformSessions: new Map(),
  })
  const h = { sent, _body: {},
    call: (m, p, body) => { h._body = body || {}; return routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) } }
  return h
}

test('PUT grants:COMMIT 抛错 → 500 且 grants 行保持原状(事务回滚)', async () => {
  const h = makeHarness()
  await h.call('PUT', '/api/admin/grants', { subjectType: 'user', subjectId: 'u1', clusterId: 'c1', namespaces: [{ namespace: 'app', level: 'view' }] })
  assert.equal(h.sent[0].status, 200)
  const before = h.db.prepare('SELECT namespace,level FROM ns_grants ORDER BY namespace').all().map(r => ({ ...r }))
  const proxied = makeProxiedHarness(dbWithFailingExec(h.db, 'COMMIT'))
  await proxied.call('PUT', '/api/admin/grants', { subjectType: 'user', subjectId: 'u1', clusterId: 'c1', namespaces: [{ namespace: 'ops', level: 'operate' }] })
  assert.equal(proxied.sent[0].status, 500, '事务失败须 500 非 400')
  const after = h.db.prepare('SELECT namespace,level FROM ns_grants ORDER BY namespace').all().map(r => ({ ...r }))
  assert.deepEqual(after, before, 'COMMIT 失败 → DELETE+INSERT 全部回滚,旧行原样')
})

test('DELETE group:COMMIT 抛错 → 500 且组/成员/授权行均未被删(事务回滚)', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/admin/groups', { name: 'devs' })
  const gid = h.sent[0].json.group.id
  await h.call('POST', `/api/admin/groups/${gid}/members`, { userIds: ['u1'] })
  await h.call('PUT', '/api/admin/grants', { subjectType: 'group', subjectId: gid, clusterId: 'c1', namespaces: [{ namespace: 'app', level: 'view' }] })
  const proxied = makeProxiedHarness(dbWithFailingExec(h.db, 'COMMIT'))
  await proxied.call('DELETE', `/api/admin/groups/${gid}`)
  assert.equal(proxied.sent[0].status, 500)
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM groups').get().c, 1)
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM group_members').get().c, 1)
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM ns_grants').get().c, 1)
})

// 终审 Finding 3a:删户级联清 group_members + user 侧 ns_grants(spec §3)
test('DELETE user:级联清 group_members 与 user ns_grants', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/admin/groups', { name: 'devs' })
  const gid = h.sent[0].json.group.id
  await h.call('POST', `/api/admin/groups/${gid}/members`, { userIds: ['u1'] })
  await h.call('PUT', '/api/admin/grants', { subjectType: 'user', subjectId: 'u1', clusterId: 'c1', namespaces: [{ namespace: 'app', level: 'view' }] })
  await h.call('PUT', '/api/admin/grants', { subjectType: 'group', subjectId: gid, clusterId: 'c1', namespaces: [{ namespace: 'team', level: 'view' }] })
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM group_members WHERE userId=?').get('u1').c, 1)
  await h.call('DELETE', '/api/admin/users/u1')
  assert.equal(h.sent.at(-1).status, 200)
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM group_members WHERE userId=?').get('u1').c, 0)
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM ns_grants WHERE subjectType='user' AND subjectId='u1'").get().c, 0)
  // 组侧授权不受牵连
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM ns_grants WHERE subjectType='group' AND subjectId=?").get(gid).c, 1)
})

test('POST groups:空名 → 400 admin.groupNameRequired(不再借用 groupOrUserNotFound)', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/admin/groups', { name: '   ' })
  assert.equal(h.sent[0].status, 400)
  assert.equal(h.sent[0].json.message, '组名必填')
  await h.call('POST', '/api/admin/groups', { name: '' })
  assert.equal(h.sent[1].status, 400)
  assert.equal(h.sent[1].json.message, '组名必填')
})

test('POST members:空 userIds → 400 admin.userIdsRequired(组存在前提下)', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/admin/groups', { name: 'devs' })
  const gid = h.sent[0].json.group.id
  await h.call('POST', `/api/admin/groups/${gid}/members`, { userIds: [] })
  assert.equal(h.sent[1].status, 400)
  assert.equal(h.sent[1].json.message, '缺少用户')
  await h.call('POST', `/api/admin/groups/${gid}/members`, {})
  assert.equal(h.sent[2].status, 400)
})

test('PUT grants:同一 body 内重复 namespace → 400(先查重再入事务)', async () => {
  const h = makeHarness()
  await h.call('PUT', '/api/admin/grants', { subjectType: 'user', subjectId: 'u1', clusterId: 'c1', namespaces: [{ namespace: 'app', level: 'view' }, { namespace: 'app', level: 'operate' }] })
  assert.equal(h.sent[0].status, 400)
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM ns_grants').get().c, 0, '校验失败不得写入任何行')
})

test('GET members / GET grants:读端点(Task 5 管理页数据面)', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/admin/groups', { name: 'devs' })
  const gid = h.sent[0].json.group.id
  await h.call('POST', `/api/admin/groups/${gid}/members`, { userIds: ['u1'] })
  await h.call('PUT', '/api/admin/grants', { subjectType: 'group', subjectId: gid, clusterId: 'c1', namespaces: [{ namespace: 'app', level: 'operate' }] })

  await h.call('GET', `/api/admin/groups/${gid}/members`)
  assert.equal(h.sent[3].status, 200)
  assert.deepEqual(h.sent[3].json.members.map(m => ({ ...m })), [{ userId: 'u1', username: 'alice', displayName: null }])
  await h.call('GET', '/api/admin/groups/nope/members')
  assert.equal(h.sent[4].status, 404)

  await h.call('GET', `/api/admin/grants?subjectType=group&subjectId=${gid}&clusterId=c1`)
  assert.equal(h.sent[5].status, 200)
  assert.deepEqual(h.sent[5].json.namespaces.map(r => ({ ...r })), [{ namespace: 'app', level: 'operate' }])
  // 无参数/参数不全 → 400(不猜默认主体)
  await h.call('GET', '/api/admin/grants')
  assert.equal(h.sent[6].status, 400)
  await h.call('GET', '/api/admin/grants?subjectType=user&subjectId=u1')
  assert.equal(h.sent[7].status, 400)
})
