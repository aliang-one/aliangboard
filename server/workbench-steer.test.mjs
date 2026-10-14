// steer 端点(spec D1/D6,2026-10-13):运行中/paused 实时补充——落 steered=1 的 user 行,
// 不启 run、不改状态、不占 F6 名额。终态 409 引导前端降级 append;洪水轻限 ≤50。
// 进程内 handler 测试(模式同 workbench-project-routes.test.mjs);bus 事件经 conv-bus 单例 subscribe 捕获。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createWorkbenchSchema, createProject, appendMessage, listMessages } from './workbench-projects.mjs'
import { createWorkbenchConvRoutes } from './routes/workbench-conversations.mjs'
import { subscribe, unsubscribe } from './conv-bus.mjs'

function setup({ status = 'running', body = { message: '补充X' } } = {}) {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  const p = createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u-me' })
  const now = Date.now()
  db.prepare('INSERT INTO workbench_conversations (id,projectId,status,createdAt,updatedAt) VALUES (?,?,?,?,?)')
    .run('conv-1', p.id, status, now, now)
  appendMessage(db, { conversationId: 'conv-1', role: 'user', content: 'hi' })
  const sent = []
  const audits = []
  let runCalled = 0
  const events = []
  const onBus = evt => events.push(evt) // conv-bus 监听器单参(bus.on(convId, fn) → fn(event))
  subscribe('conv-1', onBus)
  const routes = createWorkbenchConvRoutes({
    db,
    sendJson: (_r, status, body) => sent.push({ status, body }),
    readBody: async () => body,
    requirePlatform: () => ({ userId: 'u-me', username: 'me', role: 'user' }),
    requireAdmin: () => null,
    writeAudit: (_db, e) => audits.push(e),
    getLlmConfig: () => ({}), createLlmClient: () => ({}), buildCallContext: () => ({}),
    requestKubernetes: async () => ({ body: {} }),
    wbAgent: { runConversation: () => { runCalled++ }, resumeConversation: async () => {}, cancelConversation: async () => ({ ok: true }) },
    busDispose: () => {},
  })
  const call = () => routes.handle({ headers: { 'accept-language': 'zh' }, method: 'POST' }, {}, new URL('http://x/api/workbench/conversations/conv-1/steer'))
  return { db, sent, audits, events, call, getRunCalled: () => runCalled, cleanup: () => unsubscribe('conv-1', onBus) }
}

test('running steer:200 落 steered=1 行 + steer_ack 事件 + 审计 + 不启 run', async () => {
  const s = setup()
  try {
    await s.call()
    assert.equal(s.sent.length, 1)
    assert.equal(s.sent[0].status, 200)
    const rows = listMessages(s.db, 'conv-1')
    const steerRow = rows[rows.length - 1]
    assert.equal(steerRow.role, 'user')
    assert.equal(steerRow.content, '补充X')
    assert.equal(steerRow.steered, 1)
    assert.equal(s.sent[0].body.messageId, steerRow.id)
    console.log("DEBUG events:", JSON.stringify(s.events));
    assert.ok(s.events.some(e => e.type === 'steer_ack' && e.messageId === steerRow.id))
    assert.ok(s.audits.some(a => a.verb === 'steer' && a.tool === 'wb_conv'))
    assert.equal(s.getRunCalled(), 0)                       // D1:不启 run
    const st = s.db.prepare('SELECT status FROM workbench_conversations WHERE id=?').get('conv-1')
    assert.equal(st.status, 'running')                      // 状态不动
  } finally { s.cleanup() }
})

test('paused steer:200 同款放行(approve 续跑首轮吸收)', async () => {
  const s = setup({ status: 'paused' })
  try {
    await s.call()
    assert.equal(s.sent[0].status, 200)
    assert.equal(listMessages(s.db, 'conv-1').filter(r => r.steered === 1).length, 1)
  } finally { s.cleanup() }
})

test('终态 steer:409 steerFinished + 不落行(done/failed/cancelled)', async () => {
  for (const status of ['done', 'failed', 'cancelled']) {
    const s = setup({ status })
    try {
      await s.call()
      assert.equal(s.sent[0].status, 409)
      assert.ok(s.sent[0].body.message.includes('请直接发送新消息'))
      assert.equal(listMessages(s.db, 'conv-1').filter(r => r.steered === 1).length, 0)
    } finally { s.cleanup() }
  }
})

test('message 空:400 messageRequired', async () => {
  const s = setup({ body: { message: '' } })
  try {
    await s.call()
    assert.equal(s.sent[0].status, 400)
  } finally { s.cleanup() }
})

test('refs 超限:400 归一门拒绝(spec 测试矩阵)', async () => {
  // REFS_MAX_ITEMS 超量数组(normalizeInputRefs 单源门;形态对齐 refs-normalize 的上限)
  const refs = Array.from({ length: 33 }, (_, i) => ({ kind: 'pod', namespace: 'default', name: `p${i}` }))
  const s = setup({ body: { message: 'x', references: refs } })
  try {
    await s.call()
    assert.equal(s.sent[0].status, 400)
    assert.equal(listMessages(s.db, 'conv-1').filter(r => r.steered === 1).length, 0)
  } finally { s.cleanup() }
})

test('洪水轻限:最后非 steered user 行之后 steered≥50 → 400 steerTooMany', async () => {
  const s = setup()
  try {
    for (let i = 0; i < 50; i++) appendMessage(s.db, { conversationId: 'conv-1', role: 'user', content: `s${i}`, steered: 1 })
    await s.call()
    assert.equal(s.sent[0].status, 400)
    assert.ok(s.sent[0].body.message.includes('上限'))
    assert.equal(listMessages(s.db, 'conv-1').filter(r => r.steered === 1).length, 50)  // 未落第 51 条
  } finally { s.cleanup() }
})

test('旧库幂等:createWorkbenchSchema 二次调用不抛(steered 列 try-ALTER)', async () => {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  createWorkbenchSchema(db)   // 幂等
  appendMessage(db, { conversationId: 'c', role: 'user', content: 'x', steered: 1 })
  assert.ok(true)
})
