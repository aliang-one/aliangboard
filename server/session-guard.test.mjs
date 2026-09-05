// W2-0 §0.4-1/2:K8s session 逐请求复检——禁用/失去分配即刻失效;无归属存量会话兼容放行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { sessionOwnerValid } from './session-guard.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0)`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT)`)
  return db
}

test('复检矩阵:禁用→false;失配分配→false;admin 不看分配;无归属→true(兼容);db 异常→false', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO platform_users VALUES ('u1','user',0)`).run()
  db.prepare(`INSERT INTO platform_users VALUES ('u2','user',1)`).run()
  db.prepare(`INSERT INTO platform_users VALUES ('a1','admin',0)`).run()
  db.prepare(`INSERT INTO user_clusters VALUES ('u1','c1')`).run()
  const s = (userId, clusterId) => ({ userId, clusterId })
  assert.equal(sessionOwnerValid(db, s('u1', 'c1')), true)     // 正常
  assert.equal(sessionOwnerValid(db, s('u2', 'c1')), false)    // 禁用
  assert.equal(sessionOwnerValid(db, s('u1', 'c9')), false)    // 失去分配
  assert.equal(sessionOwnerValid(db, s('a1', 'c9')), true)     // admin 豁免
  assert.equal(sessionOwnerValid(db, s(undefined, undefined)), true) // 存量无归属
  assert.equal(sessionOwnerValid(db, s('ghost', 'c1')), false) // 用户已删
  assert.equal(sessionOwnerValid(makeDb(), s('u1', 'c1')), false) // 表不存在 = fail-closed
})
