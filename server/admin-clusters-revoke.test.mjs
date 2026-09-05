// W2-0 §0.4-2 路由级集成:PUT /api/admin/users/:id/clusters 取消分配 → 该用户存量 K8s session 立即吊销。
// (sessions 行删除 + platform_sessions.k8sSessionToken 置 NULL + 内存 Map 同步;platform session 本身存活。)
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createAdminRoutes } from './routes/admin.mjs'

function makeHarness() {
  const sent = []
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, assignedBy TEXT, assignedAt INTEGER)`)
  db.exec(`CREATE TABLE platform_sessions (token TEXT PRIMARY KEY, userId TEXT, k8sSessionToken TEXT)`)
  db.exec(`CREATE TABLE sessions (token TEXT PRIMARY KEY, userId TEXT, clusterId TEXT)`)
  db.prepare(`INSERT INTO user_clusters VALUES ('u1','c1','admin',1)`).run()
  db.prepare(`INSERT INTO platform_sessions VALUES ('p1','u1','k-a1')`).run()
  db.prepare(`INSERT INTO sessions VALUES ('k-a1','u1','c1')`).run()
  const sessions = new Map([['k-a1', { userId: 'u1', clusterId: 'c1' }]])
  const platformSessions = new Map([['p1', { userId: 'u1', k8sSessionToken: 'k-a1' }]])
  const routes = createAdminRoutes({
    db, sendJson: (r, s, j) => sent.push({ status: s, json: j }),
    readBody: async () => harness._body, requireAdmin: () => ({ role: 'admin', username: 'admin' }),
    sessions, platformSessions, writeAudit: () => {},
  })
  const harness = { sent, db, sessions, platformSessions, _body: {},
    call: (m, p, body) => { harness._body = body || {}; return routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) } }
  return harness
}

test('PUT users/u1/clusters 从 [c1] 改 [] → sessions 行消失、k8sSessionToken 置 NULL、200', async () => {
  const h = makeHarness()
  await h.call('PUT', '/api/admin/users/u1/clusters', { clusterIds: [] })
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM sessions WHERE userId=? AND clusterId=?').get('u1', 'c1').c, 0)
  assert.equal(h.sessions.has('k-a1'), false)
  assert.equal(h.db.prepare('SELECT k8sSessionToken FROM platform_sessions WHERE token=?').get('p1').k8sSessionToken, null)
  assert.equal(h.platformSessions.get('p1').k8sSessionToken, null)
  assert.equal(h.platformSessions.has('p1'), true, 'platform session 本身存活')
})

test('PUT 重分配保留 c1 → 不吊销', async () => {
  const h = makeHarness()
  await h.call('PUT', '/api/admin/users/u1/clusters', { clusterIds: ['c1'] })
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM sessions WHERE token=?').get('k-a1').c, 1)
  assert.equal(h.sessions.has('k-a1'), true)
  assert.equal(h.platformSessions.get('p1').k8sSessionToken, 'k-a1')
})
