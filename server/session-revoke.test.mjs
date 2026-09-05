// CSO #3:按 userId 级联吊销 —— 平台会话行、内存 Map、各会话接入的 K8s 凭据行全清。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { revokeUserSessions, revokeUserClusterSessions, revokeClusterSessions } from './session-revoke.mjs'

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

// W2-0 §0.4-2/3:取消集群分配 / 删集群 → 吊销存量 K8s session(双路径:归属列直查 + platform 链兜底)。
function makeDb2() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_sessions (token TEXT PRIMARY KEY, userId TEXT, k8sSessionToken TEXT)`)
  db.exec(`CREATE TABLE sessions (token TEXT PRIMARY KEY, userId TEXT, clusterId TEXT)`)
  return db
}

test('revokeUserClusterSessions:只吊该用户该集群;platform 链兜底;k8sSessionToken 置空;platform session 存活', () => {
  const db = makeDb2()
  db.prepare(`INSERT INTO sessions VALUES ('k-a1','u1','c1')`).run()   // 目标
  db.prepare(`INSERT INTO sessions VALUES ('k-a2','u1','c2')`).run()   // 他集群,保留
  db.prepare(`INSERT INTO sessions VALUES ('k-b1','u2','c1')`).run()   // 他人,保留
  db.prepare(`INSERT INTO platform_sessions VALUES ('p1','u1','k-legacy')`).run() // 链式兜底目标(sessions 表无行)
  const sessions = new Map([['k-a1', { userId: 'u1', clusterId: 'c1' }], ['k-b1', { userId: 'u2', clusterId: 'c1' }],
    ['k-legacy', { clusterId: 'c1' }]])   // legacy:表无行、内存有
  const platformSessions = new Map([['p1', { userId: 'u1', k8sSessionToken: 'k-legacy' }]])
  const n = revokeUserClusterSessions({ db, sessions, platformSessions }, 'u1', ['c1'])
  assert.equal(n, 2)                                          // k-a1(直查)+ k-legacy(链兜底)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions').get().c, 2)   // k-a2/k-b1 留
  assert.equal(sessions.has('k-a1'), false); assert.equal(sessions.has('k-legacy'), false); assert.equal(sessions.has('k-b1'), true)
  assert.equal(db.prepare('SELECT k8sSessionToken FROM platform_sessions WHERE token=?').get('p1').k8sSessionToken, null)
  assert.equal(platformSessions.get('p1').k8sSessionToken, null) // 内存同步置空;platform session 存活
  assert.equal(platformSessions.has('p1'), true)
})

test('revokeClusterSessions:删集群时全用户该集群全吊', () => {
  const db = makeDb2()
  db.prepare(`INSERT INTO sessions VALUES ('k1','u1','c9')`).run()
  db.prepare(`INSERT INTO sessions VALUES ('k2','u2','c9')`).run()
  db.prepare(`INSERT INTO sessions VALUES ('k3','u2','c1')`).run()
  const sessions = new Map([['k1', { clusterId: 'c9' }], ['k2', { clusterId: 'c9' }], ['k3', { clusterId: 'c1' }]])
  assert.equal(revokeClusterSessions({ db, sessions }, 'c9'), 2)
  assert.equal(sessions.has('k3'), true)
})
