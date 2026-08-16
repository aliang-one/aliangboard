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
  listMessages,
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

// @-ref 注入:续接端点把 refsCtx 拼进刚 append 的 user 消息 content → buildHistory 读到带资源上下文的版本。
test('多轮:@-ref context 注入到新 user 消息 content,buildHistory 可见', () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: '首轮' })
  const conv = getConversation(db, listConvId(db))
  appendMessage(db, { conversationId: conv.id, role: 'user', content: '首轮' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: '首轮答' })
  // 续接端点流程:先 append 干净 → 再 UPDATE 拼 refsCtx
  const cleanMsg = '这个 pod 怎么了'
  appendMessage(db, { conversationId: conv.id, role: 'user', content: cleanMsg })
  const refsCtx = 'Referenced resources (当前状态,供你参考):\n[pods/default/nginx]:\n{...}'
  const maxSeq = getMaxSeq(db, conv.id)
  db.prepare('UPDATE workbench_messages SET content=? WHERE conversationId=? AND seq=?')
    .run(`${refsCtx}\n\n${cleanMsg}`, conv.id, maxSeq)

  const history = buildHistory(db, conv)
  const lastUser = history[history.length - 1]
  assert.match(lastUser.content, /Referenced resources/, '@-ref context 已注入新 user content')
  assert.match(lastUser.content, /这个 pod 怎么了$/, '原始消息保留在末尾')
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
