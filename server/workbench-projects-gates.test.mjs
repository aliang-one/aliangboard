// W2-0 §2.6 路由级集成:工作台项目域集群门——POST 创建 / PUT :id/cluster / commit / reconcile
// 四处均须发起者仍被分配目标集群(user_clusters);admin 豁免;空 clusterId(未绑定)放行。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkbenchProjectRoutes } from './routes/workbench-projects.mjs'

const FORBIDDEN_MSG = '该集群未分配给你'

function makeHarness({ userId = 'u1', role = 'user' } = {}) {
  const sent = []
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE workbench_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, clusterId TEXT NOT NULL, ownerId TEXT NOT NULL, createdAt INTEGER NOT NULL, activeConversationId TEXT, projectRecap TEXT, historyWatermark INTEGER DEFAULT 0, repoRoot TEXT DEFAULT NULL)`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT)`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, assignedBy TEXT, assignedAt INTEGER)`)
  db.exec(`CREATE TABLE last_reconcile (projectId TEXT PRIMARY KEY, result TEXT, ts INTEGER NOT NULL)`)
  db.prepare(`INSERT INTO clusters VALUES ('c1','cluster-one')`).run()
  db.prepare(`INSERT INTO clusters VALUES ('c2','cluster-two')`).run()
  db.prepare(`INSERT INTO user_clusters VALUES ('u1','c1','admin',1)`).run()
  db.prepare(`INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt) VALUES ('p1','proj','c1','u1',1)`).run()
  const workbenchDir = mkdtempSync(join(tmpdir(), 'wbp-gates-'))
  const routes = createWorkbenchProjectRoutes({
    db, sendJson: (r, s, j) => sent.push({ status: s, json: j }),
    readBody: async () => harness._body,
    requirePlatform: () => ({ userId, role, username: userId }),
    writeAudit: () => {},
    WORKBENCH_DIR: workbenchDir, dbPath: ':memory:',
    buildCallContext: () => ({}), applyYamlPartial: async () => ({ applied: [], failed: [], total: 0 }),
  })
  const harness = { sent, db, _body: {},
    call: (m, p, body) => { harness._body = body || {}; return routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) } }
  return harness
}

test('非分配用户 POST 创建绑定 c2 → 403 且库中无该项目', async () => {
  const h = makeHarness()
  await h.call('POST', '/api/workbench/projects', { name: 'x', clusterId: 'c2' })
  assert.equal(h.sent[0].status, 403)
  assert.equal(h.sent[0].json.message, FORBIDDEN_MSG)
  assert.equal(h.db.prepare(`SELECT COUNT(*) c FROM workbench_projects WHERE name='x'`).get().c, 0)
})

test('非分配用户 PUT p1/cluster c2 → 403 且 p1.clusterId 仍 c1', async () => {
  const h = makeHarness()
  await h.call('PUT', '/api/workbench/projects/p1/cluster', { clusterId: 'c2' })
  assert.equal(h.sent[0].status, 403)
  assert.equal(h.sent[0].json.message, FORBIDDEN_MSG)
  assert.equal(h.db.prepare('SELECT clusterId FROM workbench_projects WHERE id=?').get('p1').clusterId, 'c1')
})

test('分配被撤后(删除 u1-c1)reconcile → 403', async () => {
  const h = makeHarness()
  h.db.prepare('DELETE FROM user_clusters WHERE userId=? AND clusterId=?').run('u1', 'c1')
  await h.call('POST', '/api/workbench/projects/p1/reconcile', {})
  assert.equal(h.sent[0].status, 403)
  assert.equal(h.sent[0].json.message, FORBIDDEN_MSG)
})

test('admin 三操作豁免 → 全 200;解绑(clusterId 空)任何用户 200', async () => {
  const h = makeHarness({ role: 'admin', userId: 'admin' })
  await h.call('POST', '/api/workbench/projects', { name: 'x-admin', clusterId: 'c2' })
  assert.equal(h.sent[0].status, 200)
  const newId = h.sent[0].json.project.id
  await h.call('PUT', `/api/workbench/projects/${newId}/cluster`, { clusterId: 'c2' })
  assert.equal(h.sent[1].status, 200)
  await h.call('PUT', '/api/workbench/projects/p1/cluster', { clusterId: '' })
  assert.equal(h.sent[2].status, 200)
  assert.equal(h.db.prepare('SELECT clusterId FROM workbench_projects WHERE id=?').get('p1').clusterId, '')
  // 非 admin 解绑(空 clusterId)也放行
  const h2 = makeHarness()
  await h2.call('PUT', '/api/workbench/projects/p1/cluster', { clusterId: '' })
  assert.equal(h2.sent[0].status, 200)
})
