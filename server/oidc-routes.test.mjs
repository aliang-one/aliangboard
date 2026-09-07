// Wave 4 OIDC Task 4:三 none-class 端点(GET login / GET callback / POST exchange)+ admin 配置端点。
// 政策(计划 Task 4):**stub IdP 全流程真验签**——真 node:http 服务(discovery/jwks/token 三路由)+
// Task 1 同款真 RSA 钥自签 id_token(crypto.sign,非 mock);provider 注入真实 fetch 打 stub IdP。
// 负矩阵:disabled/坏 state/过期 state/state 单次/IdP error 参数/token 端点 500/nonce 错/usernameTaken/
// groups 非 string[]/兑换码重放/过期/错 IP/限流 6 连击/disabled 用户(upsert 后+exchange 窗口)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { generateKeyPairSync, sign } from 'node:crypto'

import { createAuthRoutes, oidcStates, oidcCodes } from './routes/auth.mjs'
import { createAdminRoutes } from './routes/admin.mjs'
import { createAuditSchema, writeAudit } from './audit.mjs'
import { createRateLimiter } from './rate-limit.mjs'
import { createOidcProvider, _clearOidcCacheForTest } from './oidc.mjs'

const CLIENT_ID = 'aliangboard-test'
const IP = '9.9.9.9'

// === 真 RSA 钥(模块级一次生成;JWK 取 export({format:'jwk'}) 真实形状,附 kid) ===
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const rsaJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'stub-key-1', alg: 'RS256' }

const b64u = (buf) => Buffer.from(buf).toString('base64url')
function signIdToken(claims) {
  const input = Buffer.from(`${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: rsaJwk.kid }))}.${b64u(JSON.stringify(claims))}`)
  return `${input.toString()}.${b64u(sign('RSA-SHA256', input, rsa.privateKey))}`
}

// === stub IdP:discovery(issuer 指向自身)/jwks(真钥)/token(返回测试注入的自签 id_token) ===
async function startStubIdP() {
  const state = { idToken: null, tokenStatus: 200, calls: [] }
  let base = ''
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://idp.local')
    if (u.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks` }))
      return
    }
    if (u.pathname === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: [rsaJwk] }))
      return
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        state.calls.push(body)
        if (state.tokenStatus !== 200) { res.writeHead(state.tokenStatus); res.end('boom'); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id_token: state.idToken }))
      })
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  return { server, state, base }
}
async function stopStubIdP(idp) {
  idp.server.closeAllConnections?.()
  await new Promise((r) => idp.server.close(r))
}

// === 夹具库:镜像 index.mjs 真实 DDL(users 含 authProvider/oidcSubject + sessions + settings + groups) ===
function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', displayName TEXT, createdAt INTEGER NOT NULL,
    disabled INTEGER DEFAULT 0, prefs TEXT, totpSecret TEXT,
    authProvider TEXT NOT NULL DEFAULT 'local', oidcSubject TEXT)`)
  db.exec(`CREATE TABLE platform_sessions (
    token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL,
    createdAt INTEGER NOT NULL, k8sSessionToken TEXT, lastSeenAt INTEGER, ip TEXT, userAgent TEXT,
    mfaPending INTEGER DEFAULT 0, stepUpAt INTEGER)`)
  db.exec(`CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, createdBy TEXT)`)
  db.exec(`CREATE TABLE group_members (groupId TEXT NOT NULL, userId TEXT NOT NULL, addedBy TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY (groupId, userId))`)
  createAuditSchema(db)
  return db
}

// auth/admin 路由工厂:settings 走内存 Map(getSetting/setSetting 同 index.mjs 语义);
// 限流器独立实例(capacity 5 / 10s 回 1,镜像生产 LOGIN_RATE_*);审计走真实链式 writeAudit。
function makeRoutes(db, { ip = IP } = {}) {
  oidcStates.clear(); oidcCodes.clear(); _clearOidcCacheForTest()
  const settings = new Map()
  const getSetting = (k) => settings.get(k) ?? null
  const setSetting = (k, v) => settings.set(k, String(v))
  const limiter = createRateLimiter({ capacity: 5, refillPerSec: 0.1 })
  const provider = createOidcProvider({ getSetting })
  const sent = []
  const sendJson = (_r, status, payload) => { sent.push({ status, payload }) }
  let n = 0
  const randomUUID = () => `uuid-${++n}`
  const routes = createAuthRoutes({
    db, sendJson,
    readBody: async (req) => req._body,
    requirePlatform: () => null,
    platformSessions: new Map(), sessions: new Map(), persistSession: () => {},
    verifyPassword: () => false,
    randomUUID,
    checkLoginRate: (key) => limiter.check(key),
    writeAudit,
    getSetting, setSetting,
    oidcProvider: provider,
  })
  const adminRoutes = createAdminRoutes({
    db, sendJson,
    readBody: async (req) => req._body,
    requireAdmin: (req) => (req._ps?.role === 'admin' ? req._ps : (sent.push({ status: 401, payload: {} }), null)),
    getSetting, setSetting, writeAudit,
    oidcProvider: provider,
  })
  const enableOidc = (issuer) => {
    setSetting('oidc.enabled', '1')
    setSetting('oidc.issuer', issuer)
    setSetting('oidc.clientId', CLIENT_ID)
  }
  return { routes, adminRoutes, sent, settings, setSetting, enableOidc, provider, ip }
}

// GET 调用(302 走 res.writeHead+end,不经 sendJson——记录 status/location)
async function callGet(routes, path, { ip = IP, host = 'board.test' } = {}) {
  const res = { status: 0, location: null,
    writeHead(s, h) { this.status = s; this.location = h?.location ?? null },
    end() {} }
  const req = { method: 'GET', url: path, headers: { host }, socket: { remoteAddress: ip, encrypted: false } }
  await routes.handle(req, res, new URL(path, `http://${host}`))
  return res
}
async function callPost(routes, path, body, { ip = IP, host = 'board.test' } = {}) {
  const req = { method: 'POST', url: path, headers: { host }, socket: { remoteAddress: ip, encrypted: false }, _body: body }
  await routes.handle(req, {}, new URL(path, `http://${host}`))
}

// 一步走完 login(拿 state/nonce)→ 自签 nonce 匹配的 id_token 注入 stub → 返回 parsed 起跳参数。
function primeToken(idp, issuer, { nonce, sub = 'sub-1', username = 'alice', groups = ['devs', 'ops'], name = 'Alice A', nonceOverride, expSecFromNow = 3600, groupsOverride } = {}) {
  const claims = {
    iss: issuer, aud: CLIENT_ID, sub, exp: Math.floor(Date.now() / 1000) + expSecFromNow, iat: Math.floor(Date.now() / 1000),
    nonce: nonceOverride ?? nonce, preferred_username: username,
  }
  if (name !== null) claims.name = name
  if (groupsOverride !== undefined) claims.custom_groups = groupsOverride
  else if (groups !== null) claims.groups = groups
  idp.state.idToken = signIdToken(claims)
}

// ============ 全流程(happy path) ============

test('login 302 形状:未启用回 oidcError=disabled;启用后授权 URL 含 state/nonce/PKCE(S256)/client_id/redirect_uri', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    // 未启用(缺省关 = 存量零感知)
    let res = await callGet(ctx.routes, '/api/auth/oidc/login')
    assert.equal(res.status, 302)
    assert.equal(res.location, '/login?oidcError=disabled')
    // 启用
    ctx.enableOidc(idp.base)
    res = await callGet(ctx.routes, '/api/auth/oidc/login')
    assert.equal(res.status, 302)
    const loc = new URL(res.location)
    assert.equal(loc.origin + loc.pathname, `${idp.base}/authorize`)
    assert.equal(loc.searchParams.get('response_type'), 'code')
    assert.equal(loc.searchParams.get('client_id'), CLIENT_ID)
    assert.equal(loc.searchParams.get('redirect_uri'), 'http://board.test/api/auth/oidc/callback')
    assert.ok(loc.searchParams.get('state'), 'state 必在')
    assert.ok(loc.searchParams.get('nonce'), 'nonce 必在')
    assert.ok(loc.searchParams.get('code_challenge'), 'PKCE challenge 必在')
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(loc.searchParams.get('scope'))
    // state entry:10min TTL + nonce/verifier/redirectUri 绑定
    const st = oidcStates.get(loc.searchParams.get('state'))
    assert.ok(st, 'state entry 已签发')
    assert.equal(st.redirectUri, 'http://board.test/api/auth/oidc/callback')
    assert.equal(typeof st.nonce, 'string')
    assert.equal(typeof st.verifier, 'string')
    assert.ok(st.exp > Date.now())
  } finally { await stopStubIdP(idp) }
})

test('全流程:callback→302 oidcCode;JIT 建户(authProvider=oidc/哨兵哈希)+ 组同步 + ok 审计;exchange→token/user/prefs + 会话行(stepUpAt 有,mfaPending=0)', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    ctx.enableOidc(idp.base)
    const login = await callGet(ctx.routes, '/api/auth/oidc/login')
    const loc = new URL(login.location)
    const state = loc.searchParams.get('state'), nonce = loc.searchParams.get('nonce')
    primeToken(idp, idp.base, { nonce })
    const cb = await callGet(ctx.routes, `/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=stub-code-1`)
    assert.equal(cb.status, 302)
    assert.match(cb.location, /^\/login\?oidcCode=/)
    const code = cb.location.split('=')[1]
    // DB:JIT 建户
    const user = db.prepare("SELECT * FROM platform_users WHERE username='alice'").get()
    assert.ok(user, 'OIDC 用户已建')
    assert.equal(user.authProvider, 'oidc')
    assert.equal(user.oidcSubject, `${idp.base}|sub-1`)
    assert.equal(user.displayName, 'Alice A')
    assert.equal(user.role, 'user')
    assert.match(user.passwordHash, /^[0-9a-f]{32}:[0-9a-f]{128}:16384:8:1$/, '哨兵 scrypt 哈希(本地登录恒失败)')
    // DB:组同步(建组 + 成员)
    const groupNames = db.prepare('SELECT name FROM groups ORDER BY name').all().map((r) => r.name)
    assert.deepEqual(groupNames, ['devs', 'ops'])
    const memberCount = db.prepare('SELECT COUNT(*) c FROM group_members gm JOIN groups g ON g.id=gm.groupId WHERE gm.userId=?').get(user.id).c
    assert.equal(memberCount, 2)
    // token 端点收到 form-encoded PKCE 形状
    assert.equal(idp.state.calls.length, 1)
    assert.match(idp.state.calls[0], /grant_type=authorization_code/)
    assert.match(idp.state.calls[0], /code_verifier=/)
    assert.match(idp.state.calls[0], /code=stub-code-1/)
    // 审计:tool=oidc_login result=ok summary sub/created/groups
    const audit = db.prepare("SELECT * FROM audit_log WHERE tool='oidc_login' AND result='ok'").all()
    assert.equal(audit.length, 1)
    assert.equal(audit[0].owner, 'alice')
    assert.equal(audit[0].requestSummary, 'sub=sub-1 created=1 groups=2')
    // exchange → {token,user,prefs}
    await callPost(ctx.routes, '/api/auth/oidc/exchange', { code })
    const out = ctx.sent.at(-1)
    assert.equal(out.status, 200)
    assert.ok(out.payload.token)
    assert.equal(out.payload.user.username, 'alice')
    assert.equal(out.payload.user.displayName, 'Alice A')
    assert.deepEqual(out.payload.prefs, {})
    // 会话行:stepUpAt 有值;mfaPending=0(裁决 R1:OIDC 用户不设 mfaPending)
    const row = db.prepare('SELECT * FROM platform_sessions WHERE token=?').get(out.payload.token)
    assert.ok(row, 'platform_sessions 行已落')
    assert.ok(row.stepUpAt > 0)
    assert.equal(row.mfaPending, 0)
  } finally { await stopStubIdP(idp) }
})

test('二次登录同 subject:created=0,displayName 更新,组全量对齐(减员生效)', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    ctx.enableOidc(idp.base)
    // 第一次:devs/ops
    let login = await callGet(ctx.routes, '/api/auth/oidc/login')
    let loc = new URL(login.location)
    primeToken(idp, idp.base, { nonce: loc.searchParams.get('nonce') })
    await callGet(ctx.routes, `/api/auth/oidc/callback?state=${encodeURIComponent(loc.searchParams.get('state'))}&code=c1`)
    // 第二次:只留 ops,displayName 换新
    login = await callGet(ctx.routes, '/api/auth/oidc/login')
    loc = new URL(login.location)
    primeToken(idp, idp.base, { nonce: loc.searchParams.get('nonce'), name: 'Alice B', groups: ['ops'] })
    const cb = await callGet(ctx.routes, `/api/auth/oidc/callback?state=${encodeURIComponent(loc.searchParams.get('state'))}&code=c2`)
    assert.match(cb.location, /^\/login\?oidcCode=/)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM platform_users').get().c, 1, '不重建用户')
    const user = db.prepare("SELECT * FROM platform_users WHERE username='alice'").get()
    assert.equal(user.displayName, 'Alice B')
    const memberships = db.prepare('SELECT g.name n FROM group_members gm JOIN groups g ON g.id=gm.groupId WHERE gm.userId=?').all(user.id).map((r) => r.n)
    assert.deepEqual(memberships, ['ops'], '组全量对齐:devs 成员被移除')
    const okRows = db.prepare("SELECT requestSummary FROM audit_log WHERE tool='oidc_login' AND result='ok' ORDER BY rowid").all()
    assert.deepEqual(okRows.map((r) => r.requestSummary), ['sub=sub-1 created=1 groups=2', 'sub=sub-1 created=0 groups=1'])
  } finally { await stopStubIdP(idp) }
})

// ============ 负矩阵 ============

test('callback:坏 state/过期 state/state 单次 → 302 oidcError=state', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    ctx.enableOidc(idp.base)
    // 未知 state
    let res = await callGet(ctx.routes, '/api/auth/oidc/callback?state=never-issued&code=x')
    assert.equal(res.status, 302)
    assert.equal(res.location, '/login?oidcError=state')
    // 过期 state(真签发后改 exp)
    const login = await callGet(ctx.routes, '/api/auth/oidc/login')
    const loc = new URL(login.location)
    const state = loc.searchParams.get('state')
    oidcStates.get(state).exp = Date.now() - 1
    res = await callGet(ctx.routes, `/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`)
    assert.equal(res.location, '/login?oidcError=state')
    // 单次:正常走一遍后,同一 state 重放 → state
    const login2 = await callGet(ctx.routes, '/api/auth/oidc/login')
    const loc2 = new URL(login2.location)
    primeToken(idp, idp.base, { nonce: loc2.searchParams.get('nonce') })
    const cbUrl = `/api/auth/oidc/callback?state=${encodeURIComponent(loc2.searchParams.get('state'))}&code=good`
    res = await callGet(ctx.routes, cbUrl)
    assert.match(res.location, /^\/login\?oidcCode=/)
    res = await callGet(ctx.routes, cbUrl)
    assert.equal(res.location, '/login?oidcError=state')
  } finally { await stopStubIdP(idp) }
})

test('callback:IdP error 参数(用户拒绝)→ 302 denied,且不触 token 端点', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    ctx.enableOidc(idp.base)
    const login = await callGet(ctx.routes, '/api/auth/oidc/login')
    const state = new URL(login.location).searchParams.get('state')
    const res = await callGet(ctx.routes, `/api/auth/oidc/callback?state=${encodeURIComponent(state)}&error=access_denied`)
    assert.equal(res.status, 302)
    assert.equal(res.location, '/login?oidcError=denied')
    assert.equal(idp.state.calls.length, 0, 'IdP 拒绝分支不得触 code 兑换')
    assert.equal(oidcStates.has(state), false, 'error 分支同样作废 state(单次)')
  } finally { await stopStubIdP(idp) }
})

test('callback:token 端点 500 → 302 token;nonce 不匹配 → 302 verify', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    ctx.enableOidc(idp.base)
    // token 端点 500
    let login = await callGet(ctx.routes, '/api/auth/oidc/login')
    let loc = new URL(login.location)
    primeToken(idp, idp.base, { nonce: loc.searchParams.get('nonce') })
    idp.state.tokenStatus = 500
    let res = await callGet(ctx.routes, `/api/auth/oidc/callback?state=${encodeURIComponent(loc.searchParams.get('state'))}&code=c`)
    assert.equal(res.location, '/login?oidcError=token')
    idp.state.tokenStatus = 200
    // nonce 不匹配(真 token,错 nonce)
    login = await callGet(ctx.routes, '/api/auth/oidc/login')
    loc = new URL(login.location)
    primeToken(idp, idp.base, { nonce: loc.searchParams.get('nonce'), nonceOverride: 'evil-nonce' })
    res = await callGet(ctx.routes, `/api/auth/oidc/callback?state=${encodeURIComponent(loc.searchParams.get('state'))}&code=c`)
    assert.equal(res.location, '/login?oidcError=verify')
    assert.equal(db.prepare('SELECT COUNT(*) c FROM platform_users').get().c, 0, '验签失败不得建户')
  } finally { await stopStubIdP(idp) }
})

test('callback:username 被本地用户占用 → 302 usernameTaken,不接管不建户', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u-local','alice','local-hash','user',1)").run()
    const ctx = makeRoutes(db)
    ctx.enableOidc(idp.base)
    const login = await callGet(ctx.routes, '/api/auth/oidc/login')
    const loc = new URL(login.location)
    primeToken(idp, idp.base, { nonce: loc.searchParams.get('nonce'), username: 'alice' })
    const res = await callGet(ctx.routes, `/api/auth/oidc/callback?state=${encodeURIComponent(loc.searchParams.get('state'))}&code=c`)
    assert.equal(res.location, '/login?oidcError=usernameTaken')
    const alice = db.prepare("SELECT * FROM platform_users WHERE username='alice'").get()
    assert.equal(alice.id, 'u-local', '本地用户原样')
    assert.equal(alice.authProvider, 'local')
    const denied = db.prepare("SELECT reason FROM audit_log WHERE tool='oidc_login' AND result='denied'").all()
    assert.ok(denied.some((r) => r.reason === 'usernameTaken'))
  } finally { await stopStubIdP(idp) }
})

test('callback:groups claim 非 string[](字符串形态)→ 302 verify,不建户', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    ctx.enableOidc(idp.base)
    ctx.setSetting('oidc.groupsClaim', 'custom_groups') // 非 string[](字符串形态)走自定义 claim 名
    const login = await callGet(ctx.routes, '/api/auth/oidc/login')
    const loc = new URL(login.location)
    primeToken(idp, idp.base, { nonce: loc.searchParams.get('nonce'), groups: null, groupsOverride: 'devs,ops' })
    const res = await callGet(ctx.routes, `/api/auth/oidc/callback?state=${encodeURIComponent(loc.searchParams.get('state'))}&code=c`)
    assert.equal(res.location, '/login?oidcError=verify')
    assert.equal(db.prepare('SELECT COUNT(*) c FROM platform_users').get().c, 0, 'claims 形状非法不得建户')
  } finally { await stopStubIdP(idp) }
})

test('callback:disabled 用户(upsert 后)→ 302 disabled,不发兑换码', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    ctx.enableOidc(idp.base)
    // 先正常建户
    let login = await callGet(ctx.routes, '/api/auth/oidc/login')
    let loc = new URL(login.location)
    primeToken(idp, idp.base, { nonce: loc.searchParams.get('nonce') })
    await callGet(ctx.routes, `/api/auth/oidc/callback?state=${encodeURIComponent(loc.searchParams.get('state'))}&code=c1`)
    // 禁用后再登
    db.prepare("UPDATE platform_users SET disabled=1 WHERE username='alice'").run()
    login = await callGet(ctx.routes, '/api/auth/oidc/login')
    loc = new URL(login.location)
    primeToken(idp, idp.base, { nonce: loc.searchParams.get('nonce') })
    const res = await callGet(ctx.routes, `/api/auth/oidc/callback?state=${encodeURIComponent(loc.searchParams.get('state'))}&code=c2`)
    assert.equal(res.location, '/login?oidcError=disabled')
    const denied = db.prepare("SELECT reason FROM audit_log WHERE tool='oidc_login' AND result='denied'").all()
    assert.ok(denied.some((r) => r.reason === 'disabled'))
  } finally { await stopStubIdP(idp) }
})

// ============ exchange 负矩阵 ============

async function fullFlowToCode(ctx, idp) {
  const login = await callGet(ctx.routes, '/api/auth/oidc/login')
  const loc = new URL(login.location)
  primeToken(idp, idp.base, { nonce: loc.searchParams.get('nonce') })
  const cb = await callGet(ctx.routes, `/api/auth/oidc/callback?state=${encodeURIComponent(loc.searchParams.get('state'))}&code=c`)
  return cb.location.split('=')[1]
}

test('exchange:错码 401;重放拒(单次);过期拒;错 IP 拒;缺 code 400', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    ctx.enableOidc(idp.base)
    // 错码
    await callPost(ctx.routes, '/api/auth/oidc/exchange', { code: 'nope' })
    assert.equal(ctx.sent.at(-1).status, 401)
    // 真码:首次 200
    const code = await fullFlowToCode(ctx, idp)
    await callPost(ctx.routes, '/api/auth/oidc/exchange', { code })
    assert.equal(ctx.sent.at(-1).status, 200)
    // 重放(读即删)
    await callPost(ctx.routes, '/api/auth/oidc/exchange', { code })
    assert.equal(ctx.sent.at(-1).status, 401, '兑换码单次,重放必拒')
    // 过期(新码,改 exp 后兑换)
    const code2 = await fullFlowToCode(ctx, idp)
    oidcCodes.get(code2).exp = Date.now() - 1
    await callPost(ctx.routes, '/api/auth/oidc/exchange', { code: code2 })
    assert.equal(ctx.sent.at(-1).status, 401)
    // 错 IP(码绑 IP:回调在 9.9.9.9,兑换自称 8.8.8.8)
    const code3 = await fullFlowToCode(ctx, idp)
    await callPost(ctx.routes, '/api/auth/oidc/exchange', { code: code3 }, { ip: '8.8.8.8' })
    assert.equal(ctx.sent.at(-1).status, 401, '兑换码换 IP 即失效(防 referrer 泄漏重放)')
    // 缺 code
    await callPost(ctx.routes, '/api/auth/oidc/exchange', {})
    assert.equal(ctx.sent.at(-1).status, 400)
  } finally { await stopStubIdP(idp) }
})

test('exchange:独立限流 oidcx|ip —— 6 连击第 6 发 429;其他 IP 不受牵连', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    ctx.enableOidc(idp.base)
    for (let i = 0; i < 5; i++) {
      await callPost(ctx.routes, '/api/auth/oidc/exchange', { code: 'bad' })
      assert.equal(ctx.sent.at(-1).status, 401, `第 ${i + 1} 发预算内 401`)
    }
    await callPost(ctx.routes, '/api/auth/oidc/exchange', { code: 'bad' })
    const last = ctx.sent.at(-1)
    assert.equal(last.status, 429, '超出容量 5 → 429')
    assert.ok(last.payload.retryAfter >= 1)
    await callPost(ctx.routes, '/api/auth/oidc/exchange', { code: 'bad' }, { ip: '7.7.7.7' })
    assert.equal(ctx.sent.at(-1).status, 401, '其他 IP 不受限流牵连(键含 IP,独立桶)')
    const rl = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tool='oidc_login' AND result='ratelimited'").get().c
    assert.equal(rl, 1, '限流拒绝写审计')
  } finally { await stopStubIdP(idp) }
})

test('exchange:窗口内被禁用的用户 → 401(finishOidcSession 拒 disabled)', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    ctx.enableOidc(idp.base)
    const code = await fullFlowToCode(ctx, idp)
    db.prepare("UPDATE platform_users SET disabled=1 WHERE username='alice'").run()
    await callPost(ctx.routes, '/api/auth/oidc/exchange', { code })
    assert.equal(ctx.sent.at(-1).status, 401)
    // 200 落库绝无:disabled 用户不得获得会话
    assert.equal(db.prepare("SELECT COUNT(*) c FROM platform_sessions WHERE username='alice'").get().c, 0)
  } finally { await stopStubIdP(idp) }
})

// ============ admin 配置端点 ============

const ADMIN_REQ = { _ps: { userId: 'a1', username: 'root', role: 'admin' }, headers: { host: 'board.test' }, socket: { remoteAddress: IP, encrypted: false } }

test('admin oidc-config:GET 空配置形状(publicConfig+redirectUri,clientSecret 永不出)', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    await ctx.adminRoutes.handle({ ...ADMIN_REQ, method: 'GET' }, {}, new URL('http://board.test/api/admin/oidc-config'))
    assert.equal(ctx.sent.at(-1).status, 200)
    assert.deepEqual(ctx.sent.at(-1).payload, {
      enabled: false, issuer: null, clientId: null,
      scopes: 'openid profile email', groupsClaim: 'groups', usernameClaim: 'preferred_username',
      hasSecret: false, redirectUri: 'http://board.test/api/auth/oidc/callback',
    })
  } finally { await stopStubIdP(idp) }
})

test('admin oidc-config PUT:合法全量落 7 键+审计;空 clientSecret=保留旧值;hasSecret 反映', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    const put = (body) => ctx.adminRoutes.handle({ ...ADMIN_REQ, method: 'PUT', _body: body }, {}, new URL('http://board.test/api/admin/oidc-config'))
    await put({ enabled: true, issuer: idp.base, clientId: CLIENT_ID, clientSecret: 'sec-1', scopes: 'openid profile', groupsClaim: 'grp', usernameClaim: 'uname' })
    assert.equal(ctx.sent.at(-1).status, 200)
    assert.equal(ctx.settings.get('oidc.enabled'), '1')
    assert.equal(ctx.settings.get('oidc.issuer'), idp.base)
    assert.equal(ctx.settings.get('oidc.clientSecret'), 'sec-1')
    assert.equal(ctx.settings.get('oidc.scopes'), 'openid profile')
    assert.equal(ctx.settings.get('oidc.groupsClaim'), 'grp')
    assert.equal(ctx.settings.get('oidc.usernameClaim'), 'uname')
    assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tool='admin_oidc_config'").get().c, 1, '写审计 admin_oidc_config')
    // 再存:clientSecret 留空 = 不改
    await put({ enabled: true, issuer: idp.base, clientId: CLIENT_ID, clientSecret: '', scopes: 'openid profile', groupsClaim: 'grp', usernameClaim: 'uname' })
    assert.equal(ctx.sent.at(-1).status, 200)
    assert.equal(ctx.settings.get('oidc.clientSecret'), 'sec-1')
    await ctx.adminRoutes.handle({ ...ADMIN_REQ, method: 'GET' }, {}, new URL('http://board.test/api/admin/oidc-config'))
    assert.equal(ctx.sent.at(-1).payload.hasSecret, true)
    assert.ok(!('clientSecret' in ctx.sent.at(-1).payload), 'clientSecret 永不出端点')
    // 非 admin 401
    await ctx.adminRoutes.handle({ _ps: { role: 'user' }, method: 'PUT', _body: {} }, {}, new URL('http://board.test/api/admin/oidc-config'))
    assert.equal(ctx.sent.at(-1).status, 401)
  } finally { await stopStubIdP(idp) }
})

test('admin oidc-config PUT 校验:置 1 缺 issuer/clientId 400;issuer 尾斜杠/非 http(s) 400', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    const put = (body) => ctx.adminRoutes.handle({ ...ADMIN_REQ, method: 'PUT', _body: body }, {}, new URL('http://board.test/api/admin/oidc-config'))
    await put({ enabled: true, clientId: CLIENT_ID }) // 缺 issuer
    assert.equal(ctx.sent.at(-1).status, 400)
    await put({ enabled: true, issuer: idp.base }) // 缺 clientId
    assert.equal(ctx.sent.at(-1).status, 400)
    await put({ enabled: false, issuer: `${idp.base}/`, clientId: CLIENT_ID }) // 尾斜杠(即便禁用也拒——配置面就地上拒)
    assert.equal(ctx.sent.at(-1).status, 400)
    await put({ enabled: false, issuer: 'notaurl', clientId: CLIENT_ID }) // 非 http(s)
    assert.equal(ctx.sent.at(-1).status, 400)
    await put({ enabled: false, issuer: '', clientId: '' }) // 清空+禁用 → 合法
    assert.equal(ctx.sent.at(-1).status, 200)
  } finally { await stopStubIdP(idp) }
})

test('admin oidc-config/test:stub IdP 连通 → ok(端点/密钥数/kty);不可达 issuer → ok:false error=discovery;未配置 → ok:false', async () => {
  const idp = await startStubIdP()
  try {
    const db = makeDb()
    const ctx = makeRoutes(db)
    const call = () => ctx.adminRoutes.handle({ ...ADMIN_REQ, method: 'GET' }, {}, new URL('http://board.test/api/admin/oidc-config/test'))
    await call()
    assert.equal(ctx.sent.at(-1).status, 200)
    assert.deepEqual(ctx.sent.at(-1).payload, { ok: false, error: 'discovery' }, '未配置 issuer → ok:false')
    ctx.enableOidc(idp.base)
    await call()
    assert.deepEqual(ctx.sent.at(-1).payload, {
      ok: true, authorizationEndpoint: `${idp.base}/authorize`, tokenEndpoint: `${idp.base}/token`,
      jwksKeys: 1, algorithms: ['RSA'],
    })
    // 不可达 issuer(保留 clientId,换坏 issuer)
    ctx.setSetting('oidc.issuer', 'http://127.0.0.1:1')
    _clearOidcCacheForTest()
    await call()
    assert.deepEqual(ctx.sent.at(-1).payload, { ok: false, error: 'discovery' })
  } finally { await stopStubIdP(idp) }
})
