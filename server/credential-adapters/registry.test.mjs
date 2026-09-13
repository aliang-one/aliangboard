// server/credential-adapters/registry.test.mjs
// 形状匹配矩阵 + http_request 最小版(URL 白名单/GET/注入缝)。fetchImpl 桩捕获出站请求。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { listAdapters, matchAdapter, adaptersForCredential, createHttpRequestAdapter } from './registry.mjs'

const HTTP_CRED = { fields: [{ key: 'base_url', type: 'text' }, { key: 'api_token', type: 'password' }] }
const DB_CRED   = { fields: [{ key: 'driver', type: 'text' }, { key: 'host', type: 'text' }, { key: 'port', type: 'text' },
  { key: 'user', type: 'text' }, { key: 'password', type: 'password' }, { key: 'database', type: 'text' }] }

test('形状匹配:全中/缺字段/password 型错配/大小写不敏感', () => {
  assert.deepEqual(matchAdapter('http_request', HTTP_CRED), { ok: true })
  const noToken = { fields: [{ key: 'base_url', type: 'text' }] }
  assert.equal(matchAdapter('http_request', noToken).ok, false)
  assert.ok(matchAdapter('http_request', noToken).missing.includes('api_token'))
  const textToken = { fields: [{ key: 'base_url', type: 'text' }, { key: 'api_token', type: 'text' }] }
  assert.equal(matchAdapter('http_request', textToken).ok, false, 'password 型字段必须 password')
  const lower = { fields: [{ key: 'Base_Url', type: 'text' }, { key: 'API_TOKEN', type: 'password' }] }
  assert.deepEqual(matchAdapter('http_request', lower), { ok: true }, 'key 大小写不敏感')
})

test('adaptersForCredential:正向清单(db_query 实装)', () => {
  assert.deepEqual(adaptersForCredential(HTTP_CRED), ['http_request'])
  assert.deepEqual(adaptersForCredential(DB_CRED), ['db_query'])
  assert.deepEqual(listAdapters().map(a => a.name), ['http_request', 'db_query'])
})

test('http_request 最小版:注入 Authorization/origin 白名单拒逃逸/GET 默认/结果含状态与裁剪体', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return { status: 200, headers: { get: () => 'application/json' }, text: async () => '{"ok":true,"token_leak":"ghp_should_never_return"}' }
  }
  const a = createHttpRequestAdapter({ fetchImpl })
  const out = await a.exec({
    fields: { base_url: 'https://api.github.com', api_token: 'ghp_secret' },
    args: { path: '/repos/x/y' },
  })
  assert.equal(out.status, 200)
  assert.equal(calls[0].url, 'https://api.github.com/repos/x/y')
  assert.equal(calls[0].init.headers.authorization, 'Bearer ghp_secret', '服务端组装注入')
  assert.ok(!JSON.stringify(out).includes('ghp_secret'), 'token 不出现在返回值')
  // origin 逃逸:path 以 // 开头指向其它 host
  const evil = await a.exec({ fields: { base_url: 'https://api.github.com', api_token: 't' }, args: { path: '//evil.com/x' } })
  assert.match(evil.error, /不在该凭据声明的 base_url/)
  // 非法 method(Wave B 白名单 GET/POST/PUT/DELETE/PATCH 之外)
  const bad = await a.exec({ fields: { base_url: 'https://api.github.com', api_token: 't' }, args: { path: '/x', method: 'TRACE' } })
  assert.match(bad.error, /不支持的 method/)
})

test('http_request 加固:重定向逐跳复验(同 origin 过/跨 origin 拒/超3跳拒)/headers 剥离/写方法透传 body', async () => {
  const makeRes = (status, headers, body) => ({ status, headers: { get: k => headers[k.toLowerCase()] || null, entries: () => Object.entries(headers) }, text: async () => body })
  // 同 origin 3xx → 目标 200
  let n = 0
  const sameOrigin = createHttpRequestAdapter({ fetchImpl: async () => {
    n++
    if (n === 1) return makeRes(302, { location: '/final' }, '')
    return makeRes(200, { 'content-type': 'text/plain', 'x-ratelimit-remaining': '99', 'set-cookie': 'leak=1' }, 'ok')
  } })
  const out1 = await sameOrigin.exec({ fields: { base_url: 'https://a.com', api_token: 't' }, args: { path: '/start' } })
  assert.equal(out1.status, 200); assert.equal(out1.body, 'ok')
  assert.equal(out1.headers['x-ratelimit-remaining'], '99', '白名单头透出')
  assert.equal(out1.headers['set-cookie'], undefined, '非白名单头不透出')
  // 跨 origin 跳转拒
  const cross = createHttpRequestAdapter({ fetchImpl: async () => makeRes(302, { location: 'https://evil.com/x' }, '') })
  const out2 = await cross.exec({ fields: { base_url: 'https://a.com', api_token: 't' }, args: { path: '/' } })
  assert.match(out2.error, /不在该凭据声明的 base_url/)
  // 超 3 跳
  let hops = 0
  const loop = createHttpRequestAdapter({ fetchImpl: async () => { hops++; return makeRes(302, { location: `/h${hops}` }, '') } })
  const out3 = await loop.exec({ fields: { base_url: 'https://a.com', api_token: 't' }, args: { path: '/' } })
  assert.match(out3.error, /重定向/)
  assert.equal(hops, 4, '上界语义:初始请求+3 跳后停止(不多发第 5 次)')
  // headers 剥离 + POST body
  let seen = null
  const poster = createHttpRequestAdapter({ fetchImpl: async (u, init) => { seen = { u: String(u), init }; return makeRes(201, { 'content-type': 'application/json' }, '{"id":1}') } })
  const out4 = await poster.exec({ fields: { base_url: 'https://a.com', api_token: 't' }, args: {
    path: '/things', method: 'POST', body: '{"name":"x"}', headers: { Authorization: 'Bearer fake', Cookie: 'a=b', 'X-Custom': 'ok' } } })
  assert.equal(out4.status, 201)
  assert.equal(seen.init.headers.authorization, 'Bearer t', 'AI 伪造 Authorization 被覆盖')
  assert.equal(seen.init.headers.cookie, undefined, 'Cookie 族剥离')
  assert.equal(seen.init.headers['x-custom'], 'ok', '无害自定义头保留')
  assert.equal(seen.init.body, '{"name":"x"}')
})

test('http_request 顺带清偿:base_url 协议守卫 + 字段键大小写归一注入', async () => {
  // protocol 守卫(1 行纵深):ftp:// 等非 http(s) scheme 在 fetch 前显式拒
  const proto = createHttpRequestAdapter({ fetchImpl: async () => { throw new Error('不应发起请求') } })
  const out = await proto.exec({ fields: { base_url: 'ftp://a.com', api_token: 't' }, args: { path: '/' } })
  assert.match(out.error, /协议/)
  // 字段键大小写归一:桥按存储原键(可含大写)传 fields,exec 按 manifest needs 键不敏感索引
  let seen = null
  const mixed = createHttpRequestAdapter({ fetchImpl: async (u, init) => { seen = { u: String(u), init }; return { status: 200, headers: { get: () => 'text/plain' }, text: async () => 'ok' } } })
  const out2 = await mixed.exec({ fields: { base_url: 'https://a.com', API_Token: 't' }, args: { path: '/' } })
  assert.equal(out2.status, 200)
  assert.equal(seen.init.headers.authorization, 'Bearer t', '存储 API_Token 大写键仍按 needs 键归一注入')
})

test('http_request 跨边界秘密加固:先 mask 后 truncate(半截 JWT 不外泄)', async () => {
  // T7 审查修复回归钉:响应体含跨 32KB 边界的 JWT,截断若先行会把 JWT 切成两段式半截,
  // mask 正则(须三段结构)不再命中 → 半截秘密直达 LLM。修复后先整体 mask 再裁剪。
  const BODY_MAX = 32768
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  // JWT 起点 32719 < 32768 < JWT 终点:跨界(前后留空格/换行保 \b 可命中);后缀保证 mask 后仍超 BODY_MAX(截断路径真实触发)
  const text = 'a'.repeat(BODY_MAX - 50) + ' ' + jwt + '\n' + 'b'.repeat(300)
  const a = createHttpRequestAdapter({ fetchImpl: async () => ({ status: 200, headers: { get: () => 'text/plain' }, text: async () => text }) })
  const out = await a.exec({ fields: { base_url: 'https://a.com', api_token: 't' }, args: { path: '/big' } })
  assert.ok(out.body.includes('截断'), '脱敏后仍超限,截断路径真实触发')
  assert.ok(!out.body.includes('eyJhbGciOiJIUzI1NiIs'), '跨边界 JWT 不留半截头部')
  assert.ok(!out.body.includes('eyJzdWIiOiIxMjM0NTY3ODkw'), '跨边界 JWT 不留半截载荷')
  assert.ok(!out.body.includes('SflKxwRJSMeKKF2QT'), '跨边界 JWT 不留半截签名')
})
