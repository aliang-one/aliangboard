// T8/T9 测试:walking skeleton + 有界原语(requestFn mock,无需真集群)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { _setAllowedHostsForTest } from './call-context.mjs'
import { createApiKeysSchema, mintKey } from './auth-keys.mjs'
import { createAuditSchema, verifyChain } from './audit.mjs'
import { _clearSaTokenCacheForTest } from './sa-binding.mjs'
import { resolveApiKey, createApiKeyTools, _clearIssuerCacheForTest, assertPathInNs } from './api-key-tools.mjs'

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

test('deny(ns): 请求 ns ≠ 绑定 ns → policy 拒,detail 命名请求 ns + 允许集 + 指向配置', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(() => tools.getPodLogs(k, cluster, { namespace: 'other', pod: 'p1' }), (e) =>
    e.reason === 'policy' && /'other'/.test(e.detail) && /ns/.test(e.detail) && /API Keys/.test(e.detail))
})

test('deny(tier): 工具不在 tier 允许集 → policy 拒,detail 指出工具 + 配置位置', async () => {
  const db = makeDb()
  const read = mintKey(db, { owner: 'b', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), execFn: async () => ({ stdout: '', stderr: '' }) })
  await assert.rejects(tools.callTool(read, cluster, 'exec_pod', { namespace: 'ns', pod: 'p1', command: 'ls' }), (e) =>
    e.reason === 'policy' && /exec_pod/.test(e.detail) && /API Keys/.test(e.detail))
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
  const out = await tools.callTool(k, cluster, 'apply_yaml', { yaml: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n  namespace: ns' })
  assert.ok(called.yaml.includes('ConfigMap'))
  assert.ok(called.authHeader?.startsWith('Bearer '), 'SA-token ctx')
  assert.equal(out.applied.length, 1)
  assert.equal(out.total, 1)
})
test('apply_yaml: YAML metadata.namespace ∉ 允许集 → policy 拒(跨 ns 闸门;applyYamlFn 不应被调)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  let applied = false
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), applyYamlFn: async () => { applied = true; return { applied: [], failed: [], total: 0 } } })
  const yaml = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n  namespace: other'
  await assert.rejects(
    tools.callTool(k, cluster, 'apply_yaml', { yaml }),
    (e) => e.code === 'PERMISSION_DENIED' && e.reason === 'policy' && /命名空间 'other'/.test(e.detail),
  )
  assert.equal(applied, false, '跨 ns 时 applyYamlFn 不应被调')
})
test('apply_yaml: 对象缺 metadata.namespace → policy 拒(防集群级 / 落 default 越权)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  let applied = false
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), applyYamlFn: async () => { applied = true; return { applied: [], failed: [], total: 0 } } })
  const yaml = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm'
  await assert.rejects(
    tools.callTool(k, cluster, 'apply_yaml', { yaml }),
    (e) => e.code === 'PERMISSION_DENIED' && e.reason === 'policy' && /metadata\.namespace/.test(e.detail),
  )
  assert.equal(applied, false, '缺 ns 时 applyYamlFn 不应被调')
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

// --- rollout_undo(admin 档:回滚到 revision)---
test('rollout_undo(admin happy): PATCH deployment template 成目标 RS template', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  let patched = null
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (init.method === 'PATCH' && /\/deployments\/[^/]+$/.test(path)) { patched = JSON.parse(init.body); return { body: { ok: true } } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'rollout_undo', { namespace: 'ns', name: 'd1', toRevision: 1 })
  assert.equal(out.undone, 'd1'); assert.equal(out.toRevision, 1)
  assert.equal(out.previousImage, 'img:2'); assert.equal(out.newImage, 'img:1')
  assert.deepEqual(patched, { spec: { template: { spec: { containers: [{ name: 'c1', image: 'img:1' }] } } } }, 'PATCH 成 revision1 的 template')
  const rows = db.prepare('SELECT result FROM audit_log ORDER BY seq').all()
  assert.equal(rows[rows.length - 1].result, 'ok')
})
test('rollout_undo: 缺 toRevision → 报错;revision 不存在 → 报错;read 档 → policy 拒', async () => {
  const db = makeDb()
  const admin = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  const read = mintKey(db, { owner: 'b', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(admin, cluster, 'rollout_undo', { namespace: 'ns', name: 'd1' }), /toRevision/)
  await assert.rejects(tools.callTool(admin, cluster, 'rollout_undo', { namespace: 'ns', name: 'd1', toRevision: 99 }), /不存在/)
  await assert.rejects(tools.callTool(read, cluster, 'rollout_undo', { namespace: 'ns', name: 'd1', toRevision: 1 }), (e) => e.reason === 'policy')
})
test('rollout_undo: 按 ownerReference 过滤 RS,防跨 Deployment 回滚串台(回归)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  // 外来 RS:同样 revision '1',但 ownerReferences 指向另一个 Deployment(uid-other),镜像为 FOREIGN
  const foreignRs = { metadata: { name: 'other-rs', ownerReferences: [{ uid: 'uid-other', kind: 'Deployment', controller: true }], annotations: { 'deployment.kubernetes.io/revision': '1' } }, spec: { template: { spec: { containers: [{ name: 'cx', image: 'FOREIGN' }] } } } }
  // 本 Deployment 的 RS:revision '1',ownerReferences 指向 uid-d1
  const ownedRs = { metadata: { name: 'd1-rs1', ownerReferences: [{ uid: 'uid-d1', kind: 'Deployment', controller: true }], annotations: { 'deployment.kubernetes.io/revision': '1' } }, spec: { template: { spec: { containers: [{ name: 'c1', image: 'img:1' }] } } } }
  let patched = null
  const base = mockRequestFn({ replicasets: [foreignRs, ownedRs] })
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (init.method === 'PATCH' && /\/deployments\/[^/]+$/.test(path)) { patched = JSON.parse(init.body); return { body: { ok: true } } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'rollout_undo', { namespace: 'ns', name: 'd1', toRevision: 1 })
  assert.equal(out.newImage, 'img:1', '用本 Deployment 的 RS,不是外来 RS')
  assert.deepEqual(patched, { spec: { template: { spec: { containers: [{ name: 'c1', image: 'img:1' }] } } } }, 'PATCH 成 owned RS 的 template,而非 FOREIGN')
})
test('rollout_undo: revision 仅存在于外来 RS → 报"不存在"(ownerReference 过滤回归)', async () => {
  const db = makeDb()
  const admin = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  const foreignRs = { metadata: { name: 'other-rs', ownerReferences: [{ uid: 'uid-other', kind: 'Deployment', controller: true }], annotations: { 'deployment.kubernetes.io/revision': '3' } }, spec: { template: { spec: { containers: [{ name: 'cx', image: 'FOREIGN' }] } } } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn({ replicasets: [foreignRs] }) })
  await assert.rejects(tools.callTool(admin, cluster, 'rollout_undo', { namespace: 'ns', name: 'd1', toRevision: 3 }), /不存在/, '外来 RS 的 revision 不应被视为可用')
})

// --- update_image(admin 档:set image)---
test('update_image(admin happy): PATCH 容器镜像,返 previous/new', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  let patched = null
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (init.method === 'PATCH' && /\/deployments\/[^/]+$/.test(path)) { patched = JSON.parse(init.body); return { body: { ok: true } } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'update_image', { namespace: 'ns', kind: 'deployments', name: 'd1', container: 'c1', image: 'img:9' })
  assert.equal(out.newImage, 'img:9'); assert.equal(out.previousImage, 'img:2')
  assert.deepEqual(patched, { spec: { template: { spec: { containers: [{ name: 'c1', image: 'img:9' }] } } } })
})
test('update_image: 不支持 kind / 容器不存在 → 报错;read 档 → policy 拒', async () => {
  const db = makeDb()
  const admin = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  const read = mintKey(db, { owner: 'b', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(admin, cluster, 'update_image', { namespace: 'ns', kind: 'ingresses', name: 'x', container: 'c', image: 'i' }), /仅支持/)
  await assert.rejects(tools.callTool(admin, cluster, 'update_image', { namespace: 'ns', kind: 'deployments', name: 'd1', container: 'nope', image: 'i' }), /不存在/)
  await assert.rejects(tools.callTool(read, cluster, 'update_image', { namespace: 'ns', kind: 'deployments', name: 'd1', container: 'c1', image: 'i' }), (e) => e.reason === 'policy')
})

// --- source 透传到 audit ---
test('callTool source: 传入 mcp → audit 行 source=mcp', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await tools.callTool(k, cluster, 'list_resources', { kind: 'pods', namespace: 'ns' }, 'mcp')
  const row = db.prepare('SELECT source FROM audit_log ORDER BY seq DESC LIMIT 1').get()
  assert.equal(row.source, 'mcp')
})
test('callTool source: 默认 direct', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await tools.callTool(k, cluster, 'list_resources', { kind: 'pods', namespace: 'ns' })
  assert.equal(db.prepare('SELECT source FROM audit_log ORDER BY seq DESC LIMIT 1').get().source, 'direct')
})

// --- assertPathInNs(ns 作用域按 path 解析;allowedNs 为 Set 来自 effectiveNamespaces)---
test('assertPathInNs: 集群级 path(无 /namespaces/<x>/)→ 拒', () => {
  assert.throws(() => assertPathInNs('/api/v1/persistentvolumes/pv1', new Set(['ns'])), (e) => e.code === 'PERMISSION_DENIED' && e.reason === 'policy' && /集群级/.test(e.detail))
  assert.throws(() => assertPathInNs('/apis/rbac.authorization.k8s.io/v1/clusterroles/admin', new Set(['ns'])), (e) => e.code === 'PERMISSION_DENIED' && /集群级/.test(e.detail))
})
test('assertPathInNs: 他 ns path → 拒(不在允许集)', () => {
  assert.throws(() => assertPathInNs('/api/v1/namespaces/other/pods/p1', new Set(['ns'])), (e) => e.code === 'PERMISSION_DENIED' && /命名空间 'other' 不在该 key 允许的 namespace 集/.test(e.detail))
})
test('assertPathInNs: 允许集内 ns path → 通过', () => {
  assert.doesNotThrow(() => assertPathInNs('/apis/networking.k8s.io/v1/namespaces/ns/ingresses/foo', new Set(['ns'])))
  assert.doesNotThrow(() => assertPathInNs('/api/v1/namespaces/ns/pods/p1', new Set(['ns'])))
  // 跨 ns:多元素 Set 中任意 ns 均放行
  assert.doesNotThrow(() => assertPathInNs('/api/v1/namespaces/dev/pods/p1', new Set(['ns', 'dev'])))
})

// --- delete_resource 收紧(path-ns 校验)---
test('delete_resource: path ns ≠ 绑定 ns → policy 拒(assertPathInNs)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(
    tools.callTool(k, cluster, 'delete_resource', { namespace: 'ns', path: '/api/v1/namespaces/other/pods/p1' }),
    (e) => e.code === 'PERMISSION_DENIED' && e.reason === 'policy',
  )
})
test('delete_resource: 集群级 path → policy 拒', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(
    tools.callTool(k, cluster, 'delete_resource', { namespace: 'ns', path: '/api/v1/persistentvolumes/pv1' }),
    (e) => e.reason === 'policy',
  )
})

// --- get_resource_yaml(path-based,任意 kind/CRD)---
test('get_resource_yaml: path GET → YAML + managedFields 去噪;read 档可调', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (!init.method && /\/ingresses\/foo$/.test(path)) return { body: { kind: 'Ingress', apiVersion: 'networking.k8s.io/v1', metadata: { name: 'foo', managedFields: [{ x: 1 }] }, spec: { rules: [] } } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'get_resource_yaml', { namespace: 'ns', path: '/apis/networking.k8s.io/v1/namespaces/ns/ingresses/foo' })
  assert.equal(out.kind, 'Ingress'); assert.equal(out.name, 'foo'); assert.equal(out.apiVersion, 'networking.k8s.io/v1')
  assert.match(out.yaml, /kind: Ingress/); assert.doesNotMatch(out.yaml, /managedFields/)
  assert.equal(out.truncated, false)
})
test('get_resource_yaml: 大对象截 32KB + truncated + originalBytes', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const big = { kind: 'ConfigMap', apiVersion: 'v1', metadata: { name: 'big' }, data: { blob: 'x'.repeat(60000) } }
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (!init.method && /\/configmaps\/big$/.test(path)) return { body: big }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'get_resource_yaml', { namespace: 'ns', path: '/api/v1/namespaces/ns/configmaps/big' })
  assert.equal(out.truncated, true)
  assert.ok(out.originalBytes > 32768, 'originalBytes 记原始大小')
  assert.ok(Buffer.byteLength(out.yaml, 'utf8') <= 32768 + 4, '截断后 yaml 不超上限')
})
test('get_resource_yaml: path ns 不符 / 集群级 → policy 拒', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(k, cluster, 'get_resource_yaml', { namespace: 'ns', path: '/api/v1/namespaces/other/pods/p1' }), (e) => e.reason === 'policy')
  await assert.rejects(tools.callTool(k, cluster, 'get_resource_yaml', { namespace: 'ns', path: '/api/v1/persistentvolumes/pv1' }), (e) => e.reason === 'policy')
})
test('get_resource_yaml: 缺 path → 报错', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(k, cluster, 'get_resource_yaml', { namespace: 'ns' }), /缺 path/)
})

// --- list_resources(path 模式:任意 kind)---
test('list_resources(path): 列任意 kind,slim 项含 path 便于 get_resource_yaml', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (/\/namespaces\/[^/]+\/ingresses$/.test(path)) return { body: { items: [
      { kind: 'Ingress', apiVersion: 'networking.k8s.io/v1', metadata: { name: 'foo' } },
      { kind: 'Ingress', apiVersion: 'networking.k8s.io/v1', metadata: { name: 'bar' } },
    ] } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'list_resources', { namespace: 'ns', path: '/apis/networking.k8s.io/v1/namespaces/ns/ingresses' })
  assert.equal(out.kind, '(path)'); assert.equal(out.count, 2); assert.equal(out.returned, 2)
  assert.equal(out.items[0].name, 'foo'); assert.equal(out.items[0].kind, 'Ingress')
  assert.match(out.items[0].path, /\/namespaces\/ns\/ingresses\/foo$/)
})
test('list_resources(path): path ns 不符 → policy 拒', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(k, cluster, 'list_resources', { namespace: 'ns', path: '/apis/networking.k8s.io/v1/namespaces/other/ingresses' }), (e) => e.reason === 'policy')
})
test('list_resources(kind): 既有 6-kind 快捷回归(pods)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'list_resources', { kind: 'pods', namespace: 'ns' })
  assert.equal(out.kind, 'pods'); assert.ok(out.count >= 1)
})

// --- can_i(RBAC 自检 via SelfSubjectAccessReview)---
test('can_i(happy): SSAR allowed → {allowed:true},resourceAttributes 正确;read 档可调', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  let posted = null
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (init.method === 'POST' && path.endsWith('/selfsubjectaccessreviews')) { posted = JSON.parse(init.body); return { body: { status: { allowed: true, reason: '' } } } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'can_i', { namespace: 'ns', verb: 'delete', resource: 'secrets', group: '' })
  assert.equal(out.allowed, true)
  assert.equal(posted.kind, 'SelfSubjectAccessReview')
  assert.equal(posted.spec.resourceAttributes.namespace, 'ns')
  assert.equal(posted.spec.resourceAttributes.verb, 'delete')
  assert.equal(posted.spec.resourceAttributes.resource, 'secrets')
  assert.equal(posted.spec.resourceAttributes.group, '')
  assert.deepEqual(out.queried, { namespace: 'ns', verb: 'delete', resource: 'secrets', group: '', name: undefined, subresource: undefined })
})
test('can_i(denied): SSAR allowed:false → {allowed:false, reason}', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (init.method === 'POST' && path.endsWith('/selfsubjectaccessreviews')) return { body: { status: { allowed: false, reason: 'forbidden by RBAC' } } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'can_i', { namespace: 'ns', verb: 'get', resource: 'pods' })
  assert.equal(out.allowed, false)
  assert.match(out.reason, /forbidden by RBAC/)
  assert.equal(out.evaluationError, null)
})
test('can_i(evaluationError): SSAR evaluationError 透传', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (init.method === 'POST' && path.endsWith('/selfsubjectaccessreviews')) return { body: { status: { allowed: false, evaluationError: 'cannot evaluate' } } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'can_i', { namespace: 'ns', verb: 'get', resource: 'pods' })
  assert.equal(out.allowed, false)
  assert.match(out.evaluationError, /cannot evaluate/)
})
test('can_i(SSAR 403): SA 无 SSAR RBAC → 优雅 evaluationError,不抛', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const e403 = new Error('forbidden'); e403.status = 403
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (init.method === 'POST' && path.endsWith('/selfsubjectaccessreviews')) throw e403
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'can_i', { namespace: 'ns', verb: 'get', resource: 'pods' })
  assert.equal(out.allowed, false)
  assert.match(out.evaluationError, /selfsubjectaccessreviews/)
})
test('can_i: ns 不符 → policy 拒(既有 ns 校验)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(k, cluster, 'can_i', { namespace: 'other', verb: 'get', resource: 'pods' }), (e) => e.reason === 'policy')
})
test('can_i: 缺 verb/resource → 报错', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(k, cluster, 'can_i', { namespace: 'ns', resource: 'pods' }), /缺 verb/)
})

// --- ns allowlist(effectiveNamespaces)---
test('ns allowlist: 额外 ns 在 allowlist → 放行(read key,跨 ns)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'anydoor', boundSA_name: 'sa', tier: 'read', allowed_namespaces: ['dev'] })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'list_resources', { kind: 'pods', namespace: 'dev' })  // dev 在 [anydoor,dev]
  assert.equal(out.kind, 'pods')  // 走通(ns 校验过 + fn 跑)
})
test('ns allowlist: ns 不在 allowlist → policy 拒(detail 命名请求 ns + 允许集)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'anydoor', boundSA_name: 'sa', tier: 'read', allowed_namespaces: ['dev'] })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(k, cluster, 'list_resources', { kind: 'pods', namespace: 'other' }), (e) =>
    e.reason === 'policy' && /'other'/.test(e.detail) && /anydoor/.test(e.detail) && /dev/.test(e.detail))
})
test('ns allowlist: 无 allowed_namespaces → 单 ns(向后兼容,他 ns 拒)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'anydoor', boundSA_name: 'sa', tier: 'read' })  // 无 allowed
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(tools.callTool(k, cluster, 'list_resources', { kind: 'pods', namespace: 'other' }), (e) => e.reason === 'policy')
})
