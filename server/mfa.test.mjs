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
import { isMfaPendingAllowed } from './route-auth-map.mjs'
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
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT, apiServer TEXT NOT NULL, authMethod TEXT,
    authHeader TEXT, ca TEXT, cert TEXT, key TEXT, insecure INTEGER DEFAULT 0, version TEXT, nsAuthMode TEXT DEFAULT 'open', createdAt INTEGER)`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, assignedBy TEXT, assignedAt INTEGER)`)
  // /api/auth/me → effectiveGrants 消费(W2 Phase A)
  db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, createdBy TEXT)`)
  db.exec(`CREATE TABLE group_members (groupId TEXT NOT NULL, userId TEXT NOT NULL, addedBy TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY (groupId, userId))`)
  db.exec(`CREATE TABLE ns_grants (id TEXT PRIMARY KEY, subjectType TEXT NOT NULL, subjectId TEXT NOT NULL, clusterId TEXT NOT NULL, namespace TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'view', grantedBy TEXT, grantedAt INTEGER NOT NULL, UNIQUE(subjectType,subjectId,clusterId,namespace))`)
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
    // 受限 token 拦截镜像 index.mjs platformUserFromRequest(W3 §1.5):mfaPending=1 且路径不在
    // 白名单 → 403 auth.mfaEnrollmentRequired。白名单判定用真实现 isMfaPendingAllowed。
    requirePlatform: (req, res) => {
      const ps = db.prepare('SELECT * FROM platform_sessions WHERE token=?').get(req.headers['x-platform-token'])
      if (!ps) { deps.sendJson(res, 401, { message: 'not logged in' }); return null }
      if (ps.mfaPending === 1 && !isMfaPendingAllowed(req.method, new URL(req.url, 'http://x').pathname)) {
        deps.sendJson(res, 403, { message: MSG['auth.mfaEnrollmentRequired'].zh })
        return null
      }
      return ps
    },
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

// ===== Task 3:强制开关 + 受限 token + step-up =====

test('isMfaPendingAllowed:白名单矩阵(me/logout/preferences 放行;my-clusters/change-password/其他拒)', () => {
  assert.equal(isMfaPendingAllowed('GET', '/api/auth/me'), true)
  assert.equal(isMfaPendingAllowed('POST', '/api/auth/logout'), true)
  assert.equal(isMfaPendingAllowed('PUT', '/api/auth/preferences'), true)
  assert.equal(isMfaPendingAllowed('POST', '/api/auth/mfa/setup'), true)
  assert.equal(isMfaPendingAllowed('POST', '/api/auth/mfa/enable'), true)
  assert.equal(isMfaPendingAllowed('POST', '/api/auth/mfa/disable'), true)
  assert.equal(isMfaPendingAllowed('POST', '/api/auth/step-up'), false, 'step-up 不在裁决 R5 白名单(受限用户无 MFA 可验,端点对其实际 400)')
  assert.equal(isMfaPendingAllowed('GET', '/api/my-clusters'), false)
  assert.equal(isMfaPendingAllowed('POST', '/api/auth/change-password'), false)
  assert.equal(isMfaPendingAllowed('GET', '/api/k8s/api/v1/pods'), false)
  assert.equal(isMfaPendingAllowed('GET', '/api/auth/me/avatar'), false, '白名单按裁决 R5 精确四类(不含 avatar)')
  assert.equal(isMfaPendingAllowed('PATCH', '/api/auth/me'), false, 'PATCH me 不在白名单')
})

test('强制开关开:未启用用户登录 → 受限 token(me 200 / my-clusters 403 mfaEnrollmentRequired)', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db, { getSetting: (k) => (k === 'auth.mfa.required' ? '1' : null) })
  await login(routes, { username: 'alice', password: 'right-password' })
  assert.equal(sent[0].status, 200)
  assert.equal(db.prepare('SELECT mfaPending FROM platform_sessions WHERE token=?').get('uuid-x').mfaPending, 1, '会话 mfaPending=1')
  await call(routes, 'GET', '/api/auth/me', undefined, { 'x-platform-token': 'uuid-x' })
  assert.equal(sent[1].status, 200)
  await call(routes, 'GET', '/api/my-clusters', undefined, { 'x-platform-token': 'uuid-x' })
  assert.equal(sent[2].status, 403)
  assert.equal(sent[2].payload.message, MSG['auth.mfaEnrollmentRequired'].zh)
})

test('强制开关开:受限 token 完成 enable 后转完整(mfaPending=0,my-clusters 200)', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db, { getSetting: (k) => (k === 'auth.mfa.required' ? '1' : null) })
  await login(routes, { username: 'alice', password: 'right-password' })
  const token = sent[0].payload.token
  const secret = generateTotpSecret()
  await call(routes, 'POST', '/api/auth/mfa/setup', {}, { 'x-platform-token': token })
  await call(routes, 'POST', '/api/auth/mfa/enable', { secret, code: totpCodeAt(secret, Date.now()) }, { 'x-platform-token': token })
  assert.equal(sent[2].status, 200)
  assert.equal(db.prepare('SELECT mfaPending FROM platform_sessions WHERE token=?').get(token).mfaPending, 0, 'enable 成功 → mfaPending=0')
  await call(routes, 'GET', '/api/my-clusters', undefined, { 'x-platform-token': token })
  assert.equal(sent[3].status, 200)
})

test('强制开关关(默认):登录 mfaPending=0,一切照旧', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  await login(routes, { username: 'alice', password: 'right-password' })
  assert.equal(db.prepare('SELECT mfaPending FROM platform_sessions WHERE token=?').get('uuid-x').mfaPending, 0)
})

test('step-up:对码 → 200 且 stepUpAt 刷新;错码 401;恢复码可验不即焚;未启用 400', async () => {
  const db = makeDb(); seed(db)
  const secret = generateTotpSecret()
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(secret, 'u1')
  const rcHash = hashRecoveryCode('AAAAA-BBBBB')
  db.prepare('INSERT INTO mfa_recovery_codes (userId,codeHash,usedAt) VALUES (?,?,NULL)').run('u1', rcHash)
  db.prepare('UPDATE platform_sessions SET stepUpAt=? WHERE token=?').run(Date.now() - 11 * 60_000, 't-me')
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'POST', '/api/auth/step-up', { code: '000000' })
  assert.equal(sent[0].status, 401)
  // 恢复码 step-up:不消费(R2)
  await call(routes, 'POST', '/api/auth/step-up', { code: 'AAAAA-BBBBB' })
  assert.equal(sent[1].status, 200)
  assert.equal(db.prepare('SELECT usedAt FROM mfa_recovery_codes WHERE codeHash=?').get(rcHash).usedAt, null, 'step-up 不消费恢复码')
  const fresh = db.prepare('SELECT stepUpAt FROM platform_sessions WHERE token=?').get('t-me').stepUpAt
  assert.ok(fresh > Date.now() - 60_000, 'stepUpAt=now 刷新')
  // 刷新后 10min 内 disable 守卫放行(TOTP 码)
  await call(routes, 'POST', '/api/auth/mfa/disable', { code: totpCodeAt(secret, Date.now()) })
  assert.equal(sent[2].status, 200, 'step-up 刷新后守卫放行')
  // 未启用用户 step-up → 400
  await call(routes, 'POST', '/api/auth/step-up', { code: '000000' })
  assert.equal(sent[3].status, 400)
})

test('change-password:MFA 用户 step-up 过期 → 409;无 MFA 用户不要求 step-up(照旧 200/401)', async () => {
  const db = makeDb(); seed(db)
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(generateTotpSecret(), 'u1')
  db.prepare('UPDATE platform_sessions SET stepUpAt=? WHERE token=?').run(Date.now() - 11 * 60_000, 't-me')
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'POST', '/api/auth/change-password', { currentPassword: 'right-password', newPassword: 'newpassword1' })
  assert.equal(sent[0].status, 409)
  assert.equal(sent[0].payload.stepUpRequired, true)
  assert.equal(db.prepare('SELECT passwordHash FROM platform_users WHERE id=?').get('u1').passwordHash, 'good', '密码未动')
  // 无 MFA 用户:无 step-up 要求,行为与 Wave 3 前一致
  db.prepare('UPDATE platform_users SET totpSecret=NULL WHERE id=?').run('u1')
  await call(routes, 'POST', '/api/auth/change-password', { currentPassword: 'right-password', newPassword: 'newpassword1' })
  assert.equal(sent[1].status, 200, '无 MFA 用户改密不受 step-up 约束')
})

// ===== admin mfa-policy =====

function makeAdminRoutes(db, over = {}) {
  const sent = []
  const deps = {
    db, sendJson: (_r, s, p) => sent.push({ status: s, payload: p }),
    readBody: async () => deps._body,
    requireAdmin: (req, res) => db.prepare('SELECT s.*, u.role FROM platform_sessions s JOIN platform_users u ON u.id=s.userId WHERE s.token=? AND u.role=?').get(req.headers['x-platform-token'], 'admin') || (deps.sendJson(res, 403, { message: 'admin required' }), null),
    getSetting: (k) => db.prepare('SELECT value FROM platform_settings WHERE key=?').get(k)?.value ?? null,
    setSetting: (k, v) => db.prepare('INSERT OR REPLACE INTO platform_settings (key,value,updatedAt) VALUES (?,?,?)').run(k, String(v ?? ''), Date.now()),
    deleteSetting: (k) => db.prepare('DELETE FROM platform_settings WHERE key=?').run(k),
    writeAudit,
    ...over,
  }
  Object.assign(deps, over)
  const router = createAdminRoutes(deps)
  const wrapper = { get routes() { return router } }
  Object.defineProperty(wrapper, '_body', { get() { return deps._body }, set(v) { deps._body = v } })
  return { routes: wrapper, sent, deps }
}

function makeSettingsDb() {
  const db = makeDb()
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('a1','root','good','admin',1)").run()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES ('t-admin','a1','root','admin',1)").run()
  db.exec('CREATE TABLE IF NOT EXISTS platform_settings ( key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER NOT NULL )')
  return db
}

const adminCall = (routes, method, path, body) => {
  if (body !== undefined) routes._body = body
  return routes.routes.handle({ method, headers: { 'x-platform-token': 't-admin' }, url: path }, {}, new URL(path, 'http://x'))
}

test("admin mfa-policy:GET 默认关;PUT true 落 '1' + 审计;PUT false 删键 + 审计;非法 body 400", async () => {
  const db = makeSettingsDb()
  const { routes, sent } = makeAdminRoutes(db)
  await adminCall(routes, 'GET', '/api/admin/mfa-policy')
  assert.equal(sent[0].status, 200)
  assert.deepEqual(sent[0].payload, { enabled: false })
  await adminCall(routes, 'PUT', '/api/admin/mfa-policy', { enabled: true })
  assert.deepEqual(sent[1].payload, { enabled: true })
  assert.equal(db.prepare("SELECT value FROM platform_settings WHERE key='auth.mfa.required'").get().value, '1')
  await adminCall(routes, 'GET', '/api/admin/mfa-policy')
  assert.deepEqual(sent[2].payload, { enabled: true })
  await adminCall(routes, 'PUT', '/api/admin/mfa-policy', { enabled: false })
  assert.deepEqual(sent[3].payload, { enabled: false })
  assert.equal(db.prepare("SELECT COUNT(*) c FROM platform_settings WHERE key='auth.mfa.required'").get().c, 0, '关 = 删键')
  await adminCall(routes, 'PUT', '/api/admin/mfa-policy', { enabled: 'yes' })
  assert.equal(sent[4].status, 400)
  // node:sqlite 行是 null-prototype,断言映射为标量(auth-selfservice 同款手法)
  const audit = db.prepare("SELECT result FROM audit_log WHERE tool='admin_mfa_policy' ORDER BY rowid").all()
  assert.deepEqual(audit.map(a => a.result), ['ok', 'ok'], '两次 PUT 各写一行审计')
})

// ===== Review round 1(controller 裁决补录):enable-on-enabled 须 step-up + disable 400 先于 409 + setup 409 审计 =====

// 已启用账户再 enable = 同时替换两个因子(TOTP 密钥 + 恢复码组)——落在 step-up 禁改面内(与 disable/setup 同周界)。
test('enable(已启用账户 = 换双因子)须 step-up:过期 409 零改动;新鲜 200 且轮换 secret/恢复码 + 审计', async () => {
  const db = makeDb(); seed(db)
  const oldSecret = generateTotpSecret()
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(oldSecret, 'u1')
  db.prepare('UPDATE platform_sessions SET stepUpAt=? WHERE token=?').run(Date.now() - 11 * 60_000, 't-me')
  const { routes, sent } = makeRoutes(db)
  const newSecret = generateTotpSecret()
  await call(routes, 'POST', '/api/auth/mfa/enable', { secret: newSecret, code: totpCodeAt(newSecret, Date.now()) })
  assert.equal(sent[0].status, 409)
  assert.equal(sent[0].payload.stepUpRequired, true)
  assert.equal(db.prepare('SELECT totpSecret FROM platform_users WHERE id=?').get('u1').totpSecret, oldSecret, '409 时零改动')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mfa_recovery_codes').get().c, 0, '零恢复码落库')
  // 新鲜 step-up → enable 成功并轮换两因子
  db.prepare('UPDATE platform_sessions SET stepUpAt=? WHERE token=?').run(Date.now(), 't-me')
  await call(routes, 'POST', '/api/auth/mfa/enable', { secret: newSecret, code: totpCodeAt(newSecret, Date.now()) })
  assert.equal(sent[1].status, 200)
  assert.equal(sent[1].payload.recoveryCodes.length, 10)
  assert.equal(db.prepare('SELECT totpSecret FROM platform_users WHERE id=?').get('u1').totpSecret, newSecret, 'secret 轮换')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mfa_recovery_codes WHERE userId=?').get('u1').c, 10, '恢复码组轮换')
  const audit = db.prepare("SELECT result, reason FROM audit_log WHERE tool='platform_mfa_enable' ORDER BY rowid").all()
  assert.deepEqual(audit.map(a => `${a.result}:${a.reason}`), ['denied:step-up-required', 'ok:codes=10'], '409 也写 denied 审计')
})

// 重排后语义:未启用账户不存在「账户安全面」可言,400(状态)先于 409(重验)——即使 stepUpAt 过期。
test('disable:未启用(即使 stepUpAt 为 NULL/过期)→ 400 mfaNotEnabled 先于 409', async () => {
  const db = makeDb(); seed(db)
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'POST', '/api/auth/mfa/disable', { code: '000000' })
  assert.equal(sent[0].status, 400)
  assert.equal(sent[0].payload.message, MSG['auth.mfaNotEnabled'].zh)
})

test('setup 409(step-up 过期)写 denied 审计(与 enable/disable 的 denied 口径一致)', async () => {
  const db = makeDb(); seed(db)
  db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(generateTotpSecret(), 'u1')
  db.prepare('UPDATE platform_sessions SET stepUpAt=? WHERE token=?').run(Date.now() - 11 * 60_000, 't-me')
  const { routes, sent } = makeRoutes(db)
  await call(routes, 'POST', '/api/auth/mfa/setup', {})
  assert.equal(sent[0].status, 409)
  const audit = db.prepare("SELECT result, reason FROM audit_log WHERE tool='platform_mfa_setup' ORDER BY rowid").all()
  assert.deepEqual(audit.map(a => `${a.result}:${a.reason}`), ['denied:step-up-required'])
})
