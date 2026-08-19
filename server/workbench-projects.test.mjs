// W2 项目存储测试:建表 + createProject / listProjects(归属过滤)/ getProject。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createWorkbenchSchema, createProject, listProjects, getProject, appendHistory, recentHistory, setPendingDistill, getPendingDistill, clearPendingDistill, createConversation, getConversation, updateConversation, listConversations, appendMessage, listMessages, getMaxSeq, buildHistory, setActiveConversation, getActiveConversationId, salvageInterrupted } from './workbench-projects.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  return db
}

test('createProject + getProject:写入可读回,字段齐全', () => {
  const db = makeDb()
  const p = createProject(db, { name: 'ci-cd-system', clusterId: 'c1', ownerId: 'u1' })
  assert.equal(p.name, 'ci-cd-system')
  assert.equal(p.clusterId, 'c1')
  assert.equal(p.ownerId, 'u1')
  assert.ok(p.id && p.createdAt > 0)
  assert.equal(getProject(db, p.id).name, 'ci-cd-system')
  assert.equal(getProject(db, 'nope'), null)
})

test('createProject:缺字段抛错', () => {
  const db = makeDb()
  assert.throws(() => createProject(db, { clusterId: 'c1', ownerId: 'u1' }), /缺/)
  assert.throws(() => createProject(db, { name: 'x', ownerId: 'u1' }), /缺/)
})

test('listProjects:归属过滤——admin 见全部,普通用户只见自己的', () => {
  const db = makeDb()
  createProject(db, { name: 'a', clusterId: 'c1', ownerId: 'u1' })
  createProject(db, { name: 'b', clusterId: 'c1', ownerId: 'u2' })
  createProject(db, { name: 'c', clusterId: 'c2', ownerId: 'u1' })
  const adminSee = listProjects(db, { userId: 'u1', role: 'admin' })
  assert.equal(adminSee.length, 3)
  const u1See = listProjects(db, { userId: 'u1', role: 'user' })
  assert.equal(u1See.length, 2)
  assert.ok(u1See.every(p => p.ownerId === 'u1'))
  const u2See = listProjects(db, { userId: 'u2', role: 'user' })
  assert.equal(u2See.length, 1)
  assert.equal(u2See[0].name, 'b')
})

test('appendHistory + recentHistory:跨会话历史,最旧在前,按项目隔离', () => {
  const db = makeDb()
  appendHistory(db, 'p1', 'user', 'hello')
  appendHistory(db, 'p1', 'assistant', 'hi there')
  appendHistory(db, 'p1', 'user', '再做一件事')
  appendHistory(db, 'p2', 'user', '别的项目')
  const p1 = recentHistory(db, 'p1')
  assert.equal(p1.length, 3)
  assert.equal(p1[0].role, 'user')       // 最旧在前
  assert.equal(p1[0].content, 'hello')
  assert.equal(p1[2].content, '再做一件事')
  const p2 = recentHistory(db, 'p2')
  assert.equal(p2.length, 1)             // 项目隔离
  assert.equal(p2[0].content, '别的项目')
  // n 限制
  const last1 = recentHistory(db, 'p1', 1)
  assert.equal(last1.length, 1)
  assert.equal(last1[0].content, '再做一件事')
})

test('pending_distills:set/get/clear(每集群一条,最新覆盖,stats JSON)', () => {
  const db = makeDb()
  assert.equal(getPendingDistill(db, 'c1'), null)
  setPendingDistill(db, 'c1', { proposed: '# v1', current: '', summary: '1 条', stats: { audit: 3 } })
  let p = getPendingDistill(db, 'c1')
  assert.equal(p.proposed, '# v1')
  assert.equal(p.stats.audit, 3, 'stats 反序列化')
  assert.ok(p.ts > 0)
  // 覆盖
  setPendingDistill(db, 'c1', { proposed: '# v2', summary: '2 条', stats: { audit: 5 } })
  assert.equal(getPendingDistill(db, 'c1').proposed, '# v2')
  // 隔离
  setPendingDistill(db, 'c2', { proposed: '别的' })
  assert.equal(getPendingDistill(db, 'c2').proposed, '别的')
  assert.equal(getPendingDistill(db, 'c1').proposed, '# v2')
  // 清
  clearPendingDistill(db, 'c1')
  assert.equal(getPendingDistill(db, 'c1'), null)
  assert.equal(getPendingDistill(db, 'c2').proposed, '别的', '清 c1 不影响 c2')
})

test('appendMessage/listMessages/getMaxSeq: seq 单调递增,按序返回', () => {
  const db = makeDb()
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  const proj = listProjects(db, { userId: 'u1', role: 'admin' })[0]
  createConversation(db, { projectId: proj.id, system: '', userMessage: 'first' })
  const conv = listConversations(db, proj.id)[0]
  const u = appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })
  const a = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'yo' })
  assert.equal(u.seq, 1); assert.equal(a.seq, 2)
  assert.equal(getMaxSeq(db, conv.id), 2)
  const all = listMessages(db, conv.id)
  assert.equal(all.length, 2); assert.equal(all[0].role, 'user'); assert.equal(all[1].content, 'yo')
})

test('activeConversation: setActive/get 一 project 一活跃', () => {
  const db = makeDb()
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  const proj = listProjects(db, { userId: 'u1', role: 'admin' })[0]
  setActiveConversation(db, proj.id, 'c1')
  assert.equal(getActiveConversationId(db, proj.id), 'c1')
  setActiveConversation(db, proj.id, 'c2')
  assert.equal(getActiveConversationId(db, proj.id), 'c2')
})

test('迁移:conversation 有 recap/summarizedUpTo 列', () => {
  const db = makeDb()
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  const proj = listProjects(db, { userId: 'u1', role: 'admin' })[0]
  createConversation(db, { projectId: proj.id, system: '', userMessage: 'x' })
  const conv = listConversations(db, proj.id)[0]
  // 列存在 + 默认值
  const row = db.prepare('SELECT recap, summarizedUpTo FROM workbench_conversations WHERE id=?').get(conv.id)
  assert.equal(row.summarizedUpTo, 0); assert.equal(row.recap, null)
})

test('buildHistory: recap 在前 + summarizedUpTo 之后的全文消息', () => {
  const db = makeDb()
  createConversation(db, { projectId: 'p1', system: '', userMessage: 'x' })
  const conv = listConversations(db, 'p1')[0]
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'old-q' })      // seq1
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'old-a' }) // seq2
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'new-q' })      // seq3
  // 设 recap 覆盖 seq1-2
  db.prepare('UPDATE workbench_conversations SET recap=?, summarizedUpTo=? WHERE id=?').run('老对话摘要', 2, conv.id)
  const conv2 = getConversation(db, conv.id)
  const h = buildHistory(db, conv2)
  assert.equal(h[0].role, 'system'); assert.match(h[0].content, /老对话摘要/)
  assert.equal(h[1].role, 'user'); assert.equal(h[1].content, 'new-q')  // 只剩 seq3 全文
  assert.equal(h.length, 2)
})

// ── reasoning 持久化(R1:thinking 刷新/重进不丢)──
// 两表幂等加列(conv 级=流式检查点,消息级=终值);appendMessage 往返;启动抢救连 thinking 一起救。
test('reasoning 列:两表幂等迁移(重复建 schema 不抛)', () => {
  const db = makeDb()
  assert.doesNotThrow(() => createWorkbenchSchema(db), '重复执行幂等')
  const convCol = db.prepare("SELECT name FROM pragma_table_info('workbench_conversations') WHERE name='reasoning'").get()
  const msgCol = db.prepare("SELECT name FROM pragma_table_info('workbench_messages') WHERE name='reasoning'").get()
  assert.ok(convCol, 'workbench_conversations.reasoning 列存在')
  assert.ok(msgCol, 'workbench_messages.reasoning 列存在')
})

test('appendMessage:reasoning 落库可读回;不传 → null(旧行为)', () => {
  const db = makeDb()
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  const proj = listProjects(db, { userId: 'u1', role: 'admin' })[0]
  createConversation(db, { projectId: proj.id, system: '', userMessage: 'q' })
  const conv = listConversations(db, proj.id)[0]
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: '答', reasoning: '思考过程' })
  const msgs = listMessages(db, conv.id)
  assert.equal(msgs[0].reasoning, null, 'user 消息无 reasoning')
  assert.equal(msgs[1].reasoning, '思考过程', 'assistant 消息 reasoning 读回')
})

test('salvageInterrupted:检查点含 reasoning → 补录消息连 thinking 一起救回', () => {
  const db = makeDb()
  createProject(db, { name: 'p', clusterId: 'c1', ownerId: 'u1' })
  const proj = db.prepare("SELECT id FROM workbench_projects WHERE name='p'").get()
  const c = createConversation(db, { projectId: proj.id, system: '', userMessage: 'q' })
  appendMessage(db, { conversationId: c.id, role: 'user', content: 'q' })
  updateConversation(db, c.id, { content: '部分答案', reasoning: '部分思考' })
  salvageInterrupted(db)
  const last = listMessages(db, c.id).at(-1)
  assert.equal(last.role, 'assistant')
  assert.equal(last.content, '部分答案')
  assert.equal(last.reasoning, '部分思考', 'thinking 随抢救保留')
})

// 启动抢救(2026-08-17 意外中断内容保全):网关重启时 running→failed,若流式检查点已写了
// conv.content 而末条消息不是 assistant(中断轮答案从未 append),补录为 assistant 消息——
// 否则重开对话时用户看着流出来的答案蒸发。
test('salvageInterrupted:有检查点内容且末条非 assistant → 补录;空内容/已录过 → 不动', () => {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  createProject(db, { name: 'p', clusterId: 'c1', ownerId: 'u1' })
  const proj = db.prepare("SELECT id FROM workbench_projects WHERE name='p'").get()

  // 场景1:running + content 检查点 + 只有 user 消息 → failed + 补录 assistant
  const c1 = createConversation(db, { projectId: proj.id, system: '', userMessage: 'q' })
  appendMessage(db, { conversationId: c1.id, role: 'user', content: 'q' })
  updateConversation(db, c1.id, { content: '检查点救回的部分答案' })
  const salvaged = salvageInterrupted(db)
  const row1 = getConversation(db, c1.id)
  assert.equal(row1.status, 'failed', '标记失败')
  assert.match(row1.error, /Server restarted/)
  const msgs1 = listMessages(db, c1.id)
  assert.equal(msgs1.at(-1).role, 'assistant')
  assert.equal(msgs1.at(-1).content, '检查点救回的部分答案')
  assert.equal(salvaged, 1)

  // 场景2:running + 无 content(还没流出来就死了)→ 只标失败,不补录
  const c2 = createConversation(db, { projectId: proj.id, system: '', userMessage: 'q2' })
  appendMessage(db, { conversationId: c2.id, role: 'user', content: 'q2' })
  salvageInterrupted(db)
  assert.equal(listMessages(db, c2.id).length, 1, '无内容不补录')

  // 场景3:末条已是同内容 assistant(done 轮次遗留)→ 不重复补录
  const c3 = createConversation(db, { projectId: proj.id, system: '', userMessage: 'q3' })
  appendMessage(db, { conversationId: c3.id, role: 'user', content: 'q3' })
  updateConversation(db, c3.id, { content: '完整答案' })
  appendMessage(db, { conversationId: c3.id, role: 'assistant', content: '完整答案' })
  salvageInterrupted(db)
  assert.equal(listMessages(db, c3.id).length, 2, '已录过不重复')

  // 场景4:非 running 不碰
  const c4 = createConversation(db, { projectId: proj.id, system: '', userMessage: 'q4' })
  updateConversation(db, c4.id, { status: 'done', content: 'x' })
  const before4 = listMessages(db, c4.id).length
  salvageInterrupted(db)
  assert.equal(getConversation(db, c4.id).status, 'done')
  assert.equal(listMessages(db, c4.id).length, before4)
})
