// lastUsedAt 节流回写(对齐 session-touch 语义):内存即时、SQLite 按间隔。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { touchKeyUsage, _resetKeyUsageForTest } from './key-usage-touch.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE api_keys (id TEXT PRIMARY KEY, lastUsedAt INTEGER, lastUsedIp TEXT)')
  return db
}

test('首次触碰落库;间隔内跳过;越过间隔再落;ip 一并写入', () => {
  _resetKeyUsageForTest()
  const db = makeDb()
  db.prepare("INSERT INTO api_keys (id) VALUES ('k1')").run()
  const row = { id: 'k1' }
  assert.equal(touchKeyUsage(db, row, { now: 1000, ip: '1.2.3.4' }), true)
  assert.equal(touchKeyUsage(db, row, { now: 2000, ip: '1.2.3.4' }), false)        // 60s 内
  assert.equal(touchKeyUsage(db, row, { now: 61000, ip: '5.6.7.8' }), true)
  const r = db.prepare('SELECT lastUsedAt, lastUsedIp FROM api_keys WHERE id=?').get('k1')
  assert.equal(r.lastUsedAt, 61000); assert.equal(r.lastUsedIp, '5.6.7.8')
})

test('db 异常不抛(节流 map 已推进,降级为丢一次统计)', () => {
  _resetKeyUsageForTest()
  assert.equal(touchKeyUsage(makeDb(), { id: 'no-row' }, { now: 1 }), true)        // UPDATE 0 行,不抛
  assert.equal(touchKeyUsage(null, null), false)
})
