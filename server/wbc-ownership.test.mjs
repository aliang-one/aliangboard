// W2 Phase D(CB-B Task 4):审批归属——approve/deny 收口到 requirePlatform + 项目 owner
// (或 admin);approve/deny 时把 approverId/approvedAt 落进 pendingApproval(归属留痕)。
// 结构仿 workbench-projects-gates.test.mjs(handler 注入桩)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createWorkbenchConvRoutes } from './routes/workbench-conversations.mjs'

function makeHarness({ userId = 'u1', role = 'user' } = {}) {
  const sent = []
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE workbench_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, clusterId TEXT NOT NULL, ownerId TEXT NOT NULL, createdAt INTEGER NOT NULL, activeConversationId TEXT, projectRecap TEXT, historyWatermark INTEGER DEFAULT 0, repoRoot TEXT DEFAULT NULL)`)
  db.exec(`CREATE TABLE workbench_conversations (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', steps INTEGER DEFAULT 0, title TEXT, userMessage TEXT, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, pendingApproval TEXT, messages TEXT, queue TEXT, denied TEXT, "references" TEXT, system TEXT DEFAULT '', content TEXT DEFAULT '', reasoning TEXT DEFAULT '', trace TEXT DEFAULT '[]', recap TEXT, summarizedUpTo INTEGER)`)
  db.exec(`CREATE TABLE workbench_messages (conversationId TEXT, seq INTEGER, id TEXT PRIMARY KEY, role TEXT, content TEXT, createdAt INTEGER)`)
  db.exec(`CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT)`)
  db.prepare(`INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt) VALUES ('p1','proj','c1','u1',1)`).run()
  const paused = (id) => db.prepare(`INSERT INTO workbench_conversations (id,projectId,status,createdAt,updatedAt,system,pendingApproval) VALUES (?,'p1','paused',1,2,'SYS',?)`).run(id, JSON.stringify({ toolCallId: 'tc1', name: 'wb_exec', args: {} }))
  paused('cA')
  const resumeCalls = []
  const routes = createWorkbenchConvRoutes({
    db, sendJson: (r, s, j) => sent.push({ status: s, json: j }),
    readBody: async () => ({}),
    requirePlatform: () => ({ userId, role, username }),
    requireAdmin: () => (role === 'admin' ? { userId, role, username } : null),
    wbAgent: { resumeConversation: async (id, approved, llm, actor) => { resumeCalls.push({ id, approved, actor }) } },
    getLlmConfig: () => ({ baseURL: 'http://x', model: 'm' }),
    createLlmClient: () => ({}),
    busSubscribe: () => {}, busUnsubscribe: () => {}, busDispose: () => {},
  })
  const username = userId
  const harness = { sent, db, resumeCalls,
    call: (m, p) => routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) }
  return harness
}

test('u2(非 owner 非 admin)approve u1 对话 → 403 wbc.noProjectAccess,状态仍 paused', async () => {
  const h = makeHarness({ userId: 'u2', role: 'user' })
  await h.call('POST', '/api/workbench/conversations/cA/approve')
  assert.equal(h.sent[0].status, 403)
  assert.equal(h.sent[0].json.message, '无权访问该项目')
  assert.equal(h.db.prepare(`SELECT status FROM workbench_conversations WHERE id='cA'`).get().status, 'paused')
  assert.equal(h.resumeCalls.length, 0)
})

test('u2 deny u1 对话 → 403(deny 同权)', async () => {
  const h = makeHarness({ userId: 'u2', role: 'user' })
  await h.call('POST', '/api/workbench/conversations/cA/deny')
  assert.equal(h.sent[0].status, 403)
})

test('owner approve → 200;approverId/approvedAt 落 pendingApproval;CAS 置 running', async () => {
  const h = makeHarness({ userId: 'u1' })
  await h.call('POST', '/api/workbench/conversations/cA/approve')
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.db.prepare(`SELECT status FROM workbench_conversations WHERE id='cA'`).get().status, 'running')
  const pa = JSON.parse(h.db.prepare(`SELECT pendingApproval FROM workbench_conversations WHERE id='cA'`).get().pendingApproval)
  assert.equal(pa.approverId, 'u1')
  assert.ok(typeof pa.approvedAt === 'number' && pa.approvedAt > 0)
  assert.equal(pa.toolCallId, 'tc1') // 原审批载荷不丢
  assert.equal(h.resumeCalls.length, 1)
  assert.deepEqual(h.resumeCalls[0].actor, { userId: 'u1', username: 'u1' }) // 审计 actor 照旧
})

test('owner deny → 200 同样落 approverId/approvedAt,approved=false', async () => {
  const h = makeHarness({ userId: 'u1' })
  await h.call('POST', '/api/workbench/conversations/cA/deny')
  assert.equal(h.sent[0].status, 200)
  const pa = JSON.parse(h.db.prepare(`SELECT pendingApproval FROM workbench_conversations WHERE id='cA'`).get().pendingApproval)
  assert.equal(pa.approverId, 'u1')
  assert.equal(h.resumeCalls[0].approved, false)
})

test('admin approve 他人对话 → 200 且 approverId=admin', async () => {
  const h = makeHarness({ userId: 'admin1', role: 'admin' })
  await h.call('POST', '/api/workbench/conversations/cA/approve')
  assert.equal(h.sent[0].status, 200)
  const pa = JSON.parse(h.db.prepare(`SELECT pendingApproval FROM workbench_conversations WHERE id='cA'`).get().pendingApproval)
  assert.equal(pa.approverId, 'admin1')
})

test('非 paused 对话 approve → 400(CAS 不变式保持)', async () => {
  const h = makeHarness({ userId: 'u1' })
  h.db.prepare(`UPDATE workbench_conversations SET status='done', pendingApproval=NULL WHERE id='cA'`).run()
  await h.call('POST', '/api/workbench/conversations/cA/approve')
  assert.equal(h.sent[0].status, 400)
})
