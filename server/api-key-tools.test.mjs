// T8 测试:walking skeleton 端到端链(requestFn mock,无需真集群)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { _setAllowedHostsForTest } from './call-context.mjs'
import { createApiKeysSchema, mintKey } from './auth-keys.mjs'
import { createAuditSchema, verifyChain } from './audit.mjs'
import { _clearSaTokenCacheForTest } from './sa-binding.mjs'
import { resolveApiKey, createApiKeyTools, _clearIssuerCacheForTest } from './api-key-tools.mjs'

_setAllowedHostsForTest(new Set()) // 测试不受部署环境 K8S_ALLOWED_HOSTS 影响

function makeDb() {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db); createAuditSchema(db)
  _clearSaTokenCacheForTest(); _clearIssuerCacheForTest() // 模块级缓存是进程级单例,测试间清空防泄漏
  return db
}
const cluster = { id: 'c1', apiServer: 'https://10.0.0.1:6443', authHeader: 'Bearer admin', ca: null, cert: null, key: null, insecure: true }
// mock requestFn:issuer / token / log 三条路径
function mockRequestFn({ logBody = 'line1\nline2\nline3' } = {}) {
  return async (ctx, path) => {
    if (path === '/.well-known/openid-configuration') return { body: { issuer: 'https://kubernetes.default.svc.cluster.local' } }
    if (path.endsWith('/token')) return { body: { status: { token: 'SA-TOKEN', expirationTimestamp: new Date(Date.now() + 600000).toISOString() } } }
    if (path.includes('/log')) return { body: logBody }
    throw new Error('mock: unexpected path ' + path)
  }
}

test('happy: read key → 返回日志 + 审计 started→finalized(ok) + 链有效', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.getPodLogs(k, cluster, { namespace: 'ns', pod: 'p1', container: 'c', tail: 100 })
  assert.match(out.logs, /line1/)
  assert.equal(out.tail, 100)
  const rows = db.prepare('SELECT status, result FROM audit_log ORDER BY seq').all()
  assert.equal(rows.length, 2, 'started + finalized 两行')
  assert.equal(rows[0].status, 'started'); assert.equal(rows[0].result, null)
  assert.equal(rows[1].status, 'finalized'); assert.equal(rows[1].result, 'ok')
  assert.equal(verifyChain(db).valid, true)
})

test('deny(authorize): bogus tier → PERMISSION_DENIED(policy) + 审计 denied(一行)', async () => {
  const db = makeDb()
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const bogusKey = { id: 'k1', owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'bogus' }
  await assert.rejects(
    () => tools.getPodLogs(bogusKey, cluster, { namespace: 'ns', pod: 'p1' }),
    (e) => { assert.equal(e.code, 'PERMISSION_DENIED'); assert.equal(e.reason, 'policy'); return true })
  const rows = db.prepare('SELECT result, reason FROM audit_log').all()
  assert.equal(rows.length, 1); assert.equal(rows[0].result, 'denied'); assert.equal(rows[0].reason, 'policy')
})

test('deny(namespace): 请求 ns ≠ 绑定 SA 的 ns → policy 拒 + 审计', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(
    () => tools.getPodLogs(k, cluster, { namespace: 'other-ns', pod: 'p1' }),
    (e) => { assert.equal(e.reason, 'policy'); return true })
  const rows = db.prepare('SELECT result FROM audit_log').all()
  assert.equal(rows[0].result, 'denied')
})

test('error: kube 调用失败 → 审计 error + 重抛(status 透传)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const rf = async (ctx, path) => {
    if (path === '/.well-known/openid-configuration') return { body: { issuer: 'iss' } }
    if (path.endsWith('/token')) return { body: { status: { token: 'T', expirationTimestamp: new Date(Date.now() + 600000).toISOString() } } }
    throw Object.assign(new Error('forbidden'), { status: 403 })
  }
  const tools = createApiKeyTools({ db, requestFn: rf })
  await assert.rejects(() => tools.getPodLogs(k, cluster, { namespace: 'ns', pod: 'p1' }), (e) => e.status === 403)
  const rows = db.prepare('SELECT result, reason FROM audit_log ORDER BY seq').all()
  assert.equal(rows[rows.length - 1].result, 'error')
  assert.match(rows[rows.length - 1].reason, /http403/)
})

test('error: bootstrap 凭据无法签 token(TokenRequest 无 token)→ 审计 error', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const rf = async (ctx, path) => {
    if (path === '/.well-known/openid-configuration') return { body: { issuer: 'iss' } }
    if (path.endsWith('/token')) return { body: { status: {} } } // 无 token(bootstrap 无 create serviceaccounts/token)
    throw new Error('x')
  }
  const tools = createApiKeyTools({ db, requestFn: rf })
  await assert.rejects(() => tools.getPodLogs(k, cluster, { namespace: 'ns', pod: 'p1' }), /未返回 token/)
  const rows = db.prepare('SELECT result FROM audit_log ORDER BY seq').all()
  assert.equal(rows[rows.length - 1].result, 'error')
})

test('resolveApiKey: 有效 key 返回 row;错误/空/吊销 → null', () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  assert.ok(resolveApiKey(db, { headers: { authorization: `Bearer ${k.plaintext}` } }))
  assert.equal(resolveApiKey(db, { headers: { authorization: 'Bearer wrong' } }), null)
  assert.equal(resolveApiKey(db, { headers: {} }), null)
})
