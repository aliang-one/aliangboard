import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { rekeyWindowRecords, purgeOrphanWindowRecords, isKnownSessionToken, tombstoneSession, sessionTokenOwner, tombstoneExpiredSessions, purgeRotatedSessions } from './window-records.mjs'

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
  try { db.exec(`ALTER TABLE sessions ADD COLUMN userId TEXT`) } catch { /* 列已存在 */ }
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, userId TEXT, createdAt INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS rotated_sessions (token TEXT PRIMARY KEY, userId TEXT NOT NULL, rotatedAt INTEGER NOT NULL)`)
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

test('isKnownSessionToken: sessions 表里存在的 token 才算 known(空值/未知/查库异常均拒)', () => {
  const db = freshDb()
  db.prepare(`INSERT INTO sessions (token, userId, createdAt) VALUES ('tok-1', 'user-a', 1)`).run()
  assert.equal(isKnownSessionToken(db, 'tok-1'), true)
  assert.equal(isKnownSessionToken(db, 'tok-unknown'), false)
  assert.equal(isKnownSessionToken(db, ''), false)
  assert.equal(isKnownSessionToken(db, null), false)
  const badDb = { prepare: () => { throw new Error('boom') } }
  assert.equal(isKnownSessionToken(badDb, 'tok-1'), false)
})

const DAY = 24 * 60 * 60 * 1000

test('墓碑:tombstoneSession 落表;isKnownSessionToken 接受 7 天内墓碑、拒 7 天外', () => {
  const db = freshDb()
  const now = 100 * DAY
  tombstoneSession(db, 'rot-1', 'user-1', now)
  tombstoneSession(db, 'rot-old', 'user-1', now - 8 * DAY)
  assert.equal(isKnownSessionToken(db, 'rot-1', now), true)
  assert.equal(isKnownSessionToken(db, 'rot-old', now), false)
  assert.equal(isKnownSessionToken(db, 'unknown', now), false)
})

test('sessionTokenOwner:live 行优先于墓碑;都没有 → null', () => {
  const db = freshDb()
  const now = 100 * DAY
  db.prepare('INSERT INTO sessions (token, userId, createdAt) VALUES (?,?,?)').run('live', 'user-live', now)
  tombstoneSession(db, 'rot-1', 'user-rot', now)
  assert.equal(sessionTokenOwner(db, 'live'), 'user-live')
  assert.equal(sessionTokenOwner(db, 'rot-1'), 'user-rot')
  assert.equal(sessionTokenOwner(db, 'ghost'), null)
})

test('tombstoneExpiredSessions:过期行逐行落墓碑(无 userId 的旧行跳过)后由调用方删行', () => {
  const db = freshDb()
  const now = 100 * DAY
  db.prepare('INSERT INTO sessions (token, userId, createdAt) VALUES (?,?,?)').run('exp-1', 'user-1', now - 9 * DAY)
  db.prepare('INSERT INTO sessions (token, userId, createdAt) VALUES (?,?,?)').run('exp-legacy', null, now - 9 * DAY)
  db.prepare('INSERT INTO sessions (token, userId, createdAt) VALUES (?,?,?)').run('fresh', 'user-2', now)
  tombstoneExpiredSessions(db, now - 8 * DAY, now)
  assert.equal(sessionTokenOwner(db, 'exp-1'), 'user-1')
  assert.equal(sessionTokenOwner(db, 'exp-legacy'), null)   // 旧行无 userId:不落墓碑
  // fresh 的 live 行仍在(sessionTokenOwner live 优先),改验墓碑表确未落
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rotated_sessions WHERE token = ?').get('fresh').n, 0)
})

test('purgeRotatedSessions:清 rotatedAt 早于保留窗的墓碑', () => {
  const db = freshDb()
  const now = 100 * DAY
  tombstoneSession(db, 'keep', 'u', now - 3 * DAY)
  tombstoneSession(db, 'drop', 'u', now - 9 * DAY)
  purgeRotatedSessions(db, now, 7 * DAY)
  assert.equal(sessionTokenOwner(db, 'keep'), 'u')
  assert.equal(sessionTokenOwner(db, 'drop'), null)
})
