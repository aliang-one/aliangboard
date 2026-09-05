// 用户中心 self-service 端点(2026-08-29 设计 §4.2):
// PATCH me 字段白名单(防 role/username 穿越)+ preferences 读写与非法值拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createAuthRoutes } from './routes/auth.mjs'
import { createAuditSchema, writeAudit } from './audit.mjs'
import { createApiKeysSchema } from './auth-keys.mjs'
import { enforceSessionCap } from './platform-session-reaper.mjs'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', displayName TEXT, createdAt INTEGER NOT NULL,
    disabled INTEGER DEFAULT 0, prefs TEXT, avatar BLOB, avatarMime TEXT)`)
  db.exec(`CREATE TABLE platform_sessions (
    token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL,
    createdAt INTEGER NOT NULL, k8sSessionToken TEXT, lastSeenAt INTEGER, ip TEXT, userAgent TEXT)`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT, apiServer TEXT NOT NULL,
    authHeader TEXT, ca TEXT, cert TEXT, key TEXT, insecure INTEGER DEFAULT 0, version TEXT, nsAuthMode TEXT DEFAULT 'open')`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, assignedBy TEXT, assignedAt INTEGER)`)
  db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, createdBy TEXT)`)
  db.exec(`CREATE TABLE group_members (groupId TEXT NOT NULL, userId TEXT NOT NULL, addedBy TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY (groupId, userId))`)
  db.exec(`CREATE TABLE ns_grants (id TEXT PRIMARY KEY, subjectType TEXT NOT NULL, subjectId TEXT NOT NULL, clusterId TEXT NOT NULL, namespace TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'view', grantedBy TEXT, grantedAt INTEGER NOT NULL, UNIQUE(subjectType,subjectId,clusterId,namespace))`)
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
  routes._body = { theme: 'system' }
  await routes.routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/preferences' }, {}, new URL('/api/auth/preferences', 'http://x'))
  assert.equal(sent[2].status, 400)
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

// === Wave1 Task 1:密码策略可配置(自改接线 + GET policy 端点) ===
import { TABLE as MSG } from './messages/auth.mjs'

test('改密:策略档 requireDigit 开启 → 缺数字 400 passwordNeedDigit;满足则通过', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db, { getSetting: () => JSON.stringify({ minLength: 8, requireMixed: true, requireDigit: true, requireSymbol: false }) })
  routes._body = { currentPassword: 'right-password', newPassword: 'NoDigitsHere' }
  await routes.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/change-password' }, {}, new URL('/api/auth/change-password', 'http://x'))
  assert.equal(sent[0].status, 400)
  assert.equal(sent[0].payload.message, MSG['auth.passwordNeedDigit'].zh) // NoDigitsHere 大小写齐全 → digit 规则命中
  // 满足全部规则 → 200
  routes._body = { currentPassword: 'right-password', newPassword: 'Good1!Pass' }
  await routes.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/change-password' }, {}, new URL('/api/auth/change-password', 'http://x'))
  assert.equal(sent[1].status, 200)
})

test('GET /api/auth/password-policy:回当前生效策略', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db, { getSetting: () => JSON.stringify({ minLength: 12 }) })
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/password-policy' }, {}, new URL('/api/auth/password-policy', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload.policy, { minLength: 12, requireMixed: false, requireDigit: false, requireSymbol: false })
})

test('GET /api/auth/password-policy:无策略配置 → 默认档', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' }, url: '/api/auth/password-policy' }, {}, new URL('/api/auth/password-policy', 'http://x'))
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload.policy, { minLength: 8, requireMixed: false, requireDigit: false, requireSymbol: false })
})

test('GET /api/my/activity:只回本 username 行;90 天窗口强制;分页透传', async () => {
  const db = makeDb(); seed(db); createAuditSchema(db)
  const now = Date.now()
  writeAudit(db, { owner: 'alice', tool: 'platform_login', verb: 'login', result: 'ok', ts: now, source: 'platform' })
  writeAudit(db, { owner: 'bob', tool: 'platform_login', verb: 'login', result: 'ok', ts: now, source: 'platform' })
  // 91 天前的本用户旧行:writeAudit 恒取 Date.now(),须直接 INSERT(writeAudit 只能写「现在」)
  db.prepare(`INSERT INTO audit_log (ts, status, tool, verb, result, owner, source, prevHash, hash) VALUES (?, 'finalized', 'platform_login', 'login', 'ok', 'alice', 'platform', 'prev-x', 'hash-x')`).run(now - 91 * 86400000)
  // 'started' 行(reserveAudit 每次调用都会先写一条)默认不进列表(queryAuditLog status 默认 'finalized')
  db.prepare(`INSERT INTO audit_log (ts, status, tool, verb, result, owner, source, prevHash, hash) VALUES (?, 'started', 'platform_login', 'login', NULL, 'alice', 'platform', 'prev-x', 'hash-x')`).run(now)
  const { routes, sent } = makeRoutes(db)
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/my/activity'))
  assert.equal(sent[0].status, 200)
  const out = sent[0].payload
  assert.equal(out.total, 1)
  assert.equal(out.items[0].owner, 'alice')
  assert.equal(out.windowDays, 90)
  // 安全校约钉死:query 里的 owner/since 覆盖企图无效(服务端钳制)——bob 的行和 91 天旧行仍被排除
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/my/activity?owner=bob&since=0'))
  assert.equal(sent[1].payload.total, 1)
  assert.equal(sent[1].payload.items[0].owner, 'alice')
  // result 过滤透传
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/my/activity?result=denied'))
  assert.equal(sent[2].payload.total, 0)
})

test('PATCH me 头像:合法 data URL 落库;超 200KB 400;坏 mime 400;avatarClear 清空;user 响应不含 avatar', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  const tinyPng = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
  routes._body = { avatar: tinyPng }
  await routes.routes.handle({ method: 'PATCH', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/auth/me'))
  assert.equal(sent.at(-1).status, 200)
  assert.ok(sent.at(-1).payload.user.avatar === undefined)
  assert.ok(db.prepare('SELECT avatar FROM platform_users WHERE id=?').get('u1').avatar.length > 0)
  const big = 'data:image/png;base64,' + Buffer.alloc(200 * 1024 + 1, 7).toString('base64')
  routes._body = { avatar: big }
  await routes.routes.handle({ method: 'PATCH', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/auth/me'))
  assert.equal(sent.at(-1).status, 400)
  routes._body = { avatar: 'data:text/html;base64,PGI+' }
  await routes.routes.handle({ method: 'PATCH', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/auth/me'))
  assert.equal(sent.at(-1).status, 400)
  routes._body = { avatarClear: true }
  await routes.routes.handle({ method: 'PATCH', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/auth/me'))
  assert.equal(sent.at(-1).status, 200)
  assert.equal(db.prepare('SELECT avatar FROM platform_users WHERE id=?').get('u1').avatar, null)
})

test('GET avatar:有则回 dataUrl;无则 404', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/auth/me/avatar'))
  assert.equal(sent.at(-1).status, 404)
  db.prepare('UPDATE platform_users SET avatar=?, avatarMime=? WHERE id=?').run(Buffer.from([1, 2, 3]), 'image/png', 'u1')
  await routes.routes.handle({ method: 'GET', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/auth/me/avatar'))
  assert.equal(sent.at(-1).status, 200)
  assert.ok(sent.at(-1).payload.dataUrl.startsWith('data:image/png;base64,'))
})

test('PUT preferences 新键:合法落库,非法 400', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  routes._body = { landingView: 'workbench', rowsPerPage: 50, defaultNamespace: 'team-a', defaultClusterId: 'c1' }
  await routes.routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/auth/preferences'))
  assert.equal(sent.at(-1).status, 200)
  assert.equal(JSON.parse(db.prepare('SELECT prefs FROM platform_users WHERE id=?').get('u1').prefs).landingView, 'workbench')
  routes._body = { landingView: 'evil' }
  await routes.routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/auth/preferences'))
  assert.equal(sent.at(-1).status, 400)
  routes._body = { rowsPerPage: 33 }
  await routes.routes.handle({ method: 'PUT', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/auth/preferences'))
  assert.equal(sent.at(-1).status, 400)
})

test('connect-cluster: 签发的 K8s session 携带 userId+clusterId(persistSession 落戳, W2-0)', async () => {
  const db = makeDb(); seed(db)
  db.prepare(`INSERT INTO clusters (id,name,apiServer,nsAuthMode) VALUES ('c1','prod','https://k8s:6443','open')`).run()
  db.prepare(`INSERT INTO user_clusters VALUES ('u1','c1','admin',1)`).run()
  const persisted = []
  const { routes, sent } = makeRoutes(db, {
    persistSession: (tok, s) => persisted.push({ tok, s }),
    requestKubernetes: async () => ({ body: { gitVersion: 'v1.30' } }),
  })
  routes._body = { clusterId: 'c1' }
  await routes.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/connect-cluster'))
  assert.equal(sent[0].status, 200)
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].s.userId, 'u1')
  assert.equal(persisted[0].s.clusterId, 'c1')
})

// ===== W2 Phase A Task 4:/me grants 下发 + grantable-ns + my-keys ns 收口 =====
import { createMyKeyRoutes } from './routes/my-keys.mjs'

function makeAuthzDb() {
  const db = makeDb()
  db.exec(`CREATE TABLE user_keys (id TEXT PRIMARY KEY, name TEXT, key TEXT, createdAt INTEGER NOT NULL, ownerUserId TEXT)`)
  createApiKeysSchema(db)
  createAuditSchema(db)
  // alice(u1, user) 分配 c1 + 直接授权 app/view、ops/operate;组 g1 走组授权
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u1','alice','good','user',1)").run()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES ('t-me','u1','alice','user',1)").run()
  db.prepare("INSERT INTO clusters (id,name,apiServer,nsAuthMode) VALUES ('c1','prod','https://k8s:6443','allowlist')").run()
  db.prepare("INSERT INTO clusters (id,name,apiServer,nsAuthMode) VALUES ('c2','dev','https://k8s:6443','open')").run()
  db.prepare("INSERT INTO user_clusters VALUES ('u1','c1','admin',1)").run()
  db.prepare("INSERT INTO user_clusters VALUES ('u1','c2','admin',1)").run()
  db.prepare("INSERT INTO ns_grants VALUES ('gr1','user','u1','c1','app','view',NULL,1)").run()
  db.prepare("INSERT INTO ns_grants VALUES ('gr2','user','u1','c1','ops','operate',NULL,1)").run()
  return db
}

function call(routes, method, path, body) {
  if (body !== undefined) routes._body = body
  return routes.routes.handle({ method, headers: { 'x-platform-token': 't-me' } }, {}, new URL(path, 'http://x'))
}

test('GET me:非 admin 响应带 grants(分配集群 + ns 授权,Map→数组)', async () => {
  const db = makeAuthzDb()
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'GET', '/api/auth/me')
  assert.equal(sent[0].status, 200)
  const grants = sent[0].payload.grants
  assert.equal(grants.role, 'user')
  assert.deepEqual(grants.clusters.c1.mode, 'allowlist')
  assert.deepEqual([...grants.clusters.c1.namespaces].sort((a, b) => a.namespace.localeCompare(b.namespace)),
    [{ namespace: 'app', level: 'view' }, { namespace: 'ops', level: 'operate' }])
  assert.equal(grants.clusters.c2.mode, 'open', '分配的 open 集群同样下发(空 namespaces)')
})

test('GET me:admin 响应 grants = { role: admin }', async () => {
  const db = makeAuthzDb()
  db.prepare("UPDATE platform_users SET role='admin' WHERE id='u1'").run()
  db.prepare("UPDATE platform_sessions SET role='admin' WHERE token='t-me'").run()
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'GET', '/api/auth/me')
  assert.deepEqual(sent[0].payload.grants, { role: 'admin' })
})

test('GET /api/my/grantable-ns:allowlist 返回本人该集群 ns;open 集群 409;未分配 403', async () => {
  const db = makeAuthzDb()
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'GET', '/api/my/grantable-ns?clusterId=c1')
  assert.equal(sent[0].status, 200)
  assert.deepEqual([...sent[0].payload.namespaces].sort((a, b) => a.namespace.localeCompare(b.namespace)),
    [{ namespace: 'app', level: 'view' }, { namespace: 'ops', level: 'operate' }])
  await call(routes, 'GET', '/api/my/grantable-ns?clusterId=c2')
  assert.equal(sent[1].status, 409)
  await call(routes, 'GET', '/api/my/grantable-ns?clusterId=cx')
  assert.equal(sent[2].status, 403)
})

// 终审 Finding 2:admin 的 effectiveGrants 是 clusters:'ALL' 无 Map 可 .get,须短路 sentinel(否则 500)
test('GET /api/my/grantable-ns:admin → 200 + mode=admin sentinel(ns 不受限, spec §6.1)', async () => {
  const db = makeAuthzDb()
  db.prepare("UPDATE platform_users SET role='admin' WHERE id='u1'").run()
  db.prepare("UPDATE platform_sessions SET role='admin' WHERE token='t-me'").run()
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'GET', '/api/my/grantable-ns?clusterId=c1')
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload, { namespaces: [], mode: 'admin' })
})

test('my-keys POST:allowlist 集群签发未授权 ns → 403;授权 ns → 走到供给链', async () => {
  const db = makeAuthzDb()
  const provisioned = []
  const mk = (over = {}) => {
    const sent2 = []
    const deps = {
      db, sendJson: (_r, s, p) => sent2.push({ status: s, payload: p }),
      readBody: async () => over.body || {}, requirePlatform: (req) => db.prepare('SELECT * FROM platform_sessions WHERE token=?').get(req.headers['x-platform-token']),
      randomUUID: () => 'key-1', writeAudit, getSetting: () => null,
      getCluster: (id) => db.prepare('SELECT * FROM clusters WHERE id=?').get(id),
      provisionCluster: async (_c, arg) => { provisioned.push(arg); return { ok: true } },
    }
    return { routes: createMyKeyRoutes(deps), sent: sent2 }
  }
  const bad = mk({ body: { clusterId: 'c1', namespace: 'secret-ns', tier: 'read' } })
  await bad.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/my/keys'))
  assert.equal(bad.sent[0].status, 403)
  const ok = mk({ body: { clusterId: 'c1', namespace: 'app', tier: 'read' } })
  await ok.routes.handle({ method: 'POST', headers: { 'x-platform-token': 't-me' } }, {}, new URL('http://x/api/my/keys'))
  assert.equal(ok.sent[0].status, 200)
  assert.equal(provisioned.length, 1)
})
