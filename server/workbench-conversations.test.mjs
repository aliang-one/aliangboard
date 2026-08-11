// P5 对话实体测试:create→get→update→list→appendTrace round-trip。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import {
  createConversationsSchema,
  createConversation,
  getConversation,
  updateConversation,
  listConversations,
  appendTrace,
} from './workbench-projects.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  createConversationsSchema(db)
  return db
}

test('createConversation + getConversation:写入可读回,初始 status=running trace=[]', () => {
  const db = makeDb()
  const conv = createConversation(db, { projectId: 'p1', system: '你是助手', userMessage: '帮我看看' })
  assert.equal(conv.projectId, 'p1')
  assert.equal(conv.status, 'running')
  assert.equal(conv.system, '你是助手')
  assert.equal(conv.userMessage, '帮我看看')
  assert.equal(conv.steps, 0)
  assert.deepEqual(JSON.parse(conv.trace), [])
  assert.ok(conv.id && conv.createdAt > 0)
  assert.equal(conv.createdAt, conv.updatedAt, '创建时两时间戳相同')
  // getConversation round-trip
  assert.equal(getConversation(db, conv.id).id, conv.id)
  assert.equal(getConversation(db, 'nope'), null)
})

test('createConversation:缺字段抛错', () => {
  const db = makeDb()
  assert.throws(() => createConversation(db, { userMessage: 'x' }), /缺/)
  assert.throws(() => createConversation(db, { projectId: 'p1' }), /缺/)
})

test('updateConversation:patch 动态 SET(status + content),updatedAt 更新', () => {
  const db = makeDb()
  const conv = createConversation(db, { projectId: 'p1', userMessage: 'hello' })
  const updated = updateConversation(db, conv.id, { status: 'done', content: '最终答案' })
  assert.equal(updated.status, 'done')
  assert.equal(updated.content, '最终答案')
  assert.ok(updated.updatedAt >= conv.updatedAt, 'updatedAt 已推进')
  // 未提供的字段不变
  assert.equal(updated.userMessage, 'hello')
})

test('listConversations:按项目过滤 + createdAt DESC 排序,返回 slim 列', () => {
  const db = makeDb()
  const c1 = createConversation(db, { projectId: 'p1', userMessage: 'first' })
  const c2 = createConversation(db, { projectId: 'p2', userMessage: '别的项目' })
  const c3 = createConversation(db, { projectId: 'p1', userMessage: 'second' })
  const list = listConversations(db, 'p1')
  assert.equal(list.length, 2, 'p1 有 2 条')
  assert.equal(list[0].id, c3.id, '最新在前')
  assert.equal(list[1].id, c1.id)
  // 隔离:p2 不出现
  assert.ok(!list.some(c => c.id === c2.id))
  // slim 列:不含 messages / trace / pendingApproval 等重列
  assert.ok(!('messages' in list[0]), 'slim 列不含 messages')
  assert.ok(!('trace' in list[0]), 'slim 列不含 trace')
  // slim 列含必须字段
  for (const c of list) {
    assert.ok('id' in c && 'status' in c && 'steps' in c && 'userMessage' in c && 'createdAt' in c && 'updatedAt' in c)
  }
})

test('appendTrace:push 多步,trace JSON 数组累积', () => {
  const db = makeDb()
  const conv = createConversation(db, { projectId: 'p1', userMessage: 'run a tool' })
  const t1 = appendTrace(db, conv.id, { type: 'tool', name: 'list_pods', result: '3 pods' })
  assert.equal(t1.length, 1)
  assert.equal(t1[0].name, 'list_pods')
  const t2 = appendTrace(db, conv.id, { type: 'tool', name: 'get_pod', result: 'running' })
  assert.equal(t2.length, 2)
  assert.equal(t2[1].name, 'get_pod')
  assert.equal(t2[0].name, 'list_pods', '旧步保留')
  // 从 DB 读回验证持久化
  const stored = JSON.parse(getConversation(db, conv.id).trace)
  assert.equal(stored.length, 2)
  assert.equal(stored[0].type, 'tool')
  assert.equal(stored[1].type, 'tool')
  // updatedAt 被推进
  assert.ok(getConversation(db, conv.id).updatedAt >= conv.updatedAt)
})

test('appendTrace:不存在的 conversation 抛错', () => {
  const db = makeDb()
  assert.throws(() => appendTrace(db, 'nope', { type: 'tool' }), /not found/)
})

test('createConversation 落库 references(JSON)', () => {
  const db = makeDb()
  const refs = [{ kind: 'pods', namespace: 'default', name: 'nginx' }]
  const conv = createConversation(db, { projectId: 'p1', system: 's', userMessage: 'hi', references: refs })
  const row = getConversation(db, conv.id)
  assert.deepEqual(JSON.parse(row.references), refs)
})

test('createConversation 不传 references 默认空数组', () => {
  const db = makeDb()
  const conv = createConversation(db, { projectId: 'p1', userMessage: 'hi' })
  const row = getConversation(db, conv.id)
  assert.deepEqual(JSON.parse(row.references), [])
})

test('createConversation 传 undefined references 默认空数组', () => {
  const db = makeDb()
  const conv = createConversation(db, { projectId: 'p1', userMessage: 'hi', references: undefined })
  const row = getConversation(db, conv.id)
  assert.deepEqual(JSON.parse(row.references), [])
})
