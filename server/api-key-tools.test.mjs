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
function mockRequestFn({ logBody = 'line1\nline2\nline3', deployment = null, replicasets = null, getResourceBody = null } = {}) {
  return async (ctx, path, init = {}) => {
    // 脱敏 T3:覆盖任意 namespaced 单体 GET 返回体(默认 null 不生效,不影响既有分支)
    if (getResourceBody && (init.method === 'GET' || !init.method) && /\/namespaces\/[^/]+\/[^/]+\/[^/]+$/.test(path)) return { body: getResourceBody }
    if (init.method === 'PATCH' && path.endsWith('/scale')) return { body: { spec: { replicas: JSON.parse(init.body).spec.replicas } } }
    if (init.method === 'PATCH') return { body: { ok: true } } // restart 等 PATCH
    if (init.method === 'DELETE') return { body: { kind: 'Status', status: 'Success' } }
    if (path === '/.well-known/openid-configuration') return { body: { issuer: 'https://kubernetes.default.svc.cluster.local' } }
    if (path.endsWith('/token')) return { body: { status: { token: 'SA-TOKEN', expirationTimestamp: new Date(Date.now() + 600000).toISOString() } } }
    if (path.includes('/log')) return { body: logBody }
    if (/\/namespaces\/[^/]+\/pods$/.test(path)) return { body: { items: [{ metadata: { name: 'p1' }, status: { phase: 'Running', containerStatuses: [{ name: 'c1', ready: true }] } }, { metadata: { name: 'p2' }, status: { phase: 'Pending' } }] } }
    if (/\/namespaces\/[^/]+\/deployments$/.test(path)) return { body: { items: [{ metadata: { name: 'd1' }, spec: { replicas: 2 }, status: { readyReplicas: 2, updatedReplicas: 2 } }] } }
    if (/\/namespaces\/[^/]+\/ingresses$/.test(path)) return { body: { items: [{ metadata: { name: 'ing-1' } }] } }
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
// 2026-08-26 词表齐平:api-key list 从 6 kind 扩到与 get 同源的全量(kind-paths.mjs KIND_API)
test('list_resources(ingresses): 词表外 kind 现已可列(2026-08-26 齐平)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  const out = await tools.callTool(k, cluster, 'list_resources', { kind: 'ingresses', namespace: 'ns' })
  assert.equal(out.kind, 'ingresses'); assert.equal(out.count, 1)
  assert.deepEqual(out.items[0], { name: 'ing-1' }) // 非 pods/工作负载 → name-only slim
})
test('list_resources(unsupported kind): policy 拒', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn() })
  await assert.rejects(() => tools.callTool(k, cluster, 'list_resources', { kind: 'widget', namespace: 'ns' }), (e) => e.reason === 'policy')
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

// --- 体积上限(2026-08-14 审计 P1b):JSON 版与 get_resource_yaml 的 32KB 对齐,防大 ConfigMap/Secret 撑爆 AI 上下文 ---
function withBigPod(size = 50000) {
  const base = mockRequestFn()
  const big = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p1' }, spec: { data: 'x'.repeat(size) } }
  return async (ctx, path, init = {}) => {
    if (init.method !== 'PATCH' && /\/namespaces\/[^/]+\/pods\/[^/]+$/.test(path)) return { body: big }
    return base(ctx, path, init)
  }
}
test('get_resource(体积上限): JSON > 32KB → 截断 json 字符串 + truncated 标志,不再返回完整对象', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: withBigPod() })
  const out = await tools.callTool(k, cluster, 'get_resource', { kind: 'pods', namespace: 'ns', name: 'p1' })
  assert.equal(out.truncated, true)
  assert.ok(out.originalBytes > 32768, 'originalBytes 记原始大小')
  assert.equal(out.byteCap, 32768)
  assert.ok(Buffer.byteLength(out.json) <= 32768 + 4, '截断后 json 不超上限(+4 容忍多字节尾巴)')
  assert.equal(out.resource, undefined, '超限时不再回完整对象(否则上限无效)')
  assert.match(out.hint, /get_resource_yaml/, '提示可用 yaml 版')
})
test('describe_resource(体积上限): 资源超 32KB → 同样截断;events(本身有界)仍返回', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: withBigPod() })
  const out = await tools.callTool(k, cluster, 'describe_resource', { kind: 'pods', namespace: 'ns', name: 'p1' })
  assert.equal(out.truncated, true)
  assert.ok(out.json && Buffer.byteLength(out.json) <= 32768 + 4)
  assert.equal(out.resource, undefined)
  assert.equal(out.events.count, 1, 'events 有界(20×300)不受资源超限影响')
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
  // execFn 契约 = execCapture 返回:status 是 V1Status 对象(真实 client-node 形态,2026-08-26 前
  // mock 猜成数字 status:0 → 测试全绿但线上 exit=[object Object])+ exitCode 数字(新字段)
  const execFn = async (saCtx, ns, pod, container, command, bounds) => { called = { ns, pod, container, command, bounds, authHeader: saCtx.authHeader }; return { stdout: Buffer.from('total 0\n'), stderr: '', status: { kind: 'Status', status: 'Success' }, exitCode: 0, timedOut: false, truncated: false } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), execFn })
  const out = await tools.callTool(k, cluster, 'exec_pod', { namespace: 'ns', pod: 'p1', container: 'c1', command: 'ls -la' })
  assert.equal(called.ns, 'ns'); assert.equal(called.pod, 'p1'); assert.deepEqual(called.command, ['sh', '-c', 'ls -la'], 'exec 契约是 argv 数组(shell 命令→sh -c 包装)')
  assert.ok(called.authHeader?.startsWith('Bearer '), 'execFn 拿到 SA-token ctx')
  assert.equal(out.stdout, 'total 0\n')
  assert.equal(out.exitCode, 0)
  const rows = db.prepare('SELECT result FROM audit_log ORDER BY seq').all()
  assert.equal(rows[rows.length - 1].result, 'ok')
})

// --- exitCode 契约(2026-08-26 exit=[object Object] bug):非零退出的 V1Status 对象必须解析成数字 ---
// 真实形态:码在 details.causes[reason=ExitCode].message(kubectl/client-go 同款)。旧实现
// `exitCode: r.status ?? null` 把整个对象塞进 exitCode → 前端 fmtExec 渲染 exit=[object Object]。
test('exec_pod(exitCode): 非零退出 V1Status 对象 → exitCode 数字(旧注入无 exitCode 字段时兜底解析 status)', async () => {
  const db = makeDb()
  const k = mkAdmin(db)
  const v1fail = { kind: 'Status', status: 'Failure', reason: 'NonZeroExitCode', message: 'command terminated with non-zero exit code: Error executing in Docker Container: 1', details: { causes: [{ reason: 'ExitCode', message: '1' }] } }
  // 旧形态注入(仅 status 对象,无 exitCode 字段)→ 网关内兜底解析
  const execFnOld = async () => ({ stdout: Buffer.from('migrate failed'), stderr: 'PostgresError: schema "auth" does not exist', status: v1fail, timedOut: false, truncated: false })
  const outOld = await createApiKeyTools({ db, requestFn: mockRequestFn(), execFn: execFnOld }).callTool(k, cluster, 'exec_pod', { namespace: 'ns', pod: 'p1', command: 'node /app/dist/db-migrate.js' })
  assert.equal(outOld.exitCode, 1, '退出码必须是数字 1,不是 V1Status 对象')
  assert.ok(typeof outOld.exitCode === 'number')
})

// --- exec 界限(2026-08-14 审计 P1a):AI 路径必须向 execFn 传 {timeoutMs,maxBytes},防挂死/吃内存 ---
const mkAdmin = (db) => mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })

test('exec_pod(bounds): 向 execFn 传 {timeoutMs,maxBytes},结果透传 timedOut + 人读提示', async () => {
  const db = makeDb()
  const k = mkAdmin(db)
  let gotBounds = null
  const execFn = async (_ctx, _ns, _pod, _c, _cmd, bounds) => { gotBounds = bounds; return { stdout: 'partial', stderr: '', status: null, timedOut: true, truncated: false } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), execFn })
  const out = await tools.callTool(k, cluster, 'exec_pod', { namespace: 'ns', pod: 'p1', command: 'tail -f /var/log/x' })
  assert.ok(gotBounds?.timeoutMs > 0, `execFn 应收到 timeoutMs(实际 ${gotBounds?.timeoutMs})`)
  assert.ok(gotBounds?.maxBytes > 0, `execFn 应收到 maxBytes(实际 ${gotBounds?.maxBytes})`)
  assert.equal(out.timedOut, true)
  assert.match(out.hint, /超时/, '超时要给人读提示(AI 能看到为何只有部分输出)')
})

test('exec_pod(bounds): 字节超限 → truncated 透传', async () => {
  const db = makeDb()
  const k = mkAdmin(db)
  const execFn = async () => ({ stdout: 'x'.repeat(32768), stderr: '', status: 0, timedOut: false, truncated: true })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), execFn })
  const out = await tools.callTool(k, cluster, 'exec_pod', { namespace: 'ns', pod: 'p1', command: 'cat /huge.bin' })
  assert.equal(out.truncated, true)
  assert.equal(out.timedOut, false)
})

test('browse_files/read_file(bounds): 同样向 execFn 传 bounds', async () => {
  const db = makeDb()
  const k = mkAdmin(db)
  const boundsSeen = []
  const execFn = async (_ctx, _ns, _pod, _c, _cmd, bounds) => { boundsSeen.push(bounds); return { stdout: 'x', stderr: '', status: 0, timedOut: false, truncated: false } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), execFn })
  await tools.callTool(k, cluster, 'browse_files', { namespace: 'ns', pod: 'p1', path: '/etc' })
  await tools.callTool(k, cluster, 'read_file', { namespace: 'ns', pod: 'p1', path: '/etc/hosts' })
  assert.equal(boundsSeen.length, 2)
  for (const b of boundsSeen) assert.ok(b?.timeoutMs > 0 && b?.maxBytes > 0, 'exec 族工具都要传 bounds')
})

// --- exec 命令形态(2026-08-25 bug):exec API 的 argv 必须以数组传给 execFn ---
// 根因:字符串命令经 client-node querystring.stringify 只产单个 command= 参数,
// kubelet 收到单元素 argv(整串被当二进制名)→ exec 必败(executable not found)。
// exec_pod 契约=shell 命令 → ['sh','-c',cmd];read_file/browse_files=固定动词+受控路径
// → 数组直传(不经 shell,路径含空格也安全)。
test('exec_pod(命令形态): execFn 收到 ["sh","-c",<command>](带引号的 shell 语法必须经 sh 解析)', async () => {
  const db = makeDb()
  const k = mkAdmin(db)
  let got = null
  const execFn = async (_ctx, _ns, _pod, _c, command) => { got = command; return { stdout: '', stderr: '', status: 0, timedOut: false, truncated: false } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), execFn })
  await tools.callTool(k, cluster, 'exec_pod', { namespace: 'ns', pod: 'p1', command: 'curl -s -o /dev/null -w "%{http_code}" http://svc:80/healthz' })
  assert.deepEqual(got, ['sh', '-c', 'curl -s -o /dev/null -w "%{http_code}" http://svc:80/healthz'])
})

test('read_file(命令形态): execFn 收到 ["cat","--",path] 数组(空格路径原样一参,不经 shell)', async () => {
  const db = makeDb()
  const k = mkAdmin(db)
  let got = null
  const execFn = async (_ctx, _ns, _pod, _c, command) => { got = command; return { stdout: 'x', stderr: '', status: 0, timedOut: false, truncated: false } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), execFn })
  await tools.callTool(k, cluster, 'read_file', { namespace: 'ns', pod: 'p1', path: '/opt/my app/conf.yaml' })
  assert.deepEqual(got, ['cat', '--', '/opt/my app/conf.yaml'])
})

test('browse_files(命令形态): execFn 收到 ["ls","-la",path] 数组(默认 /)', async () => {
  const db = makeDb()
  const k = mkAdmin(db)
  const got = []
  const execFn = async (_ctx, _ns, _pod, _c, command) => { got.push(command); return { stdout: 'x', stderr: '', status: 0, timedOut: false, truncated: false } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), execFn })
  await tools.callTool(k, cluster, 'browse_files', { namespace: 'ns', pod: 'p1', path: '/etc' })
  await tools.callTool(k, cluster, 'browse_files', { namespace: 'ns', pod: 'p1' })
  assert.deepEqual(got[0], ['ls', '-la', '/etc'])
  assert.deepEqual(got[1], ['ls', '-la', '/'], '缺 path 默认 /,仍是数组')
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
  assert.deepEqual(out.revisions[1].images, ['c1=img:1'])
})
test('rollout_history: 只列该 Deployment 的 RS(ownerReference 过滤)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const otherRs = { metadata: { name: 'other-rs', ownerReferences: [{ uid: 'uid-other', kind: 'Deployment', controller: true }], annotations: { 'deployment.kubernetes.io/revision': '5' } }, spec: { template: { spec: { containers: [{ name: 'x', image: 'x' }] } } } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn({ replicasets: [otherRs] }) })
  const out = await tools.callTool(k, cluster, 'rollout_history', { namespace: 'ns', name: 'd1' })
  assert.equal(out.revisions.length, 0, '不属于 d1 的 RS 被过滤')
})

// --- rollout 多容器(2026-08-14 审计 P3):此前只看 containers[0].image,多容器 Deployment 的历史/回滚展示误导 ---
const rsMulti = (rev, appImg, sideImg) => ({ metadata: { name: `d1-rs${rev}`, ownerReferences: [{ uid: 'uid-d1', kind: 'Deployment', controller: true }], annotations: { 'deployment.kubernetes.io/revision': String(rev) }, creationTimestamp: '2026-08-06T02:00:00Z' }, spec: { template: { spec: { containers: [{ name: 'app', image: appImg }, { name: 'sidecar', image: sideImg }] } } } })
const deployMulti = (appImg, sideImg) => ({ metadata: { name: 'd1', uid: 'uid-d1', annotations: { 'deployment.kubernetes.io/revision': '2' } }, spec: { template: { spec: { containers: [{ name: 'app', image: appImg }, { name: 'sidecar', image: sideImg }] } } } })

test('rollout_history(多容器): images 列出全部容器 name=image,不只 containers[0]', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn({ deployment: deployMulti('app:2', 'side:2'), replicasets: [rsMulti(2, 'app:2', 'side:2'), rsMulti(1, 'app:1', 'side:1')] }) })
  const out = await tools.callTool(k, cluster, 'rollout_history', { namespace: 'ns', name: 'd1' })
  assert.deepEqual(out.revisions.find(r => r.revision === '1').images, ['app=app:1', 'sidecar=side:1'], '全容器,不止第一个')
  assert.deepEqual(out.revisions.find(r => r.revision === '2').images, ['app=app:2', 'sidecar=side:2'])
})

test('rollout_undo(多容器): previousImages/newImages 覆盖全部容器(此前 prevImage/newImage 只看第一个)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  let patched = null
  const base = mockRequestFn({ deployment: deployMulti('app:2', 'side:2'), replicasets: [rsMulti(2, 'app:2', 'side:2'), rsMulti(1, 'app:1', 'side:1')] })
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (init.method === 'PATCH' && /\/deployments\/[^/]+$/.test(path)) { patched = JSON.parse(init.body); return { body: { ok: true } } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'rollout_undo', { namespace: 'ns', name: 'd1', toRevision: 1 })
  assert.deepEqual(out.previousImages, ['app=app:2', 'sidecar=side:2'])
  assert.deepEqual(out.newImages, ['app=app:1', 'sidecar=side:1'])
  assert.ok(patched, 'PATCH 仍发完整 template(多容器回滚本身原本就正确)')
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
  assert.deepEqual(out.previousImages, ['c1=img:2']); assert.deepEqual(out.newImages, ['c1=img:1'])
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
  assert.deepEqual(out.newImages, ['c1=img:1'], '用本 Deployment 的 RS,不是外来 RS')
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

// --- SA 404 自愈 + 友好错误(managed SA lifecycle)---
// mock:首次 token POST 404(SA 被删),之后恢复;SSA PATCH 记录成数组验证自愈重建。
function mockWithSaDeletedOnce() {
  const ssaCalls = []
  let tokenCalls = 0
  return {
    ssaCalls,
    requestFn: async (ctx, path, init = {}) => {
      if (path.endsWith('/token')) {
        tokenCalls++
        if (tokenCalls === 1) { const e = new Error('serviceaccounts "sa" not found'); e.status = 404; throw e }
        return { body: { status: { token: 'SA-TOKEN-2', expirationTimestamp: new Date(Date.now() + 600000).toISOString() } } }
      }
      if (init.method === 'PATCH' && path.includes('fieldManager=aliangboard')) { ssaCalls.push(path); return { body: {} } }
      if (path === '/.well-known/openid-configuration') return { body: { issuer: 'https://kubernetes.default.svc.cluster.local' } }
      if (/\/namespaces\/[^/]+\/pods$/.test(path)) return { body: { items: [] } }
      throw new Error('mock: unexpected path ' + path)
    },
  }
}

test('自愈:托管 key 签 token 404 → 幂等重建(SSA)→ 重签成功,审计 ok', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', saManaged: 1 })
  const { requestFn, ssaCalls } = mockWithSaDeletedOnce()
  const tools = createApiKeyTools({ db, requestFn })
  const out = await tools.callTool(k, cluster, 'list_resources', { namespace: 'ns', kind: 'pods' })
  assert.equal(out.kind, 'pods')
  assert.ok(ssaCalls.some(p => p.includes('/serviceaccounts/sa?')), '重建了 SA')
  assert.ok(ssaCalls.some(p => p.includes('/clusterrolebindings/')), '重建了 can-i CRB')
})

test('BYO key 签 token 404 → 不重建,抛 SA_BINDING_ERROR 中文引导(提「修复」)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' }) // saManaged=0
  const { requestFn, ssaCalls } = mockWithSaDeletedOnce()
  const tools = createApiKeyTools({ db, requestFn })
  await assert.rejects(
    () => tools.callTool(k, cluster, 'list_resources', { namespace: 'ns', kind: 'pods' }),
    e => e.message.startsWith('SA_BINDING_ERROR:') && e.message.includes('修复') && e.message.includes('ns/sa')
  )
  assert.equal(ssaCalls.length, 0, 'BYO 不代建')
})

test('自愈失败(重建也失败)→ 抛 SA_BINDING_ERROR 含「自动重建失败」', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', saManaged: 1 })
  const requestFn = async (ctx, path, init = {}) => {
    if (path.endsWith('/token')) { const e = new Error('serviceaccounts "sa" not found'); e.status = 404; throw e }
    if (init.method === 'PATCH' && path.includes('fieldManager=aliangboard')) { const e = new Error('rbac forbidden'); e.status = 403; throw e }
    if (path === '/.well-known/openid-configuration') return { body: { issuer: 'https://kubernetes.default.svc.cluster.local' } }
    throw new Error('mock: unexpected path ' + path)
  }
  const tools = createApiKeyTools({ db, requestFn })
  await assert.rejects(
    () => tools.callTool(k, cluster, 'list_resources', { namespace: 'ns', kind: 'pods' }),
    e => e.message.startsWith('SA_BINDING_ERROR:') && e.message.includes('自动重建失败')
  )
})

// ── 2026-08-27 MCP get_pod_logs [object Object] 事故 ──
// previous=true 取崩溃容器日志,整段日志恰为合法 JSON(gotrue 结构化日志一行)时被
// requestOnce 无脑 JSON.parse 成对象 → 工具层 String(obj) = "[object Object]"
// (外部 AI 会话实测拿到,还误诊为「gotrue 把错误 toString 了」)。根因修复在
// requestOnce 的 content-type 感知解析(call-context.parseResponseBody);此处锁工具层
// 兜底:body 穿透为对象时序列化为可读 JSON,永不产出 [object Object]。
test('get_pod_logs:body 为对象(根因穿透/代理剥 content-type)→ logs 为可读 JSON 串,非 [object Object]', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn({ logBody: { level: 'error', msg: 'connect ECONNREFUSED 127.0.0.1:5432', svc: 'gotrue' } }) })
  const out = await tools.getPodLogs(k, cluster, { namespace: 'ns', pod: 'p1', previous: true })
  assert.ok(!out.logs.includes('[object Object]'), `logs 不得是 [object Object],实际: ${out.logs.slice(0, 80)}`)
  assert.match(out.logs, /connect ECONNREFUSED/)
  assert.match(out.logs, /gotrue/)
  assert.equal(out.previous, true)
})

// 2026-08-28 生产事故:LLM 参数 tag 带首尾空格("repo:1.0.10 ")patch 进 Deployment →
// Pod 创建被 K8s 拒(must not have leading or trailing whitespace)→ 永远 Pending。
// 契约:update_image 落 patch 前清掉镜像引用内一切空白。
test('update_image: 镜像引用清空白("img:9 " → "img:9",内嵌空格也清)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  let patched = null
  const base = mockRequestFn()
  const tools = createApiKeyTools({ db, requestFn: async (ctx, path, init = {}) => {
    if (init.method === 'PATCH' && /\/deployments\/[^/]+$/.test(path)) { patched = JSON.parse(init.body); return { body: { ok: true } } }
    return base(ctx, path, init)
  } })
  const out = await tools.callTool(k, cluster, 'update_image', { namespace: 'ns', kind: 'deployments', name: 'd1', container: 'c1', image: ' ghcr.io/x/y:1.0.10 \n' })
  assert.equal(out.newImage, 'ghcr.io/x/y:1.0.10')
  assert.deepEqual(patched, { spec: { template: { spec: { containers: [{ name: 'c1', image: 'ghcr.io/x/y:1.0.10' }] } } } })
})

// ── 脱敏 T3:MCP 读 Secret 值全掩码(D2:MCP 一致掩码)──
test('get_resource/describe_resource/get_resource_yaml:Secret 值掩码指纹,明文/base64 不出现', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const b64pw = Buffer.from('s3cr3t-hunter2').toString('base64')
  const secretBody = { kind: 'Secret', metadata: { name: 'db-cred', namespace: 'ns' },
    data: { password: b64pw }, stringData: { tok: 'plain-tok' } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn({ getResourceBody: secretBody }) })
  // get_resource
  const out = await tools.callTool(k, cluster, 'get_resource', { namespace: 'ns', kind: 'secrets', name: 'db-cred' })
  assert.equal(out.resource.kind, 'Secret')
  assert.ok(!JSON.stringify(out).includes('s3cr3t-hunter2') && !JSON.stringify(out).includes(b64pw), '明文/base64 不出现')
  assert.match(out.resource.data.password, /\*\*\* \(\d+ chars, #[0-9a-f]{8}\)/)
  assert.match(out.resource.stringData.tok, /\(9 chars,/)
  // describe_resource
  const d = await tools.callTool(k, cluster, 'describe_resource', { namespace: 'ns', kind: 'secrets', name: 'db-cred' })
  assert.ok(!JSON.stringify(d).includes('s3cr3t-hunter2') && !JSON.stringify(d).includes(b64pw), 'describe 明文不出现')
  assert.match(d.resource.data.password, /#[0-9a-f]{8}/)
  // get_resource_yaml
  const y = await tools.callTool(k, cluster, 'get_resource_yaml', { namespace: 'ns', path: '/api/v1/namespaces/ns/secrets/db-cred' })
  assert.ok(!y.yaml.includes('s3cr3t-hunter2') && !y.yaml.includes(b64pw), 'yaml 明文不出现')
  assert.match(y.yaml, /#[0-9a-f]{8}/)
})
test('apply_yaml(CSO adjacent): 集群级 kind 即使带 metadata.namespace 也拒(ns 绑定 key)', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  let applied = false
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), applyYamlFn: async () => { applied = true; return { applied: [], failed: [], total: 0 } } })
  // apply-yaml.mjs 对集群级 kind 丢弃 namespace 段 → ns 闸门被骗过,实际创建集群级对象
  const yaml = 'apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: cr1\n  namespace: ns'
  await assert.rejects(
    tools.callTool(k, cluster, 'apply_yaml', { yaml }),
    (e) => e.code === 'PERMISSION_DENIED' && e.reason === 'policy' && /集群级/.test(e.detail) && /ClusterRole/.test(e.detail),
  )
  assert.equal(applied, false, '集群级 kind 时 applyYamlFn 不应被调')
})
test('apply_yaml(CSO adjacent) 对照: namespaced kind + 允许 ns → 正常放行到 applyYamlFn', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin' })
  let called = null
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn(), applyYamlFn: async (ctx, y) => { called = y; return { applied: [], failed: [], total: 0 } } })
  await tools.callTool(k, cluster, 'apply_yaml', { yaml: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n  namespace: ns' })
  assert.ok(called.includes('ConfigMap'), 'namespaced kind 应照常放行')
})
