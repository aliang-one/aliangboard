// lastSeenAt 节流回写:内存即时更新,库写按最小间隔节流(SQLite 同步写,平台每请求都写会拖垮)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { touchSession } from './session-touch.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE platform_sessions (token TEXT PRIMARY KEY, userId TEXT, lastSeenAt INTEGER)')
  db.prepare("INSERT INTO platform_sessions (token,userId) VALUES ('t1','u1')").run()
  return db
}

test('首次 touch:内存更新 + 写库,返回 true', () => {
  const db = makeDb()
  const ps = { token: 't1', userId: 'u1' }
  assert.equal(touchSession(db, ps, { now: 1000 }), true)
  assert.equal(ps.lastSeenAt, 1000)
  assert.equal(db.prepare('SELECT lastSeenAt FROM platform_sessions WHERE token=?').get('t1').lastSeenAt, 1000)
})

test('间隔内重复 touch:内存不更新、不写库,返回 false', () => {
  const db = makeDb()
  const ps = { token: 't1', userId: 'u1', lastSeenAt: 1000 }
  assert.equal(touchSession(db, ps, { now: 1000 + 59_999 }), false)
  assert.equal(ps.lastSeenAt, 1000)
})

test('超过最小间隔:再次写库(内存即时、库 ≤1 次/分钟/会话)', () => {
  const db = makeDb()
  const ps = { token: 't1', userId: 'u1', lastSeenAt: 1000 }
  assert.equal(touchSession(db, ps, { now: 1000 + 60_000 }), true)
  assert.equal(ps.lastSeenAt, 61_000)
})

test('ps 无 token / 库异常:不抛出,返回 false(触点在每请求热路径)', () => {
  const db = makeDb()
  assert.equal(touchSession(db, {}, { now: 1 }), false)
  const bad = new DatabaseSync(':memory:') // 无表
  assert.equal(touchSession(bad, { token: 'x' }, { now: 1 }), false)
})
