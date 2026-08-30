// 平台会话保留策略单测(2026-08-30 设计 §5):内存 Map + SQLite 内存库,注入式纯函数直测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { reapExpiredSessions, enforceSessionCap } from './platform-session-reaper.mjs'
import { createAuditSchema, writeAudit } from './audit.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  // platform_sessions 与 index.mjs 同构;sessions 只需要 token 列(测 DELETE 命中)
  db.exec(`CREATE TABLE platform_sessions (
    token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL,
    createdAt INTEGER NOT NULL, k8sSessionToken TEXT, lastSeenAt INTEGER, ip TEXT, userAgent TEXT)`)
  db.exec('CREATE TABLE sessions (token TEXT PRIMARY KEY)')
  createAuditSchema(db)
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

test('cap:超限踢最久未活跃,keepToken 永不踢', () => {
  const { db, platformSessions, sessions } = setup({ rows: [
    { token: 't-a', createdAt: 1, lastSeenAt: 100 },
    { token: 't-b', createdAt: 2, lastSeenAt: 300 },
    { token: 't-keep', createdAt: 3, lastSeenAt: 500 },
  ] })
  const { evicted } = enforceSessionCap({ platformSessions, db, sessions, userId: 'u1', owner: 'alice', max: 2, keepToken: 't-keep', now: 600, writeAudit })
  assert.equal(evicted, 1)
  assert.equal(platformSessions.has('t-a'), false, '最久未活跃的应被踢')
  assert.equal(platformSessions.has('t-b'), true)
  assert.equal(platformSessions.has('t-keep'), true, '本会话永不踢')
})

test('cap:lastSeenAt 缺省回退 createdAt 排序', () => {
  const { db, platformSessions } = setup({ rows: [
    { token: 't-a', createdAt: 50 },              // 无 lastSeenAt → 回退 50,最旧
    { token: 't-b', createdAt: 100 },
    { token: 't-keep', createdAt: 200 },
  ] })
  const { evicted } = enforceSessionCap({ platformSessions, db, sessions: new Map(), userId: 'u1', owner: 'alice', max: 2, keepToken: 't-keep', now: 300 })
  assert.equal(evicted, 1)
  assert.equal(platformSessions.has('t-a'), false)
})

test('cap:被踢会话 K8s 凭据回收 + 审计写入 platform_session_evict', () => {
  const { db, platformSessions, sessions } = setup({ rows: [
    { token: 't-a', createdAt: 1, lastSeenAt: 10, k8s: 'k-a' },
    { token: 't-keep', createdAt: 2, lastSeenAt: 500 },
  ] })
  enforceSessionCap({ platformSessions, db, sessions, userId: 'u1', owner: 'alice', max: 1, keepToken: 't-keep', now: 600, writeAudit })
  assert.equal(sessions.has('k-a'), false)
  const row = db.prepare("SELECT owner,tool,requestSummary FROM audit_log WHERE tool='platform_session_evict'").get()
  assert.ok(row, '应写审计')
  assert.equal(row.owner, 'alice')
  assert.match(row.requestSummary, /evicted=1/)
})

test('cap:未超限不踢不审计;max<1 视作关闭', () => {
  const { db, platformSessions } = setup({ rows: [
    { token: 't-a', createdAt: 1 }, { token: 't-b', createdAt: 2 },
  ] })
  const r1 = enforceSessionCap({ platformSessions, db, sessions: new Map(), userId: 'u1', owner: 'alice', max: 5, keepToken: 't-b', now: 10, writeAudit })
  assert.equal(r1.evicted, 0)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tool='platform_session_evict'").get().c, 0)
  const r2 = enforceSessionCap({ platformSessions, db, sessions: new Map(), userId: 'u1', owner: 'alice', max: 0, keepToken: 't-b', now: 10, writeAudit })
  assert.equal(r2.evicted, 0, 'max<1 = 关闭上限')
  assert.equal(platformSessions.size, 2)
})

test('cap:跨用户隔离——对 u1 超限踢除不波及 u2 会话(即便 u2 更旧)', () => {
  const { db, platformSessions, sessions } = setup({ rows: [
    { token: 'u1-a', userId: 'u1', createdAt: 1, lastSeenAt: 5, k8s: 'k-u1a' },
    { token: 'u1-b', userId: 'u1', createdAt: 2, lastSeenAt: 6 },
    { token: 'u1-keep', userId: 'u1', createdAt: 3, lastSeenAt: 700 },
    { token: 'u2-old', userId: 'u2', createdAt: 1, lastSeenAt: 1, k8s: 'k-u2old' },
    { token: 'u2-old2', userId: 'u2', createdAt: 1, lastSeenAt: 2 },
  ] })
  const { evicted } = enforceSessionCap({ platformSessions, db, sessions, userId: 'u1', owner: 'alice', max: 1, keepToken: 'u1-keep', now: 800, writeAudit })
  assert.equal(evicted, 2)
  assert.equal(platformSessions.has('u1-a'), false)
  assert.equal(platformSessions.has('u1-b'), false)
  assert.equal(platformSessions.has('u1-keep'), true)
  assert.equal(platformSessions.has('u2-old'), true, 'u2 更旧也不该被踢')
  assert.equal(platformSessions.has('u2-old2'), true)
  assert.equal(sessions.has('k-u2old'), true, 'u2 的 K8s 凭据不动')
  assert.ok(db.prepare("SELECT token FROM platform_sessions WHERE token='u2-old'").get(), 'u2 DB 行不动')
})

