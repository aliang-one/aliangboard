import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maybeSummarize } from './workbench-summarize.mjs'
import {
  createWorkbenchSchema,
  createProject,
  createConversation,
  appendMessage,
  listConversations,
  getConversation,
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
