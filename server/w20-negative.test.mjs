// W2-0 双用户负向矩阵(spec §9 夹具的 Phase-0 子集):
// u1(分配 c1)/ u2(未分配)/ a1(admin);u1 的 K8s token 在失去分配后必须立即死。
// 覆盖:①复检矩阵(session-guard 全档)②取消分配吊销(admin PUT 集群路由级)
// ③Workspace 三门(创建带未分配集群 / 绑定未分配 / 失配后 reconcile)④admin 豁免 ⑤登出清暂存语义的
// 服务端对应物(吊销后旧 token 401:解析不到任何会话——内存 Map 缺席 + 库行已删)。
// 夹具:clusters c1/c2;platform_users u1(user)/u2(user,未分配)/a1(admin);u1→c1 分配;
// sessions 表含 u1@c1 行 + platform_sessions 链。此文件是 Phase A/B/C 负向子集的追加落点。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionOwnerValid } from './session-guard.mjs'
import { createAdminRoutes } from './routes/admin.mjs'
import { createWorkbenchProjectRoutes } from './routes/workbench-projects.mjs'

const FORBIDDEN_MSG = '该集群未分配给你'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0)`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, assignedBy TEXT, assignedAt INTEGER)`)
  return db
}

// ① session-guard 全档复检矩阵(模块级,同 session-guard.test.mjs)
test('① 复检矩阵:正常/禁用/失去分配/admin 豁免/存量无归属/用户已删/fail-closed', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO platform_users VALUES ('u1','user',0)`).run()
  db.prepare(`INSERT INTO platform_users VALUES ('u2','user',1)`).run()
  db.prepare(`INSERT INTO platform_users VALUES ('a1','admin',0)`).run()
  db.prepare(`INSERT INTO user_clusters VALUES ('u1','c1','a1',1)`).run()
  const s = (userId, clusterId) => ({ userId, clusterId })
  assert.equal(sessionOwnerValid(db, s('u1', 'c1')), true)     // 正常
  assert.equal(sessionOwnerValid(db, s('u2', 'c1')), false)    // 未分配
  assert.equal(sessionOwnerValid(db, s('u2', 'c1')), false)    // 禁用(u2 同时禁用)
  assert.equal(sessionOwnerValid(db, s('u1', 'c2')), false)    // 失去分配(错集群)
  assert.equal(sessionOwnerValid(db, s('a1', 'c2')), true)     // admin 豁免
  assert.equal(sessionOwnerValid(db, s(undefined, undefined)), true) // 存量无归属兼容
  assert.equal(sessionOwnerValid(db, s('ghost', 'c1')), false) // 用户已删
  assert.equal(sessionOwnerValid(makeDb(), s('u1', 'c1')), false) // 表不存在 = fail-closed
})

// 共享路由级夹具:c1/c2 集群;u1→c1 分配;k-a1 会话行 + p1 platform session 链
function makeHarness({ userId = 'u1', role = 'user' } = {}) {
  const sent = []
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, assignedBy TEXT, assignedAt INTEGER)`)
  db.exec(`CREATE TABLE platform_sessions (token TEXT PRIMARY KEY, userId TEXT, k8sSessionToken TEXT)`)
  db.exec(`CREATE TABLE sessions (token TEXT PRIMARY KEY, userId TEXT, clusterId TEXT)`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT)`)
  db.exec(`CREATE TABLE workbench_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, clusterId TEXT NOT NULL, ownerId TEXT NOT NULL, createdAt INTEGER NOT NULL, activeConversationId TEXT, projectRecap TEXT, historyWatermark INTEGER DEFAULT 0, repoRoot TEXT DEFAULT NULL)`)
  db.exec(`CREATE TABLE last_reconcile (projectId TEXT PRIMARY KEY, result TEXT, ts INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0)`)
  db.prepare(`INSERT INTO platform_users VALUES ('u1','user',0)`).run()
  db.prepare(`INSERT INTO platform_users VALUES ('a1','admin',0)`).run()
  db.prepare(`INSERT INTO clusters VALUES ('c1','cluster-one')`).run()
  db.prepare(`INSERT INTO clusters VALUES ('c2','cluster-two')`).run()
  db.prepare(`INSERT INTO user_clusters VALUES ('u1','c1','a1',1)`).run()
  db.prepare(`INSERT INTO platform_sessions VALUES ('p1','u1','k-a1')`).run()
  db.prepare(`INSERT INTO sessions VALUES ('k-a1','u1','c1')`).run()
  db.prepare(`INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt) VALUES ('p1','proj','c1','u1',1)`).run()
  const sessions = new Map([['k-a1', { userId: 'u1', clusterId: 'c1' }]])
  const platformSessions = new Map([['p1', { userId: 'u1', k8sSessionToken: 'k-a1' }]])
  const workbenchDir = mkdtempSync(join(tmpdir(), 'w20-neg-'))
  const adminRoutes = createAdminRoutes({
    db, sendJson: (r, s, j) => sent.push({ status: s, json: j }),
    readBody: async () => harness._body, requireAdmin: () => ({ role: 'admin', username: 'a1' }),
    sessions, platformSessions, writeAudit: () => {},
  })
  const wbRoutes = createWorkbenchProjectRoutes({
    db, sendJson: (r, s, j) => sent.push({ status: s, json: j }),
    readBody: async () => harness._body,
    requirePlatform: () => ({ userId, role, username: userId }),
    writeAudit: () => {},
    WORKBENCH_DIR: workbenchDir, dbPath: ':memory:',
    buildCallContext: () => ({}), applyYamlPartial: async () => ({ applied: [], failed: [], total: 0 }),
  })
  const handle = async (m, p, body) => {
    harness._body = body || {}
    const routes = p.startsWith('/api/admin/') ? adminRoutes : wbRoutes
    return routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`))
  }
  const harness = { sent, db, sessions, platformSessions, _body: {}, call: handle }
  return harness
}

// ② admin PUT 取消分配 → 路由级吊销:会话行消失 + platform k8sSessionToken NULL + Map 同步
test('② admin PUT users/u1/clusters [c1]→[] → k8s 会话行消失、k8sSessionToken 置 NULL、platform session 存活', async () => {
  const h = makeHarness()
  await h.call('PUT', '/api/admin/users/u1/clusters', { clusterIds: [] })
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM sessions WHERE userId=? AND clusterId=?').get('u1', 'c1').c, 0, '库行已删')
  assert.equal(h.sessions.has('k-a1'), false, '内存 Map 同步移除')
  assert.equal(h.db.prepare('SELECT k8sSessionToken FROM platform_sessions WHERE token=?').get('p1').k8sSessionToken, null)
  assert.equal(h.platformSessions.get('p1').k8sSessionToken, null)
  assert.equal(h.platformSessions.has('p1'), true, 'platform session 本身存活')
})

// ③ Workspace 三门(未分配用户)+ admin 豁免
test('③ 未分配用户创建带 c2 / 绑定 c2 / 失配后 reconcile 均 403;admin 三操作豁免 200', async () => {
  // 三门:未分配用户(u2 无任何分配)
  const h2 = makeHarness({ userId: 'u2', role: 'user' })
  await h2.call('POST', '/api/workbench/projects', { name: 'x', clusterId: 'c2' })
  assert.equal(h2.sent[0].status, 403)
  assert.equal(h2.sent[0].json.message, FORBIDDEN_MSG)
  assert.equal(h2.db.prepare(`SELECT COUNT(*) c FROM workbench_projects WHERE name='x'`).get().c, 0, '库不变')
  // 绑定未分配:u1(有 c1)试图绑 c2
  const h = makeHarness()
  await h.call('PUT', '/api/workbench/projects/p1/cluster', { clusterId: 'c2' })
  assert.equal(h.sent[0].status, 403)
  assert.equal(h.sent[0].json.message, FORBIDDEN_MSG)
  assert.equal(h.db.prepare('SELECT clusterId FROM workbench_projects WHERE id=?').get('p1').clusterId, 'c1', '库不变')
  // 失配后 reconcile:u1 的 c1 分配被撤
  h.db.prepare('DELETE FROM user_clusters WHERE userId=? AND clusterId=?').run('u1', 'c1')
  await h.call('POST', '/api/workbench/projects/p1/reconcile', {})
  assert.equal(h.sent[1].status, 403)
  assert.equal(h.sent[1].json.message, FORBIDDEN_MSG)
  // admin 豁免
  const ha = makeHarness({ userId: 'a1', role: 'admin' })
  await ha.call('POST', '/api/workbench/projects', { name: 'x-admin', clusterId: 'c2' })
  assert.equal(ha.sent[0].status, 200)
  const newId = ha.sent[0].json.project.id
  await ha.call('PUT', `/api/workbench/projects/${newId}/cluster`, { clusterId: 'c2' })
  assert.equal(ha.sent[1].status, 200)
  assert.equal(ha.db.prepare('SELECT clusterId FROM workbench_projects WHERE id=?').get(newId).clusterId, 'c2', '库已变(admin 豁免落库)')
})

// ④⑤ 吊销后旧 token 语义:stale bearer token 解析不到任何会话(Map 缺席 + 库行已删)→ 等效 401
test('④ 吊销后旧 k8s token 解析为无会话(Map 缺席 + DB 行消失),复检守卫同样拒绝', async () => {
  const h = makeHarness()
  // 吊销前:token 可解析出活会话且复检通过
  assert.equal(h.sessions.has('k-a1'), true)
  assert.equal(sessionOwnerValid(h.db, h.sessions.get('k-a1')), true)
  // admin 取消分配
  await h.call('PUT', '/api/admin/users/u1/clusters', { clusterIds: [] })
  assert.equal(h.sent[0].status, 200)
  // 吊销后:stale bearer token 'k-a1' 解析 → 无会话
  const stale = h.sessions.get('k-a1')
  assert.equal(stale, undefined, '内存 Map 中 token 缺席 → 请求路径解析不到会话 = 401 等效')
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM sessions WHERE token=?').get('k-a1').c, 0, '库行已消失')
})
