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

// mock requestFn:覆盖 issuer / token / log / list / get / events / Deployment 单体 / ReplicaSet 列表(rollout 用)
function mockRequestFn({ logBody = 'line1\nline2\nline3', deployment = null, replicasets = null } = {}) {
  return async (ctx, path, init = {}) => {
    if (init.method === 'PATCH' && path.endsWith('/scale')) return { body: { spec: { replicas: JSON.parse(init.body).spec.replicas } } }
    if (init.method === 'PATCH') return { body: { ok: true } } // restart 等 PATCH
    if (init.method === 'DELETE') return { body: { kind: 'Status', status: 'Success' } }
    if (path === '/.well-known/openid-configuration') return { body: { issuer: 'https://kubernetes.default.svc.cluster.local' } }
    if (path.endsWith('/token')) return { body: { status: { token: 'SA-TOKEN', expirationTimestamp: new Date(Date.now() + 600000).toISOString() } } }
    if (path.includes('/log')) return { body: logBody }
    if (/\/namespaces\/[^/]+\/pods$/.test(path)) return { body: { items: [{ metadata: { name: 'p1' }, status: { phase: 'Running', containerStatuses: [{ name: 'c1', ready: true }] } }, { metadata: { name: 'p2' }, status: { phase: 'Pending' } }] } }
    if (/\/namespaces\/[^/]+\/deployments$/.test(path)) return { body: { items: [{ metadata: { name: 'd1' }, spec: { replicas: 2 }, status: { readyReplicas: 2, updatedReplicas: 2 } }] } }
    if (/\/namespaces\/[^/]+\/pods\/[^/]+$/.test(path)) return { body: { metadata: { name: 'p1', managedFields: [{ x: 1 }] }, status: { phase: 'Running' } } }
    if (/\/namespaces\/[^/]+\/events/.test(path)) return { body: { items: [{ reason: 'BackOff', type: 'Warning', message: 'x'.repeat(400), lastTimestamp: '2026-01-01T00:00:00Z' }] } }
    // --- 新增:Deployment 单体 GET(非 PATCH)+ ReplicaSet 列表(rollout 用)---
    if (init.method !== 'PATCH' && /\/namespaces\/[^/]+\/deployments\/[^/]+$/.test(path)) return { body: deployment || {
      metadata: { name: 'd1', uid: 'uid-d1', annotations: { 'deployment.kubernetes.io/revision': '2' } },
      spec: { template: { spec: { containers: [{ name: 'c1', image: 'img:2' }] } } } } }
    if (/\/namespaces\/[^/]+\/replicasets$/.test(path)) return { body: { items: replicasets || [
      { metadata: { name: 'd1-rs2', uid: 'rs2', ownerReferences: [{ uid: 'uid-d1', kind: 'Deployment', controller: true }], annotations: { 'deployment.kubernetes.io/revision': '2' }, creationTimestamp: '2026-08-06T02:00:00Z' }, spec: { template: { spec: { containers: [{ name: 'c1', image: 'img:2' }] } } } },
      { metadata: { name: 'd1-rs1', uid: 'rs1', ownerReferences: [{ uid: 'uid-d1', kind: 'Deployment', controller: true }], annotations: { 'deployment.kubernetes.io/revision': '1' }, creationTimestamp: '2026-08-06T01:00:00Z' }, spec: { template: { spec: { containers: [{ name: 'c1', image: 'img:1' }] } } } },
    ] } }
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

// --- exec_pod(DANGEROUS,admin 档;第一个接通的 stub,做后续 stub 的模板)---
test('exec_pod(deny): read 档 → policy 拒(exec_pod 是 admin 档)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' }) // tier 默认 read
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), execFn: async () => { throw new Error('execFn 不应被调') } })
  await assert.rejects(
    tools.callTool(k, cluster, 'exec_pod', { namespace: 'ns', pod: 'p1', command: 'ls' }),
    (e) => e.code === 'PERMISSION_DENIED',
  )
})

test('exec_pod(admin happy): 走 runBoundedTool 全链(SA token)→ execFn(saCtx,...) 被调,返 stdout + 审计 ok', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  let called = null
  const execFn = async (saCtx, ns, pod, container, command) => { called = { ns, pod, container, command, authHeader: saCtx.authHeader }; return { stdout: Buffer.from('total 0\n'), stderr: '', status: 0 } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), execFn })
  const out = await tools.callTool(k, cluster, 'exec_pod', { namespace: 'ns', pod: 'p1', container: 'c1', command: 'ls -la' })
  assert.equal(called.ns, 'ns'); assert.equal(called.pod, 'p1'); assert.equal(called.command, 'ls -la')
  assert.ok(called.authHeader?.startsWith('Bearer '), 'execFn 拿到 SA-token ctx')
  assert.equal(out.stdout, 'total 0\n')
  assert.equal(out.exitCode, 0)
  const rows = db.prepare('SELECT result FROM audit_log ORDER BY seq').all()
  assert.equal(rows[rows.length - 1].result, 'ok')
})

test('browse_files/read_file/apply_yaml(deny): read 档全拒(admin 档工具)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), execFn: async () => ({ stdout: Buffer.from(''), stderr: '' }), applyYamlFn: async () => ({ applied: [], failed: [], total: 0 }) })
  for (const t of ['browse_files', 'read_file', 'apply_yaml']) {
    await assert.rejects(tools.callTool(k, cluster, t, { namespace: 'ns', pod: 'p1', path: '/x', yaml: 'a: b' }), (e) => e.code === 'PERMISSION_DENIED', `${t} 应被 read 档拒`)
  }
})

test('apply_yaml(admin happy): 走全链 → applyYamlFn(saCtx, yaml) 被调,返 {applied,failed}', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  let called = null
  const applyYamlFn = async (saCtx, yaml) => { called = { yaml, authHeader: saCtx.authHeader }; return { applied: [{ kind: 'ConfigMap', name: 'cm' }], failed: [], total: 1 } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), applyYamlFn })
  const out = await tools.callTool(k, cluster, 'apply_yaml', { yaml: 'apiVersion: v1\nkind: ConfigMap' })
  assert.ok(called.yaml.includes('ConfigMap'))
  assert.ok(called.authHeader?.startsWith('Bearer '), 'SA-token ctx')
  assert.equal(out.applied.length, 1)
  assert.equal(out.total, 1)
})

test('delete_resource(admin happy): DELETE path → requestFn called, 返 {deleted} + 审计 ok', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'delete_resource', { namespace: 'ns', path: '/api/v1/namespaces/ns/pods/p1' })
  assert.equal(out.deleted, '/api/v1/namespaces/ns/pods/p1')
  const rows = db.prepare('SELECT result FROM audit_log ORDER BY seq').all()
  assert.equal(rows[rows.length - 1].result, 'ok')
})

// --- rollout_history(read 档:列 ReplicaSet revisions)---
test('rollout_history(read happy): 列 revisions,降序,current 标记', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'rollout_history', { namespace: 'ns', name: 'd1' })
  assert.equal(out.deployment, 'd1')
  assert.equal(out.currentRevision, '2')
  assert.equal(out.revisions.length, 2)
  assert.equal(out.revisions[0].revision, '2', '降序')
  assert.equal(out.revisions[0].current, true)
  assert.equal(out.revisions[1].revision, '1')
  assert.equal(out.revisions[1].image, 'img:1')
})
test('rollout_history: 只列该 Deployment 的 RS(ownerReference 过滤)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const otherRs = { metadata: { name: 'other-rs', ownerReferences: [{ uid: 'uid-other', kind: 'Deployment', controller: true }], annotations: { 'deployment.kubernetes.io/revision': '5' } }, spec: { template: { spec: { containers: [{ name: 'x', image: 'x' }] } } } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn({ replicasets: [otherRs] }) })
  const out = await tools.callTool(k, cluster, 'rollout_history', { namespace: 'ns', name: 'd1' })
  assert.equal(out.revisions.length, 0, '不属于 d1 的 RS 被过滤')
})
