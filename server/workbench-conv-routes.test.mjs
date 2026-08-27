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
    wbAgent: { runConversation: async () => {}, resumeConversation: async () => {}, cancelConversation: () => ({ ok: true }) },
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
    // SSE 端点直测:注入自定义 res 捕获 write 的原始事件块
    callSSE: (method, pathname, customRes) => routes.handle({ method, on: () => {} }, customRes, new URL(`http://x${pathname}`)),
  }
}

// ── 写路径:续接带 @-ref → 落库干净 + refs 并入对话级 references ──

test('续接 @-ref:content 干净落库(不烤 refsCtx),refs 仍带完整资源', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: 's', userMessage: '首轮' })
  h.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv.id) // P0(D)守卫:续接须非运行态
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
  h.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv.id) // P0(D)守卫:续接须非运行态
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
  h.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv.id) // P0(D)守卫:续接须非运行态
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

// ── P0 生命周期守卫(2026-08-17 审计):双轨分叉同族——detached run 无互斥、终态可被迟到操作改写 ──

test('A: 续接消息复位运行态字段——上一轮 content/trace/steps/pendingApproval 不残留(防 salvage 跨轮污染)', async () => {
  const h = makeHarness()
  // 模拟上一轮 done:content 有完整答案 + pendingApproval 残留
  const conv = createConversation(h.db, { projectId: h.pid, system: '', userMessage: 'q1' })
  h.db.prepare("UPDATE workbench_conversations SET status='done', content='上一轮完整答案', trace='[{\"type\":\"tool\"}]', steps=3, pendingApproval='{\"toolCallId\":\"t\"}' WHERE id=?").run(conv.id)
  h.setBody({ message: '追问' })
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/messages`))
  const row = getConversation(h.db, conv.id)
  assert.equal(row.content, '', 'content 复位')
  assert.equal(row.trace, '[]', 'trace 复位')
  assert.equal(row.steps, 0, 'steps 复位')
  assert.equal(row.pendingApproval, null, 'pendingApproval 清空')
})

test('D: 运行中对话拒绝续接(409 语义 400)——防并发双 run 互踩', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: '', userMessage: 'q1' }) // status=running
  h.setBody({ message: '再发一条' })
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/messages`))
  assert.equal(h.sent.at(-1).status, 400)
  assert.match(h.sent.at(-1).json.message, /运行中/)
  const msgs = listMessages(h.db, conv.id)
  assert.equal(msgs.length, 0, '未追加消息(createConversation 只建行,拒接后零消息)')
})

test('E1: 非 paused 对话拒绝审批——迟到审批不再把终态改写成 failed', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: '', userMessage: 'q1' })
  h.db.prepare("UPDATE workbench_conversations SET status='done', content='x' WHERE id=?").run(conv.id)
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/approve`))
  assert.equal(h.sent.at(-1).status, 400)
  const row = getConversation(h.db, conv.id)
  assert.equal(row.status, 'done', '终态不被改写')
  assert.equal(row.content, 'x')
})

test('E2: paused 双击 approve——第二次被 CAS 挡住,只 resume 一次', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: '', userMessage: 'q1' })
  h.db.prepare("UPDATE workbench_conversations SET status='paused', pendingApproval='{\"toolCallId\":\"t\",\"name\":\"wb_scale\",\"args\":{}}', messages='[]', queue='[]', denied='[]' WHERE id=?").run(conv.id)
  let resumed = 0
  // makeHarness 的 wbAgent 是固定桩;这里重建 routes 用计数桩
  const sent2 = []
  const routes2 = createWorkbenchConvRoutes({
    db: h.db, sendJson: (r, s, j) => { sent2.push({ status: s, json: j }) }, readBody: async () => ({}),
    requireAdmin: () => ({ userId: 'u1', username: 'u', role: 'admin' }),
    wbAgent: { runConversation: () => {}, resumeConversation: async () => { resumed++ }, cancelConversation: () => ({ ok: true }) },
    getLlmConfig: () => ({ baseURL: 'http://llm', apiKey: 'k', model: 'm' }),
    createLlmClient: () => ({ chat: async () => ({ content: '' }) }),
    buildCallContext: () => ({}), requestKubernetes: async () => ({}),
    busSubscribe: () => {}, busUnsubscribe: () => {}, busSnapshot: () => null, busDispose: () => {},
  })
  const call2 = (m, p) => routes2.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`))
  assert.ok(await call2('POST', `/api/workbench/conversations/${conv.id}/approve`))
  assert.equal(sent2.at(-1).status, 200, '第一次通过')
  assert.ok(await call2('POST', `/api/workbench/conversations/${conv.id}/approve`))
  assert.equal(sent2.at(-1).status, 400, '第二次被 CAS 拒')
  assert.equal(resumed, 1, '只 resume 一次')
})

test('F: 删除运行中对话——先取消(结果不回写)再事务删除,bus dispose', async () => {
  const h = makeHarness()
  const cancelled = []
  const disposed = []
  const conv = createConversation(h.db, { projectId: h.pid, system: '', userMessage: 'q1' })
  appendMessage(h.db, { conversationId: conv.id, role: 'user', content: 'q1' })
  const sent2 = []
  const routes2 = createWorkbenchConvRoutes({
    db: h.db, sendJson: (r, s, j) => { sent2.push({ status: s, json: j }) }, readBody: async () => ({}),
    requireAdmin: () => ({ userId: 'u1', username: 'u', role: 'admin' }),
    wbAgent: { runConversation: async () => {}, resumeConversation: async () => {}, cancelConversation: id => { cancelled.push(id); h.db.prepare("UPDATE workbench_conversations SET status='cancelled' WHERE id=?").run(id); return { ok: true } } },
    getLlmConfig: () => ({ baseURL: 'http://llm', apiKey: 'k', model: 'm' }),
    createLlmClient: () => ({ chat: async () => ({ content: '' }) }),
    buildCallContext: () => ({}), requestKubernetes: async () => ({}),
    busSubscribe: () => {}, busUnsubscribe: () => {}, busSnapshot: () => null, busDispose: id => disposed.push(id),
  })
  const call2 = (m, p) => routes2.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`))
  assert.ok(await call2('DELETE', `/api/workbench/conversations/${conv.id}`))
  assert.equal(sent2.at(-1).status, 200)
  assert.deepEqual(cancelled, [conv.id], '运行中先取消(结果不回写)')
  assert.deepEqual(disposed, [conv.id], 'bus dispose(SSE 收到终结)')
  assert.equal(getConversation(h.db, conv.id), null, '对话已删')
  assert.equal(listMessages(h.db, conv.id).length, 0, '消息无孤儿行')
})

// ── reasoning 出参与复位(R1/R3,2026-08-19):conv 级检查点必须显式出参(响应体是枚举字段,
// SELECT * 不会自动带);续接/regenerate 复位防上轮 thinking 污染本轮;SSE 终态快照补 reasoning。──

test('R1: GET /:id 出参含 conv 级 reasoning 检查点 + 消息级 reasoning(轮询回放/重建回看的数据源)', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: 's', userMessage: 'q' })
  appendMessage(h.db, { conversationId: conv.id, role: 'user', content: 'q' })
  appendMessage(h.db, { conversationId: conv.id, role: 'assistant', content: '答', reasoning: '思考终值' })
  h.db.prepare("UPDATE workbench_conversations SET status='running', content='检查点内容', reasoning='检查点思考' WHERE id=?").run(conv.id)
  assert.ok(await h.call('GET', `/api/workbench/conversations/${conv.id}`))
  const { json } = h.sent[0]
  assert.equal(json.reasoning, '检查点思考', 'conv 级 reasoning 出参(前端轮询回放用)')
  assert.equal(json.messages[1].reasoning, '思考终值', '消息级 reasoning 出参(重建 turns 回看 thinking)')
})

test('R1: 续接消息复位 reasoning——上一轮 thinking 检查点不残留(与 content/trace 复位同族)', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: '', userMessage: 'q1' })
  h.db.prepare("UPDATE workbench_conversations SET status='done', content='上一轮答案', reasoning='上一轮思考' WHERE id=?").run(conv.id)
  h.setBody({ message: '追问' })
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/messages`))
  const row = getConversation(h.db, conv.id)
  assert.equal(row.content, '', 'content 复位')
  assert.equal(row.reasoning, '', 'reasoning 复位')
})

test('R1: SSE 终态快照含 reasoning——刚结束就连上的客户端 thinking 不丢', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: '', userMessage: 'q1' })
  h.db.prepare("UPDATE workbench_conversations SET status='done', content='完整答案', reasoning='完整思考' WHERE id=?").run(conv.id)
  const chunks = []
  const res = { writeHead: () => {}, write: s => chunks.push(s), end: () => {} }
  assert.ok(await h.callSSE('GET', `/api/workbench/conversations/${conv.id}/stream`, res))
  const events = chunks.join('').split('\n\n').filter(Boolean).map(c => JSON.parse(c.replace(/^data: /, '')))
  const snap = events.find(e => e.type === 'snapshot')
  assert.ok(snap, '终态补发快照')
  assert.equal(snap.content, '完整答案')
  assert.equal(snap.reasoning, '完整思考', '快照带 reasoning(此前只有 running 才有)')
})

test('快照按轮切割(2026-08-25 闪变续修):trace 只含上一条消息之后的当前轮事件,assistant 瘦身;历史轮不混入', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: '', userMessage: 'q1' })
  // 历史轮:消息行 createdAt=T1;其 trace 事件 ts<T1。当前轮(未落库)事件 ts>T1。
  appendMessage(h.db, { conversationId: conv.id, role: 'user', content: '历史问', trace: null })
  appendMessage(h.db, { conversationId: conv.id, role: 'assistant', content: '历史答', trace: '[]' })
  const T1 = Date.now()
  h.db.prepare('UPDATE workbench_messages SET createdAt=? WHERE conversationId=?').run(T1, conv.id)
  const trace = JSON.stringify([
    { type: 'tool', name: '旧轮工具', args: {}, result: {}, ts: T1 - 5000 },
    { type: 'assistant', message: { role: 'assistant', content: '旧轮文本' }, ts: T1 - 4000 },
    { type: 'assistant', message: { role: 'assistant', content: '当前轮中间文本' }, ts: T1 + 1000 },
    { type: 'tool', name: '当前轮工具', args: {}, result: {}, ts: T1 + 2000 },
    { type: 'assistant', message: { role: 'assistant', content: '当前轮终答' }, ts: T1 + 3000 },
  ])
  h.db.prepare("UPDATE workbench_conversations SET status='done', content='当前轮终答', trace=? WHERE id=?").run(trace, conv.id)
  const chunks = []
  const res = { writeHead: () => {}, write: s => chunks.push(s), end: () => {} }
  assert.ok(await h.callSSE('GET', `/api/workbench/conversations/${conv.id}/stream`, res))
  const events = chunks.join('').split('\n\n').filter(Boolean).map(c => JSON.parse(c.replace(/^data: /, '')))
  const snap = events.find(e => e.type === 'snapshot')
  assert.ok(snap, '快照存在')
  const names = snap.trace.map(e => e.name).filter(Boolean)
  assert.ok(!names.includes('旧轮工具'), `历史轮工具不得混入: ${JSON.stringify(names)}`)
  assert.ok(names.includes('当前轮工具'), '当前轮工具须在')
  const asst = snap.trace.filter(e => e.type === 'assistant')
  assert.ok(asst.some(e => e.content === '当前轮中间文本' && !e.message), 'assistant 须瘦身(content 平铺)')
  assert.ok(!asst.some(e => e.content === '旧轮文本' || e.message?.content === '旧轮文本'), '历史轮文本不得混入')
})
