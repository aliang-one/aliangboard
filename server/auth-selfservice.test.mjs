// 用户中心 self-service 端点(2026-08-29 设计 §4.2):
// PATCH me 字段白名单(防 role/username 穿越)+ preferences 读写与非法值拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createAuthRoutes } from './routes/auth.mjs'
import { createAuditSchema, writeAudit } from './audit.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', displayName TEXT, createdAt INTEGER NOT NULL,
    disabled INTEGER DEFAULT 0, prefs TEXT)`)
  db.exec(`CREATE TABLE platform_sessions (
    token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL,
    createdAt INTEGER NOT NULL, k8sSessionToken TEXT, lastSeenAt INTEGER, ip TEXT, userAgent TEXT)`)
  createAuditSchema(db)
  return db
}

// 最小会话态:token t-me → u1(alice)
function seed(db) {
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,displayName,createdAt) VALUES ('u1','alice','good','user','Alice',1)").run()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES ('t-me','u1','alice','user',1)").run()
}

function makeRoutes(db, over = {}) {
  const sent = []
  const deps = {
    db, sendJson: (_res, status, payload) => sent.push({ status, payload }),
    readBody: async () => deps._body,
    requirePlatform: (req) => (req._ps ?? db.prepare('SELECT * FROM platform_sessions WHERE token=?').get(req.headers['x-platform-token'])),
    platformSessions: new Map([['t-me', db.prepare('SELECT * FROM platform_sessions WHERE token=?').get('t-me')]]),
    sessions: new Map(), persistSession: () => {},
    verifyPassword: (p) => p === 'right-password',
    hashPassword: (p) => `hashed(${p})`,
    randomUUID: () => 'uuid-x',
    normalizeServer: (s) => new URL(s), buildCallContext: () => ({}),
    requestKubernetes: async () => ({ body: {} }),
    checkLoginRate: () => ({ allowed: true }),
    writeAudit,
    extractPlatformToken: (req) => req.headers['x-platform-token'] || '',
    ...over,
  }
  Object.assign(deps, over)
  // 用法契约:调用方解构 { routes, sent } 后以 routes.routes.handle(...) 分发、routes._body=… 注入请求体。
  // 故返回包装对象:.routes 恒指向真 router,_body 读写直通 deps._body(readBody 的取值源)。
  const router = createAuthRoutes(deps)
  const wrapper = { get routes() { return router } }
  Object.defineProperty(wrapper, '_body', { get() { return deps._body }, set(v) { deps._body = v } })
  return { routes: wrapper, sent, deps }
}

function patchMe(routes, body) {
  routes._body = body
  return routes.routes.handle(
    { method: 'PATCH', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/me' }, {},
    new URL('/api/auth/me', 'http://x'))
}

test('PATCH me:改 displayName,返回最新 user', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  await patchMe(routes, { displayName: '  阿亮  ' })
  assert.equal(sent[0].status, 200)
  assert.equal(sent[0].payload.user.displayName, '阿亮', '应 trim')
  assert.equal(db.prepare('SELECT displayName FROM platform_users WHERE id=?').get('u1').displayName, '阿亮')
})

test('PATCH me:白名单——role/username/password 字段被忽略(防穿越)', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  await patchMe(routes, { displayName: 'X', role: 'admin', username: 'root', passwordHash: 'pwn' })
  const row = db.prepare('SELECT role,username,passwordHash FROM platform_users WHERE id=?').get('u1')
  assert.deepEqual({ ...row }, { role: 'user', username: 'alice', passwordHash: 'good' })
  assert.equal(sent[0].status, 200)
})

test('GET /api/auth/me:回传 prefs(未设置 → {})', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/me' }, {}, new URL('/api/auth/me', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload.prefs, {})
})

test('PUT preferences:合法 language/theme 落库并回传;GET me 可读回', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  routes._body = { language: 'en', theme: 'dark' }
  await routes.routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/preferences' }, {}, new URL('/api/auth/preferences', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload.prefs, { language: 'en', theme: 'dark' })
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/me' }, {}, new URL('/api/auth/me', 'http://x'))
  assert.deepEqual(sent[1].payload.prefs, { language: 'en', theme: 'dark' })
})

test('PUT preferences:非法值 400 拒绝且不落库(部分合法字段也不写——全有或全无)', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  routes._body = { language: 'fr' }
  await routes.routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/preferences' }, {}, new URL('/api/auth/preferences', 'http://x'))
  assert.equal(sent[0].status, 400)
  routes._body = { theme: 'purple' }
  await routes.routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/preferences' }, {}, new URL('/api/auth/preferences', 'http://x'))
  assert.equal(sent[1].status, 400)
  assert.equal(db.prepare('SELECT prefs FROM platform_users WHERE id=?').get('u1').prefs, null)
})

test('PUT preferences:存量坏 prefs JSON 不崩,按 {} 起步', async () => {
  const db = makeDb(); seed(db)
  db.prepare('UPDATE platform_users SET prefs=? WHERE id=?').run('not-json{', 'u1')
  const { routes, sent } = makeRoutes(db)
  routes._body = { language: 'zh' }
  await routes.routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/preferences' }, {}, new URL('/api/auth/preferences', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload.prefs, { language: 'zh' })
})
