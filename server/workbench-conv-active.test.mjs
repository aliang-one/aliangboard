// GET /api/workbench/conversations/active 契约(2026-08-17 近期动态模型):
// running/paused 永在(不受窗口限制);终态 done/failed/cancelled 窗口内(默认 30min)才在;
// Top-N(cap 默认 5);presence.* 配置注入端点;requireAdmin。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import {
  createWorkbenchSchema, createProject, createConversation,
  listActiveConversations, getPresenceConfig,
} from './workbench-projects.mjs'
import { createWorkbenchConvRoutes } from './routes/workbench-conversations.mjs'

function makeHarness({ requireAdmin, requirePlatform, settings } = {}) {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  db.exec(`CREATE TABLE IF NOT EXISTS platform_settings ( key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER NOT NULL )`)
  for (const [k, v] of Object.entries(settings || {}))
    db.prepare('INSERT INTO platform_settings (key,value,updatedAt) VALUES (?,?,?)').run(k, String(v), Date.now())
  const p1 = createProject(db, { name: 'proj-1', clusterId: 'c1', ownerId: 'u1' }).id
  const p2 = createProject(db, { name: 'proj-2', clusterId: 'c1', ownerId: 'u1' }).id
  const sent = []
  const res = { writeHead: () => {}, end: () => {} }
  const routes = createWorkbenchConvRoutes({
    db,
    sendJson: (r, status, json) => { sent.push({ status, json }) },
    readBody: async () => ({}),
    requireAdmin: requireAdmin || (() => ({ userId: 'u1', username: 'u', role: 'admin' })),
    // 仅在显式传入时覆盖——缺省走工厂默认(requirePlatform=requireAdmin),
    // 「requireAdmin 拒绝」用例的既有语义依赖该缺省链。
    ...(requirePlatform ? { requirePlatform } : {}),
    wbAgent: { runConversation: async () => {}, resumeConversation: async () => {}, cancelConversation: () => ({ ok: true }) },
    getLlmConfig: () => ({ baseURL: 'http://llm', apiKey: 'k', model: 'm' }),
    createLlmClient: () => ({ chat: async () => ({ content: '' }) }),
    buildCallContext: () => ({}),
    requestKubernetes: async () => ({}),
    busSubscribe: () => {}, busUnsubscribe: () => {},
  })
  return {
    db, p1, p2, sent,
    set: (id, status, updatedAt) => db.prepare('UPDATE workbench_conversations SET status=?, updatedAt=? WHERE id=?').run(status, updatedAt, id),
    call: (method, pathname) => routes.handle({ method, on: () => {} }, res, new URL(`http://x${pathname}`)),
  }
}

test('running/paused 永在:超过 24h 无动态仍返回(路由顺序不被 GET /:id 吞掉)', async () => {
  const h = makeHarness()
  const now = Date.now()
  const run = createConversation(h.db, { projectId: h.p1, system: '', userMessage: 'q1' })
  h.set(run.id, 'running', now - 25 * 3600_000)
  const paused = createConversation(h.db, { projectId: h.p2, system: '', userMessage: 'q2' })
  h.set(paused.id, 'paused', now - 40 * 60_000)
  assert.ok(await h.call('GET', '/api/workbench/conversations/active'))
  assert.equal(h.sent[0].status, 200)
  const byProj = Object.fromEntries(h.sent[0].json.conversations.map(r => [r.projectName, r]))
  assert.equal(byProj['proj-1'].status, 'running', 'running 超 24h 仍在')
  assert.equal(byProj['proj-2'].status, 'paused', 'paused 超 30min 仍在')
})

test('终态窗口:done/failed/cancelled 30min 内返回,窗口外不返回', async () => {
  const h = makeHarness()
  const now = Date.now()
  const mk = (status, ageMin) => {
    const c = createConversation(h.db, { projectId: h.p1, system: '', userMessage: status + ageMin })
    h.set(c.id, status, now - ageMin * 60_000)
    return c.id
  }
  mk('done', 10); mk('failed', 29); mk('cancelled', 5); mk('done', 31); mk('failed', 600)
  await h.call('GET', '/api/workbench/conversations/active')
  const statuses = h.sent[0].json.conversations.map(r => r.status).sort()
  assert.equal(h.sent[0].json.conversations.length, 3, '窗口外的 done(31min)/failed(600min) 不返回')
  assert.ok(statuses.includes('cancelled'), '含 cancelled')
  assert.ok(statuses.includes('done'), '含 done')
  assert.ok(statuses.includes('failed'), '含 failed')
})

test('cap 默认 5:listActiveConversations 直测,新→旧', () => {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  const pid = createProject(db, { name: 'p', clusterId: 'c1', ownerId: 'u1' }).id
  const now = Date.now()
  for (let i = 0; i < 8; i++) {
    const c = createConversation(db, { projectId: pid, system: '', userMessage: `q${i}` })
    db.prepare("UPDATE workbench_conversations SET status='done', updatedAt=? WHERE id=?").run(now - i * 1000, c.id)
  }
  const rows = listActiveConversations(db, { now })
  assert.equal(rows.length, 5)
  assert.ok(rows[0].updatedAt >= rows[1].updatedAt)
})

test('配置注入:presence.activityWindowMin=1 → 2min 前终态不回,running 仍回;cap 来自 maxItems', async () => {
  const h = makeHarness({ settings: { 'presence.activityWindowMin': 1, 'presence.maxItems': 2 } })
  const now = Date.now()
  const run = createConversation(h.db, { projectId: h.p1, system: '', userMessage: 'r' })
  h.set(run.id, 'running', now - 3600_000)
  const old = createConversation(h.db, { projectId: h.p1, system: '', userMessage: 'o' })
  h.set(old.id, 'done', now - 2 * 60_000)
  const fresh = createConversation(h.db, { projectId: h.p2, system: '', userMessage: 'f' })
  h.set(fresh.id, 'done', now - 30_000)
  await h.call('GET', '/api/workbench/conversations/active')
  const ids = h.sent[0].json.conversations.map(r => r.id)
  assert.ok(ids.includes(run.id), 'running 永在')
  assert.ok(!ids.includes(old.id), '窗口 1min:2min 前终态不回')
  assert.ok(ids.includes(fresh.id), '窗口内终态回')
})

test('getPresenceConfig:默认 5/30;越界/垃圾值 clamp;缺表回默认', () => {
  const mk = settings => {
    const db = new DatabaseSync(':memory:')
    createWorkbenchSchema(db)
    db.exec(`CREATE TABLE IF NOT EXISTS platform_settings ( key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER NOT NULL )`)
    for (const [k, v] of Object.entries(settings)) db.prepare('INSERT INTO platform_settings (key,value,updatedAt) VALUES (?,?,?)').run(k, String(v), 1)
    return db
  }
  assert.deepEqual(getPresenceConfig(mk({})), { maxItems: 5, windowMin: 30, windowMs: 30 * 60_000 })
  assert.deepEqual(getPresenceConfig(mk({ 'presence.maxItems': 99, 'presence.activityWindowMin': 0 })).maxItems, 20)
  assert.deepEqual(getPresenceConfig(mk({ 'presence.activityWindowMin': 'abc' })).windowMin, 30)
  const noTable = new DatabaseSync(':memory:'); createWorkbenchSchema(noTable)
  assert.deepEqual(getPresenceConfig(noTable), { maxItems: 5, windowMin: 30, windowMs: 30 * 60_000 }, '缺 platform_settings 表回默认')
})

test('requireAdmin 拒绝 → 分支不再写 json', async () => {
  const h = makeHarness({ requireAdmin: (req, res) => { res.writeHead(401, {}); res.end(); return null } })
  createConversation(h.db, { projectId: h.p1, system: '', userMessage: 'q' })
  assert.ok(await h.call('GET', '/api/workbench/conversations/active'))
  assert.equal(h.sent.length, 0)
})

// conv-lifecycle-11(2026-09-07 审计批次三):active 列表 LIMIT 先于 owner 过滤——
// 旧 SQL 全局 Top-N 后才由路由按 owner 过滤,他人 10 条 running 可把非 admin 自己的
// running/paused 整体挤出 cap(活跃入口失明,自己的对话「消失」)。修复契约:owner
// 过滤前移进 SQL(LIMIT 之前),非 admin 的 running/paused 恒在。
test('conv-lifecycle-11: 他人 10 条 running 挤不出非 admin 自己的 running(cap=5)', async () => {
  const h = makeHarness({ requirePlatform: () => ({ userId: 'u2', username: 'u2', role: 'user' }) })
  const mine = createProject(h.db, { name: 'mine', clusterId: 'c1', ownerId: 'u2' })
  const now = Date.now()
  // 自己 1 条 running(最旧);他人(u1 的 p1)10 条 running 全部更新——全局 Top-5 全被他人占
  const own = createConversation(h.db, { projectId: mine.id, system: '', userMessage: '我自己的' })
  h.set(own.id, 'running', now - 60_000)
  for (let i = 0; i < 10; i++) {
    const c = createConversation(h.db, { projectId: h.p1, system: '', userMessage: `别人的${i}` })
    h.set(c.id, 'running', now - i * 1000)
  }
  await h.call('GET', '/api/workbench/conversations/active')
  assert.equal(h.sent[0].status, 200)
  const ids = h.sent[0].json.conversations.map(r => r.id)
  assert.ok(ids.includes(own.id), `自己的 running 恒在(LIMIT 须在 owner 过滤之后),收到: ${JSON.stringify(h.sent[0].json.conversations)}`)
  for (const r of h.sent[0].json.conversations) {
    const proj = h.db.prepare('SELECT ownerId FROM workbench_projects WHERE id=?').get(r.projectId)
    assert.equal(proj.ownerId, 'u2', '只见自己项目的行')
  }
})
