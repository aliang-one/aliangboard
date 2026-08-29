// SP1 Task 4 多轮核心测试:验证续接对话时 buildHistory(runConversation 的唯一 history 来源)
// 含第 1 轮 user/assistant + 新 user 消息。runConversation 是 index.mjs 闭包无法直测,
// 这里测它依赖的 buildHistory 产出 —— 即 agent 实际收到的 history。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import {
  createWorkbenchSchema,
  createProject,
  createConversation,
  getConversation,
  updateConversation,
  listConversations,
  appendMessage,
  getMaxSeq,
  buildHistory,
  setActiveConversation,
  getActiveConversationId,
  listMessages, truncateAfterLastUser, regenWatermark, appendHistory,
} from './workbench-projects.mjs'

function freshDb() {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  return db
}

function p1Id(db) {
  return db.prepare("SELECT id FROM workbench_projects WHERE name='p1'").get().id
}

// 核心多轮断言:续接第 2 条消息时,runConversation 读到的 history 含第 1 轮。
test('多轮:第 2 轮 buildHistory 含第 1 轮 user/assistant + 新 user', () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: 'sys', userMessage: '帮我看看 pod' })
  const conv = getConversation(db, listConvId(db))
  // 第 1 轮(POST /conversations 先 append user → runConversation → done 时 append assistant)
  appendMessage(db, { conversationId: conv.id, role: 'user', content: '帮我看看 pod' })       // seq1
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: '找到 3 个 pod', trace: '[]' }) // seq2
  // 第 2 轮(POST /:id/messages append 新 user)
  appendMessage(db, { conversationId: conv.id, role: 'user', content: '第 2 个详情?' })        // seq3

  // runConversation 内部:const history = buildHistory(db, conv)
  const history = buildHistory(db, conv)
  assert.equal(history.length, 3, '3 条全文消息')
  assert.equal(history[0].role, 'user')
  assert.equal(history[0].content, '帮我看看 pod', '第 1 轮 user 在前')
  assert.equal(history[1].role, 'assistant')
  assert.equal(history[1].content, '找到 3 个 pod', '第 1 轮 assistant 保留')
  assert.equal(history[2].role, 'user')
  assert.equal(history[2].content, '第 2 个详情?', '新 user 消息在末尾')
})

// @-ref 注入(2026-08-16 契约修订):续接端点不再把 refsCtx 烤进 user content(刷新后
// 原始 JSON 当消息显示),改存干净正文;新 refs 并入对话级 "references",由 runConversation
// 的 refreshSystem 每轮注入 system(HTTP 层契约见 workbench-conv-routes.test.mjs,此处验
// 存储语义:content 干净可直读,references 承载 agent 上下文)。
test('多轮:@-ref 续接 content 干净,refs 走对话级 references(refreshSystem 注入)', () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: '首轮' })
  const conv = getConversation(db, listConvId(db))
  appendMessage(db, { conversationId: conv.id, role: 'user', content: '首轮' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: '首轮答' })
  // 续接端点流程:append 干净 user + 新 refs 并入 "references"
  const cleanMsg = '这个 pod 怎么了'
  appendMessage(db, { conversationId: conv.id, role: 'user', content: cleanMsg })
  updateConversation(db, conv.id, { references: [{ kind: 'pods', namespace: 'default', name: 'nginx' }] })

  const history = buildHistory(db, conv)
  const lastUser = history[history.length - 1]
  assert.equal(lastUser.content, cleanMsg, 'user content 干净(不含 refsCtx)')
  const row = getConversation(db, conv.id)
  assert.deepEqual(JSON.parse(row.references), [{ kind: 'pods', namespace: 'default', name: 'nginx' }], 'refs 在对话级 references(refreshSystem 每轮注入 system)')
})

// done 分支 append assistant:handleAgentResult done 后消息表多一条 assistant → 下一轮 buildHistory 含它。
test('多轮:done append assistant 后,第 3 轮 history 含第 2 轮 assistant', () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'q1' })
  const conv = getConversation(db, listConvId(db))
  // 轮 1
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q1' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a1', trace: '[]' })
  // 轮 2
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q2' })
  // runConversation 跑完 → handleAgentResult done → append assistant(模拟 T4 done 分支)
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a2', trace: '[]' })
  // 轮 3
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q3' })

  const history = buildHistory(db, conv)
  assert.equal(history.length, 5, '5 条全文:q1,a1,q2,a2,q3')
  assert.deepEqual(
    history.map(h => h.role),
    ['user', 'assistant', 'user', 'assistant', 'user'],
    '轮次交替完整',
  )
})

// 摘要后:recap 在前,summarizedUpTo 之后的全文(多轮下 recap 不丢近期轮次)。
test('多轮:摘要触发后 recap + 近期全文共存的 history', () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'q0' })
  const conv = getConversation(db, listConvId(db))
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q0' })       // seq1
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a0' }) // seq2
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q1' })      // seq3
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a1' }) // seq4
  // 摘要覆盖 seq1-2
  updateConversation(db, conv.id, { recap: '早期:用户问了 q0', summarizedUpTo: 2 })
  const conv2 = getConversation(db, conv.id)
  const history = buildHistory(db, conv2)
  assert.equal(history[0].role, 'system')
  assert.match(history[0].content, /早期:用户问了 q0/, 'recap 在最前')
  assert.equal(history.length, 3, 'recap + seq3,4 两条全文')
  assert.equal(history[1].content, 'q1')
  assert.equal(history[2].content, 'a1')
})

// helper:取 p1 最新 conversation id
function listConvId(db) {
  return db.prepare("SELECT id FROM workbench_conversations WHERE projectId=? ORDER BY createdAt DESC LIMIT 1").get(p1Id(db)).id
}

// T5:POST /conversations 新建线程后调 setActiveConversation → GET project 的 activeConversationId 指向新线程。
test('T5:新建线程 setActiveConversation 后,getActiveConversationId 返回该线程', () => {
  const db = freshDb()
  const pid = p1Id(db)
  const conv = createConversation(db, { projectId: pid, system: '', userMessage: 'hi' })
  // 模拟 POST /conversations 的 setActiveConversation(db, projectId, conv.id)
  setActiveConversation(db, pid, conv.id)
  assert.equal(getActiveConversationId(db, pid), conv.id, 'active 指向新线程')
  // 切到另一线程后 active 跟着变
  const conv2 = createConversation(db, { projectId: pid, system: '', userMessage: 'hi2' })
  setActiveConversation(db, pid, conv2.id)
  assert.equal(getActiveConversationId(db, pid), conv2.id, 'active 切到最新线程')
  // 未 set 过的项目返回 null(GET project 字段为 null,前端无活跃线程)
  createProject(db, { name: 'p2', clusterId: 'c1', ownerId: 'u1' })
  const p2id = db.prepare("SELECT id FROM workbench_projects WHERE name='p2'").get().id
  assert.equal(getActiveConversationId(db, p2id), null, '无活跃线程 → null')
})

// T5:GET /conversations/:id 返 messages + recap + summarizedUpTo。
// 验证 listMessages + getConversation(含 recap/summarizedUpTo 列)供 GET 端点拼装响应。
test('T5:GET conversation 的 messages/recap/summarizedUpTo 字段拼装', () => {
  const db = freshDb()
  const pid = p1Id(db)
  createConversation(db, { projectId: pid, system: '', userMessage: 'q0' })
  const conv = getConversation(db, listConvId(db))
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q0' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a0', trace: '[]' })

  // GET conversation 响应拼装(与 index.mjs GET /:id 响应体字段一致)
  const response = {
    id: conv.id, status: conv.status,
    recap: conv.recap, summarizedUpTo: conv.summarizedUpTo,
    messages: listMessages(db, conv.id),
  }
  assert.equal(response.recap, null, '未摘要前 recap 为 null')
  assert.equal(response.summarizedUpTo, 0, '未摘要前 summarizedUpTo 为 0 (列默认值,recap=null 表无摘要)')
  assert.equal(response.messages.length, 2, '2 条消息:user + assistant')
  assert.equal(response.messages[0].role, 'user')
  assert.equal(response.messages[0].content, 'q0')
  assert.equal(response.messages[1].role, 'assistant')

  // 摘要后 recap/summarizedUpTo 落库 → getConversation 再读出来即新值
  updateConversation(db, conv.id, { recap: '早期总结', summarizedUpTo: 2 })
  const conv2 = getConversation(db, conv.id)
  assert.equal(conv2.recap, '早期总结', 'recap 已落库')
  assert.equal(conv2.summarizedUpTo, 2, 'summarizedUpTo 已落库')
})

test('createConversation 落库 references(JSON)', () => {
  const db = freshDb()
  const refs = [{ kind: 'pods', namespace: 'default', name: 'nginx' }]
  const conv = createConversation(db, { projectId: p1Id(db), system: 's', userMessage: 'hi', references: refs })
  const row = getConversation(db, conv.id)
  assert.deepEqual(JSON.parse(row.references), refs)
})

test('createConversation 不传 references 默认空数组', () => {
  const db = freshDb()
  const conv = createConversation(db, { projectId: p1Id(db), userMessage: 'hi' })
  const row = getConversation(db, conv.id)
  assert.deepEqual(JSON.parse(row.references), [])
})

test('createConversation 传 undefined references 默认空数组', () => {
  const db = freshDb()
  const conv = createConversation(db, { projectId: p1Id(db), userMessage: 'hi', references: undefined })
  const row = getConversation(db, conv.id)
  assert.deepEqual(JSON.parse(row.references), [])
})

// I1 回归:updateConversation 的 SET 子句必须对列名双引号,否则「references」(SQLite 保留字) 裸插值会 syntax error。
test('updateConversation: patch references(保留字)不抛 + 值落库', () => {
  const db = freshDb()
  const conv = createConversation(db, { projectId: p1Id(db), userMessage: 'hi' })
  const refs = [{ kind: 'pods', namespace: 'default', name: 'nginx' }]
  const updated = updateConversation(db, conv.id, { references: refs })
  assert.equal(updated.status, 'running', '其他字段不受影响')
  const row = getConversation(db, conv.id)
  assert.deepEqual(JSON.parse(row.references), refs, 'references 落库可读回')
})

// 活跃度排序(2026-08-16 交互审查):updatedAt DESC——续接旧对话浮顶,createdAt 沉底违背直觉
test('listConversations 按 updatedAt DESC(活跃优先,非创建时间)', () => {
  const db = freshDb()
  const pid = p1Id(db)
  const old = createConversation(db, { projectId: pid, system: '', userMessage: '旧的' })
  const fresh = createConversation(db, { projectId: pid, system: '', userMessage: '新的' })
  // 旧对话后来被续接(updatedAt 更新)→ 应排到最前
  updateConversation(db, old.id, { content: '续接后' })
  const list = listConversations(db, pid)
  assert.equal(list[0].id, old.id, '最近活跃的旧对话排最前')
  assert.equal(list[1].id, fresh.id)
})

// dev28: 重新生成(P1)——truncateAfterLastUser 截掉最后 user 之后的回复,保留该 user 及更早轮次
test('truncateAfterLastUser:多轮只截末轮回复,前几轮完整保留;无 user 返回 0', () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: 'sys', userMessage: 'q1' })
  const conv = getConversation(db, listConvId(db))
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q1' })                    // seq1
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a1', trace: '[]' }) // seq2
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q2' })                    // seq3
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a2-bad', trace: '[]' }) // seq4
  const { removed, lastUserSeq } = truncateAfterLastUser(db, conv.id)
  assert.equal(removed, 1, '只删末轮回复')
  assert.equal(lastUserSeq, 3, '返回末轮 user 的 seq(水位钳制用)')
  const msgs = listMessages(db, conv.id)
  assert.equal(msgs.length, 3)
  assert.equal(msgs[2].content, 'q2', '末轮 user 保留(buildHistory 重跑即重答此轮)')
  assert.equal(msgs[1].content, 'a1', '第一轮完整保留')
  // 再跑一次:末轮已无回复 → 删 0(幂等;调用方据此 400)
  assert.equal(truncateAfterLastUser(db, conv.id).removed, 0)
  // 无 user 消息的对话 → 0
  const conv2 = createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'x' })
  db.prepare("DELETE FROM workbench_messages WHERE conversationId=?").run(conv2.id)
  assert.equal(truncateAfterLastUser(db, conv2.id).removed, 0)
})

// dev29 风险修复:水位钳制——seq 复用 × summarizedUpTo 互踩
// 场景:水位已盖住末轮 user(regenerate 前),不钳制的话重答丢原问题全文、只靠 recap。
test('regenWatermark:水位盖住末轮 user 时钳到 lastUserSeq-1,buildHistory 保留原问题全文', () => {
  // 纯函数:各边界
  assert.equal(regenWatermark(undefined, 3), 0)
  assert.equal(regenWatermark(2, 3), 2, '未盖住则不动')
  assert.equal(regenWatermark(3, 3), 2, '恰好盖住 → 钳到 lastUserSeq-1')
  assert.equal(regenWatermark(5, 1), 0, '极端情况钳到 0 不为负')
  // 行为级:水位=4(盖住 q2=3),钳制后 buildHistory 里 q2 走全文
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'q1' })
  const conv = getConversation(db, listConvId(db))
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q1' })                     // 1
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a1', trace: '[]' })  // 2
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q2-原问题' })              // 3
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a2-bad', trace: '[]' }) // 4
  updateConversation(db, conv.id, { recap: '早期摘要', summarizedUpTo: 4 })
  const { lastUserSeq } = truncateAfterLastUser(db, conv.id)
  const clamped = regenWatermark(4, lastUserSeq)
  const convFresh = getConversation(db, conv.id) // 重取(recap/waterfield 已落库,旧对象是过期快照)
  const history = buildHistory(db, { ...convFresh, summarizedUpTo: clamped })
  const q2 = history.find(m => m.content === 'q2-原问题')
  assert.ok(q2, '钳制后原问题进全文(不被"已进 recap"跳过)')
  assert.equal(history[0].role, 'system', 'recap 段仍在最前')
})

// ── T3:GET /:id 带 context 字段(余量口径见 spec §4.3)──
// 本文件既有测试均为 DB 直调;HTTP 层沿用 workbench-conv-routes.test.mjs 的
// handle-direct 桩 harness(真 :memory: db + 桩 deps),断言按 brief 逐字。
import { createWorkbenchConvRoutes } from './routes/workbench-conversations.mjs'

function makeHttpHarness() {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  db.exec(`CREATE TABLE IF NOT EXISTS clusters (
    id TEXT PRIMARY KEY, name TEXT, apiServer TEXT, authMethod TEXT, authHeader TEXT,
    ca TEXT, cert TEXT, key TEXT, insecure INTEGER, version TEXT, createdBy TEXT, createdAt INTEGER)`)
  db.prepare("INSERT INTO clusters (id,name,apiServer,createdAt) VALUES ('c1','c1','http://k8s',?)").run(Date.now())
  const pid = createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' }).id
  const sent = []
  const res = { writeHead: () => {}, end: () => {} }
  const routes = createWorkbenchConvRoutes({
    db,
    sendJson: (r, status, json) => { sent.push({ status, json }) },
    readBody: async () => ({}),
    requireAdmin: () => ({ userId: 'u1', username: 'u', role: 'admin' }),
    wbAgent: { runConversation: async () => {}, resumeConversation: async () => {}, cancelConversation: () => ({ ok: true }) },
    getLlmConfig: () => ({ baseURL: 'http://llm', apiKey: 'k', model: 'mock-1' }),
    createLlmClient: () => ({ chat: async () => ({ content: '' }) }),
    buildCallContext: () => ({}),
    requestKubernetes: async () => ({ status: 200, headers: {}, body: {} }),
    busSubscribe: () => {}, busUnsubscribe: () => {}, busSnapshot: () => null,
  })
  return { db, pid, sent, call: (method, pathname) => routes.handle({ method, on: () => {} }, res, new URL(`http://x${pathname}`)) }
}

test('GET /:id 返回 context:estTokens/windowTokens/budgetTokens/recapUpTo/willTrim', async () => {
  const h = makeHttpHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: '工作台提示词', userMessage: '帮我看看 pod' })
  appendMessage(h.db, { conversationId: conv.id, role: 'user', content: '帮我看看 pod' })
  appendMessage(h.db, { conversationId: conv.id, role: 'assistant', content: '找到 3 个 pod', trace: '[]' })
  h.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv.id)
  // 注:LLM 配置 model=mock-1(未命中表)→ 窗口 200k
  assert.ok(await h.call('GET', `/api/workbench/conversations/${conv.id}`), '路由命中')
  const r = h.sent[h.sent.length - 1].json
  assert.ok(r.context, 'context 字段存在')
  assert.equal(r.context.windowTokens, 200_000, '未知模型默认 200k')
  assert.equal(r.context.budgetTokens, 140_000, '200k×0.7')
  assert.equal(typeof r.context.estTokens, 'number')
  assert.ok(r.context.estTokens > 0, '含 system+history 估算')
  assert.equal(r.context.recapUpTo, conv.summarizedUpTo ?? 0)
  assert.equal(r.context.willTrim, r.context.estTokens > r.context.budgetTokens)
})

// ── 编辑重发 T2:POST /:id/edit 契约(spec §3.1)──
// 复用 makeHttpHarness 骨架,readBody 可注入 body;能自建多条消息/refs/置终态。
function makeEditHarness() {
  const h = makeHttpHarness()
  const sent = []
  const res = { writeHead: () => {}, end: () => {} }
  const body = { v: {} } // 可变引用:各断言阶段覆写请求体
  const routes = createWorkbenchConvRoutes({
    db: h.db,
    sendJson: (r, status, json) => { sent.push({ status, json }) },
    readBody: async () => body.v,
    requireAdmin: () => ({ userId: 'u1', username: 'u', role: 'admin' }),
    wbAgent: { runConversation: async () => {}, resumeConversation: async () => {}, cancelConversation: () => ({ ok: true }) },
    getLlmConfig: () => ({ baseURL: 'http://llm', apiKey: 'k', model: 'mock-1' }),
    createLlmClient: () => ({ chat: async () => ({ content: '' }) }),
    buildCallContext: () => ({}),
    requestKubernetes: async () => ({ status: 200, headers: {}, body: {} }),
    busSubscribe: () => {}, busUnsubscribe: () => {}, busSnapshot: () => null,
  })
  return { db: h.db, pid: h.pid, sent, body, call: (method, pathname) => routes.handle({ method, on: () => {} }, res, new URL(`http://x${pathname}`)) }
}

// 建一条 done 对话:user(带 refs)/assistant/user 三条,返回 { conv, anchorId }
function seedEditConv(db, pid, refs = [{ kind: 'pods', namespace: 'ns', name: 'p1' }]) {
  const conv = createConversation(db, { projectId: pid, system: 'sys', userMessage: 'q1' })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q1', refs })             // seq1
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a1', trace: '[]' }) // seq2
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q2-原问题' })           // seq3 = 锚(无 refs,测沿用需给锚本身 refs)
  db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv.id)
  const anchorId = db.prepare("SELECT id FROM workbench_messages WHERE conversationId=? AND seq=3").get(conv.id).id
  return { conv, anchorId }
}

test('POST edit:截断+新消息+running+refs 沿用+水位钳制', async () => {
  const h = makeEditHarness()
  const anchorRefs = [{ kind: 'pods', namespace: 'ns', name: 'p1' }]
  const { conv, anchorId } = seedEditConv(h.db, h.pid)
  // 锚消息自带 refs(编辑缺省 references 时沿用锚的)
  h.db.prepare('UPDATE workbench_messages SET refs=? WHERE id=?').run(JSON.stringify(anchorRefs), anchorId)
  // 水位已盖住锚(seq3)→ 钳到 fromSeq-1=2(新消息不被"已进 recap"跳过)
  updateConversation(h.db, conv.id, { recap: '早期摘要', summarizedUpTo: 3 })
  h.body.v = { messageId: anchorId, content: '改过的问题' }
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/edit`), '路由命中')
  const ok = h.sent[h.sent.length - 1]
  assert.equal(ok.status, 200)
  assert.equal(ok.json.status, 'running')
  assert.ok(ok.json.context.windowTokens, '响应带 context')
  // GET messages:前 2 条保留,末条为新 user,内容=改后,refs 沿用锚原值
  const msgs = listMessages(h.db, conv.id)
  assert.equal(msgs.length, 3, 'seq3 起截断后重 append 一条 user')
  assert.equal(msgs[0].content, 'q1')
  assert.equal(msgs[1].content, 'a1')
  assert.equal(msgs[2].content, '改过的问题')
  assert.deepEqual(JSON.parse(msgs[2].refs), anchorRefs, 'refs 缺省沿用锚消息原值')
  const after = getConversation(h.db, conv.id)
  assert.equal(after.status, 'running')
  // 水位钳制(spec §3.1 修正版):min(现值, fromSeq-1)——前缀 1..2 连续,盖住锚(3)钳到 2
  assert.equal(after.summarizedUpTo, 2, '水位盖住锚:钳到 fromSeq-1')
  assert.ok(JSON.parse(after.references).some(r => r.kind === 'pods' && r.name === 'p1'), '对话级 references 含原 ref')
})

// 水位边界锁定(spec §3.1 修正:边界=fromSeq-1,非 keptMinSeq-1——后者 seq 从 1 起恒为 1,
// 每次编辑都把水位归零、前缀摘要覆盖白做。正确语义:前缀连续 1..fromSeq-1,其最大 seq 即 fromSeq-1)
test('POST edit:水位边界=fromSeq-1——编辑末条保留前缀摘要覆盖,编辑首条归 0', async () => {
  // 场景 1:锚=seq3(末条 user),summarizedUpTo=2 恰盖前缀 → 编辑后水位保留 2(不归 0)
  const h = makeEditHarness()
  const { conv, anchorId } = seedEditConv(h.db, h.pid)
  updateConversation(h.db, conv.id, { recap: '早期摘要', summarizedUpTo: 2 })
  h.body.v = { messageId: anchorId, content: '改末条' }
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/edit`))
  assert.equal(h.sent[h.sent.length - 1].status, 200)
  const after = getConversation(h.db, conv.id)
  assert.equal(after.summarizedUpTo, 2, '编辑末条:前缀(1..fromSeq-1=2)摘要覆盖保留')
  assert.equal(after.recap, '早期摘要', 'recap 不动')
  // 场景 2:锚=seq1(首条 user)→ 前缀空,水位归 0
  const h2 = makeEditHarness()
  const s2 = seedEditConv(h2.db, h2.pid)
  const seq1Id = h2.db.prepare("SELECT id FROM workbench_messages WHERE conversationId=? AND seq=1").get(s2.conv.id).id
  updateConversation(h2.db, s2.conv.id, { recap: '早期摘要', summarizedUpTo: 2 })
  h2.body.v = { messageId: seq1Id, content: '改首条' }
  assert.ok(await h2.call('POST', `/api/workbench/conversations/${s2.conv.id}/edit`))
  assert.equal(h2.sent[h2.sent.length - 1].status, 200)
  assert.equal(getConversation(h2.db, s2.conv.id).summarizedUpTo, 0, '编辑首条:前缀空(fromSeq-1=0)→ 归 0')
})

test('POST edit:references 替换(非沿用)', async () => {
  const h = makeEditHarness()
  const { conv, anchorId } = seedEditConv(h.db, h.pid)
  h.body.v = { messageId: anchorId, content: 'x', references: [{ kind: 'services', namespace: 'ns', name: 'svc1' }] }
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/edit`))
  assert.equal(h.sent[h.sent.length - 1].status, 200)
  const msgs = listMessages(h.db, conv.id)
  assert.deepEqual(JSON.parse(msgs[2].refs), [{ kind: 'services', namespace: 'ns', name: 'svc1' }])
})

test('POST edit:running → 400;锚非 user/不存在/跨对话 → 400;空内容 → 400', async () => {
  const h = makeEditHarness()
  const { conv, anchorId } = seedEditConv(h.db, h.pid)
  // running 拒绝
  updateConversation(h.db, conv.id, { status: 'running' })
  h.body.v = { messageId: anchorId, content: 'x' }
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/edit`))
  assert.equal(h.sent[h.sent.length - 1].status, 400, 'running → 400')
  updateConversation(h.db, conv.id, { status: 'done' })
  // 锚是 assistant(seq2)→ 400
  const asstId = h.db.prepare("SELECT id FROM workbench_messages WHERE conversationId=? AND seq=2").get(conv.id).id
  h.body.v = { messageId: asstId, content: 'x' }
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/edit`))
  assert.equal(h.sent[h.sent.length - 1].status, 400, '锚非 user → 400')
  // 锚不存在
  h.body.v = { messageId: 'no-such-msg', content: 'x' }
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/edit`))
  assert.equal(h.sent[h.sent.length - 1].status, 400, '锚不存在 → 400')
  // 跨对话锚:另一对话的 user 消息 id
  const c2 = seedEditConv(h.db, h.pid)
  h.body.v = { messageId: c2.anchorId, content: 'x' }
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/edit`))
  assert.equal(h.sent[h.sent.length - 1].status, 400, '跨对话锚 → 400')
  // 空内容
  h.body.v = { messageId: anchorId, content: '  ' }
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/edit`))
  assert.equal(h.sent[h.sent.length - 1].status, 400, '空内容 → 400')
  // 上述拒绝均未截断:消息仍 3 条、末条仍原文
  const msgs = listMessages(h.db, conv.id)
  assert.equal(msgs.length, 3, '拒绝路径零副作用')
  assert.equal(msgs[2].content, 'q2-原问题')
})

function makeCompactHarness() {
  const h = makeHttpHarness()
  // 覆写 readBody/createLlmClient:带 instruction + 固定摘要返回
  const db = h.db
  const sent = []
  const res = { writeHead: () => {}, end: () => {} }
  const routes = createWorkbenchConvRoutes({
    db,
    sendJson: (r, status, json) => { sent.push({ status, json }) },
    readBody: async () => ({ instruction: '保留结论' }),
    requireAdmin: () => ({ userId: 'u1', username: 'u', role: 'admin' }),
    wbAgent: { runConversation: async () => {}, resumeConversation: async () => {}, cancelConversation: () => ({ ok: true }) },
    getLlmConfig: () => ({ baseURL: 'http://llm', apiKey: 'k', model: 'mock-1' }),
    createLlmClient: () => ({ chat: async () => ({ content: '压缩后摘要' }) }),
    buildCallContext: () => ({}),
    requestKubernetes: async () => ({ status: 200, headers: {}, body: {} }),
    busSubscribe: () => {}, busUnsubscribe: () => {}, busSnapshot: () => null,
  })
  return { db, pid: h.pid, sent, call: (method, pathname) => routes.handle({ method, on: () => {} }, res, new URL(`http://x${pathname}`)) }
}

test('POST compact:成功 → { ok, recap, context };running → 400', async () => {
  const h = makeCompactHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: 'sys', userMessage: 'q1' })
  for (const [role, content] of [['user', 'q1'], ['assistant', 'a1'], ['user', 'q2'], ['assistant', 'a2'], ['user', 'q3']]) {
    appendMessage(h.db, { conversationId: conv.id, role, content, trace: role === 'assistant' ? '[]' : undefined })
  }
  h.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv.id)
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/compact`), '路由命中')
  const ok = h.sent[h.sent.length - 1]
  assert.equal(ok.status, 200)
  assert.equal(ok.json.ok, true)
  assert.ok(ok.json.recap)
  assert.ok(ok.json.context.windowTokens, '响应带 context')
  assert.equal(ok.json.context.recapUpTo, 3, '水位=最大seq-2')
  // running 拒绝:第二条对话置 running
  const conv2 = createConversation(h.db, { projectId: h.pid, system: 'sys', userMessage: 'q' })
  updateConversation(h.db, conv2.id, { status: 'running' })
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv2.id}/compact`))
  assert.equal(h.sent[h.sent.length - 1].status, 400)
})

test('POST edit:非归属用户 → 403', async () => {
  const h = makeEditHarness()
  const { conv, anchorId } = seedEditConv(h.db, h.pid)
  // 覆写 requireAdmin 为第二个普通用户(非 owner u1、非 admin)
  const sent = []
  const res = { writeHead: () => {}, end: () => {} }
  const routes = createWorkbenchConvRoutes({
    db: h.db,
    sendJson: (r, status, json) => { sent.push({ status, json }) },
    readBody: async () => ({ messageId: anchorId, content: 'x' }),
    requireAdmin: () => ({ userId: 'u2', username: 'u2', role: 'user' }),
    wbAgent: { runConversation: async () => {}, resumeConversation: async () => {}, cancelConversation: () => ({ ok: true }) },
    getLlmConfig: () => ({ baseURL: 'http://llm', apiKey: 'k', model: 'mock-1' }),
    createLlmClient: () => ({ chat: async () => ({ content: '' }) }),
    buildCallContext: () => ({}),
    requestKubernetes: async () => ({ status: 200, headers: {}, body: {} }),
    busSubscribe: () => {}, busUnsubscribe: () => {}, busSnapshot: () => null,
  })
  assert.ok(await routes.handle({ method: 'POST', on: () => {} }, res, new URL(`http://x/api/workbench/conversations/${conv.id}/edit`)))
  assert.equal(sent[sent.length - 1].status, 403, '非归属普通用户 → 403')
  assert.equal(listMessages(h.db, conv.id).length, 3, '403 零副作用')
})

// ── 项目记忆 T3:GET /:id 出参 projectRecap + append 路由 fire maybeSummarizeProject ──
test('GET /:id 带 projectRecap;append 路由 fire maybeSummarizeProject', async () => {
  const h = makeEditHarness()
  // 场景 1:项目行置 projectRecap → GET /:id 原样出参
  h.db.prepare('UPDATE workbench_projects SET projectRecap=? WHERE id=?').run('记忆内容', h.pid)
  const conv = createConversation(h.db, { projectId: h.pid, system: 'sys', userMessage: 'q1' })
  appendMessage(h.db, { conversationId: conv.id, role: 'user', content: 'q1' })
  h.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv.id)
  assert.ok(await h.call('GET', `/api/workbench/conversations/${conv.id}`), 'GET 路由命中')
  assert.equal(h.sent[h.sent.length - 1].json.projectRecap, '记忆内容', 'GET /:id 出参 projectRecap')

  // 场景 2:append(messages)fire——预置 8 条 history + llm mock 固定摘要 → POST → 轮询 projects 行非空
  const h2 = makeEditHarness()
  const llmContent = '滚动项目摘要产出'
  // 覆写 createLlmClient 返回固定摘要(独立 routes 实例,避免与场景 1 串)
  const sent2 = []
  const res2 = { writeHead: () => {}, end: () => {} }
  const body2 = { v: { message: '新问题' } }
  const routes2 = createWorkbenchConvRoutes({
    db: h2.db,
    sendJson: (r, status, json) => { sent2.push({ status, json }) },
    readBody: async () => body2.v,
    requireAdmin: () => ({ userId: 'u1', username: 'u', role: 'admin' }),
    wbAgent: { runConversation: async () => {}, resumeConversation: async () => {}, cancelConversation: () => ({ ok: true }) },
    getLlmConfig: () => ({ baseURL: 'http://llm', apiKey: 'k', model: 'mock-1' }),
    createLlmClient: () => ({ chat: async () => ({ content: llmContent }) }),
    buildCallContext: () => ({}),
    requestKubernetes: async () => ({ status: 200, headers: {}, body: {} }),
    busSubscribe: () => {}, busUnsubscribe: () => {}, busSnapshot: () => null,
  })
  const call2 = (method, pathname) => routes2.handle({ method, on: () => {} }, res2, new URL(`http://x${pathname}`))
  for (let i = 0; i < 8; i++) appendHistory(h2.db, h2.pid, i % 2 ? 'assistant' : 'user', `历史消息 ${i + 1}`)
  const conv2 = createConversation(h2.db, { projectId: h2.pid, system: 'sys', userMessage: 'q1' })
  appendMessage(h2.db, { conversationId: conv2.id, role: 'user', content: 'q1' })
  h2.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv2.id)
  assert.ok(await call2('POST', `/api/workbench/conversations/${conv2.id}/messages`), 'POST messages 路由命中')
  assert.equal(sent2[sent2.length - 1].status, 200)
  // 行为面轮询(≤2s):fire 异步落库,不断言调用次数(竞态 flaky)
  const deadline = Date.now() + 2000
  let recap = null
  while (Date.now() < deadline) {
    recap = h2.db.prepare('SELECT projectRecap FROM workbench_projects WHERE id=?').get(h2.pid)?.projectRecap ?? null
    if (recap) break
    await new Promise(r => setTimeout(r, 25))
  }
  assert.equal(recap, llmContent, 'append fire 后项目行 projectRecap 落库')
})
