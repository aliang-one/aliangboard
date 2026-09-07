// W2 Phase C (Task 6): @mention 引用门——refAllowed 单一 helper(fetchRefContext 与
// buildRefsContext 两份实现共用)。allowlist 下无权 ns 的 @ref 注入为空(静默跳过,不中断),
// @server ref 维持 exposeToAi 闸(此处恒放行)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createRefContextFetcher, refAllowed } from './ref-fetch.mjs'
import { makeAuthzDb } from './authz.test.mjs'

// 夹具:c1=allowlist(u1=team-a:view,u2=team-b:operate,a1=admin)、c2=open(u1 分配)
function fixture() {
  const db = makeAuthzDb()
  db.exec(`CREATE TABLE ssh_servers (id TEXT PRIMARY KEY, name TEXT, description TEXT, clusterRef TEXT, host TEXT, exposed INTEGER DEFAULT 1)`)
  db.prepare('INSERT INTO platform_users VALUES (?,?,?,?,?)').run('u1', 'user1', 'user', 0, 1)
  db.prepare('INSERT INTO platform_users VALUES (?,?,?,?,?)').run('u2', 'user2', 'user', 0, 1)
  db.prepare('INSERT INTO platform_users VALUES (?,?,?,?,?)').run('a1', 'admin1', 'admin', 0, 1)
  db.prepare('INSERT INTO clusters VALUES (?,?,?,?)').run('c1', 'allowlist-one', 'https://k8s', 'allowlist')
  db.prepare('INSERT INTO clusters VALUES (?,?,?,?)').run('c2', 'open-one', 'https://k8s', 'open')
  db.prepare('INSERT INTO user_clusters VALUES (?,?)').run('u1', 'c1')
  db.prepare('INSERT INTO user_clusters VALUES (?,?)').run('u1', 'c2')
  db.prepare('INSERT INTO user_clusters VALUES (?,?)').run('u2', 'c1')
  db.prepare('INSERT INTO ns_grants VALUES (?,?,?,?,?,?,?,?)').run('n1', 'user', 'u1', 'c1', 'team-a', 'view', 'root', 1)
  db.prepare('INSERT INTO ns_grants VALUES (?,?,?,?,?,?,?,?)').run('n2', 'user', 'u2', 'c1', 'team-b', 'operate', 'root', 1)
  return db
}

const podA = { kind: 'pod', namespace: 'team-a', name: 'web-a' }
const podB = { kind: 'pod', namespace: 'team-b', name: 'web-b' }

// ===== 纯逻辑层:refAllowed =====

test('refAllowed:@server 恒放行(维持 exposeToAi 闸);未绑定集群放行(自然失败优先)', () => {
  const db = fixture()
  assert.equal(refAllowed(db, { userId: 'u1', role: 'user' }, { kind: 'server', name: 'gw-1' }, 'c1'), true)
  assert.equal(refAllowed(db, { userId: 'u1', role: 'user' }, podB, ''), true)
})

test('refAllowed:k8s ref = canAccessNs(view)——u1 仅 team-a / u2 仅 team-b / open 全通 / admin 全通', () => {
  const db = fixture()
  assert.equal(refAllowed(db, { userId: 'u1', role: 'user' }, podA, 'c1'), true)
  assert.equal(refAllowed(db, { userId: 'u1', role: 'user' }, podB, 'c1'), false)
  assert.equal(refAllowed(db, { userId: 'u2', role: 'user' }, podA, 'c1'), false)
  assert.equal(refAllowed(db, { userId: 'u2', role: 'user' }, podB, 'c1'), true)
  assert.equal(refAllowed(db, { userId: 'u1', role: 'user' }, podB, 'c2'), true) // open
  assert.equal(refAllowed(db, { userId: 'a1', role: 'admin' }, podA, 'c1'), true)
})

// ===== 2026-09-07 审计 F5(refs-injection-05):集群级 kind 走 clusterWide 门 =====
// 集群级 kind(nodes/PV/clusterroles…)本无 namespace——旧逻辑统一 canAccessNs,伪造
// ref.namespace(填自己有授权的 ns)即可越过 wb 工具侧 Phase C 的 clusterWide 拒绝。
// 修复:与工具面同门(wbToolGate.clusterWide 单一事实源:admin/open 集群放行,
// allowlist 非 admin 拒;Phase C 无 per-user clusterWide 授权档,allowlist 用户仅能靠
// admin 身份或集群切 open 拿到集群级面)。kind 判定经 normalizeKind + kind-paths 单源。
const nodeRef = { kind: 'nodes', namespace: 'team-a', name: 'node-1' }       // 伪造 ns = 自己有授权的 team-a
const pvRef = { kind: 'persistentvolumes', namespace: 'team-a', name: 'pv-1' }
const crRef = { kind: 'clusterrole', namespace: 'team-a', name: 'view' }     // 单数形态(前端/LLM 可能传)

test('refAllowed:集群级 kind 伪造 namespace(填自己有授权的 ns)→ allowlist 非 admin 拒', () => {
  const db = fixture()
  assert.equal(refAllowed(db, { userId: 'u1', role: 'user' }, nodeRef, 'c1'), false)
  assert.equal(refAllowed(db, { userId: 'u1', role: 'user' }, pvRef, 'c1'), false)
  assert.equal(refAllowed(db, { userId: 'u2', role: 'user' }, { kind: 'nodes', namespace: 'team-b', name: 'n' }, 'c1'), false)
  assert.equal(refAllowed(db, { userId: 'u1', role: 'user' }, crRef, 'c1'), false, '单数 clusterrole 也须归一后按集群级拒')
})

test('refAllowed:集群级 kind admin / open 集群放行(clusterWide 授权的两种形态)', () => {
  const db = fixture()
  assert.equal(refAllowed(db, { userId: 'a1', role: 'admin' }, nodeRef, 'c1'), true) // admin
  assert.equal(refAllowed(db, { userId: 'u1', role: 'user' }, nodeRef, 'c2'), true)  // open 集群(u1 已分配)
})

test('refAllowed:namespaced kind 既有行为回归不变(pods/deployments 仍走 canAccessNs)', () => {
  const db = fixture()
  assert.equal(refAllowed(db, { userId: 'u1', role: 'user' }, podA, 'c1'), true)
  assert.equal(refAllowed(db, { userId: 'u1', role: 'user' }, podB, 'c1'), false)
  assert.equal(refAllowed(db, { userId: 'u1', role: 'user' }, { kind: 'deployments', namespace: 'team-a', name: 'web' }, 'c1'), true)
})

// ===== 实现一:fetchRefContext(refreshSystem 每轮注入面) =====

test('fetchRefContext 带 gate:无权 ref 静默跳过(零注入),有权 ref 正常注入', async () => {
  const db = fixture()
  const fetcher = createRefContextFetcher({
    requestKubernetes: async (s, path) => ({ status: 200, headers: {}, body: { kind: 'Pod', metadata: { name: path.includes('team-b') ? 'web-b' : 'web-a' } } }),
    listSshServers: () => [],
  })
  const gate = { db, principal: { userId: 'u1', role: 'user' }, clusterId: 'c1' }
  const out = await fetcher.fetchRefContext([podA, podB], {}, gate)
  assert.match(out, /team-a\/web-a/)
  assert.doesNotMatch(out, /team-b\/web-b/, 'team-b 无授权 → 不得注入')
})

// F5 集成面:伪造 ns 的集群级 ref 在 fetchRefContext 同样零注入、不触网(门在拉取之前)。
test('fetchRefContext 带 gate:集群级 ref 无 clusterWide 授权 → 静默跳过且不触网', async () => {
  const db = fixture()
  const seen = []
  const fetcher = createRefContextFetcher({
    requestKubernetes: async (s, path) => { seen.push(path); return { status: 200, headers: {}, body: { kind: 'Node', metadata: { name: 'node-1' } } } },
    listSshServers: () => [],
  })
  const gate = { db, principal: { userId: 'u1', role: 'user' }, clusterId: 'c1' }
  const out = await fetcher.fetchRefContext([nodeRef], {}, gate)
  assert.doesNotMatch(out, /node-1/, '伪造 ns 的 nodes ref 不得注入')
  assert.ok(!seen.some(p => p.includes('/nodes/')), 'nodes 不得触网拉取')
})

test('fetchRefContext 无 gate(旧调用形状)→ 零过滤(向后兼容)', async () => {
  const db = fixture()
  const fetcher = createRefContextFetcher({
    requestKubernetes: async () => ({ status: 200, headers: {}, body: { kind: 'Pod', metadata: { name: 'web-b' } } }),
    listSshServers: () => [],
  })
  const out = await fetcher.fetchRefContext([podB], {})
  assert.match(out, /team-b\/web-b/)
})

// ===== 实现二:buildRefsContext(POST /conversations 首屏 ResourceCard 拉取面) =====

import { createWorkbenchConvRoutes } from './routes/workbench-conversations.mjs'

function convHarness(db, { userId, role }) {
  const sent = []
  db.exec(`CREATE TABLE workbench_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, clusterId TEXT NOT NULL, ownerId TEXT NOT NULL, createdAt INTEGER NOT NULL, activeConversationId TEXT, projectRecap TEXT, historyWatermark INTEGER DEFAULT 0, repoRoot TEXT DEFAULT NULL)`)
  db.exec(`CREATE TABLE workbench_conversations (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', steps INTEGER DEFAULT 0, title TEXT, userMessage TEXT, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, pendingApproval TEXT, messages TEXT, queue TEXT, denied TEXT, "references" TEXT, system TEXT DEFAULT '', content TEXT DEFAULT '', reasoning TEXT DEFAULT '', trace TEXT DEFAULT '[]', recap TEXT, summarizedUpTo INTEGER)`)
  db.exec(`CREATE TABLE workbench_messages (conversationId TEXT, seq INTEGER, id TEXT PRIMARY KEY, role TEXT, content TEXT, refs TEXT, reasoning TEXT, trace TEXT, createdAt INTEGER)`)
  db.exec(`CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT)`)
  db.prepare(`INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt) VALUES ('p1','proj','c1','u1',1)`).run()
  const k8sPaths = []
  const routes = createWorkbenchConvRoutes({
    db, sendJson: (r, s, j) => sent.push({ status: s, json: j }),
    readBody: async () => ({ projectId: 'p1', message: 'hi', references: [podA, podB] }),
    requirePlatform: () => ({ userId, role, username: userId }),
    requireAdmin: () => ({ userId, role, username: userId }),
    wbAgent: { runConversation: async () => {} },
    writeAudit: () => {},
    getLlmConfig: () => ({ baseURL: 'http://x', model: 'm' }),
    createLlmClient: () => ({}),
    buildCallContext: () => ({}),
    requestKubernetes: async (s, path) => { k8sPaths.push(path); return { status: 200, headers: {}, body: { kind: 'Pod', metadata: { name: path.includes('team-b') ? 'web-b' : 'web-a' } } } },
    busSubscribe: () => {}, busUnsubscribe: () => {}, busDispose: () => {},
  })
  return { sent, k8sPaths, call: () => routes.handle({ method: 'POST', on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL('http://x/api/workbench/conversations')) }
}

test('buildRefsContext:u1(team-a view)——team-b ref 跳过(resources 对应位 null),team-a 正常拉', async () => {
  const db = fixture()
  const h = convHarness(db, { userId: 'u1', role: 'user' })
  await h.call()
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.references.length, 2)
  assert.ok(h.sent[0].json.references[0]?.metadata, 'team-a ref 正常拉取')
  assert.equal(h.sent[0].json.references[1], null, 'team-b 无授权 → 对应位 null(下标对齐不变式)')
  assert.ok(!h.k8sPaths.some(p => p.includes('team-b')), 'team-b 不得触网拉取')
})

test('buildRefsContext:admin / open 集群全通(对照面)', async () => {
  const db = fixture()
  const h = convHarness(db, { userId: 'a1', role: 'admin' })
  await h.call()
  assert.ok(h.sent[0].json.references[0]?.metadata)
  assert.ok(h.sent[0].json.references[1]?.metadata, 'admin 两 ref 均拉取')
})
