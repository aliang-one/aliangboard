// CSO #3:按 userId 级联吊销 —— 平台会话行、内存 Map、各会话接入的 K8s 凭据行全清。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { revokeUserSessions } from './session-revoke.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_sessions (token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT, role TEXT, k8sSessionToken TEXT, createdAt INTEGER, lastSeenAt INTEGER)`)
  db.exec(`CREATE TABLE sessions (token TEXT PRIMARY KEY, apiServer TEXT, createdAt INTEGER)`)
  return db
}

test('级联吊销:平台会话行 + K8s 凭据行全删,exceptToken 豁免', () => {
  const db = makeDb()
  const platformSessions = new Map([['t1', { userId: 'u1', k8sSessionToken: 'k1' }], ['t2', { userId: 'u2' }]])
  const sessions = new Map([['k1', {}]])
  db.prepare('INSERT INTO platform_sessions VALUES (?,?,?,?,?,?,?)').run('t1', 'u1', 'a', 'user', 'k1', 1, 1)
  db.prepare('INSERT INTO platform_sessions VALUES (?,?,?,?,?,?,?)').run('t2', 'u2', 'b', 'user', null, 1, 1)
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run('k1', 'http://x', 1)
  const n = revokeUserSessions({ db, platformSessions, sessions }, 'u1')
  assert.equal(n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM platform_sessions WHERE userId=?').get('u1').c, 0)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE token=?').get('k1').c, 0)
  assert.equal(platformSessions.has('t1'), false)
  assert.equal(platformSessions.has('t2'), true) // 他人不动
  // exceptToken 豁免当前会话
  db.prepare('INSERT INTO platform_sessions VALUES (?,?,?,?,?,?,?)').run('t3', 'u1', 'a', 'user', null, 2, 2)
  platformSessions.set('t3', { userId: 'u1' })
  assert.equal(revokeUserSessions({ db, platformSessions, sessions }, 'u1', { exceptToken: 't3' }), 0)
  assert.equal(platformSessions.has('t3'), true)
})
