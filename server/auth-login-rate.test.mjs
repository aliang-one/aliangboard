// 安全回归(2026-08-28 CSO 审计发现 #3):/api/auth/login 曾无速率限制/无失败审计
// (checkRate 仅挂 /api/key/*),配合部署默认弱口令可无限速暴力破解。
// 本测试固化:① 按 IP+用户名限流,超限 429 + retryAfter;② 失败/成功均写审计(tool=platform_login)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createAuthRoutes } from './routes/auth.mjs'
import { createRateLimiter } from './rate-limit.mjs'
import { createAuditSchema, writeAudit } from './audit.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE IF NOT EXISTS platform_users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', displayName TEXT, createdAt INTEGER NOT NULL, disabled INTEGER DEFAULT 0)`)
  db.exec(`CREATE TABLE IF NOT EXISTS platform_sessions (
    token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, createdAt INTEGER NOT NULL, k8sSessionToken TEXT)`)
  createAuditSchema(db)
  return db
}

function makeRoutes(db, { capacity = 5, refillPerSec = 0.1 } = {}) {
  const limiter = createRateLimiter({ capacity, refillPerSec })
  const sent = []
  const sendJson = (_res, status, payload) => { sent.push({ status, payload }) }
  const routes = createAuthRoutes({
    db, sendJson,
    readBody: async () => routes._nextBody,
    requirePlatform: () => null,
    platformSessions: new Map(), sessions: new Map(), persistSession: () => {},
    verifyPassword: (p, stored) => stored === 'good' && p === 'right-password',
    randomUUID: () => 'uuid-' + (routes._n = (routes._n || 0) + 1),
    normalizeServer: (s) => new URL(s),
    buildCallContext: () => ({}),
    requestKubernetes: async () => ({ body: {} }),
    checkLoginRate: (ip, username) => limiter.check(`${ip}|${username}`),
    writeAudit, // 真实链式审计(与产线同路径;勿用简化桩——node:sqlite 拒 undefined 绑定)
  })
  return { routes, sent }
}

async function login(routes, body, ip = '1.2.3.4') {
  routes._nextBody = body
  const req = { method: 'POST', url: '/api/auth/login', headers: {}, socket: { remoteAddress: ip } }
  await routes.handle(req, {}, new URL('/api/auth/login', 'http://x'))
}

test('连续失败登录被限流:预算内 401,超限 429 带 retryAfter', async () => {
  const db = makeDb()
  db.prepare(`INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u1','alice','good','user',1)`).run()
  const { routes, sent } = makeRoutes(db)
  for (let i = 0; i < 5; i++) await login(routes, { username: 'alice', password: 'wrong' })
  assert.equal(sent.filter(s => s.status === 401).length, 5, '预算内应是 401')
  await login(routes, { username: 'alice', password: 'wrong' })
  const last = sent[sent.length - 1]
  assert.equal(last.status, 429, '超出预算应 429')
  assert.ok(last.payload.retryAfter >= 1, '429 应带 retryAfter')
})

test('限流按 IP+用户名 维度隔离:别的人不受牵连', async () => {
  const db = makeDb()
  db.prepare(`INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u1','alice','good','user',1)`).run()
  db.prepare(`INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u2','bob','good','user',1)`).run()
  const { routes, sent } = makeRoutes(db)
  for (let i = 0; i < 5; i++) await login(routes, { username: 'alice', password: 'wrong' }, '9.9.9.9')
  await login(routes, { username: 'alice', password: 'wrong' }, '9.9.9.9')
  assert.equal(sent[sent.length - 1].status, 429)
  await login(routes, { username: 'bob', password: 'right-password' }, '8.8.8.8')
  assert.equal(sent[sent.length - 1].status, 200, '其他 IP+用户名不受限流牵连')
})

test('失败与成功登录均写审计(tool=platform_login,result=denied/ok)', async () => {
  const db = makeDb()
  db.prepare(`INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u1','alice','good','user',1)`).run()
  const { routes } = makeRoutes(db)
  await login(routes, { username: 'alice', password: 'wrong' })
  await login(routes, { username: 'alice', password: 'right-password' })
  await login(routes, { username: 'ghost', password: 'x' })
  const rows = db.prepare(`SELECT owner,result FROM audit_log WHERE tool='platform_login' ORDER BY rowid`).all()
  assert.equal(rows.length, 3, '三次尝试均应留痕')
  assert.deepEqual(rows.map(r => r.result), ['denied', 'ok', 'denied'])
  assert.deepEqual(rows.map(r => r.owner), ['alice', 'alice', 'ghost'])
})

test('用户名不存在同样消耗限流预算(防用户名枚举式并行爆破)', async () => {
  const db = makeDb()
  const { routes, sent } = makeRoutes(db)
  for (let i = 0; i < 5; i++) await login(routes, { username: 'ghost', password: 'x' })
  await login(routes, { username: 'ghost', password: 'x' })
  assert.equal(sent[sent.length - 1].status, 429)
})
