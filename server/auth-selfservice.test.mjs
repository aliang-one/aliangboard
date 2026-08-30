// 用户中心 self-service 端点(2026-08-29 设计 §4.2):
// PATCH me 字段白名单(防 role/username 穿越)+ preferences 读写与非法值拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createAuthRoutes } from './routes/auth.mjs'
import { createAuditSchema, writeAudit } from './audit.mjs'
import { enforceSessionCap } from './platform-session-reaper.mjs'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    platformSessions: new Map(db.prepare('SELECT * FROM platform_sessions').all().map(r => [r.token, r])),
    sessions: new Map(), persistSession: () => {},
    verifyPassword: (p) => p === 'right-password',
    hashPassword: (p) => `hashed(${p})`,
    randomUUID: () => 'uuid-x',
    normalizeServer: (s) => new URL(s), buildCallContext: () => ({}),
    requestKubernetes: async () => ({ body: {} }),
    checkLoginRate: () => ({ allowed: true }),
    enforceSessionCap, maxPlatformSessionsPerUser: 10,
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

// === Task 3:改密 + 会话管理 ===
function seedMulti(db) {
  seed(db)
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt,ip,userAgent) VALUES ('t-other','u1','alice','user',2,'2.2.2.2','Mozilla/5.0 Chrome')").run()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES ('t-stranger','u2','bob','user',3)").run()
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u2','bob','good','user',1)").run()
  db.prepare('UPDATE platform_sessions SET lastSeenAt=100 WHERE token=?').run('t-me')
  db.prepare('UPDATE platform_sessions SET lastSeenAt=200 WHERE token=?').run('t-other')
}

test('change-password:旧密错 → 401 + 审计 denied,密码不变', async () => {
  const db = makeDb(); seedMulti(db)
  const { routes, sent } = makeRoutes(db)
  routes._body = { currentPassword: 'wrong', newPassword: 'newpassword1' }
  await routes.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/change-password' }, {}, new URL('/api/auth/change-password', 'http://x'))
  assert.equal(sent[0].status, 401)
  assert.equal(db.prepare('SELECT passwordHash FROM platform_users WHERE id=?').get('u1').passwordHash, 'good')
  const audit = db.prepare("SELECT result FROM audit_log WHERE tool='platform_change_password'").all()
  assert.deepEqual(audit.map(a => a.result), ['denied'])
})

test('change-password:新密 <8 → 400', async () => {
  const db = makeDb(); seedMulti(db)
  const { routes, sent } = makeRoutes(db)
  routes._body = { currentPassword: 'right-password', newPassword: 'short' }
  await routes.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/change-password' }, {}, new URL('/api/auth/change-password', 'http://x'))
  assert.equal(sent[0].status, 400)
})

test('change-password:成功 → 哈希更新 + 吊销其他会话(保留当前)+ 审计 ok', async () => {
  const db = makeDb(); seedMulti(db)
  const { routes, sent, deps } = makeRoutes(db)
  routes._body = { currentPassword: 'right-password', newPassword: 'newpassword1' }
  await routes.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/change-password' }, {}, new URL('/api/auth/change-password', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload, { ok: true, revoked: 1 })
  assert.equal(db.prepare('SELECT passwordHash FROM platform_users WHERE id=?').get('u1').passwordHash, 'hashed(newpassword1)')
  assert.equal(deps.platformSessions.has('t-other'), false, '其他会话应被吊销')
  assert.equal(deps.platformSessions.has('t-me'), true, '当前会话保留')
  assert.equal(deps.platformSessions.has('t-stranger'), true, '别人的会话不动')
  assert.equal(db.prepare("SELECT COUNT(*) c FROM platform_sessions WHERE token='t-other'").get().c, 0, 'DB 同步删除')
  const ok = db.prepare("SELECT result FROM audit_log WHERE tool='platform_change_password' AND result='ok'").get()
  assert.ok(ok, '应写 ok 审计')
})

// 终审发现 4:被吊会话的 k8sSessionToken 须同步从 sessions Map 回收(否则被踢设备集群凭据存活至 TTL)
test('change-password:吊销其他会话时同步回收其 k8sSessionToken;当前会话的保留', async () => {
  const db = makeDb(); seedMulti(db)
  const { routes, sent, deps } = makeRoutes(db)
  // 两个平台会话各自接入过集群(t-me→k8s-me,t-other→k8s-other)
  deps.platformSessions.get('t-me').k8sSessionToken = 'k8s-me'
  deps.platformSessions.get('t-other').k8sSessionToken = 'k8s-other'
  deps.sessions.set('k8s-me', { apiServer: 'https://a' })
  deps.sessions.set('k8s-other', { apiServer: 'https://b' })
  routes._body = { currentPassword: 'right-password', newPassword: 'newpassword1' }
  await routes.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/change-password' }, {}, new URL('/api/auth/change-password', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.equal(deps.sessions.has('k8s-other'), false, '被吊会话的 K8s 凭据应回收')
  assert.equal(deps.sessions.has('k8s-me'), true, '当前会话的 K8s 凭据保留')
})

// 终审发现 2:createdAt 须随 user 下发(资料卡「注册时间」消费)
test('GET /api/auth/me:响应 user 含 createdAt', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/me' }, {}, new URL('/api/auth/me', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.equal(sent[0].payload.user.createdAt, 1, 'seed 的 createdAt=1 应原样透传')
})

test('GET sessions:只列自己的,指纹为 token 前缀,current 标记正确,按 lastSeenAt 降序', async () => {
  const db = makeDb(); seedMulti(db)
  const { routes, sent, deps } = makeRoutes(db)
  deps.platformSessions.get('t-me').lastSeenAt = 100
  deps.platformSessions.get('t-other').lastSeenAt = 200
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/sessions' }, {}, new URL('/api/auth/sessions', 'http://x'))
  const list = sent[0].payload.sessions
  assert.equal(list.length, 2, '只列 alice 的两条')
  assert.equal(list[0].fingerprint, 't-other'.slice(0, 8), '指纹 = token.slice(0,8)(短 token 即全文)')
  assert.equal(list[0].current, false)
  assert.equal(list[0].ip, '2.2.2.2')
  assert.equal(list[1].fingerprint, 't-me')
  assert.equal(list[1].current, true)
  for (const s of list) assert.ok(!s.token, '绝不回传完整 token')
})

test('DELETE sessions/others:原子吊销其余全部,保留当前', async () => {
  const db = makeDb(); seedMulti(db)
  const { routes, sent, deps } = makeRoutes(db)
  await routes.routes.handle({ method: 'DELETE', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/sessions/others' }, {}, new URL('/api/auth/sessions/others', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload, { ok: true, revoked: 1 })
  assert.equal(deps.platformSessions.has('t-me'), true)
  assert.equal(deps.platformSessions.has('t-other'), false)
})

// === Task 12(CSO #13):改密成功即删首管一次性凭证文件 ===
test('change-password:成功 → best-effort 删除 dataDir/first-admin-credentials.txt', async () => {
  const db = makeDb(); seedMulti(db)
  const dir = mkdtempSync(join(tmpdir(), 'ab-cred-'))
  const credFile = join(dir, 'first-admin-credentials.txt')
  writeFileSync(credFile, '用户名: admin\n密码: one-time\n')
  try {
    const { routes, sent } = makeRoutes(db, { dataDir: dir })
    routes._body = { currentPassword: 'right-password', newPassword: 'newpassword1' }
    await routes.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/change-password' }, {}, new URL('/api/auth/change-password', 'http://x'))
    assert.equal(sent[0].status, 200)
    assert.equal(existsSync(credFile), false, '改密成功后凭证文件应被删除')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('change-password:失败(旧密错)→ 凭证文件保留', async () => {
  const db = makeDb(); seedMulti(db)
  const dir = mkdtempSync(join(tmpdir(), 'ab-cred-'))
  const credFile = join(dir, 'first-admin-credentials.txt')
  writeFileSync(credFile, '用户名: admin\n密码: one-time\n')
  try {
    const { routes, sent } = makeRoutes(db, { dataDir: dir })
    routes._body = { currentPassword: 'wrong', newPassword: 'newpassword1' }
    await routes.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/change-password' }, {}, new URL('/api/auth/change-password', 'http://x'))
    assert.equal(sent[0].status, 401)
    assert.equal(existsSync(credFile), true, '改密失败凭证文件应保留')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DELETE sessions/:fingerprint:按 8 位指纹吊销;吊当前 400;未命中 404', async () => {
  const db = makeDb(); seedMulti(db)
  const { routes, sent, deps } = makeRoutes(db)
  const fp = 't-other'.slice(0, 8)
  await routes.routes.handle({ method: 'DELETE', headers: { 'x-platform-token': 't-me' }, url: `/api/auth/sessions/${fp}` }, {}, new URL(`/api/auth/sessions/${fp}`, 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.equal(deps.platformSessions.has('t-other'), false)
  await routes.routes.handle({ method: 'DELETE', headers: { 'x-platform-token': 't-me' }, url: `/api/auth/sessions/${'t-me'.slice(0, 8)}` }, {}, new URL(`/api/auth/sessions/${'t-me'.slice(0, 8)}`, 'http://x'))
  assert.equal(sent[1].status, 400, '当前会话不可自吊(防自锁)')
  await routes.routes.handle({ method: 'DELETE', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/sessions/deadbeef' }, {}, new URL('/api/auth/sessions/deadbeef', 'http://x'))
  assert.equal(sent[2].status, 404)
})

// === 会话保留(2026-08-30 设计 §3.2):登录超限踢旧 + cap 失败不阻断 ===

test('登录:会话数超上限,踢最久未活跃的旧会话,本会话保留', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent, deps } = makeRoutes(db, { maxPlatformSessionsPerUser: 1 })
  routes._body = { username: 'alice', password: 'right-password' }
  await routes.routes.handle({ method: 'POST', headers: { 'user-agent': 'vitest' }, url: '/api/auth/login' }, {}, new URL('/api/auth/login', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.equal(sent[0].payload.token, 'uuid-x')
  assert.equal(deps.platformSessions.has('t-me'), false, '旧会话(lastSeenAt 回退 createdAt=1)应被踢')
  assert.equal(deps.platformSessions.has('uuid-x'), true)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM platform_sessions WHERE userId=?').get('u1').c, 1)
})

test('登录:cap 强制抛异常不阻断登录(降级不踢)', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db, { enforceSessionCap: () => { throw new Error('boom') } })
  routes._body = { username: 'alice', password: 'right-password' }
  await routes.routes.handle({ method: 'POST', headers: { 'user-agent': 'vitest' }, url: '/api/auth/login' }, {}, new URL('/api/auth/login', 'http://x'))
  assert.equal(sent[0].status, 200, '登录应成功')
})
