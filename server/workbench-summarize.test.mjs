import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maybeSummarize, compactConversation, SUMMARIZE_PROMPT, maybeSummarizeProject } from './workbench-summarize.mjs'
import {
  createWorkbenchSchema,
  createProject,
  createConversation,
  appendMessage,
  listConversations,
  getConversation,
  updateConversation,
} from './workbench-projects.mjs'
import { DatabaseSync } from 'node:sqlite'

function freshDb() {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db) // 含 workbench_projects + conversations/messages
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  // createProject 用 randomUUID;查回 id 给测试用。
  return db
}

function p1Id(db) {
  return db.prepare("SELECT id FROM workbench_projects WHERE name='p1'").get().id
}

// 注:createLlmClient(server/llm.mjs) 暴露的是 chat({messages}) → message{role,content},
// 不是 run;测试桩对齐真实签名。Task 4 把真实 llmClient 注入即可。
test('未达阈值不摘要', async () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'x' })
  const conv = listConversations(db, p1Id(db))[0]
  for (let i = 0; i < 5; i++) {
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a' })
  }
  const llm = { chat: async () => { throw new Error('不该调') } }
  const fired = await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 8 })
  assert.equal(fired, false)
})

test('达阈值:把老消息摘成 recap,前移 summarizedUpTo', async () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'x' })
  const conv = listConversations(db, p1Id(db))[0]
  for (let i = 0; i < 10; i++) {
    appendMessage(db, { conversationId: conv.id, role: 'user', content: `q${i}` })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: `a${i}` })
  } // 20 条
  const llm = { chat: async ({ messages }) => ({ content: 'RECAP:' + messages.length }) }
  const fired = await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 8 })
  assert.equal(fired, true)
  const c = getConversation(db, conv.id)
  assert.match(c.recap, /RECAP:/)
  assert.ok(c.summarizedUpTo > 0)
})

test('已有 recap 时追加(不覆盖),summarizedUpTo 推进', async () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'x' })
  const conv = listConversations(db, p1Id(db))[0]
  for (let i = 0; i < 10; i++) {
    appendMessage(db, { conversationId: conv.id, role: 'user', content: `q${i}` })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: `a${i}` })
  }
  // 第一轮摘要
  const llm1 = { chat: async () => ({ content: 'FIRST-RECAP' }) }
  await maybeSummarize(db, conv.id, llm1, { thresholdTurns: 12, recentKeep: 8 })
  let c = getConversation(db, conv.id)
  const firstUpTo = c.summarizedUpTo
  assert.equal(c.recap, 'FIRST-RECAP')
  // 再加 10 条触发第二轮
  for (let i = 0; i < 10; i++) {
    appendMessage(db, { conversationId: conv.id, role: 'user', content: `m${i}` })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: `n${i}` })
  }
  const llm2 = { chat: async () => ({ content: 'SECOND-RECAP' }) }
  const fired2 = await maybeSummarize(db, conv.id, llm2, { thresholdTurns: 12, recentKeep: 8 })
  assert.equal(fired2, true)
  c = getConversation(db, conv.id)
  assert.match(c.recap, /FIRST-RECAP/)
  assert.match(c.recap, /SECOND-RECAP/)
  assert.ok(c.summarizedUpTo > firstUpTo, 'summarizedUpTo 必须推进')
})

test('LLM 抛错时不阻塞(返回 false,不抛)', async () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'x' })
  const conv = listConversations(db, p1Id(db))[0]
  for (let i = 0; i < 10; i++) {
    appendMessage(db, { conversationId: conv.id, role: 'user', content: `q${i}` })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: `a${i}` })
  }
  const llm = { chat: async () => { throw new Error('LLM down') } }
  const fired = await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 8 })
  assert.equal(fired, false)
  const c = getConversation(db, conv.id)
  assert.equal(c.recap, null)
  assert.equal(c.summarizedUpTo, 0)
})

test('LLM 返回空 content 不写 recap', async () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'x' })
  const conv = listConversations(db, p1Id(db))[0]
  for (let i = 0; i < 10; i++) {
    appendMessage(db, { conversationId: conv.id, role: 'user', content: `q${i}` })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: `a${i}` })
  }
  const llm = { chat: async () => ({ content: '   ' }) }
  const fired = await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 8 })
  assert.equal(fired, false)
})

test('conversation 不存在返回 false', async () => {
  const db = freshDb()
  const llm = { chat: async () => ({ content: 'x' }) }
  const fired = await maybeSummarize(db, 'nope', llm)
  assert.equal(fired, false)
})

// dev29 防御钳制:await LLM 期间消息被 regenerate 截掉 → upTo 钳到当前 maxSeq;
// 水位已越过现存最大(全被删) → 放弃写入,不产生吞新回复的错位水位
test('摘要写入前钳制:LLM 期间消息被截 → upTo 不越过现存最大 seq', async () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'q1' })
  const convId = db.prepare("SELECT id FROM workbench_conversations LIMIT 1").get().id
  for (let i = 0; i < 12; i++) {
    appendMessage(db, { conversationId: convId, role: i % 2 ? 'assistant' : 'user', content: `m${i}` })
  }
  // 慢 LLM:第一次调用期间把尾部消息删掉(模拟 regenerate 竞态)
  const llm = {
    chat: async () => {
      db.prepare('DELETE FROM workbench_messages WHERE seq > 6').run(convId)
      return { role: 'assistant', content: '摘要内容' }
    },
  }
  const wrote = await maybeSummarize(db, convId, llm)
  const conv = getConversation(db, convId)
  const maxSeq = db.prepare('SELECT MAX(seq) AS m FROM workbench_messages WHERE conversationId=?').get(convId).m
  assert.ok((conv.summarizedUpTo ?? 0) <= maxSeq, '水位不越过现存最大 seq(复用 seq 的新回复不被吞)')
  if (wrote) assert.ok(conv.recap, '写入了 recap')
})

// 悬浮入口「新动态」语义(2026-08-17):recap 摘要是后台整理,不是用户可见的新消息——
// 落库不得 bump updatedAt,否则已读对话的小点会无故复活。
test('摘要落库不 bump updatedAt(否则已读对话误报新动态)', async () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'x' })
  const conv = listConversations(db, p1Id(db))[0]
  for (let i = 0; i < 10; i++) {
    appendMessage(db, { conversationId: conv.id, role: 'user', content: `q${i}` })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: `a${i}` })
  }
  const before = getConversation(db, conv.id).updatedAt
  const llm = { chat: async () => ({ content: 'RECAP' }) }
  const fired = await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 8 })
  assert.equal(fired, true)
  const after = getConversation(db, conv.id)
  assert.ok(after.recap.includes('RECAP'), 'recap 已写')
  assert.equal(after.updatedAt, before, 'updatedAt 不动——摘要不是新消息')
})

// ── T4:手动 compact(全量重摘要+可选指令;spec §4.4)──
function compactFixture() {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: '第一问' })
  const conv = listConversations(db, p1Id(db))[0]
  appendMessage(db, { conversationId: conv.id, role: 'user', content: '第一问' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: '第一答', trace: '[]' })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: '第二问' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: '第二答', trace: '[]' })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: '第三问' })
  updateConversation(db, conv.id, { recap: '旧摘要', summarizedUpTo: 1 })
  db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv.id)
  return { db, conv }
}

test('compactConversation:全量重摘要落库,summarizedUpTo=最大seq-2,instruction 拼入 prompt', async () => {
  const { db, conv } = compactFixture()
  const calls = []
  const llm = { chat: async (args) => { calls.push(args); return { content: '全量新摘要' } } }
  const out = await compactConversation(db, conv.id, llm, '重点保留网络排查结论')
  assert.equal(out.ok, true)
  const row = getConversation(db, conv.id)
  assert.equal(row.recap, '全量新摘要', 'recap 被整体替换(旧 recap 并入摘要输入,非拼接)')
  const maxSeq = db.prepare('SELECT MAX(seq) AS m FROM workbench_messages WHERE conversationId=?').get(conv.id).m
  assert.equal(row.summarizedUpTo, maxSeq - 2)
  const userPrompt = calls[0].messages.map(m => m.content).join('\n')
  assert.ok(userPrompt.includes('重点保留网络排查结论'), '用户指令拼入')
  assert.ok(userPrompt.includes('第一问'), '旧消息全文进入摘要输入')
  assert.ok(userPrompt.includes('旧摘要'), '旧 recap 并入摘要输入')
})

test('compactConversation:LLM 失败 → 不动任何字段', async () => {
  const { db, conv } = compactFixture()
  const before = getConversation(db, conv.id)
  const llm = { chat: async () => { throw new Error('LLM down') } }
  const out = await compactConversation(db, conv.id, llm)
  assert.equal(out.ok, false)
  const after = getConversation(db, conv.id)
  assert.equal(after.recap, before.recap)
  assert.equal(after.summarizedUpTo, before.summarizedUpTo)
})

test('compactConversation:消息 ≤3 → 拒绝;running/paused → 拒绝', async () => {
  const { db, conv } = compactFixture()
  // 短对话:截到 3 条
  db.prepare('DELETE FROM workbench_messages WHERE seq > 3 AND conversationId=?').run(conv.id)
  const llm = { chat: async () => ({ content: 'x' }) }
  let out = await compactConversation(db, conv.id, llm)
  assert.deepEqual(out, { ok: false, status: 400, message: 'wbc.compactShort' })
  // running 态(消息恢复 5 条,置 running)
  db.prepare("UPDATE workbench_conversations SET status='running' WHERE id=?").run(conv.id)
  out = await compactConversation(db, conv.id, llm)
  assert.equal(out.status, 400, 'running 拒绝')
  assert.equal(out.message, 'wbc.compactBusy')
})

// ── 项目记忆 T1(spec §3.1/3.2)──
import { unsummarizedProjectHistory } from './workbench-projects.mjs'

// 显式 ts 裸 INSERT(appendHistory 用 Date.now() 不可控)
function insertHistory(db, projectId, role, content, ts) {
  db.prepare('INSERT INTO workbench_history (projectId,role,content,ts) VALUES (?,?,?,?)')
    .run(projectId, role, content, ts)
}

test('maybeSummarizeProject:未满 8 条不动;满 8 条滚动合并旧摘要并推进水位;失败不动库', async () => {
  const db = freshDb()
  const project = { id: p1Id(db) }
  // 不足阈值:7 条 history → false,projectRecap 仍 null
  for (let i = 0; i < 7; i++) insertHistory(db, project.id, 'user', `q${i}`, 1000 + i)
  const llm = { chat: async () => { throw new Error('不该调') } }
  assert.equal(await maybeSummarizeProject(db, project.id, llm), false)
  let row = db.prepare('SELECT projectRecap, historyWatermark FROM workbench_projects WHERE id=?').get(project.id)
  assert.equal(row.projectRecap, null)

  // 满 8:预置旧摘要+水位 0,再 8 条新(显式 ts)→ true
  db.prepare('UPDATE workbench_projects SET projectRecap=?, historyWatermark=0 WHERE id=?').run('旧摘要:定了用 nginx', project.id)
  const llmOk = { chat: async ({ messages }) => {
    const transcript = messages[1].content
    return { content: '新摘要:并入「' + (transcript.includes('旧摘要') ? '旧摘要' : '') + '决定3' + '」' }
  } }
  for (let i = 0; i < 8; i++) insertHistory(db, project.id, 'assistant', `决定${i}`, 2000 + i)
  assert.equal(await maybeSummarizeProject(db, project.id, llmOk), true)
  row = db.prepare('SELECT projectRecap, historyWatermark FROM workbench_projects WHERE id=?').get(project.id)
  assert.ok(row.projectRecap.includes('旧摘要') || row.projectRecap.includes('决定'), '滚动合并')
  assert.equal(row.historyWatermark, 2007, '水位=本批最大 ts')

  // 幂等边界:再调一次(0 条未摘要)→ false,库不变
  const before = row
  assert.equal(await maybeSummarizeProject(db, project.id, { chat: async () => ({ content: 'x' }) }), false)
  row = db.prepare('SELECT projectRecap, historyWatermark FROM workbench_projects WHERE id=?').get(project.id)
  assert.equal(row.projectRecap, before.projectRecap)
  assert.equal(row.historyWatermark, before.historyWatermark)
})

test('maybeSummarizeProject:LLM 抛错 → 不动库返回 false', async () => {
  const db = freshDb()
  const project = { id: p1Id(db) }
  db.prepare('UPDATE workbench_projects SET projectRecap=?, historyWatermark=? WHERE id=?').run('旧', 42, project.id)
  for (let i = 0; i < 8; i++) insertHistory(db, project.id, 'user', `m${i}`, 3000 + i)
  const llm = { chat: async () => { throw new Error('LLM down') } }
  assert.equal(await maybeSummarizeProject(db, project.id, llm), false)
  const row = db.prepare('SELECT projectRecap, historyWatermark FROM workbench_projects WHERE id=?').get(project.id)
  assert.equal(row.projectRecap, '旧')
  assert.equal(row.historyWatermark, 42)
})

test('unsummarizedProjectHistory:只取 ts > watermark,升序', () => {
  const db = freshDb()
  const id = p1Id(db)
  insertHistory(db, id, 'user', 'a', 100)
  insertHistory(db, id, 'assistant', 'b', 200)
  insertHistory(db, id, 'user', 'c', 300)
  assert.deepEqual(unsummarizedProjectHistory(db, id).map(r => r.ts), [100, 200, 300], '水位 0 全量升序')
  db.prepare('UPDATE workbench_projects SET historyWatermark=? WHERE id=?').run(200, id)
  const rows = unsummarizedProjectHistory(db, id)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows.map(r => r.content), ['c'])
})

// 毒记忆事故加固(2026-08-31):瞬时能力结论禁止固化成持久先验
const HARD_RULE = '硬性约束:工具、能力、权限的可用性随时可能因部署/配置变化,禁止把"某功能不可用/缺少某接口"这类瞬时状态写入摘要;摘要只记录稳定的项目事实、目标与决策。'

test('SUMMARIZE_PROMPT:含硬性约束(轮次 recap 同款,禁止瞬时能力结论)', () => {
  assert.ok(SUMMARIZE_PROMPT.includes(HARD_RULE), '硬性约束逐字')
})

test('maybeSummarizeProject:summarizer 指令含硬性约束(禁止瞬时能力结论入摘要)', async () => {
  const db = freshDb()
  const id = p1Id(db)
  for (let i = 0; i < 8; i++) insertHistory(db, id, 'user', `m${i}`, 6000 + i)
  let captured = null
  const llm = { chat: async ({ messages }) => { captured = messages; return { content: 's' } } }
  assert.equal(await maybeSummarizeProject(db, id, llm), true)
  assert.ok(captured, 'llm 被调用')
  assert.equal(captured[0].role, 'system')
  assert.ok(captured[0].content.includes(HARD_RULE), '硬性约束逐字入提示词')
})

test('compactConversation:压缩器指令含硬性约束(旧 recap 滚动重写不许传播瞬时结论)', async () => {
  const { db, conv } = compactFixture()
  let captured = null
  const llm = { chat: async ({ messages }) => { captured = messages; return { content: 's' } } }
  const out = await compactConversation(db, conv.id, llm)
  assert.equal(out.ok, true)
  assert.ok(captured, 'llm 被调用')
  assert.equal(captured[0].role, 'system')
  assert.ok(captured[0].content.includes(HARD_RULE), 'compact 硬性约束逐字')
})

test('maybeSummarizeProject:超长摘要硬钳 ≤2000+截断标记', async () => {
  const db = freshDb()
  const id = p1Id(db)
  for (let i = 0; i < 8; i++) insertHistory(db, id, 'user', `m${i}`, 5000 + i)
  const llm = { chat: async () => ({ content: 'x'.repeat(3000) }) }
  assert.equal(await maybeSummarizeProject(db, id, llm), true)
  const row = db.prepare('SELECT projectRecap, historyWatermark FROM workbench_projects WHERE id=?').get(id)
  assert.ok(row.projectRecap.length <= 2000 + "…(截断)".length, "落库长度硬钳")
  assert.ok(row.projectRecap.includes('…(截断)'), '截断标记')
  assert.equal(row.historyWatermark, 5007, '截断不影响水位推进')
})
