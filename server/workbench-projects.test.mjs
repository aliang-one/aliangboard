// W2 项目存储测试:建表 + createProject / listProjects(归属过滤)/ getProject。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createWorkbenchSchema, createProject, listProjects, getProject, appendHistory, recentHistory } from './workbench-projects.mjs'

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
