import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { rekeyWindowRecords, purgeOrphanWindowRecords } from './window-records.mjs'

function freshDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE terminals (
    id TEXT PRIMARY KEY, sessionToken TEXT NOT NULL, name TEXT NOT NULL,
    namespace TEXT NOT NULL, podName TEXT NOT NULL, container TEXT, command TEXT,
    status TEXT DEFAULT 'minimized', createdAt INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE file_browsers (
    id TEXT PRIMARY KEY, sessionToken TEXT NOT NULL, name TEXT NOT NULL,
    namespace TEXT NOT NULL, podName TEXT NOT NULL, container TEXT,
    status TEXT DEFAULT 'minimized', createdAt INTEGER NOT NULL)`)
  return db
}
const insTerm = (db, id, token, createdAt = 1) =>
  db.prepare('INSERT INTO terminals (id, sessionToken, name, namespace, podName, createdAt) VALUES (?,?,?,?,?,?)').run(id, token, id, 'ns', 'pod', createdAt)
const insFb = (db, id, token, createdAt = 1) =>
  db.prepare('INSERT INTO file_browsers (id, sessionToken, name, namespace, podName, createdAt) VALUES (?,?,?,?,?,?)').run(id, token, id, 'ns', 'pod', createdAt)
const count = (db, t, token) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE sessionToken = ?`).get(token).n

test('rekey: 旧 token 名下记录整体迁到新 token(terminals + file_browsers)', () => {
  const db = freshDb()
  insTerm(db, 't1', 'old'); insTerm(db, 't2', 'old'); insFb(db, 'f1', 'old'); insTerm(db, 't3', 'other')
  const moved = rekeyWindowRecords(db, 'old', 'new')
  assert.deepEqual(moved, { terminals: 2, file_browsers: 1 })
  assert.equal(count(db, 'terminals', 'new'), 2)
  assert.equal(count(db, 'file_browsers', 'new'), 1)
  assert.equal(count(db, 'terminals', 'other'), 1) // 他人记录不受影响
})

test('rekey: from/to 相同或为空 → 抛错不执行', () => {
  const db = freshDb()
  insTerm(db, 't1', 'old')
  assert.throws(() => rekeyWindowRecords(db, 'old', 'old'))
  assert.throws(() => rekeyWindowRecords(db, '', 'new'))
  assert.throws(() => rekeyWindowRecords(db, 'old', ''))
  assert.equal(count(db, 'terminals', 'old'), 1) // 未被误动
})

test('rekey: 新 token 已有其他记录 → 正常合并互不影响', () => {
  const db = freshDb()
  insTerm(db, 'm1', 'old'); insTerm(db, 'm2', 'old')
  insTerm(db, 'mine', 'new') // 新 token 名下已有自己的记录(id 全局主键,跨 token 不会同 id)
  const moved = rekeyWindowRecords(db, 'old', 'new')
  assert.equal(moved.terminals, 2)
  assert.equal(count(db, 'terminals', 'new'), 3)
  assert.equal(db.prepare('SELECT sessionToken s FROM terminals WHERE id=?').get('mine').s, 'new')
})

test('purge: 只删超龄记录,新记录与可迁移旧记录保留', () => {
  const db = freshDb()
  const now = 1_000_000_000
  insTerm(db, 'ancient', 'dead', now - 31 * 24 * 60 * 60 * 1000)
  insTerm(db, 'recent', 'alive', now - 1000)
  insFb(db, 'old-fb', 'someone', now - 40 * 24 * 60 * 60 * 1000)
  const purged = purgeOrphanWindowRecords(db, 30 * 24 * 60 * 60 * 1000, now)
  assert.deepEqual(purged, { terminals: 1, file_browsers: 1 })
  assert.equal(count(db, 'terminals', 'alive'), 1)
  assert.equal(count(db, 'terminals', 'dead'), 0)
})

test('purge: 无超龄记录时零删除', () => {
  const db = freshDb()
  insTerm(db, 't1', 'tok', Date.now())
  const purged = purgeOrphanWindowRecords(db, 30 * 24 * 60 * 60 * 1000)
  assert.deepEqual(purged, { terminals: 0, file_browsers: 0 })
})
