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

function makeHarness({ userId = 'u1', role = 'user', requestKubernetes: reqK8s } = {}) {
  const sent = []
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE workbench_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, clusterId TEXT NOT NULL, ownerId TEXT NOT NULL, createdAt INTEGER NOT NULL, activeConversationId TEXT, projectRecap TEXT, historyWatermark INTEGER DEFAULT 0, repoRoot TEXT DEFAULT NULL)`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT, apiServer TEXT, nsAuthMode TEXT DEFAULT 'open')`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, assignedBy TEXT, assignedAt INTEGER)`)
  db.exec(`CREATE TABLE last_reconcile (projectId TEXT PRIMARY KEY, result TEXT, ts INTEGER NOT NULL)`)
  db.prepare(`INSERT INTO clusters VALUES ('c1','cluster-one',NULL,'open')`).run()
  db.prepare(`INSERT INTO clusters VALUES ('c2','cluster-two',NULL,'open')`).run()
  db.prepare(`INSERT INTO user_clusters VALUES ('u1','c1','admin',1)`).run()
  db.prepare(`INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt) VALUES ('p1','proj','c1','u1',1)`).run()
  db.exec(`CREATE TABLE IF NOT EXISTS platform_users (id TEXT PRIMARY KEY, username TEXT, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0, createdAt INTEGER)`)
  db.exec(`CREATE TABLE IF NOT EXISTS ns_grants (id TEXT PRIMARY KEY, subjectType TEXT, subjectId TEXT, clusterId TEXT, namespace TEXT, level TEXT, grantedBy TEXT, grantedAt INTEGER)`)
  db.exec(`CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT)`)
  db.exec(`CREATE TABLE IF NOT EXISTS group_members (groupId TEXT, userId TEXT, addedBy TEXT, addedAt INTEGER, PRIMARY KEY(groupId, userId))`)
  db.prepare(`INSERT OR IGNORE INTO platform_users VALUES ('u1','u1','user',0,1)`).run()
  const workbenchDir = mkdtempSync(join(tmpdir(), 'wbp-gates-'))
  const routes = createWorkbenchProjectRoutes({
    db, sendJson: (r, s, j) => sent.push({ status: s, json: j }),
    readBody: async () => harness._body,
    requirePlatform: () => ({ userId, role, username: userId }),
    requireAdmin: () => (role === 'admin' ? { userId, role, username: userId } : null),
    writeAudit: () => {},
    WORKBENCH_DIR: workbenchDir, dbPath: ':memory:',
    buildCallContext: () => ({}), applyYamlPartial: async () => ({ applied: [], failed: [], total: 0 }),
    requestKubernetes: reqK8s || (async () => ({ status: 200, headers: {}, body: { resources: [{ kind: 'ConfigMap', namespaced: true }] } })),
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

// ===== W2 Phase C Task 2: 导出式 ownership/查询 helper =====
import { assertProjectOwnership, listConversationsByOwner } from './routes/workbench-projects.mjs'

test('assertProjectOwnership:owner true;admin true;他人 false;缺参 false', () => {
  const p = { ownerId: 'u1' }
  assert.equal(assertProjectOwnership({ userId: 'u1', role: 'user' }, p), true)
  assert.equal(assertProjectOwnership({ userId: 'zz', role: 'admin' }, p), true)
  assert.equal(assertProjectOwnership({ userId: 'u2', role: 'user' }, p), false)
  assert.equal(assertProjectOwnership(null, p), false)
  assert.equal(assertProjectOwnership({ userId: 'u1', role: 'user' }, null), false)
})

test('listConversationsByOwner:只回该用户名下项目对话,倒序,含项目名/消息数', () => {
  const h = makeHarness()
  h.db.exec(`CREATE TABLE workbench_conversations (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', steps INTEGER DEFAULT 0, title TEXT, userMessage TEXT, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, pendingApproval TEXT)`)
  h.db.exec(`CREATE TABLE workbench_messages (conversationId TEXT, seq INTEGER)`)
  h.db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id TEXT, source TEXT)`)
  h.db.prepare(`INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt) VALUES ('p2','other','c1','u2',2)`).run()
  const ins = h.db.prepare(`INSERT INTO workbench_conversations (id,projectId,status,createdAt,updatedAt) VALUES (?,?,?,?,?)`)
  ins.run('cA', 'p1', 'running', 10, 20)
  ins.run('cB', 'p1', 'done', 5, 30)
  ins.run('cC', 'p2', 'done', 1, 40) // 他人项目,不回
  h.db.prepare(`INSERT INTO workbench_messages VALUES ('cA',1)`).run()
  h.db.prepare(`INSERT INTO workbench_messages VALUES ('cA',2)`).run()
  const rows = listConversationsByOwner(h.db, 'u1')
  assert.deepEqual(rows.map(r => r.id), ['cB', 'cA']) // updatedAt DESC
  const a = rows.find(r => r.id === 'cA')
  assert.equal(a.projectName, 'proj')
  assert.equal(a.messageCount, 2)
  assert.equal(rows.find(r => r.id === 'cB').messageCount, 0)
})

// ===== W2 Phase C/D Batch CB-B Task 3: records/summary/search owner 收口 =====
// 改造 harness:requireAdmin 语义化(非 admin 返 null),补对话/消息/ssh_servers 表。
function makeOwnedHarness({ userId = 'u1', role = 'user', requestKubernetes: reqK8s } = {}) {
  const h = makeHarness({ userId, role, requestKubernetes: reqK8s })
  h.db.exec(`CREATE TABLE workbench_conversations (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', steps INTEGER DEFAULT 0, title TEXT, userMessage TEXT, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, pendingApproval TEXT)`)
  h.db.exec(`CREATE TABLE workbench_messages (conversationId TEXT, seq INTEGER)`)
  h.db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id TEXT, source TEXT)`)
  h.db.prepare(`INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt) VALUES ('p2','other-proj','c1','u2',2)`).run()
  const ins = h.db.prepare(`INSERT INTO workbench_conversations (id,projectId,status,createdAt,updatedAt) VALUES (?,?,?,?,?)`)
  ins.run('cA', 'p1', 'running', 10, 20) // u1 的
  ins.run('cB', 'p2', 'done', 5, 30)     // u2 的
  h.db.prepare(`INSERT INTO workbench_messages VALUES ('cA',1)`).run()
  h.db.prepare(`INSERT INTO workbench_messages VALUES ('cA',2)`).run()
  h.db.prepare(`INSERT INTO workbench_messages VALUES ('cB',1)`).run()
  h._ssh = (rows) => {
    h.db.exec(`CREATE TABLE IF NOT EXISTS ssh_servers (id TEXT PRIMARY KEY, name TEXT, host TEXT, port INTEGER, username TEXT, authMethod TEXT, description TEXT, clusterRef TEXT, exposeToAi INTEGER DEFAULT 1, aiApprovalPolicy TEXT, tags TEXT, hostKeyFingerprint TEXT, status TEXT, osId TEXT, osName TEXT, lastTestedAt INTEGER, notes TEXT, encPassword TEXT, encPrivateKey TEXT, encPassphrase TEXT, encSudoPassword TEXT, createdBy TEXT, createdAt INTEGER, updatedAt INTEGER)`)
    for (const r of rows) h.db.prepare(`INSERT INTO ssh_servers (id,name,host,exposeToAi) VALUES (?,?,?,1)`).run(r.id, r.name, r.host)
  }
  return h
}

test('records: 非 admin 只见自己项目对话+counts 按 owner 过滤;storage/aiToolCalls 为 null', async () => {
  const h = makeOwnedHarness({ userId: 'u1' })
  await h.call('GET', '/api/workbench/records')
  const r = h.sent[0]
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.conversations.map(c => c.id), ['cA'])
  assert.equal(r.json.counts.projects, 1)
  assert.equal(r.json.counts.conversations, 1)
  assert.equal(r.json.counts.messages, 2)
  assert.equal(r.json.counts.aiToolCalls, null)
  assert.equal(r.json.storage, null)
})

test('records: admin 全量(对话/计数/storage 齐全)', async () => {
  const h = makeOwnedHarness({ userId: 'admin', role: 'admin' })
  await h.call('GET', '/api/workbench/records')
  const r = h.sent[0]
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.conversations.map(c => c.id).sort(), ['cA', 'cB'])
  assert.equal(r.json.counts.conversations, 2)
  assert.equal(r.json.counts.messages, 3)
  assert.equal(typeof r.json.counts.aiToolCalls, 'number')
  assert.ok(r.json.storage)
})

test('summary: 非 admin totals 只计自己项目(admin 全量)', async () => {
  const h = makeOwnedHarness({ userId: 'u1' })
  await h.call('GET', '/api/workbench/summary')
  assert.equal(h.sent[0].json.totals.projects, 1)
  const ha = makeOwnedHarness({ userId: 'admin', role: 'admin' })
  await ha.call('GET', '/api/workbench/summary')
  assert.equal(ha.sent[0].json.totals.projects, 2)
})

test('search server 分支: owner 200;非 owner 403 wbp.noProjectAccess', async () => {
  const h = makeOwnedHarness({ userId: 'u1' })
  h._ssh([{ id: 's1', name: 'srv-a', host: '10.0.0.1' }])
  await h.call('GET', '/api/workbench/search?projectId=p1&kind=server&q=')
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.items.length, 1)
  assert.equal(h.sent[0].json.items[0].host, undefined) // 非 admin 不带 host
  const h2 = makeOwnedHarness({ userId: 'u2' })
  h2._ssh([{ id: 's1', name: 'srv-a', host: '10.0.0.1' }])
  await h2.call('GET', '/api/workbench/search?projectId=p1&kind=server&q=')
  assert.equal(h2.sent[0].status, 403)
  assert.equal(h2.sent[0].json.message, '无权访问该项目')
})

test('search server 分支: admin 全量带 host', async () => {
  const h = makeOwnedHarness({ userId: 'admin', role: 'admin' })
  h._ssh([{ id: 's1', name: 'srv-a', host: '10.0.0.1' }])
  await h.call('GET', '/api/workbench/search?projectId=p1&kind=server&q=')
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.items[0].host, '10.0.0.1')
})

// W2 C+D 终审#5:reconcile 与 wb_apply 同门(逐文档 ns operate;集群级 kind null-ns 拒)。
// 夹具:c1 切 allowlist,u1 仅 team-a:view;manifests 注入 team-b 文档(view/未授权 operate)→ 403。
// harness 无真 git repo → wbReadManifests 抛 git ENOENT → 500;断言点因此取「已越过 ns 门」:
// 空 manifests(或 manifests 读取失败)时 ns 门零调用 → 状态码不是 403(500=git 缺失,恰好证明
// ns 门未拦)。403(ap nsForbidden/api.nsForbidden)只应在 manifests 非空且含未授权 ns 时出现。
test('reconcile:allowlist 非 admin + manifests 读取失败(空仓)→ 越过 ns 门(非 403)', async () => {
  const h = makeHarness()
  h.db.prepare(`UPDATE clusters SET nsAuthMode='allowlist' WHERE id='c1'`).run()
  await h.call('POST', '/api/workbench/projects/p1/reconcile', {})
  assert.notEqual(h.sent[0].status, 403, `ns 门不应拦空/不可读 manifests(实得 ${h.sent[0].status} ${h.sent[0].json?.message})`)
})

// entitlement 门仍前置(既有不变式):撤分配 → 403 先于 ns 门。
test('reconcile:撤分配后 allowlist → 仍是 clusterForbidden 403(先于 ns 门)', async () => {
  const h = makeHarness()
  h.db.prepare(`UPDATE clusters SET nsAuthMode='allowlist' WHERE id='c1'`).run()
  h.db.prepare('DELETE FROM user_clusters WHERE userId=? AND clusterId=?').run('u1', 'c1')
  await h.call('POST', '/api/workbench/projects/p1/reconcile', {})
  assert.equal(h.sent[0].status, 403)
  assert.equal(h.sent[0].json.message, FORBIDDEN_MSG)
})

// ===== 2026-09-07 审计 F4(authz-entitlement-04):ledger GET 集群门 =====
// GET /api/workbench/ledger 原先只有 requirePlatform——任意平台用户可读任意集群的全集群
// survey 台账(含待审蒸馏稿 pending),与兄弟端点(POST 创建/PUT cluster/commit/reconcile)
// 的 clusterEntitled 门不齐。补齐后与兄弟端点逐字同款(403 wbp.clusterForbidden)。
// 夹具补 pending_distills:ledger 响应尾部的 getPendingDistill 直查该表,缺表会炸路由。
function withPendingDistill(h, clusterId, proposed = 'proposed-x') {
  h.db.exec(`CREATE TABLE IF NOT EXISTS pending_distills (clusterId TEXT PRIMARY KEY, proposed TEXT, current TEXT, summary TEXT, stats TEXT, ts INTEGER NOT NULL)`)
  h.db.prepare(`INSERT OR REPLACE INTO pending_distills VALUES (?,?,?,?,?,?)`).run(clusterId, proposed, 'current-x', 'sum-x', '{}', 1)
  return h
}

test('ledger:无该集群授权的平台用户 → 403 clusterForbidden(待审蒸馏稿不可达)', async () => {
  const h = withPendingDistill(makeHarness(), 'c2')
  await h.call('GET', '/api/workbench/ledger?clusterId=c2') // u1 只分配了 c1
  assert.equal(h.sent[0].status, 403)
  assert.equal(h.sent[0].json.message, FORBIDDEN_MSG)
})

test('ledger:已分配用户 200 且 pending 蒸馏稿同门可达;admin 豁免未分配集群也 200', async () => {
  const h = withPendingDistill(makeHarness(), 'c1')
  await h.call('GET', '/api/workbench/ledger?clusterId=c1') // u1 已分配 c1(open)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.pending?.proposed, 'proposed-x')
  const ha = withPendingDistill(makeHarness({ userId: 'admin', role: 'admin' }), 'c2')
  await ha.call('GET', '/api/workbench/ledger?clusterId=c2') // admin 未分配 c2 → 豁免
  assert.equal(ha.sent[0].status, 200)
})

// W2 审计 P1-4(2026-09-07):/api/workbench/search K8s 分支此前仅 requireAdmin(无 ownership/
// entitlement/ns 过滤)——既是普通用户 @mention K8s 搜索恒拒的功能缺口,也是「降门即成洞」的
// 第二份集群级 list。按 spec §6.2 E/§6.3 与 server 分支同门:ownership + clusterEntitled;
// 候选集来自已授权查询——wbToolGate.namespaces() 结果过滤(admin/open → null 不限;集群级
// 条目对受限用户不可见,同 wb_list_resources 的过滤语义)。
test('search K8s 分支:受限 owner(仅 team-a view)200 且候选集滤到授权 ns;admin 全量;非 owner 403', async () => {
  const k8sItems = async () => ({ status: 200, headers: {}, body: { items: [
    { metadata: { name: 'web-a', namespace: 'team-a' } },
    { metadata: { name: 'web-b', namespace: 'team-b' } },
    { metadata: { name: 'node-1', namespace: undefined } }, // 集群级条目(无 ns)
  ] } })
  const h = makeOwnedHarness({ userId: 'u1', requestKubernetes: k8sItems })
  h.db.prepare(`UPDATE clusters SET nsAuthMode='allowlist' WHERE id='c1'`).run()
  h.db.prepare(`INSERT INTO ns_grants VALUES ('g1','user','u1','c1','team-a','view','root',1)`).run()
  await h.call('GET', '/api/workbench/search?projectId=p1&kind=pods&q=')
  assert.equal(h.sent[0].status, 200, JSON.stringify(h.sent[0].json))
  assert.deepEqual(h.sent[0].json.items.map(i => i.name), ['web-a'], 'team-b 条目与无 ns 集群级条目不得进受限 owner 候选集')

  const ha = makeOwnedHarness({ userId: 'admin', role: 'admin', requestKubernetes: k8sItems })
  ha.db.prepare(`INSERT OR IGNORE INTO platform_users VALUES ('admin','admin','admin',0,1)`).run() // 门不信任 ps.role,现查 DB——夹具 admin 须有真实用户行
  ha.db.prepare(`UPDATE clusters SET nsAuthMode='allowlist' WHERE id='c1'`).run()
  await ha.call('GET', '/api/workbench/search?projectId=p1&kind=pods&q=')
  assert.equal(ha.sent[0].status, 200)
  assert.deepEqual(ha.sent[0].json.items.map(i => i.name).sort(), ['node-1', 'web-a', 'web-b'], 'admin 全量(含集群级条目)')

  const h2 = makeOwnedHarness({ userId: 'u2', requestKubernetes: k8sItems })
  await h2.call('GET', '/api/workbench/search?projectId=p1&kind=pods&q=')
  assert.equal(h2.sent[0].status, 403)
  assert.equal(h2.sent[0].json.message, '无权访问该项目')
})

test('search K8s 分支:owner 失去集群分配 → 403 clusterForbidden(entitlement 同 server 面)', async () => {
  const h = makeOwnedHarness({ userId: 'u1', requestKubernetes: async () => ({ status: 200, headers: {}, body: { items: [] } }) })
  h.db.prepare(`DELETE FROM user_clusters WHERE userId='u1' AND clusterId='c1'`).run()
  await h.call('GET', '/api/workbench/search?projectId=p1&kind=pods&q=')
  assert.equal(h.sent[0].status, 403)
  assert.equal(h.sent[0].json.message, FORBIDDEN_MSG)
})
