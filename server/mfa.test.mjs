// MFA 端点级测试(Wave 3 Task 2/3):setup/enable/disable、login 二步(mfaTicket)、恢复码即焚、
// MFA 限流、step-up 守卫、强制开关 + 受限 token、step-up 端点、admin mfa-policy。
// 工厂照 auth-selfservice.test.mjs(makeDb 增 MFA 列/表);有效码一律用 totpCodeAt(secret, Date.now())
// 构造(与 verifyTotp 同一计算路径,±1 窗容忍跨界)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createAuthRoutes, mfaTickets } from './routes/auth.mjs'
import { createAdminRoutes } from './routes/admin.mjs'
import { createAuditSchema, writeAudit } from './audit.mjs'
import { enforceSessionCap } from './platform-session-reaper.mjs'
import { createRateLimiter } from './rate-limit.mjs'
import { generateTotpSecret, totpCodeAt, hashRecoveryCode } from './totp.mjs'
import { TABLE as MSG } from './messages/auth.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', displayName TEXT, createdAt INTEGER NOT NULL,
    disabled INTEGER DEFAULT 0, prefs TEXT, avatar BLOB, avatarMime TEXT, totpSecret TEXT)`)
  db.exec(`CREATE TABLE platform_sessions (
    token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL,
    createdAt INTEGER NOT NULL, k8sSessionToken TEXT, lastSeenAt INTEGER, ip TEXT, userAgent TEXT,
    mfaPending INTEGER DEFAULT 0, stepUpAt INTEGER)`)
  db.exec(`CREATE TABLE mfa_recovery_codes (
    userId TEXT NOT NULL, codeHash TEXT NOT NULL, usedAt INTEGER,
    PRIMARY KEY (userId, codeHash))`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT, apiServer TEXT NOT NULL,
    authHeader TEXT, ca TEXT, cert TEXT, key TEXT, insecure INTEGER DEFAULT 0, version TEXT, nsAuthMode TEXT DEFAULT 'open')`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, assignedBy TEXT, assignedAt INTEGER)`)
  createAuditSchema(db)
  return db
}

function seed(db) {
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,displayName,createdAt) VALUES ('u1','alice','good','user','Alice',1)").run()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES ('t-me','u1','alice','user',1)").run()
}

function makeRoutes(db, over = {}) {
  const sent = []
  const deps = {
    db, sendJson: (_res, status, payload) => sent.push({ status, payload }),
    readBody: async () => deps._body,
    requirePlatform: (req) => db.prepare('SELECT * FROM platform_sessions WHERE token=?').get(req.headers['x-platform-token']),
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
    getSetting: () => null,
    extractPlatformToken: (req) => req.headers['x-platform-token'] || '',
    ...over,
  }
  Object.assign(deps, over)
  const router = createAuthRoutes(deps)
  const wrapper = { get routes() { return router } }
  Object.defineProperty(wrapper, '_body', { get() { return deps._body }, set(v) { deps._body = v } })
  return { routes: wrapper, sent, deps }
}

function call(routes, method, path, body, headers = { 'x-platform-token': 't-me' }) {
  if (body !== undefined) routes._body = body
  return routes.routes.handle({ method, headers, socket: { remoteAddress: '9.9.9.9' }, url: path }, {}, new URL(path, 'http://x'))
}

const login = (routes, body) => call(routes, 'POST', '/api/auth/login', body, { 'user-agent': 'vitest' })

// ===== Task 2 =====

// 回归锚(裁决 R5):未启用 MFA + 开关关 → 登录路径与 Wave 3 之前逐字节同形。
test('回归锚:未启用 MFA → 登录直发 token,响应无 mfaRequired 字段(键集精确钉死)', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  await login(routes, { username: 'alice', password: 'right-password' })
  assert.equal(sent[0].status, 200)
  assert.deepEqual(Object.keys(sent[0].payload).sort(), ['prefs', 'token', 'user'], '键集 = token/user/prefs,不多不少')
  assert.equal(sent[0].payload.mfaRequired, undefined)
  assert.equal(sent[0].payload.token, 'uuid-x')
})

test('setup:返回 32 字符 secret + otpauthUri 含 username;重复调用轮换', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'POST', '/api/auth/mfa/setup', {})
  assert.equal(sent[0].status, 200)
  assert.match(sent[0].payload.secret, /^[A-Z2-7]{32}$/)
  assert.ok(sent[0].payload.otpauthUri.includes('AliangBoard:alice'), 'otpauth 含 username')
  assert.ok(sent[0].payload.otpauthUri.includes(`secret=${sent[0].payload.secret}`))
  await call(routes, 'POST', '/api/auth/mfa/setup', {})
  assert.notEqual(sent[1].payload.secret, sent[0].payload.secret, '重复调用轮换 pending secret')
  // 不落库:platform_users.totpSecret 仍 NULL
  assert.equal(db.prepare('SELECT totpSecret FROM platform_users WHERE id=?').get('u1').totpSecret, null)
})

test('enable:错码 400 且零落库;对码 200 → 10 明文恢复码 + 库中 10 哈希 + totpSecret 落库 + stepUpAt 刷新', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  const secret = generateTotpSecret()
  await call(routes, 'POST', '/api/auth/mfa/enable', { secret, code: '000000' })
  assert.equal(sent[0].status, 400)
  assert.equal(sent[0].payload.message, MSG['auth.mfaCodeInvalid'].zh)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mfa_recovery_codes').get().c, 0, '零落库')
  const good = totpCodeAt(secret, Date.now())
  await call(routes, 'POST', '/api/auth/mfa/enable', { secret, code: good })
  assert.equal(sent[1].status, 200)
  assert.ok(sent[1].payload.ok)
  assert.equal(sent[1].payload.recoveryCodes.length, 10)
  for (const p of sent[1].payload.recoveryCodes) assert.match(p, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/)
  assert.equal(db.prepare('SELECT totpSecret FROM platform_users WHERE id=?').get('u1').totpSecret, secret)
  const hashes = db.prepare('SELECT codeHash, usedAt FROM mfa_recovery_codes WHERE userId=?').all('u1')
  assert.equal(hashes.length, 10)
  const expectHashes = new Set(sent[1].payload.recoveryCodes.map(p => hashRecoveryCode(p)))
  assert.deepEqual(new Set(hashes.map(h => h.codeHash)), expectHashes, '库中哈希与下发明文一一对应')
  assert.ok(hashes.every(h => h.usedAt == null), '初始未使用')
  assert.ok(db.prepare('SELECT stepUpAt FROM platform_sessions WHERE token=?').get('t-me').stepUpAt > 1, 'stepUpAt=now 刷新(seed createdAt=1)')
})

test('login:已启用用户 → mfaRequired + mfaTicket,不发 token、不建会话', async () => {
  const db = makeDb(); seed(db)
  const secret = generateTotpSecret()
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(secret, 'u1')
  const { routes, sent } = makeRoutes(db)
  await login(routes, { username: 'alice', password: 'right-password' })
  assert.equal(sent[0].status, 200)
  assert.equal(sent[0].payload.mfaRequired, true)
  assert.ok(sent[0].payload.mfaTicket)
  assert.equal(sent[0].payload.token, undefined)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM platform_sessions').get().c, 1, '未新建会话(仍只有 seed)')
  assert.ok(mfaTickets.has(sent[0].payload.mfaTicket), 'ticket 在内存 Map')
})

test('login/mfa:正确 TOTP → 完整 token(user/prefs);ticket 单次,重放 401', async () => {
  const db = makeDb(); seed(db)
  const secret = generateTotpSecret()
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(secret, 'u1')
  const { routes, sent } = makeRoutes(db)
  await login(routes, { username: 'alice', password: 'right-password' })
  const ticket = sent[0].payload.mfaTicket
  await call(routes, 'POST', '/api/auth/login/mfa', { username: 'alice', mfaTicket: ticket, code: totpCodeAt(secret, Date.now()) }, { 'user-agent': 'vitest' })
  assert.equal(sent[1].status, 200)
  assert.equal(sent[1].payload.token, 'uuid-x')
  assert.equal(sent[1].payload.user.username, 'alice')
  assert.deepEqual(sent[1].payload.prefs, {})
  assert.ok(db.prepare('SELECT stepUpAt FROM platform_sessions WHERE token=?').get('uuid-x').stepUpAt, 'MFA 登录会话 stepUpAt=now')
  // ticket 单次:读即删
  assert.equal(mfaTickets.has(ticket), false)
  await call(routes, 'POST', '/api/auth/login/mfa', { username: 'alice', mfaTicket: ticket, code: totpCodeAt(secret, Date.now()) }, { 'user-agent': 'vitest' })
  assert.equal(sent[2].status, 401)
  assert.equal(sent[2].payload.message, MSG['auth.mfaTicketInvalid'].zh)
})

test('login/mfa:恢复码 → token 且即焚(二次用 401);恢复码可作 TOTP 替代', async () => {
  const db = makeDb(); seed(db)
  const secret = generateTotpSecret()
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(secret, 'u1')
  const rc = hashRecoveryCode('ABCDE-FGHIJ')
  db.prepare('INSERT INTO mfa_recovery_codes (userId,codeHash,usedAt) VALUES (?,?,NULL)').run('u1', rc)
  const { routes, sent } = makeRoutes(db)
  await login(routes, { username: 'alice', password: 'right-password' })
  const ticket = sent[0].payload.mfaTicket
  await call(routes, 'POST', '/api/auth/login/mfa', { username: 'alice', mfaTicket: ticket, code: ' abcde-fghij ' }, { 'user-agent': 'vitest' })
  assert.equal(sent[1].status, 200, '归一化(前后空格/小写)后命中')
  assert.equal(db.prepare('SELECT usedAt FROM mfa_recovery_codes WHERE codeHash=?').get(rc).usedAt != null, true, '即焚:usedAt 落库')
  // 二次使用:重新走密码步拿新 ticket
  await login(routes, { username: 'alice', password: 'right-password' })
  const ticket2 = sent[2].payload.mfaTicket
  await call(routes, 'POST', '/api/auth/login/mfa', { username: 'alice', mfaTicket: ticket2, code: 'ABCDE-FGHIJ' }, { 'user-agent': 'vitest' })
  assert.equal(sent[3].status, 401, '已用恢复码不可复用')
  assert.equal(sent[3].payload.message, MSG['auth.mfaCodeInvalid'].zh)
})

test('login/mfa:错 ticket 401;过期 ticket 401;错 username 绑定 401', async () => {
  const db = makeDb(); seed(db)
  const secret = generateTotpSecret()
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(secret, 'u1')
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'POST', '/api/auth/login/mfa', { username: 'alice', mfaTicket: 'no-such-ticket', code: totpCodeAt(secret, Date.now()) }, { 'user-agent': 'vitest' })
  assert.equal(sent[0].status, 401)
  // 直接向内存 Map 播种一张过期 ticket(exp 已过)
  mfaTickets.set('t-expired', { userId: 'u1', username: 'alice', exp: Date.now() - 1 })
  await call(routes, 'POST', '/api/auth/login/mfa', { username: 'alice', mfaTicket: 't-expired', code: totpCodeAt(secret, Date.now()) }, { 'user-agent': 'vitest' })
  assert.equal(sent[1].status, 401)
  assert.equal(mfaTickets.has('t-expired'), false, '过期票据同样读即删')
  // ticket 绑定 username:拿 alice 的票据报 bob 的用户名 → 拒
  await login(routes, { username: 'alice', password: 'right-password' })
  const ticket = sent[2].payload.mfaTicket
  await call(routes, 'POST', '/api/auth/login/mfa', { username: 'bob', mfaTicket: ticket, code: totpCodeAt(secret, Date.now()) }, { 'user-agent': 'vitest' })
  assert.equal(sent[3].status, 401)
})

test('login/mfa:错码 401(票据已耗,不因错码复用)', async () => {
  const db = makeDb(); seed(db)
  const secret = generateTotpSecret()
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(secret, 'u1')
  const { routes, sent } = makeRoutes(db)
  await login(routes, { username: 'alice', password: 'right-password' })
  const ticket = sent[0].payload.mfaTicket
  await call(routes, 'POST', '/api/auth/login/mfa', { username: 'alice', mfaTicket: ticket, code: '000000' }, { 'user-agent': 'vitest' })
  assert.equal(sent[1].status, 401)
  assert.equal(sent[1].payload.message, MSG['auth.mfaCodeInvalid'].zh)
  assert.equal(mfaTickets.has(ticket), false, '错码后 ticket 仍被消费(单次语义)')
})

test('login/mfa:独立限流键 mfa|ip|username —— 6 连击第 6 次 429', async () => {
  const db = makeDb(); seed(db)
  const secret = generateTotpSecret()
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(secret, 'u1')
  const limiter = createRateLimiter({ capacity: 5, refillPerSec: 0.1 })
  const { routes, sent } = makeRoutes(db, { checkLoginRate: (key) => limiter.check(key) })
  for (let i = 0; i < 6; i++) {
    await call(routes, 'POST', '/api/auth/login/mfa', { username: 'alice', mfaTicket: `t-${i}`, code: '000000' }, { 'user-agent': 'vitest' })
  }
  assert.equal(sent[4].status, 401, '前 5 次(容量 5)为 401 错 ticket')
  assert.equal(sent[5].status, 429, '第 6 次 429')
  assert.equal(sent[5].payload.message, MSG['auth.rateLimited'].zh)
})

test('disable:step-up 过期(>10min)→ 409 stepUpRequired;新鲜 + 对码 → 200 清 totpSecret 与恢复码', async () => {
  const db = makeDb(); seed(db)
  const secret = generateTotpSecret()
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(secret, 'u1')
  db.prepare('INSERT INTO mfa_recovery_codes (userId,codeHash,usedAt) VALUES (?,?,NULL)').run('u1', hashRecoveryCode('AAAAA-BBBBB'))
  db.prepare('UPDATE platform_sessions SET stepUpAt=? WHERE token=?').run(Date.now() - 11 * 60_000, 't-me')
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'POST', '/api/auth/mfa/disable', { code: totpCodeAt(secret, Date.now()) })
  assert.equal(sent[0].status, 409)
  assert.equal(sent[0].payload.stepUpRequired, true)
  assert.equal(db.prepare('SELECT totpSecret FROM platform_users WHERE id=?').get('u1').totpSecret, secret, '409 时零改动')
  // 新鲜 step-up → 禁用成功
  db.prepare('UPDATE platform_sessions SET stepUpAt=? WHERE token=?').run(Date.now(), 't-me')
  await call(routes, 'POST', '/api/auth/mfa/disable', { code: totpCodeAt(secret, Date.now()) })
  assert.equal(sent[1].status, 200)
  assert.equal(db.prepare('SELECT totpSecret FROM platform_users WHERE id=?').get('u1').totpSecret, null)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mfa_recovery_codes WHERE userId=?').get('u1').c, 0, '恢复码同清')
})

test('disable:新鲜 step-up 但错码 → 401;恢复码可验(小写归一化)→ 禁用成功清两处', async () => {
  const db = makeDb(); seed(db)
  const secret = generateTotpSecret()
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(secret, 'u1')
  db.prepare('INSERT INTO mfa_recovery_codes (userId,codeHash,usedAt) VALUES (?,?,NULL)').run('u1', hashRecoveryCode('AAAAA-BBBBB'))
  db.prepare('UPDATE platform_sessions SET stepUpAt=? WHERE token=?').run(Date.now(), 't-me')
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'POST', '/api/auth/mfa/disable', { code: '000000' })
  assert.equal(sent[0].status, 401)
  assert.equal(sent[0].payload.message, MSG['auth.mfaCodeInvalid'].zh)
  // R2:disable 用恢复码验过即禁用(不设 usedAt——消费仅发生在登录);随后恢复码行随禁用全清。
  await call(routes, 'POST', '/api/auth/mfa/disable', { code: 'aaaaa-bbbbb' })
  assert.equal(sent[1].status, 200, '恢复码(小写归一化)验过')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mfa_recovery_codes WHERE userId=?').get('u1').c, 0, '禁用清空恢复码')
  assert.equal(db.prepare('SELECT totpSecret FROM platform_users WHERE id=?').get('u1').totpSecret, null)
})

test('disable:未启用 → 400 mfaNotEnabled', async () => {
  const db = makeDb(); seed(db)
  db.prepare('UPDATE platform_sessions SET stepUpAt=? WHERE token=?').run(Date.now(), 't-me')
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'POST', '/api/auth/mfa/disable', { code: '000000' })
  assert.equal(sent[0].status, 400)
  assert.equal(sent[0].payload.message, MSG['auth.mfaNotEnabled'].zh)
})

test('setup:已启用者需 step-up(重置场景)——过期 409,新鲜 200', async () => {
  const db = makeDb(); seed(db)
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(generateTotpSecret(), 'u1')
  db.prepare('UPDATE platform_sessions SET stepUpAt=? WHERE token=?').run(Date.now() - 11 * 60_000, 't-me')
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'POST', '/api/auth/mfa/setup', {})
  assert.equal(sent[0].status, 409)
  assert.equal(sent[0].payload.stepUpRequired, true)
  db.prepare('UPDATE platform_sessions SET stepUpAt=? WHERE token=?').run(Date.now(), 't-me')
  await call(routes, 'POST', '/api/auth/mfa/setup', {})
  assert.equal(sent[1].status, 200)
})

test('登录启用 MFA 用户后自动登出语义:密码步不建会话(cap 不触发)', async () => {
  const db = makeDb(); seed(db)
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(generateTotpSecret(), 'u1')
  const { routes, sent, deps } = makeRoutes(db, { maxPlatformSessionsPerUser: 1, enforceSessionCap: () => { throw new Error('must not be called') } })
  await login(routes, { username: 'alice', password: 'right-password' })
  assert.equal(sent[0].payload.mfaRequired, true)
  assert.equal(deps.platformSessions.has('t-me'), true, '旧会话不被 cap 踢(未进入尾段)')
})

