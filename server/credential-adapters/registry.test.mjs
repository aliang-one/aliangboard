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

test('adaptersForCredential:正向清单(db_query 未实装时不出现)', () => {
  assert.deepEqual(adaptersForCredential(HTTP_CRED), ['http_request'])
  assert.deepEqual(adaptersForCredential(DB_CRED), [], 'db_query Wave C 前不匹配任何适配器')
  assert.deepEqual(listAdapters().map(a => a.name), ['http_request'])
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
  // 非法 method(Wave A 白名单只 GET)
  const bad = await a.exec({ fields: { base_url: 'https://api.github.com', api_token: 't' }, args: { path: '/x', method: 'POST' } })
  assert.match(bad.error, /仅支持 GET/)
})
