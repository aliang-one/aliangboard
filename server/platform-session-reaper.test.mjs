// 平台会话保留策略单测(2026-08-30 设计 §5):内存 Map + SQLite 内存库,注入式纯函数直测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { reapExpiredSessions } from './platform-session-reaper.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  // platform_sessions 与 index.mjs 同构;sessions 只需要 token 列(测 DELETE 命中)
  db.exec(`CREATE TABLE platform_sessions (
    token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL,
    createdAt INTEGER NOT NULL, k8sSessionToken TEXT, lastSeenAt INTEGER, ip TEXT, userAgent TEXT)`)
  db.exec('CREATE TABLE sessions (token TEXT PRIMARY KEY)')
  return db
}

function setup({ rows = [] } = {}) {
  const db = makeDb()
  const platformSessions = new Map()
  const sessions = new Map()
  for (const r of rows) {
    const rec = { token: r.token, userId: r.userId || 'u1', username: 'alice', role: 'user',
      createdAt: r.createdAt, lastSeenAt: r.lastSeenAt ?? null, k8sSessionToken: r.k8s ?? null }
    platformSessions.set(r.token, rec)
    db.prepare('INSERT INTO platform_sessions (token,userId,username,role,createdAt,k8sSessionToken,lastSeenAt) VALUES (?,?,?,?,?,?,?)')
      .run(rec.token, rec.userId, rec.username, rec.role, rec.createdAt, rec.k8sSessionToken, rec.lastSeenAt)
    if (r.k8s) sessions.set(r.k8s, { apiServer: 'https://k8s.example' })
  }
  return { db, platformSessions, sessions }
}

test('reap:过期会话三处回收(内存 Map + platform_sessions 表 + K8s 凭据)', () => {
  const now = 1_000_000
  const ttl = 8 * 60 * 60 * 1000
  const { db, platformSessions, sessions } = setup({ rows: [
    { token: 't-old', createdAt: now - ttl - 1, k8s: 'k-old' },
    { token: 't-fresh', createdAt: now - 1000 },
  ] })
  const { expired } = reapExpiredSessions({ platformSessions, db, sessions, now, ttlMs: ttl })
  assert.equal(expired, 1)
  assert.equal(platformSessions.has('t-old'), false)
  assert.equal(platformSessions.has('t-fresh'), true)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM platform_sessions').get().c, 1)
  assert.equal(sessions.has('k-old'), false, 'K8s 凭据应一并回收')
})

test('reap:恰好等于 TTL 不过期(判据为严格大于,与懒删除一致)', () => {
  const now = 1_000_000
  const ttl = 8 * 60 * 60 * 1000
  const { db, platformSessions } = setup({ rows: [{ token: 't-edge', createdAt: now - ttl }] })
  const { expired } = reapExpiredSessions({ platformSessions, db, sessions: new Map(), now, ttlMs: ttl })
  assert.equal(expired, 0)
  assert.equal(platformSessions.has('t-edge'), true)
})

test('reap:db 不可用时跳过该条不中断整批(内存仍清)', () => {
  const now = 1_000_000
  const { db, platformSessions, sessions } = setup({ rows: [
    { token: 't-a', createdAt: now - 2000 }, { token: 't-b', createdAt: now - 3000 },
  ] })
  // 闭包一个会抛错的 db 代理:DELETE 语句失败,内存删除照常
  const badDb = { prepare: (sql) => { if (sql.includes('DELETE FROM platform_sessions')) throw new Error('db down'); return db.prepare(sql) } }
  const { expired } = reapExpiredSessions({ platformSessions, db: badDb, sessions, now, ttlMs: 1000 })
  assert.equal(expired, 2)
  assert.equal(platformSessions.size, 0)
})
