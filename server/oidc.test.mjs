// Wave 4 OIDC Task 2:provider 模块(oidc.mjs)——discovery/JWKS 缓存、授权 URL、code 兑换、
// id_token 验签(kid 强刷一次)。fetchImpl 注入(默认 globalThis.fetch),桩形状 { ok, status, json() }。
// id_token 用 Task 1 同款**真钥真签**(RS256 generateKeyPairSync,非 mock 验签)。
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'

import { createOidcProvider, _clearOidcCacheForTest, OIDC_CACHE_TTL_MS } from './oidc.mjs'

// === 夹具 ===
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const rsaJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'k-1', alg: 'RS256' }
const b64u = (buf) => Buffer.from(buf).toString('base64url')
function makeIdToken(claims, over = {}) {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'k-1', ...over.header }
  const signingInput = Buffer.from(`${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`)
  return `${signingInput}.${b64u(sign('RSA-SHA256', signingInput, rsa.privateKey))}`
}
const ISS = 'https://idp.example.com'
const NOW_S = Math.floor(Date.now() / 1000)
const goodClaims = (over = {}) => ({ iss: ISS, aud: 'client-a', sub: 'sub-1', exp: NOW_S + 600, iat: NOW_S, nonce: 'n1', ...over })
const docOf = (over = {}) => ({
  issuer: ISS, authorization_endpoint: `${ISS}/auth`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/jwks`, ...over,
})

// settings 桩 + fetch 桩(按 URL 分发,带调用计数)
function makeProvider({ settings = {}, routes = {} } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    const hit = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix))
    if (!hit) return { ok: false, status: 404, json: async () => ({}) }
    const res = await hit[1](url, init)
    return { ok: true, status: 200, json: async () => res, ...res }
  }
  const provider = createOidcProvider({ getSetting: (k) => settings[k] ?? null, fetchImpl })
  return { provider, calls, fetchImpl }
}

beforeEach(() => { _clearOidcCacheForTest() }) // 模块级缓存,逐用例隔离

// === isEnabled 组合矩阵 ===
test('isEnabled:enabled=1 且 issuer+clientId 齐 → true;任一缺失/关 → false', () => {
  const on = { 'oidc.enabled': '1', 'oidc.issuer': ISS, 'oidc.clientId': 'client-a' }
  assert.equal(makeProvider({ settings: on }).provider.isEnabled(), true)
  assert.equal(makeProvider({ settings: { 'oidc.issuer': ISS, 'oidc.clientId': 'client-a' } }).provider.isEnabled(), false) // 未开
  assert.equal(makeProvider({ settings: { ...on, 'oidc.enabled': '0' } }).provider.isEnabled(), false) // 显式关
  assert.equal(makeProvider({ settings: { ...on, 'oidc.issuer': null } }).provider.isEnabled(), false)
  assert.equal(makeProvider({ settings: { ...on, 'oidc.clientId': null } }).provider.isEnabled(), false)
})

// === getPublicConfig / getFullConfig ===
test('getPublicConfig:全字段 + hasSecret,clientSecret 永不出现;未配置项用缺省', () => {
  const { provider } = makeProvider({ settings: {
    'oidc.enabled': '1', 'oidc.issuer': ISS, 'oidc.clientId': 'client-a', 'oidc.clientSecret': 's3cret',
  } })
  const cfg = provider.getPublicConfig()
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.issuer, ISS)
  assert.equal(cfg.clientId, 'client-a')
  assert.equal(cfg.scopes, 'openid profile email') // 缺省
  assert.equal(cfg.groupsClaim, 'groups')
  assert.equal(cfg.usernameClaim, 'preferred_username')
  assert.equal(cfg.hasSecret, true)
  assert.ok(!('clientSecret' in cfg), 'clientSecret must never appear in public config')
})

test('getPublicConfig:自定义 scopes/claims + hasSecret=false;getFullConfig 内部含 secret/未配置返 null', () => {
  const { provider } = makeProvider({ settings: {
    'oidc.enabled': '0', 'oidc.issuer': ISS, 'oidc.clientId': 'client-a',
    'oidc.scopes': 'openid profile', 'oidc.groupsClaim': 'roles', 'oidc.usernameClaim': 'email',
  } })
  const cfg = provider.getPublicConfig()
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.scopes, 'openid profile')
  assert.equal(cfg.groupsClaim, 'roles')
  assert.equal(cfg.usernameClaim, 'email')
  assert.equal(cfg.hasSecret, false)
  const full = provider.getFullConfig()
  assert.equal(full.clientSecret, null)
  assert.equal(full.enabled, false) // 布尔化语义与 publicConfig 一致
  const unconfigured = makeProvider().provider.getFullConfig()
  assert.equal(unconfigured, null) // issuer/clientId 缺 → null
})

// === discovery:文档校验/缓存命中计数/坏文档/坏状态 ===
test('discovery:GET .well-known 路径 + 文档四字段校验 + 缓存命中(第二次零 fetch)', async () => {
  const { provider, calls } = makeProvider({ routes: { [`${ISS}/.well-known`]: () => docOf() } })
  const doc = await provider.discovery(ISS)
  assert.equal(doc.authorization_endpoint, `${ISS}/auth`)
  assert.equal(calls[0].url, `${ISS}/.well-known/openid-configuration`)
  await provider.discovery(ISS) // 缓存
  assert.equal(calls.length, 1)
})

test('discovery:缺字段 → throw;HTTP 非 2xx → throw', async () => {
  const badDoc = makeProvider({ routes: { [`${ISS}/.well-known`]: () => docOf({ token_endpoint: undefined }) } })
  await assert.rejects(() => badDoc.provider.discovery(ISS), /discovery/)
  const badStatus = makeProvider({ routes: {} }) // 404
  await assert.rejects(() => badStatus.provider.discovery(ISS), /discovery/)
})

// 审 1-5:discovery 文档 issuer 必须与请求 issuer 相符(防错配端点/中间人换文档)。
test('discovery:doc.issuer ≠ 请求 issuer → throw discovery', async () => {
  const { provider } = makeProvider({ routes: { [`${ISS}/.well-known`]: () => docOf({ issuer: 'https://other.example.com' }) } })
  await assert.rejects(() => provider.discovery(ISS), /discovery/)
})

// 审 1-6:buildAuthUrl 对畸形 authorization_endpoint(非 URL)→ 编码化 'discovery'(不裸传 URL 构造异常)。
test('buildAuthUrl:authorization_endpoint 非 URL → throw discovery', () => {
  const { provider } = makeProvider()
  assert.throws(() => provider.buildAuthUrl({
    doc: docOf({ authorization_endpoint: 'not a url at all' }), clientId: 'a', redirectUri: 'u',
    state: 's', nonce: 'n', codeChallenge: 'c', scopes: 'openid',
  }), /discovery/)
})

test('discovery:TTL 12h 过期后重新拉取', async (t) => {
  const realNow = Date.now()
  let fake = realNow
  t.mock.method(Date, 'now', () => fake)
  assert.equal(OIDC_CACHE_TTL_MS, 12 * 3600 * 1000)
  const { provider, calls } = makeProvider({ routes: { [`${ISS}/.well-known`]: () => docOf() } })
  await provider.discovery(ISS)
  await provider.discovery(ISS)
  assert.equal(calls.length, 1)
  fake = realNow + OIDC_CACHE_TTL_MS + 1000 // 越过 TTL
  await provider.discovery(ISS)
  assert.equal(calls.length, 2)
})

// === jwksFor:走 jwks_uri + kid 索引 + 缓存 ===
test('jwksFor:经 discovery 的 jwks_uri 拉取,keys 数组含全部 kid;二次调用命中缓存', async () => {
  const { provider, calls } = makeProvider({ routes: {
    [`${ISS}/.well-known`]: () => docOf(),
    [`${ISS}/jwks`]: () => ({ keys: [rsaJwk] }),
  } })
  const jwks = await provider.jwksFor(ISS)
  assert.deepEqual(jwks.keys.map((k) => k.kid), ['k-1'])
  await provider.jwksFor(ISS)
  const jwksCalls = calls.filter((c) => c.url === `${ISS}/jwks`)
  assert.equal(jwksCalls.length, 1) // 缓存
})

// === buildAuthUrl ===
test('buildAuthUrl:authorization_endpoint + 全参数 + URL 编码', () => {
  const { provider } = makeProvider()
  const url = new URL(provider.buildAuthUrl({
    doc: docOf(), clientId: 'client a+', redirectUri: 'https://board.example.com/api/auth/oidc/callback',
    state: 'st 1', nonce: 'nc 1', codeChallenge: 'chal-lenge', scopes: 'openid profile email',
  }))
  assert.equal(url.origin + url.pathname, `${ISS}/auth`)
  const q = url.searchParams
  assert.equal(q.get('response_type'), 'code')
  assert.equal(q.get('client_id'), 'client a+')
  assert.equal(q.get('redirect_uri'), 'https://board.example.com/api/auth/oidc/callback')
  assert.equal(q.get('state'), 'st 1')
  assert.equal(q.get('nonce'), 'nc 1')
  assert.equal(q.get('code_challenge'), 'chal-lenge')
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.equal(q.get('scope'), 'openid profile email')
})

// === exchangeCode ===
test('exchangeCode:POST token_endpoint + form-encoded body 形状 + 返回 { idToken }', async () => {
  const captured = []
  const { provider } = makeProvider({ routes: {
    [`${ISS}/token`]: (url, init) => { captured.push(String(init.body)); return { id_token: 'tok-1' } },
  } })
  const out = await provider.exchangeCode({
    doc: docOf(), clientId: 'client-a', clientSecret: 'sec', redirectUri: 'https://b.example.com/cb',
    code: 'c-123', codeVerifier: 'v-xyz',
  })
  assert.equal(out.idToken, 'tok-1')
  const body = new URLSearchParams(captured[0]) // 能按 urlencoded 解析即形状正确
  assert.equal(captured[0], 'client_id=client-a&client_secret=sec&grant_type=authorization_code&code=c-123&redirect_uri=https%3A%2F%2Fb.example.com%2Fcb&code_verifier=v-xyz')
  assert.equal(body.get('client_id'), 'client-a')
})

test('exchangeCode:响应缺 id_token → throw token;HTTP 非 2xx → throw token', async () => {
  const noToken = makeProvider({ routes: { [`${ISS}/token`]: () => ({ access_token: 'x' }) } })
  await assert.rejects(() => noToken.provider.exchangeCode({ doc: docOf(), clientId: 'a', clientSecret: 's', redirectUri: 'u', code: 'c', codeVerifier: 'v' }), /token/)
  // 直接构造 ok:false 桩
  const p2 = createOidcProvider({ getSetting: () => null, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) })
  await assert.rejects(() => p2.exchangeCode({ doc: docOf(), clientId: 'a', clientSecret: 's', redirectUri: 'u', code: 'c', codeVerifier: 'v' }), /token/)
})

// === verifyCallbackIdToken:缓存验签 + unknown-kid 强刷一次 ===
test('verifyCallbackIdToken:真钥真签 id_token 全绿 → claims', async () => {
  const { provider } = makeProvider({ routes: {
    [`${ISS}/.well-known`]: () => docOf(),
    [`${ISS}/jwks`]: () => ({ keys: [rsaJwk] }),
  } })
  const { claims } = await provider.verifyCallbackIdToken(makeIdToken(goodClaims()), ISS, 'client-a', 'n1')
  assert.equal(claims.sub, 'sub-1')
})

test('verifyCallbackIdToken:unknown-kid → 强刷一次 jwks 后验过(轮换场景)', async () => {
  let jwksCalls = 0
  const { provider } = makeProvider({ routes: {
    [`${ISS}/.well-known`]: () => docOf(),
    [`${ISS}/jwks`]: () => { jwksCalls++; return { keys: jwksCalls === 1 ? [] : [rsaJwk] } }, // 首拉空,刷新后有
  } })
  const { claims } = await provider.verifyCallbackIdToken(makeIdToken(goodClaims()), ISS, 'client-a', 'n1')
  assert.equal(claims.sub, 'sub-1')
  assert.equal(jwksCalls, 2) // 恰好强刷一次
})

test('verifyCallbackIdToken:刷新后仍 unknown-kid → throw;refreshJwks:false 不刷新直接败', async () => {
  let jwksCalls = 0
  const routes = {
    [`${ISS}/.well-known`]: () => docOf(),
    [`${ISS}/jwks`]: () => { jwksCalls++; return { keys: [] } },
  }
  const a = makeProvider({ routes })
  await assert.rejects(() => a.provider.verifyCallbackIdToken(makeIdToken(goodClaims()), ISS, 'client-a', 'n1'), /unknown-kid/)
  assert.equal(jwksCalls, 2) // 初拉 + 强刷一次
  const b = makeProvider({ routes })
  await assert.rejects(() => b.provider.verifyCallbackIdToken(makeIdToken(goodClaims()), ISS, 'client-a', 'n1', { refreshJwks: false }), /unknown-kid/)
  assert.equal(jwksCalls, 2) // false 档:沿用 a 留下的缓存(b 自身零 fetch),不再强刷
})

test('verifyCallbackIdToken:aud=clientId 校验 + nonce 比对透传(错 nonce → throw nonce)', async () => {
  const { provider } = makeProvider({ routes: {
    [`${ISS}/.well-known`]: () => docOf(),
    [`${ISS}/jwks`]: () => ({ keys: [rsaJwk] }),
  } })
  await assert.rejects(() => provider.verifyCallbackIdToken(makeIdToken(goodClaims({ nonce: 'wrong' })), ISS, 'client-a', 'n1'), /nonce/)
  await assert.rejects(() => provider.verifyCallbackIdToken(makeIdToken(goodClaims({ aud: 'other-client' })), ISS, 'client-a', 'n1'), /audience/)
})

// === 审 1-2:网络面失败编码化(不裸传 TypeError/SyntaxError 给上层分支) ===
test('网络拒绝/json() 炸 → discovery/jwks/token 编码化错误(非 TypeError 透传)', async () => {
  const code = (name) => (e) => e instanceof Error && e.message === name // 精确码(防 TypeError 透传)
  // discovery:fetch 拒绝 + json() 炸
  const netDown = createOidcProvider({ getSetting: () => null, fetchImpl: async () => { throw new TypeError('fetch failed') } })
  await assert.rejects(() => netDown.discovery(ISS), code('discovery'))
  const badJson = createOidcProvider({ getSetting: () => null, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token') } }) })
  await assert.rejects(() => badJson.discovery(ISS), code('discovery'))
  // jwks:discovery 走桩,其余(含 jwks_uri)一律网络拒绝
  const rest = createOidcProvider({
    getSetting: () => null,
    fetchImpl: async (url) => {
      if (String(url).includes('.well-known')) return { ok: true, status: 200, json: async () => docOf() }
      throw new TypeError('fetch failed')
    },
  })
  await assert.rejects(() => rest.jwksFor(ISS), code('jwks'))
  // exchange:token 端点网络拒绝
  await assert.rejects(() => rest.exchangeCode({ doc: docOf(), clientId: 'a', clientSecret: 's', redirectUri: 'u', code: 'c', codeVerifier: 'v' }), code('token'))
  // jwks 面 json() 炸同样编码化
  const badJwksJson = createOidcProvider({
    getSetting: () => null,
    fetchImpl: async (url) => {
      if (String(url).includes('.well-known')) return { ok: true, status: 200, json: async () => docOf() }
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('nope') } }
    },
  })
  await assert.rejects(() => badJwksJson.jwksFor(ISS), code('jwks'))
})
