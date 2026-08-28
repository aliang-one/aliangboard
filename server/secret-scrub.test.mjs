// server/secret-scrub.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createWorkbenchSchema, createProject, createConversation, appendMessage } from './workbench-projects.mjs'
import { scrubSecrets } from './secret-scrub.mjs'

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
