// T8/T9 测试:walking skeleton + 有界原语(requestFn mock,无需真集群)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { _setAllowedHostsForTest } from './call-context.mjs'
import { createApiKeysSchema, mintKey } from './auth-keys.mjs'
import { createAuditSchema, verifyChain } from './audit.mjs'
import { _clearSaTokenCacheForTest } from './sa-binding.mjs'
import { resolveApiKey, createApiKeyTools, _clearIssuerCacheForTest } from './api-key-tools.mjs'

_setAllowedHostsForTest(new Set())

function makeDb() {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db); createAuditSchema(db)
  _clearSaTokenCacheForTest(); _clearIssuerCacheForTest()
  return db
}
const cluster = { id: 'c1', apiServer: 'https://10.0.0.1:6443', authHeader: 'Bearer admin', ca: null, cert: null, key: null, insecure: true }

// mock requestFn:覆盖 issuer / token / log / list / get / events
function mockRequestFn({ logBody = 'line1\nline2\nline3' } = {}) {
  return async (ctx, path, init = {}) => {
    if (init.method === 'PATCH' && path.endsWith('/scale')) return { body: { spec: { replicas: JSON.parse(init.body).spec.replicas } } }
    if (init.method === 'PATCH') return { body: { ok: true } } // restart 等 PATCH
    if (path === '/.well-known/openid-configuration') return { body: { issuer: 'https://kubernetes.default.svc.cluster.local' } }
    if (path.endsWith('/token')) return { body: { status: { token: 'SA-TOKEN', expirationTimestamp: new Date(Date.now() + 600000).toISOString() } } }
    if (path.includes('/log')) return { body: logBody }
    if (/\/namespaces\/[^/]+\/pods$/.test(path)) return { body: { items: [{ metadata: { name: 'p1' }, status: { phase: 'Running', containerStatuses: [{ name: 'c1', ready: true }] } }, { metadata: { name: 'p2' }, status: { phase: 'Pending' } }] } }
    if (/\/namespaces\/[^/]+\/deployments$/.test(path)) return { body: { items: [{ metadata: { name: 'd1' }, spec: { replicas: 2 }, status: { readyReplicas: 2, updatedReplicas: 2 } }] } }
    if (/\/namespaces\/[^/]+\/pods\/[^/]+$/.test(path)) return { body: { metadata: { name: 'p1', managedFields: [{ x: 1 }] }, status: { phase: 'Running' } } }
    if (/\/namespaces\/[^/]+\/events/.test(path)) return { body: { items: [{ reason: 'BackOff', type: 'Warning', message: 'x'.repeat(400), lastTimestamp: '2026-01-01T00:00:00Z' }] } }
    throw new Error('mock: unexpected path ' + path)
  }
}

// --- get_pod_logs(回归,经 runBoundedTool 重构后仍通)---
test('get_pod_logs(happy): 返回日志 + 审计 started→finalized(ok)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.getPodLogs(k, cluster, { namespace: 'ns', pod: 'p1', tail: 100 })
  assert.match(out.logs, /line1/)
  assert.equal(out.truncated, false)
  const rows = db.prepare('SELECT status, result FROM audit_log ORDER BY seq').all()
  assert.equal(rows[0].status, 'started'); assert.equal(rows[1].result, 'ok')
  assert.equal(verifyChain(db).valid, true)
})
test('get_pod_logs(字节上限 codex #11): 巨大日志被截到 LOG_BYTE_MAX + truncated 标志', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const bigLog = 'x'.repeat(50000) // 50KB > 32KB 上限
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn({ logBody: bigLog }) })
  const out = await tools.getPodLogs(k, cluster, { namespace: 'ns', pod: 'p1', tail: 10 })
  assert.equal(out.truncated, true)
  assert.ok(out.originalBytes >= 50000, 'originalBytes 记原始大小')
  assert.ok(Buffer.byteLength(out.logs) <= 32768 + 4, '截断后 logs 不超上限(+4 容忍多字节尾巴)')
})

test('deny: bogus tier → policy 拒 + 审计 denied', async () => {
  const db = makeDb()
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const bogus = { id: 'k1', owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'bogus' }
  await assert.rejects(() => tools.getPodLogs(bogus, cluster, { namespace: 'ns', pod: 'p1' }), (e) => e.reason === 'policy')
  assert.equal(db.prepare('SELECT result FROM audit_log').get().result, 'denied')
})

test('deny(ns): 请求 ns ≠ 绑定 ns → policy 拒', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(() => tools.getPodLogs(k, cluster, { namespace: 'other', pod: 'p1' }), (e) => e.reason === 'policy')
})

// --- list_resources ---
test('list_resources(pods): 返回 slim 名单(name/phase/ready),capped', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'list_resources', { kind: 'pods', namespace: 'ns' })
  assert.equal(out.kind, 'pods'); assert.equal(out.count, 2)
  assert.equal(out.items[0].name, 'p1'); assert.equal(out.items[0].phase, 'Running')
  assert.deepEqual(out.items[0].ready, [{ name: 'c1', ready: true }])
  assert.equal(out.items[1].phase, 'Pending')
})
test('list_resources(deployments): slimWorkload(ready/desired/updated)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'list_resources', { kind: 'deployments', namespace: 'ns' })
  assert.deepEqual(out.items[0], { name: 'd1', ready: 2, desired: 2, updated: 2 })
})
test('list_resources(unsupported kind): policy 拒', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(() => tools.callTool(k, cluster, 'list_resources', { kind: 'ingresses', namespace: 'ns' }), (e) => e.reason === 'policy')
})

// --- get_resource ---
test('get_resource: 返回对象,managedFields 被去噪', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'get_resource', { kind: 'pods', namespace: 'ns', name: 'p1' })
  assert.equal(out.resource.metadata.name, 'p1')
  assert.ok(!('managedFields' in out.resource.metadata), 'managedFields 应被去除')
})

// --- get_events ---
test('get_events: 返回 slim 事件(reason/type/message 截断/last)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'get_events', { namespace: 'ns', name: 'p1' })
  assert.equal(out.items[0].reason, 'BackOff')
  assert.ok(out.items[0].message.length <= 300, 'message 应截断到 300')
})

// --- callTool 派发 ---
test('callTool: 未知工具 → policy 拒', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(() => tools.callTool(k, cluster, 'exec_pod', {}), (e) => { assert.equal(e.reason, 'policy'); return true })
})

test('listTools: 返回注册的工具集', () => {
  const db = makeDb()
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const names = tools.listTools()
  for (const t of ['get_pod_logs', 'list_resources', 'get_resource', 'get_events', 'scale', 'restart']) assert.ok(names.includes(t), `应含 ${t}`)
})

// --- scale / restart(有界写,operator+)---
test('scale(operator happy): PATCH scale 子资源,replicas 透传', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'operator' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'scale', { kind: 'deployments', namespace: 'ns', name: 'd1', replicas: 3 })
  assert.equal(out.replicas, 3); assert.equal(out.kind, 'deployments')
})
test('scale: cap 违规(0 / 99)→ 拒;read 档 → policy 拒(authorize 先于 cap)', async () => {
  const db = makeDb()
  const op = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'operator' })
  const read = mintKey(db, { owner: 'b', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(() => tools.callTool(op, cluster, 'scale', { kind: 'deployments', namespace: 'ns', name: 'd1', replicas: 0 }), /1\.\.20/)
  await assert.rejects(() => tools.callTool(op, cluster, 'scale', { kind: 'deployments', namespace: 'ns', name: 'd1', replicas: 99 }), /1\.\.20/)
  // read 档:authorize 先拒(policy),不到 cap
  await assert.rejects(() => tools.callTool(read, cluster, 'scale', { kind: 'deployments', namespace: 'ns', name: 'd1', replicas: 3 }), (e) => e.reason === 'policy')
})
test('restart(operator happy): PATCH template annotation,返回 restartedAt', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'operator' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'restart', { kind: 'deployments', namespace: 'ns', name: 'd1' })
  assert.equal(out.name, 'd1'); assert.ok(out.restartedAt)
})
test('scale/restart: read 档均 policy 拒', async () => {
  const db = makeDb()
  const read = mintKey(db, { owner: 'b', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(() => tools.callTool(read, cluster, 'restart', { kind: 'deployments', namespace: 'ns', name: 'd1' }), (e) => e.reason === 'policy')
})

// --- resolveApiKey ---
test('resolveApiKey: 有效→row;错误/空→null', () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  assert.ok(resolveApiKey(db, { headers: { authorization: `Bearer ${k.plaintext}` } }))
  assert.equal(resolveApiKey(db, { headers: { authorization: 'Bearer wrong' } }), null)
  assert.equal(resolveApiKey(db, { headers: {} }), null)
})
