import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { maybeSummarize, compactConversation, SUMMARIZE_PROMPT, maybeSummarizeProject, CAPABILITY_CONSTRAINT } from './workbench-summarize.mjs'
import {
  createWorkbenchSchema,
  createProject,
  createConversation,
  appendMessage,
  listConversations,
  getConversation,
  updateConversation,
  buildHistory,
  setProjectRecap,
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

// ── conv-lifecycle-01(2026-09-07 审计 P2,数据丢失类):compact 落库竞态防线 ──
// await LLM 是秒级窗口,期间 regenerate/edit 截断(水位被钳回/消息大幅回退)或会话状态翻转
// 都可能发生;按入口陈旧 maxSeq 无条件落库会使 summarizedUpTo 高于现存/未来消息 seq →
// buildHistory 永久跳过新消息(静默上下文损坏)。契约:落库前重读会话(gone/running/paused
// → 放弃)+ 水位钳制(不越过现存 maxSeq)+ 条件写(WHERE COALESCE(summarizedUpTo,0)=入口值,
// changes=0 → 放弃,不覆写并发摘要)。

// 受控挂起配方:chat 同步执行到首个 await 前置 entered=true(与 maybeSummarizeProject 竞态
// 测试同款),调用方在 release() 前注入窗口内变更。
function hangLlm(content) {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered = false
  const llm = { chat: async () => { entered = true; await gate; return { content } } }
  return { llm, release: () => release(), get entered() { return entered } }
}

test('compact 竞态:LLM 窗口内消息被截 → 水位钳到现存 maxSeq,新消息进 buildHistory', async () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'q1' })
  const convId = db.prepare("SELECT id FROM workbench_conversations LIMIT 1").get().id
  for (let i = 0; i < 10; i++) {
    appendMessage(db, { conversationId: convId, role: i % 2 ? 'assistant' : 'user', content: `m${i}` })
  } // seq 1..10:入口 maxSeq=10,陈旧落库会写 10-2=8
  db.prepare("UPDATE workbench_conversations SET status='done', recap='旧摘要', summarizedUpTo=1 WHERE id=?").run(convId)
  const h = hangLlm('窗口后摘要')
  const task = compactConversation(db, convId, h.llm)
  assert.ok(h.entered, 'compact 已同步跑到 chat 并挂起(入口 maxSeq 已固化)')
  // 窗口内 edit 锚 seq=3 截断(删锚及后全部;regenerate 同为尾部删除):现存 maxSeq 回退 10 → 2。
  // 只动消息表不动水位——隔离验证 compact 自身的钳制防线(路由侧 regenWatermark 钳制是并行的另一道防线)。
  db.prepare('DELETE FROM workbench_messages WHERE seq >= 3 AND conversationId=?').run(convId)
  h.release()
  const out = await task
  assert.equal(out.ok, true)
  const conv = getConversation(db, convId)
  const curMax = db.prepare('SELECT MAX(seq) AS m FROM workbench_messages WHERE conversationId=?').get(convId).m
  assert.ok((conv.summarizedUpTo ?? 0) <= curMax,
    `水位不越过现存最大 seq(${conv.summarizedUpTo} > ${curMax}:appendMessage 复用被删 seq,新消息会被永久跳过)`)
  // 截断后重发的新消息(seq 复用 3)必须进 buildHistory 全文——数据面不丢内容的判据
  appendMessage(db, { conversationId: convId, role: 'user', content: '截断后新问题' })
  const history = buildHistory(db, getConversation(db, convId))
  assert.ok(history.some(m => m.content === '截断后新问题'), '新消息进 buildHistory(未被陈旧水位吞掉)')
})

test('compact 竞态:LLM 窗口内会话转 running → 放弃落库(recap/水位均不动)', async () => {
  const { db, conv } = compactFixture()
  const h = hangLlm('迟到摘要')
  const task = compactConversation(db, conv.id, h.llm)
  assert.ok(h.entered)
  // 窗口内另一标签页 regenerate/resume:置 running(落库会破坏 resume 状态)
  db.prepare("UPDATE workbench_conversations SET status='running' WHERE id=?").run(conv.id)
  h.release()
  const out = await task
  assert.deepEqual(out, { ok: false, status: 400, message: 'wbc.compactBusy' }, '放弃写,按 busy 报')
  const after = getConversation(db, conv.id)
  assert.equal(after.recap, '旧摘要', 'recap 不被迟到摘要覆写')
  assert.equal(after.summarizedUpTo, 1, '水位不动')
})

test('compact 竞态:LLM 窗口内并发摘要已推进水位 → 条件写拒绝,不覆写', async () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'q1' })
  const convId = db.prepare("SELECT id FROM workbench_conversations LIMIT 1").get().id
  for (let i = 0; i < 12; i++) {
    appendMessage(db, { conversationId: convId, role: i % 2 ? 'assistant' : 'user', content: `m${i}` })
  } // seq 1..12:compact 入口 maxSeq=12,陈旧落库会写 10
  db.prepare("UPDATE workbench_conversations SET status='done', recap='旧摘要', summarizedUpTo=1 WHERE id=?").run(convId)
  const h = hangLlm('compact 的整体替换')
  const task = compactConversation(db, convId, h.llm)
  assert.ok(h.entered)
  // 窗口内 maybeSummarize 完成:追加式写 recap + 水位推进(1 → 12-8=4)
  updateConversation(db, convId, { recap: '旧摘要\n\n并发增量摘要', summarizedUpTo: 4 }, { touch: false })
  h.release()
  const out = await task
  assert.equal(out.ok, false, '条件写 changes=0 → 放弃')
  assert.equal(out.status, 409, '竞态放弃按 Conflict 报')
  const after = getConversation(db, convId)
  assert.equal(after.recap, '旧摘要\n\n并发增量摘要', '并发摘要不被 compact 迟到落库覆写回旧口径')
  assert.equal(after.summarizedUpTo, 4, '水位不被回写')
})

test('compact 竞态:LLM 窗口内对话被删 → 404,不复活行', async () => {
  const { db, conv } = compactFixture()
  const h = hangLlm('幽灵摘要')
  const task = compactConversation(db, conv.id, h.llm)
  assert.ok(h.entered)
  db.prepare('DELETE FROM workbench_messages WHERE conversationId=?').run(conv.id)
  db.prepare('DELETE FROM workbench_conversations WHERE id=?').run(conv.id)
  h.release()
  const out = await task
  assert.deepEqual(out, { ok: false, status: 404, message: 'wbc.convNotFound' }, '对话已不存在')
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM workbench_conversations WHERE id=?').get(conv.id).c, 0, '不复活已删对话')
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

// context-assembly-08(含 gap2-03,2026-09-07 审计批次三):水位读法 `ts > watermark` 把与水位
// 同毫秒的迟并行(竞态窗口内 append 的行)永久排除——done 链路 appendHistory(user)+
// appendHistory(assistant) 同毫秒是常态。`>=` 读法把边界毫秒行重新纳入;「已摘行不重摘」由
// maybeSummarizeProject 的 in-memory 已摘 rowid 上限守住(见下一用例)。
test('unsummarizedProjectHistory:ts >= 水位(边界毫秒的并列行纳入),升序', () => {
  const db = freshDb()
  const id = p1Id(db)
  insertHistory(db, id, 'user', 'a', 100)
  insertHistory(db, id, 'assistant', 'b', 200)
  insertHistory(db, id, 'user', 'c', 300)
  assert.deepEqual(unsummarizedProjectHistory(db, id).map(r => r.ts), [100, 200, 300], '水位 0 全量升序')
  db.prepare('UPDATE workbench_projects SET historyWatermark=? WHERE id=?').run(200, id)
  const rows = unsummarizedProjectHistory(db, id)
  assert.deepEqual(rows.map(r => r.content), ['b', 'c'], 'ts==水位 的行纳入(同毫秒迟并行不再永久跳过)')
})

// 毒记忆事故加固(2026-08-31):瞬时能力结论禁止固化成持久先验。
// 终审 I3:断言用 import 的常量,不再自抄第三份字面(否则措辞收紧时测试仍绿、实现已脱钩)。
const HARD_RULE = CAPABILITY_CONSTRAINT

// I3 防线:约束字面在 summarize 源码里只允许出现一次(export 声明处),
// 三条链路(recap/compact/项目记忆)必须 ${CAPABILITY_CONSTRAINT} 内插。
test('CAPABILITY_CONSTRAINT 单一事实源:源码不再手抄约束字面(I3)', async () => {
  const src = await readFile(new URL('./workbench-summarize.mjs', import.meta.url), 'utf8')
  const occurrences = src.split(CAPABILITY_CONSTRAINT).length - 1
  assert.equal(occurrences, 1, `约束字面应只在 export 声明处出现 1 次,实际 ${occurrences} 次`)
})

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

// 摘要竞态覆写(2026-09-06):pending 读取后 await llmClient.chat(...) 期间,另一
// maybeSummarizeProject 可完成并写入更新的 recap+水位;旧任务完成后无条件 UPDATE 会把新
// recap 覆写回旧内容(内容回退;水位因 MAX 不回退,丢失的增量被跳过,无法自愈)。
// 契约:落库为条件写(WHERE COALESCE(historyWatermark,0) < maxTs),changes=0 → 本次丢弃 return false。
// gap2-01 后注:生产路径并发同项目触发已被 in-flight Set 去重,本用例注入独立 Set 复现
//「双双重入」(防重摘/条件写守卫是 in-flight 之外的纵深防御——直接调用方/未来新增触发点)。
test('maybeSummarizeProject:摘要竞态——旧任务后完成不覆写新摘要', async () => {
  const db = freshDb()
  const id = p1Id(db)
  db.prepare('UPDATE workbench_projects SET projectRecap=?, historyWatermark=? WHERE id=?').run('旧摘要', 0, id)
  for (let i = 0; i < 8; i++) insertHistory(db, id, 'user', `m${i}`, 7000 + i)

  // 任务A:先读到 pending,chat 挂起(受控 Promise),其产出是旧内容
  let releaseA
  const gateA = new Promise(resolve => { releaseA = resolve })
  let aEnteredChat = false
  const llmA = { chat: async () => {
    aEnteredChat = true
    await gateA
    return { content: '旧任务产的旧摘要' }
  } }
  const taskA = maybeSummarizeProject(db, id, llmA, { inflight: new Set() })
  // maybeSummarizeProject 同步跑到首个 await(chat 调用本身同步执行)——此刻 A 的 pending 已固化
  assert.ok(aEnteredChat, '任务A已读到 pending 并挂在其 chat 上')

  // 任务B:同批内容先完成写入(水位=本批最大 ts 7007,recap=新)
  const llmB = { chat: async () => ({ content: '新任务产的新摘要' }) }
  assert.equal(await maybeSummarizeProject(db, id, llmB, { inflight: new Set() }), true)
  let row = db.prepare('SELECT projectRecap, historyWatermark FROM workbench_projects WHERE id=?').get(id)
  assert.equal(row.projectRecap, '新任务产的新摘要')
  assert.equal(row.historyWatermark, 7007)

  // 放行任务A(其 chat 返回旧内容)→ 条件写拒绝:不覆写新摘要,返回 false
  releaseA()
  assert.equal(await taskA, false, '旧任务后完成:已有同批或更新的摘要落库,本次丢弃')

  row = db.prepare('SELECT projectRecap, historyWatermark FROM workbench_projects WHERE id=?').get(id)
  assert.equal(row.projectRecap, '新任务产的新摘要', 'recap 不被旧任务覆写回旧内容')
  assert.equal(row.historyWatermark, 7007, '水位不回退')
})

// ── gap2-02(2026-09-07 审计 P2):人工写 recap vs 在途摘要器的乐观锁 ──
// setProjectRecap 的清空/精编可被在途 maybeSummarizeProject 击穿:清空会归零
// historyWatermark,水位守卫(COALESCE(historyWatermark,0) < maxTs)反而放行——
// 被清掉的毒 recap 由迟到摘要「复活」;精编分支不动水位,同理被静默覆盖。
// 契约:recapRev 列做乐观锁——setProjectRecap 两分支递增;maybeSummarizeProject
// 快照读 rev,条件写追加 AND COALESCE(recapRev,0)=?,changes=0 → 丢弃(与水位守卫并列)。
test('maybeSummarizeProject 竞态:窗口内人工清空 → 迟到摘要丢弃,清掉的毒 recap 不复活', async () => {
  const db = freshDb()
  const id = p1Id(db)
  db.prepare('UPDATE workbench_projects SET projectRecap=? WHERE id=?').run('存量毒 recap:缺少 wb_ssh_exec', id)
  for (let i = 0; i < 8; i++) insertHistory(db, id, 'user', `m${i}`, 9000 + i)
  const h = hangLlm('迟到摘要:滚入旧毒结论的新摘要')
  const task = maybeSummarizeProject(db, id, h.llm)
  assert.ok(h.entered, '摘要器已读到 pending 并挂在 chat 上(rev 快照已定格)')
  // 窗口内人工清空(projectRecap=NULL + 水位归零 + recapRev+1)
  assert.equal(setProjectRecap(db, id, '').ok, true)
  h.release()
  assert.equal(await task, false, 'rev 不匹配 → 条件写 changes=0,丢弃')
  const row = db.prepare('SELECT projectRecap, historyWatermark FROM workbench_projects WHERE id=?').get(id)
  assert.equal(row.projectRecap, null, '清空不被在途摘要复活(毒 recap 不还魂)')
  assert.equal(row.historyWatermark, 0, '水位仍 0(不被迟到摘要推进)')
})

test('maybeSummarizeProject 竞态:窗口内人工精编覆写 → 迟到摘要丢弃,不静默覆盖', async () => {
  const db = freshDb()
  const id = p1Id(db)
  db.prepare('UPDATE workbench_projects SET projectRecap=? WHERE id=?').run('自动摘要', id)
  for (let i = 0; i < 8; i++) insertHistory(db, id, 'user', `m${i}`, 9100 + i)
  const h = hangLlm('迟到摘要')
  const task = maybeSummarizeProject(db, id, h.llm)
  assert.ok(h.entered)
  // 窗口内人工精编(projectRecap 覆写 + recapRev+1;水位不动)
  assert.equal(setProjectRecap(db, id, '人工精编:只保留 TLS 轮换结论').ok, true)
  h.release()
  assert.equal(await task, false, 'rev 不匹配 → 丢弃')
  const row = db.prepare('SELECT projectRecap, historyWatermark FROM workbench_projects WHERE id=?').get(id)
  assert.equal(row.projectRecap, '人工精编:只保留 TLS 轮换结论', '人工精编不被迟到摘要静默覆盖')
})

// fix round 1(Important):rev 不匹配 + 水位不动的组合——防重摘键不得在丢弃路径提前推进。
// 生产唯一可达的 changes=0 形态 = 窗口内人工非空精编(setProjectRecap 非空分支刻意不动水位:
// 契约「自动摘要继续增量」;in-flight Set 已挡同项目并发,双摘要竞态仅测试注入可达)。若 fedRid
// 在条件写之前推进,本批 ≥8 行被 rid>fedFloor 永久滤出、永不并入 projectRecap——增量语义被
// 击穿(旧代码下一轮会重喂合并)。契约:丢弃不推进键 → 下一轮重喂本批并与人工精编滚动合并。
test('rev 竞态×水位不动:迟到摘要丢弃后,下一轮批次行重喂合并(增量语义不丢)', async () => {
  const db = freshDb()
  const id = p1Id(db)
  // wm>0 的存量形状:上一批已摘要到 100;本批 8 行(ts 200..207)触发摘要
  db.prepare('UPDATE workbench_projects SET projectRecap=?, historyWatermark=100 WHERE id=?').run('旧摘要', id)
  for (let i = 0; i < 8; i++) insertHistory(db, id, 'user', `批次行${i}`, 200 + i)
  // A:挂在 LLM 上
  const h = hangLlm('A 迟到摘要')
  const taskA = maybeSummarizeProject(db, id, h.llm)
  assert.ok(h.entered)
  // 窗口内人工非空精编:rev+1、水位不动(100)
  setProjectRecap(db, id, '人工精编正文')
  h.release()
  assert.equal(await taskA, false, 'rev 不匹配 → 条件写丢弃')
  assert.equal(db.prepare('SELECT historyWatermark FROM workbench_projects WHERE id=?').get(id).historyWatermark, 100, '水位不动(非空精编契约)')
  // B:下一轮触发——本批 8 行必须重喂(不被 fedFloor 滤掉)并与人工精编滚动合并
  let transcript = null
  const llmB = { chat: async ({ messages }) => { transcript = messages[1].content; return { content: '并入人工精编的新摘要' } } }
  assert.equal(await maybeSummarizeProject(db, id, llmB), true, '批次行重喂 → 落库(增量语义不丢)')
  assert.ok(transcript.includes('人工精编正文'), '人工精编作为「此前项目摘要」并入输入')
  assert.ok(transcript.includes('批次行0') && transcript.includes('批次行7'), '本批 8 行全部重进摘要输入')
  const row = db.prepare('SELECT projectRecap, historyWatermark FROM workbench_projects WHERE id=?').get(id)
  assert.equal(row.projectRecap, '并入人工精编的新摘要')
  assert.equal(row.historyWatermark, 207, '水位推进到本批最大 ts')
})

// 回归(乐观锁不许误伤正常链路):人工写在摘要器快照【之前】完成 → rev 快照=当前值,
// 条件写放行;摘要器自身的写不递增 rev(只有人工写计数),连续两轮摘要互不挤兑。
test('maybeSummarizeProject 回归:人工清空发生在快照前 → 摘照常落库;摘要写不递增 rev', async () => {
  const db = freshDb()
  const id = p1Id(db)
  db.prepare('UPDATE workbench_projects SET projectRecap=? WHERE id=?').run('待清毒', id)
  for (let i = 0; i < 8; i++) insertHistory(db, id, 'user', `m${i}`, 9200 + i)
  // 先人工清空(rev 0→1),再起摘要器(快照 rev=1)
  setProjectRecap(db, id, '')
  const llmA = { chat: async () => ({ content: '清空后的第一轮摘要' }) }
  assert.equal(await maybeSummarizeProject(db, id, llmA), true, 'rev 快照=当前 → 正常落库')
  // 摘要写不递增 rev:紧接着的第二轮(快照仍 rev=1)不被第一轮挤兑
  for (let i = 0; i < 8; i++) insertHistory(db, id, 'assistant', `r${i}`, 9300 + i)
  const llmB = { chat: async () => ({ content: '第二轮摘要' }) }
  assert.equal(await maybeSummarizeProject(db, id, llmB), true, '连续摘要互不挤兑(非人工写不动 rev)')
  const row = db.prepare('SELECT projectRecap, historyWatermark, recapRev FROM workbench_projects WHERE id=?').get(id)
  assert.equal(row.projectRecap, '第二轮摘要')
  assert.equal(row.historyWatermark, 9307)
  assert.equal(row.recapRev, 1, 'rev 只数人工写(两轮摘要后仍 1)')
})

// ═══ 2026-09-07 审计批次三 PT4:上下文与记忆(context-assembly-03/08、gap2-01/04)═══

// context-assembly-03:recap 写点 64KB 硬钳。maybeSummarize 是追加式写点(`${旧}\n\n${新}` 每轮
// 滚动增长,LLM 不服从「不超过 300 字」时无界)——旧 recap 已 65k 字 + 一段新增即超限落库,
// 每轮全量注入放大。契约:三写点(此/compact/setProjectRecap)统一 clamp 64KB chars。
test('maybeSummarize:追加式 recap 超 64KB → 落库为截断值(clamp 而非无界)', async () => {
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'x' })
  const conv = listConversations(db, p1Id(db))[0]
  updateConversation(db, conv.id, { recap: '旧'.repeat(66_000) })
  for (let i = 0; i < 10; i++) {
    appendMessage(db, { conversationId: conv.id, role: 'user', content: `q${i}` })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: `a${i}` })
  }
  const llm = { chat: async () => ({ content: '新增段'.repeat(100) }) }
  await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 8 })
  const recap = getConversation(db, conv.id).recap
  assert.ok(recap.length <= 65_536 + '…(截断)'.length, `落库硬钳 64KB(实际 ${recap.length})`)
  assert.ok(recap.includes('…(截断)'), '截断标记')
  // 保头截尾(clampRecap 统一语义):追加式写点超限时尾部新增段被裁属预期——recap 瘦身的
  // 正路是 compact(全量重摘要,自身同钳),钳的承诺只是「不上限穿透」而非「保留最新」。
  assert.ok(recap.startsWith('旧'), '保头截尾,总量封顶')
})

test('compactConversation:LLM 超长摘要 → 落库为 64KB 截断值(整体替换写点同钳)', async () => {
  const { db, conv } = compactFixture()
  const llm = { chat: async () => ({ content: 'x'.repeat(70_000) }) }
  const out = await compactConversation(db, conv.id, llm)
  assert.equal(out.ok, true)
  const recap = getConversation(db, conv.id).recap
  assert.ok(recap.length <= 65_536 + '…(截断)'.length, `落库硬钳(实际 ${recap.length})`)
  assert.ok(recap.includes('…(截断)'), '截断标记')
})

// context-assembly-08 同毫秒迟并行端到端:第一批摘要落库(水位=107)后,与水位同毫秒的
// 迟并行行(竞态窗口内 append)在旧 `ts > 水位` 读法下永久跳过;第二批摘要输入必须含它。
// 同时锁定防重摘:边界毫秒的已摘行(第一批7)不重喂 LLM。
test('maybeSummarizeProject:同毫秒迟并行不再永久跳过;边界已摘行不重摘', async () => {
  const db = freshDb()
  const id = p1Id(db)
  for (let i = 0; i < 8; i++) insertHistory(db, id, 'user', `第一批${i}`, 100 + i)
  const llm1 = { chat: async () => ({ content: '第一批摘要' }) }
  assert.equal(await maybeSummarizeProject(db, id, llm1), true)
  assert.equal(db.prepare('SELECT historyWatermark FROM workbench_projects WHERE id=?').get(id).historyWatermark, 107)
  // 迟并行:与水位同毫秒(ts=107)追加(done 链路 user/assistant 同毫秒的常态形状)
  insertHistory(db, id, 'user', '迟并行STRAGGLER', 107)
  for (let i = 0; i < 7; i++) insertHistory(db, id, 'user', `第二批${i}`, 200 + i)
  let transcript = null
  const llm2 = { chat: async ({ messages }) => { transcript = messages[1].content; return { content: '第二批摘要' } } }
  assert.equal(await maybeSummarizeProject(db, id, llm2), true, '过滤已摘行后仍满阈值(8 行)')
  assert.ok(transcript.includes('迟并行STRAGGLER'), '同毫秒迟并行进入摘要输入(不再被 ts>水位 永久跳过)')
  assert.ok(!transcript.includes('第一批7'), '边界毫秒的已摘行不重摘(防重摘键)')
  assert.equal(db.prepare('SELECT historyWatermark FROM workbench_projects WHERE id=?').get(id).historyWatermark, 206)
})

// gap2-01:per-project in-flight 去重。messages 路由与 agent done 两触发点 fire-and-forget
// 并发到达时,旧实现双双读 pending → 两路 LLM → 条件写只留一路(一次 LLM 白烧)。
test('gap2-01:并发两触发 → 一次 LLM(in-flight 去重);run 结束清除后可再摘', async () => {
  const db = freshDb()
  const id = p1Id(db)
  for (let i = 0; i < 8; i++) insertHistory(db, id, 'user', `m${i}`, 4000 + i)
  const h = hangLlm('第一次摘要')
  const taskA = maybeSummarizeProject(db, id, h.llm)
  assert.ok(h.entered, 'A 已在途')
  let bCalls = 0
  const llmB = { chat: async () => { bCalls++; return { content: 'x' } } }
  assert.equal(await maybeSummarizeProject(db, id, llmB), false, 'in-flight 期间第二触发直接放弃')
  assert.equal(bCalls, 0, '第二触发不调 LLM')
  h.release()
  assert.equal(await taskA, true)
  // run 结束(出函)清除:新一批照常可摘
  for (let i = 0; i < 8; i++) insertHistory(db, id, 'user', `n${i}`, 5000 + i)
  assert.equal(await maybeSummarizeProject(db, id, { chat: async () => ({ content: '第二次摘要' }) }), true)
})

// gap2-04:摘要失败全链路静默 → 可见。内层 catch(maybeSummarize/maybeSummarizeProject)落
// console.error(带定位前缀,与 [compact]/[workbench-agent] 惯例同款);不改语义仍返 false。
test('gap2-04:轮次/项目摘要失败落 console.error(可见性,不改返回语义)', async (t) => {
  const logs = []
  const errMock = t.mock.method(console, 'error', (...a) => logs.push(a.map(String).join(' ')))
  const db = freshDb()
  createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'x' })
  const conv = listConversations(db, p1Id(db))[0]
  for (let i = 0; i < 10; i++) {
    appendMessage(db, { conversationId: conv.id, role: 'user', content: `q${i}` })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: `a${i}` })
  }
  assert.equal(await maybeSummarize(db, conv.id, { chat: async () => { throw new Error('LLM down A') } }, { thresholdTurns: 12, recentKeep: 8 }), false)
  assert.ok(logs.some(l => /摘要失败.*LLM down A/.test(l)), '轮次摘要失败落日志(带前缀)')
  for (let i = 0; i < 8; i++) insertHistory(db, p1Id(db), 'user', `m${i}`, 8000 + i)
  assert.equal(await maybeSummarizeProject(db, p1Id(db), { chat: async () => { throw new Error('LLM down B') } }), false)
  assert.ok(logs.some(l => /摘要失败.*LLM down B/.test(l)), '项目摘要失败落日志(带前缀)')
  assert.ok(getConversation(db, conv.id).recap == null, '语义不变:失败不落库')
})

// gap2-04 静态守卫:摘要 fire-and-forget 装配点不得再 `.catch(() => {})` 静默吞错
//(routes/workbench-conversations ×2 + workbench-agent ×2,四点全带日志 catch)。
test('gap2-04 静态守卫:两装配文件的摘要 fire-and-forget 全带错误日志,无静默吞错', async () => {
  for (const f of ['./routes/workbench-conversations.mjs', './workbench-agent.mjs']) {
    const src = await readFile(new URL(f, import.meta.url), 'utf8')
    const silent = [...src.matchAll(/maybeSummarize(?:Project)?\([^)]*\)\s*\.catch\(\(\)\s*=>\s*\{\}\)/g)]
    assert.equal(silent.length, 0, `${f} 摘要 fire 不得静默吞错(实际 ${silent.length} 处)`)
    const fires = [...src.matchAll(/maybeSummarize(?:Project)?\([^)]*\)\s*\.catch\(/g)].length
    const logged = [...src.matchAll(/maybeSummarize(?:Project)?\([^)]*\)\s*\.catch\(\s*[a-zA-Z]+/g)].length
    assert.ok(fires > 0, `${f} 应有摘要 fire 点`)
    assert.equal(fires, logged, `${f}:全部摘要 fire 均带错误参数 catch(${fires}/${logged})`)
  }
})

// ── E(2026-09-09 多维审计):摘要链修复 ──
function eConv(db, msgs) {
  const pid = p1Id(db)
  const conv = createConversation(db, { projectId: pid, system: '', userMessage: 'q0' })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q0' })
  for (const [role, content, trace] of msgs) appendMessage(db, { conversationId: conv.id, role, content, ...(trace ? { trace } : {}) })
  return conv
}

// H1:LLM await 窗口内水位被并发推进 → CAS 丢弃,不整段覆写并发结果(双摘要互踩丢段)
test('E1: 摘要落库 CAS——窗口内并发推进水位 → changes=0 丢弃不覆写', async () => {
  const db = freshDb()
  const conv = eConv(db, Array.from({ length: 16 }, (_, i) => [i % 2 ? 'assistant' : 'user', `msg${i}`]))
  const llm = {
    chat: async () => {
      db.prepare("UPDATE workbench_conversations SET recap='并发摘要的结果', summarizedUpTo=13 WHERE id=?").run(conv.id)
      return { role: 'assistant', content: '本路摘要' }
    },
  }
  const fired = await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 8 })
  assert.equal(fired, false, 'CAS 未命中丢弃')
  const row = db.prepare('SELECT recap, summarizedUpTo FROM workbench_conversations WHERE id=?').get(conv.id)
  assert.equal(row.recap, '并发摘要的结果', '不覆写并发已落库结果')
  assert.equal(row.summarizedUpTo, 13)
})

// H1:窗口内编辑截断(maxSeq 回落)→ 丢弃(水位不越过现存消息)
test('E2: 窗口内消息被截断(maxSeq 回落)→ 丢弃不落', async () => {
  const db = freshDb()
  const conv = eConv(db, Array.from({ length: 16 }, (_, i) => [i % 2 ? 'assistant' : 'user', `msg${i}`]))
  const llm = {
    chat: async () => {
      db.prepare('DELETE FROM workbench_messages WHERE conversationId=? AND seq>10').run(conv.id) // 编辑截断
      return { role: 'assistant', content: '迟到的摘要' }
    },
  }
  const fired = await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 8 })
  assert.equal(fired, false, 'maxSeq 回落 → 丢弃')
  const row = db.prepare('SELECT recap FROM workbench_conversations WHERE id=?').get(conv.id)
  assert.equal(row.recap, null, '迟到摘要不落库')
})

// H2:空 assistant 行(salvage 形态,文本在 trace)→ transcript 回填文本;纯工具空轮剔除
test('E3: 空 assistant 行经 trace 回填进 transcript,「继续」+空行不再产「助手零产出」毒输入', async () => {
  const db = freshDb()
  const emptyTrace = JSON.stringify([
    { type: 'assistant', content: '收到,我来查。', ts: 1 },
    { type: 'tool', name: 'wb_list', args: {}, result: '...', ts: 2 },
  ])
  const conv = eConv(db, [
    ['user', '查一下'], ['assistant', '', emptyTrace],          // salvage 形态:content 空,trace 有文本
    ['user', '继续'], ['assistant', '', JSON.stringify([{ type: 'tool', name: 'x', args: {}, result: 'y', ts: 3 }])], // 纯工具空轮
    ...Array.from({ length: 12 }, (_, i) => [i % 2 ? 'assistant' : 'user', `filler${i}`]),
  ])
  let captured = null
  const llm = { chat: async (m) => { captured = m; return { role: 'assistant', content: '摘要' } } }
  await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 2 })
  assert.ok(captured, 'LLM 被调用')
  const transcript = captured.messages[1].content
  assert.ok(transcript.includes('收到,我来查。'), '空行文本经 trace 回填进 transcript')
  assert.ok(!/^assistant: $/m.test(transcript), '不残留空 assistant 行')
  assert.ok(!transcript.includes('assistant: \n'), '纯工具空轮被剔除')
})

// H2③:折叠窗内全为空轮 → 跳过 LLM 直接推进水位(体积触发使折叠窗落在 8 个空 assistant 行上)
test('E4: 窗口全空轮 → 跳过 LLM,水位直接推进', async () => {
  const db = freshDb()
  // 自建(不经 eConv 的 q0 前置——折叠窗须全空才能命中「跳过 LLM」分支)
  const conv = createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'q' })
  for (const [role, content, trace] of [
    ...Array.from({ length: 8 }, () => ['assistant', '', '[]']),      // 折叠窗:8 个空轮
    ['user', 'U'.repeat(30000)], ['assistant', 'A'.repeat(30000)],    // 体积触发(120KB>70k)
    ['user', 'U'.repeat(30000)], ['assistant', 'A'.repeat(30000)],
  ]) appendMessage(db, { conversationId: conv.id, role, content, trace })
  let called = false
  const llm = { chat: async () => { called = true; return { role: 'assistant', content: 'x' } } }
  const fired = await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 8 })
  assert.equal(called, false, '零有效内容不烧 LLM')
  assert.equal(fired, true, '水位推进(返回 true)')
  const row = db.prepare('SELECT summarizedUpTo FROM workbench_conversations WHERE id=?').get(conv.id)
  assert.equal(row.summarizedUpTo, 8, '水位推过全部空轮')
})

// METER-5:体积触发线——行数未达 12 但体积超半预算 → 触发;末条 user 永不摘
test('E5: 体积触发——4 轮×30KB 巨轮(行数<12)也触发摘要,水位保末条 user 之前', async () => {
  const db = freshDb()
  const conv = eConv(db, [
    ['user', 'U'.repeat(30000)], ['assistant', 'A'.repeat(30000)],
    ['user', 'U'.repeat(30000)], ['assistant', 'A'.repeat(30000)],
  ])
  let called = false
  const llm = { chat: async () => { called = true; return { role: 'assistant', content: '体积触发的摘要' } } }
  const fired = await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 8 })
  assert.equal(called, true, '体积线触发 LLM')
  assert.equal(fired, true)
  const row = db.prepare('SELECT summarizedUpTo FROM workbench_conversations WHERE id=?').get(conv.id)
  const lastUser = db.prepare("SELECT seq FROM workbench_messages WHERE conversationId=? AND role='user' ORDER BY seq DESC LIMIT 1").get(conv.id)
  assert.ok(row.summarizedUpTo < lastUser.seq, `末条 user(seq=${lastUser.seq})保持全文(水位 ${row.summarizedUpTo})`)
})

// 评审 Important#1:体积线只计装配面(seq>upToPrev)——已摘要历史不永久触发(免每条消息白烧摘要 LLM)
test('E6: 历史已摘要(装配面低于体积线)→ 不触发,即使全量历史超线', async () => {
  const db = freshDb()
  // 8 条 30KB 巨轮全已被摘要(水位=8),其后仅 2 条小消息 → 装配面 ~60B + recap
  const conv = createConversation(db, { projectId: p1Id(db), system: '', userMessage: 'q' })
  for (let i = 0; i < 8; i++) appendMessage(db, { conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: 'X'.repeat(30000) })
  updateConversation(db, conv.id, { recap: '已摘要的旧决策', summarizedUpTo: 8 })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: '小问题' })
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: '小回答' })
  let called = false
  const llm = { chat: async () => { called = true; return { role: 'assistant', content: 'x' } } }
  const fired = await maybeSummarize(db, conv.id, llm, { thresholdTurns: 12, recentKeep: 8 })
  assert.equal(called, false, '装配面低于体积线 → 不烧 LLM(全量 240KB 不计入)')
  assert.equal(fired, false)
})
