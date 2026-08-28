// server/secret-scrub.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createWorkbenchSchema, createProject, createConversation, appendMessage } from './workbench-projects.mjs'
import { scrubSecrets } from './secret-scrub.mjs'
import { REFS_CTX_HEADER } from './refs-context.mjs'

const SECRET_PLAIN = { kind: 'Secret', metadata: { name: 's1' }, data: { password: Buffer.from('hunter2').toString('base64') } }

function setup() {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  const project = db.prepare("SELECT * FROM workbench_projects WHERE name='p1'").get()
  const conv = createConversation(db, { projectId: project.id, system: 'sys', userMessage: 'hi' })
  return { db, conv }
}

test('scrubSecrets:对话级+消息级 trace 的 Secret 事件重掩;非 Secret 不动;幂等', () => {
  const { db, conv } = setup()
  const trace = JSON.stringify([
    { type: 'tool', name: 'wb_get_resource', args: { kind: 'secrets' }, result: { resource: SECRET_PLAIN }, ts: 1 },
    { type: 'tool', name: 'wb_get_resource', args: { kind: 'pods' }, result: { resource: { kind: 'Pod', metadata: { name: 'p1' } } }, ts: 2 },
  ])
  db.prepare('UPDATE workbench_conversations SET trace=? WHERE id=?').run(trace, conv.id)
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'ok', trace })
  const r1 = scrubSecrets(db)
  assert.equal(r1.eventsMasked, 2, '对话级+消息级各 1 个 Secret 事件')
  assert.ok(!db.prepare('SELECT trace FROM workbench_conversations WHERE id=?').get(conv.id).trace.includes('aHVudGVyMg=='), '明文(base64)已清除')
  assert.match(db.prepare('SELECT trace FROM workbench_conversations WHERE id=?').get(conv.id).trace, /\*\*\* \(\d+ chars, #/)
  const r2 = scrubSecrets(db)
  assert.equal(r2.eventsMasked, 0, '幂等:再跑零变化')
})

test('scrubSecrets:损坏 JSON 行跳过不抛', () => {
  const { db, conv } = setup()
  db.prepare('UPDATE workbench_conversations SET trace=? WHERE id=?').run('{broken json', conv.id)
  const r = scrubSecrets(db)
  assert.equal(r.rowsScanned >= 1, true)
  assert.equal(r.eventsMasked, 0)
})

test('scrubSecrets:trace 为空/[] 的行安全跳过', () => {
  const { db, conv } = setup()
  db.prepare('UPDATE workbench_conversations SET trace=? WHERE id=?').run('[]', conv.id)
  const r = scrubSecrets(db)
  assert.equal(r.eventsMasked, 0)
})

test('scrubSecrets:user content 烤入的 refsCtx Secret 块重掩;非 Secret 块/正文不动;幂等(终审 I2)', () => {
  const { db, conv } = setup()
  const plain = Buffer.from('hunter2').toString('base64')
  const secretBlock = JSON.stringify({ kind: 'Secret', metadata: { name: 's1' }, data: { password: plain } }, null, 2)
  const podBlock = JSON.stringify({ kind: 'Pod', metadata: { name: 'p1' } }, null, 2)
  const content = `${REFS_CTX_HEADER}[Secret/ns/s1]:\n${secretBlock}\n\n[Pod/ns/p1]:\n${podBlock}\n\n这个配置对吗`
  appendMessage(db, { conversationId: conv.id, role: 'user', content })
  const plainMsg = appendMessage(db, { conversationId: conv.id, role: 'user', content: '普通消息无 refsCtx' })
  const r1 = scrubSecrets(db)
  assert.equal(r1.eventsMasked, 1, 'refsCtx 的 Secret 块计 1')
  const rows = db.prepare('SELECT id, content FROM workbench_messages WHERE conversationId=? ORDER BY seq ASC').all(conv.id)
  const scrubbed = rows.find(r => r.content.includes(REFS_CTX_HEADER)).content
  assert.ok(!scrubbed.includes(plain), '明文(base64)已清除')
  assert.match(scrubbed, /\*\*\* \(\d+ chars, #[0-9a-f]{8}\)/, '值为掩码指纹形态')
  assert.ok(scrubbed.includes(`[Secret/ns/s1]:`) && scrubbed.includes(`[Pod/ns/p1]:`), 'label 保留')
  assert.ok(scrubbed.includes(podBlock), '非 Secret 块逐字不变')
  assert.ok(scrubbed.endsWith('这个配置对吗'), '用户正文原样收尾')
  const plainRow = rows.find(r => !r.content.includes(REFS_CTX_HEADER))
  assert.equal(plainRow.content, '普通消息无 refsCtx', '非 refsCtx 消息不动')
  const r2 = scrubSecrets(db)
  assert.equal(r2.eventsMasked, 0, '幂等:再跑零变化')
  assert.equal(db.prepare('SELECT content FROM workbench_messages WHERE id=?').get(plainRow.id).content, '普通消息无 refsCtx', '幂等跑不动干净行')
})
