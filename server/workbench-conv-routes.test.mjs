// 续接对话 @-ref 的「卡片→刷新变 JSON」回归(2026-08-16):
// 旧 POST /:id/messages 把 refsCtx(引用资源的完整 JSON)烤进 user 消息 content 落库——
// live 渲染是本地干净 turn(卡片),刷新后 pollOnce 从 messages 重建 → 原始 JSON 当文本显示。
// 修复契约:content 干净落库;新 refs 并入对话级 "references"(refreshSystem 每轮注入 system,
// agent.mjs:127 每轮重写 messages[0],上下文等价且更新鲜);历史已污染行由 GET /:id 出参剥前缀。
// HTTP 层直测路由 handler(deps 全注入):db 用真 :memory:,requestKubernetes/llm 用桩。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import {
  createWorkbenchSchema, createProject, createConversation,
  getConversation, appendMessage, listMessages,
} from './workbench-projects.mjs'
import { createWorkbenchConvRoutes } from './routes/workbench-conversations.mjs'
import { stripRefsContext, REFS_CTX_HEADER } from './refs-context.mjs'

// ── 路由测试装置:真 db + 桩 deps,POST/GET 走真实 handler ──
function makeHarness() {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  db.exec(`CREATE TABLE IF NOT EXISTS clusters (
    id TEXT PRIMARY KEY, name TEXT, apiServer TEXT, authMethod TEXT, authHeader TEXT,
    ca TEXT, cert TEXT, key TEXT, insecure INTEGER, version TEXT, createdBy TEXT, createdAt INTEGER)`)
  db.prepare("INSERT INTO clusters (id,name,apiServer,createdAt) VALUES ('c1','c1','http://k8s',?)").run(Date.now())
  const pid = createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' }).id
  const sent = []
  let body = {}
  const res = { writeHead: () => {}, end: () => {} }
  const routes = createWorkbenchConvRoutes({
    db,
    sendJson: (r, status, json) => { sent.push({ status, json }) },
    readBody: async () => body,
    requireAdmin: () => ({ userId: 'u1', username: 'u', role: 'admin' }),
    wbAgent: { runConversation: () => {}, resumeConversation: () => {}, cancelConversation: () => ({ ok: true }) },
    getLlmConfig: () => ({ baseURL: 'http://llm', apiKey: 'k', model: 'm' }),
    createLlmClient: () => ({ chat: async () => ({ content: '' }) }),
    buildCallContext: () => ({}),
    requestKubernetes: async () => ({ status: 200, headers: {}, body: { kind: 'Pod', metadata: { name: 'nginx', namespace: 'default' } } }),
    busSubscribe: () => {}, busUnsubscribe: () => {}, busSnapshot: () => null,
  })
  return {
    db, pid, sent,
    setBody: b => { body = b },
    call: (method, pathname) => routes.handle({ method, on: () => {} }, res, new URL(`http://x${pathname}`)),
  }
}

// ── 写路径:续接带 @-ref → 落库干净 + refs 并入对话级 references ──

test('续接 @-ref:content 干净落库(不烤 refsCtx),refs 仍带完整资源', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: 's', userMessage: '首轮' })
  h.setBody({ message: '这个 pod 怎么了', references: [{ kind: 'pods', namespace: 'default', name: 'nginx' }] })
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/messages`), '路由命中')

  const msgs = listMessages(h.db, conv.id)
  const last = msgs[msgs.length - 1]
  assert.equal(last.role, 'user')
  assert.equal(last.content, '这个 pod 怎么了', 'content 干净——刷新后不再显示 JSON')
  assert.ok(!last.content.includes('Referenced resources'), '无 refsCtx 残留')
  const refs = JSON.parse(last.refs)
  assert.equal(refs.length, 1, 'refs 落库(刷新后卡片数据源)')
  assert.equal(refs[0].resource?.kind, 'Pod', 'refs 带完整资源体(ResourceCard)')
})

test('续接 @-ref:新 refs 并入对话级 references(refreshSystem 每轮注入 system)', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: 's', userMessage: '首轮', references: [{ kind: 'pods', namespace: 'default', name: 'nginx' }] })
  h.setBody({ message: '再看这个', references: [
    { kind: 'pods', namespace: 'default', name: 'nginx' },      // 重复引用 → 去重
    { kind: 'deployments', namespace: 'default', name: 'api' }, // 新引用 → 追加
  ] })
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/messages`))

  const row = getConversation(h.db, conv.id)
  assert.deepEqual(JSON.parse(row.references), [
    { kind: 'pods', namespace: 'default', name: 'nginx' },
    { kind: 'deployments', namespace: 'default', name: 'api' },
  ], '去重 + 追加;agent 每轮经 refreshSystem 看到全部引用资源')
})

test('续接无 @-ref:references 保持原值,content 不动', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: 's', userMessage: '首轮', references: [{ kind: 'pods', namespace: 'default', name: 'nginx' }] })
  h.setBody({ message: '继续' })
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/messages`))
  const row = getConversation(h.db, conv.id)
  assert.deepEqual(JSON.parse(row.references), [{ kind: 'pods', namespace: 'default', name: 'nginx' }], '原引用不丢')
  const last = listMessages(h.db, conv.id).pop()
  assert.equal(last.content, '继续')
})

// ── 读路径:历史已污染行(旧版烤入 refsCtx)出参剥前缀,数据不动 ──

test('GET /:id:历史烤入的 refsCtx 前缀在出参中被剥掉(旧数据免迁移)', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: 's', userMessage: 'q' })
  const refsCtx = REFS_CTX_HEADER + '[pods/default/nginx]:\n' + JSON.stringify({ kind: 'Pod', metadata: { name: 'nginx', annotations: { note: 'x}y' } } }, null, 2)
  appendMessage(h.db, { conversationId: conv.id, role: 'user', content: `${refsCtx}\n\n这个 pod 怎么了` })
  appendMessage(h.db, { conversationId: conv.id, role: 'assistant', content: '答', trace: '[]' })

  assert.ok(await h.call('GET', `/api/workbench/conversations/${conv.id}`))
  const { json } = h.sent[0]
  assert.equal(json.messages[0].content, '这个 pod 怎么了', '出参干净(刷新后卡片/文本正常)')
  assert.equal(json.messages[1].content, '答', 'assistant 原样')
  // 落库数据不动(agent buildHistory / 摘要不受影响)
  assert.match(listMessages(h.db, conv.id)[0].content, /^Referenced resources/, '库内原文保留')
})

test('GET /:id:assistant 消息 content 不参与剥离(自然语言可含同头)', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: 's', userMessage: 'q' })
  appendMessage(h.db, { conversationId: conv.id, role: 'assistant', content: `${REFS_CTX_HEADER}引用资源如下……(叙述性回答)` })
  assert.ok(await h.call('GET', `/api/workbench/conversations/${conv.id}`))
  const m = h.sent[0].json.messages[0]
  assert.equal(m.content, `${REFS_CTX_HEADER}引用资源如下……(叙述性回答)`, '非 user 不剥')
})

// ── stripRefsContext 纯函数边界 ──

test('stripRefsContext:无标记/结构不符原样返回(宁滥勿删)', () => {
  assert.equal(stripRefsContext('普通消息'), '普通消息')
  assert.equal(stripRefsContext(''), '')
  assert.equal(stripRefsContext(null), null)
  // 有头但后续不是块结构 → 不动(防误删用户正文)
  assert.equal(stripRefsContext(`${REFS_CTX_HEADER}但我聊的是别的话题`), `${REFS_CTX_HEADER}但我聊的是别的话题`)
})

test('stripRefsContext:多块(含 not found 单行块 + 嵌套 JSON)整块剥净', () => {
  const pod = JSON.stringify({ kind: 'Pod', spec: { containers: [{ name: 'c', args: ['{"x":1}'] }] } }, null, 2)
  const ctx = `${REFS_CTX_HEADER}[pods/default/nginx]:\n${pod}\n\n[secrets/default/t]: (not found)`
  assert.equal(stripRefsContext(`${ctx}\n\n\n正文保持\n\n多段`), '\n正文保持\n\n多段', 'JSON 内字符串花括号/单行备注块都不干扰边界')
})

test('stripRefsContext:JSON 未闭合(截断的历史行)原样返回', () => {
  const broken = `${REFS_CTX_HEADER}[pods/default/nginx]:\n{"kind": "Pod", "meta`
  assert.equal(stripRefsContext(broken), broken)
})

// 悬浮入口「新动态」语义(2026-08-17):重命名是元数据编辑,不是对话动态——
// PATCH title 不得 bump updatedAt,否则刚读过的对话小点复活、且悬浮列表跳顶。
test('重命名不 bump updatedAt(元数据编辑≠新动态)', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: '', userMessage: 'q' })
  const before = getConversation(h.db, conv.id).updatedAt
  h.setBody({ title: '新标题' })
  assert.ok(await h.call('PATCH', `/api/workbench/conversations/${conv.id}`))
  const after = getConversation(h.db, conv.id)
  assert.equal(after.title, '新标题')
  assert.equal(after.updatedAt, before, '重命名不动 updatedAt')
})
