// GET /api/workbench/conversations/active 契约:跨项目 running/paused(JOIN projectName)、
// 终态 24h 窗口、cancelled 排除、cap 20、路由顺序('active' 不被 GET /:id 的 [^/]+$ 吞)、requireAdmin。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import {
  createWorkbenchSchema, createProject, createConversation, listActiveConversations,
} from './workbench-projects.mjs'
import { createWorkbenchConvRoutes } from './routes/workbench-conversations.mjs'

function makeHarness({ requireAdmin } = {}) {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  const p1 = createProject(db, { name: 'proj-1', clusterId: 'c1', ownerId: 'u1' }).id
  const p2 = createProject(db, { name: 'proj-2', clusterId: 'c1', ownerId: 'u1' }).id
  const sent = []
  const res = { writeHead: () => {}, end: () => {} }
  const routes = createWorkbenchConvRoutes({
    db,
    sendJson: (r, status, json) => { sent.push({ status, json }) },
    readBody: async () => ({}),
    requireAdmin: requireAdmin || (() => ({ userId: 'u1', username: 'u', role: 'admin' })),
    wbAgent: { runConversation: () => {}, resumeConversation: () => {}, cancelConversation: () => ({ ok: true }) },
    getLlmConfig: () => ({ baseURL: 'http://llm', apiKey: 'k', model: 'm' }),
    createLlmClient: () => ({ chat: async () => ({ content: '' }) }),
    buildCallContext: () => ({}),
    requestKubernetes: async () => ({}),
    busSubscribe: () => {}, busUnsubscribe: () => {}, busSnapshot: () => null,
  })
  return {
    db, p1, p2, sent,
    call: (method, pathname) => routes.handle({ method, on: () => {} }, res, new URL(`http://x${pathname}`)),
  }
}

test('GET /active:跨项目 running/paused 返回,JOIN projectName;不被 GET /:id 吞掉', async () => {
  const h = makeHarness()
  createConversation(h.db, { projectId: h.p1, system: '', userMessage: 'q1' }) // 默认 running
  const paused = createConversation(h.db, { projectId: h.p2, system: '', userMessage: 'q2' })
  h.db.prepare("UPDATE workbench_conversations SET status='paused' WHERE id=?").run(paused.id)

  assert.ok(await h.call('GET', '/api/workbench/conversations/active'), '路由命中')
  assert.equal(h.sent[0].status, 200)
  const rows = h.sent[0].json.conversations
  assert.equal(rows.length, 2)
  assert.ok(rows.every(r => r.id && r.projectId && r.projectName && r.status && r.updatedAt), 'slim 字段齐')
  assert.ok(!('content' in rows[0]) && !('messages' in rows[0]), '不带消息体')
  const byProj = Object.fromEntries(rows.map(r => [r.projectName, r]))
  assert.equal(byProj['proj-1'].status, 'running')
  assert.equal(byProj['proj-2'].status, 'paused')
})

test('终态 24h 窗口:窗口内 done/failed 返回,窗口外不返回;cancelled 永不返回', async () => {
  const h = makeHarness()
  const now = Date.now()
  const fresh = createConversation(h.db, { projectId: h.p1, system: '', userMessage: 'a' })
  h.db.prepare("UPDATE workbench_conversations SET status='done', updatedAt=? WHERE id=?").run(now - 3600_000, fresh.id)
  const stale = createConversation(h.db, { projectId: h.p1, system: '', userMessage: 'b' })
  h.db.prepare("UPDATE workbench_conversations SET status='failed', updatedAt=? WHERE id=?").run(now - 25 * 3600_000, stale.id)
  const cancelled = createConversation(h.db, { projectId: h.p1, system: '', userMessage: 'c' })
  h.db.prepare("UPDATE workbench_conversations SET status='cancelled', updatedAt=? WHERE id=?").run(now - 1000, cancelled.id)

  await h.call('GET', '/api/workbench/conversations/active')
  const ids = h.sent[0].json.conversations.map(r => r.id)
  assert.ok(ids.includes(fresh.id), '24h 内 done 返回')
  assert.ok(!ids.includes(stale.id), '24h 外 failed 不返回')
  assert.ok(!ids.includes(cancelled.id), 'cancelled 不返回')
})

test('cap 20:按 updatedAt DESC 截断(listActiveConversations 直测)', () => {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  const pid = createProject(db, { name: 'p', clusterId: 'c1', ownerId: 'u1' }).id
  const now = Date.now()
  for (let i = 0; i < 25; i++) {
    const c = createConversation(db, { projectId: pid, system: '', userMessage: `q${i}` })
    db.prepare("UPDATE workbench_conversations SET status='done', updatedAt=? WHERE id=?").run(now - i * 1000, c.id)
  }
  const rows = listActiveConversations(db, { now })
  assert.equal(rows.length, 20)
  assert.equal(rows[0].title, null, 'title 列存在(未命名对话为 null)')
  assert.ok(rows[0].updatedAt >= rows[1].updatedAt, '新→旧排序')
})

test('requireAdmin 拒绝 → 分支不再写 json', async () => {
  const h = makeHarness({ requireAdmin: (req, res) => { res.writeHead(401, {}); res.end(); return null } })
  createConversation(h.db, { projectId: h.p1, system: '', userMessage: 'q' })
  assert.ok(await h.call('GET', '/api/workbench/conversations/active'))
  assert.equal(h.sent.length, 0, 'requireAdmin 已终结响应,active 分支短路')
})
