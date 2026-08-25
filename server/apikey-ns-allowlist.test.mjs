// ns allowlist PATCH 契约(2026-08-25):「增加可访问 namespace」必须端到端可用。
// 根因:PATCH 只改 DB 策略层,不给集群补 Role/RoleBinding → 托管 key 在新 ns 实发 403(策略过、RBAC 拒);
// 移除 ns 也不清理集群残留。语义对齐托管 mint「先供给后落库」:供给失败 → 502 + 明细,DB 不动(不给假成功)。
// BYO key:平台不碰其集群身份(与 repair 需 takeover 同立场)→ 只落库,响应 rbac='byo-self-managed'。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createApiKeysSchema, mintKey, listKeys } from './auth-keys.mjs'
import { createAdminRoutes } from './routes/admin.mjs'

function makeHarness({ provisionResult, missingNs = [] } = {}) {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const sent = []
  let body = {}
  const provisionCalls = [], sweepCalls = [], k8sCalls = []
  const routes = createAdminRoutes({
    db, sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    readBody: async () => body, requireAdmin: () => ({ userId: 'u1', role: 'admin', username: 'admin' }),
    getCluster: id => ({ id, apiServer: 'https://10.0.0.1:6443', authHeader: 'Bearer admin', insecure: 1, clusterId: id }),
    buildCallContext: c => ({ apiServer: c.apiServer, authHeader: c.authHeader }),
    // ns 存在性预检桩:GET /api/v1/namespaces/<ns>;missingNs 里的 → 404(真实集群「ns 不存在」语义)
    requestKubernetes: async (ctx, path) => {
      k8sCalls.push(path)
      const m = path.match(/^\/api\/v1\/namespaces\/([^/?]+)/)
      if (m && missingNs.includes(decodeURIComponent(m[1]))) { const e = new Error(`namespaces "${m[1]}" not found`); e.status = 404; throw e }
      return { body: { kind: 'Namespace', metadata: { name: m ? m[1] : 'x' } } }
    },
    provisionCluster: async (row, spec) => { provisionCalls.push({ row, spec }); return provisionResult || { ok: true, applied: [], failed: [], total: 5 } },
    sweepNamespacesCluster: async (row, spec) => { sweepCalls.push({ row, spec }); return { deleted: [], errors: [] } },
  })
  const seedKey = (extra = {}) => mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'aliangboard-mcp-deadbeef', tier: 'read', ...extra }).id
  return { db, sent, provisionCalls, sweepCalls, k8sCalls, setBody: b => { body = b }, seedKey, call: (m, p) => routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) }
}
const keyRow = (h, id) => listKeys(h.db).find(k => k.id === id)

test('托管 key PATCH 加 ns → 先供给(namespaces=新集,幂等 SSA)成功才落库', async () => {
  const h = makeHarness()
  const id = h.seedKey({ saManaged: 1, allowed_namespaces: ['kube-system'] })
  h.setBody({ allowed_namespaces: ['kube-system', 'demo'] })
  await h.call('PATCH', `/api/admin/apikeys/${id}/namespaces`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.provisionCalls.length, 1, '托管 key 必须 provision(补新 ns 的 Role/RoleBinding)')
  assert.equal(h.provisionCalls[0].spec.namespace, 'ns')
  assert.equal(h.provisionCalls[0].spec.name, 'aliangboard-mcp-deadbeef')
  assert.equal(h.provisionCalls[0].spec.tier, 'read')
  assert.deepEqual(h.provisionCalls[0].spec.namespaces, ['kube-system', 'demo'])
  assert.equal(keyRow(h, id).allowed_namespaces, '["kube-system","demo"]')
})

test('托管 key PATCH 供给失败 → 502 + failed 明细 + DB 不动(不落一个 403 的 ns)', async () => {
  const h = makeHarness({ provisionResult: { ok: false, applied: [], failed: [{ kind: 'Role', name: 'aliangboard-mcp-read-deadbeef', namespace: 'demo', error: 'forbidden' }], total: 1 } })
  const id = h.seedKey({ saManaged: 1, allowed_namespaces: null })
  h.setBody({ allowed_namespaces: ['demo'] })
  await h.call('PATCH', `/api/admin/apikeys/${id}/namespaces`)
  assert.equal(h.sent[0].status, 502)
  assert.match(h.sent[0].json.message, /集群身份.*forbidden|forbidden/)
  assert.equal(keyRow(h, id).allowed_namespaces, null, '供给失败不得改库')
})

test('托管 key PATCH 移除 ns → best-effort 清理被移除 ns 的三档 RBAC + 落库', async () => {
  const h = makeHarness()
  const id = h.seedKey({ saManaged: 1, allowed_namespaces: ['kube-system', 'demo'] })
  h.setBody({ allowed_namespaces: ['demo'] })
  await h.call('PATCH', `/api/admin/apikeys/${id}/namespaces`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sweepCalls.length, 1, '移除 ns 要清集群残留')
  assert.deepEqual(h.sweepCalls[0].spec.namespaces, ['kube-system'])
  assert.equal(h.sweepCalls[0].spec.keyId, id)
  assert.equal(keyRow(h, id).allowed_namespaces, '["demo"]')
})

test('BYO key PATCH → 不供给、不清理(平台不碰 BYO 身份),落库 + rbac 标注自管', async () => {
  const h = makeHarness()
  const id = h.seedKey({ boundSA_name: 'my-sa' })
  h.setBody({ allowed_namespaces: ['demo'] })
  await h.call('PATCH', `/api/admin/apikeys/${id}/namespaces`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.provisionCalls.length, 0)
  assert.equal(h.sweepCalls.length, 0)
  assert.equal(h.sent[0].json.rbac, 'byo-self-managed')
  assert.equal(keyRow(h, id).allowed_namespaces, '["demo"]')
})

test('非空集且供给全成功时移除为空 → 不调 sweep', async () => {
  const h = makeHarness()
  const id = h.seedKey({ saManaged: 1, allowed_namespaces: null })
  h.setBody({ allowed_namespaces: ['demo'] })
  await h.call('PATCH', `/api/admin/apikeys/${id}/namespaces`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sweepCalls.length, 0)
})

test('托管 key PATCH 缺供给 deps(未接线)→ 503 明确报错,DB 不动', async () => {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const id = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', saManaged: 1 }).id
  const sent = []
  const routes = createAdminRoutes({ db, sendJson: (r, s, j) => { sent.push({ status: s, json: j }) }, readBody: async () => ({ allowed_namespaces: ['demo'] }), requireAdmin: () => ({ role: 'admin', username: 'admin' }) })
  await routes.handle({ method: 'PATCH', on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x/api/admin/apikeys/${id}/namespaces`))
  assert.equal(sent[0].status, 503)
  assert.equal(listKeys(db)[0].allowed_namespaces, null)
})

test('坏 ns 名仍 400(strict 校验保持,供给零副作用)', async () => {
  const h = makeHarness()
  const id = h.seedKey({ saManaged: 1 })
  h.setBody({ allowed_namespaces: ['Bad_Ns'] })
  await h.call('PATCH', `/api/admin/apikeys/${id}/namespaces`)
  assert.equal(h.sent[0].status, 400)
  assert.equal(h.provisionCalls.length, 0)
})

test('托管 key PATCH 加「集群里不存在的 ns」→ 400 明确指引 + 零供给 + DB 不动(kind 实测回归:SSA 往不存在 ns 打 RBAC 必 404)', async () => {
  const h = makeHarness({ missingNs: ['ghost-ns'] })
  const id = h.seedKey({ saManaged: 1, allowed_namespaces: null })
  h.setBody({ allowed_namespaces: ['ghost-ns'] })
  await h.call('PATCH', `/api/admin/apikeys/${id}/namespaces`)
  assert.equal(h.sent[0].status, 400)
  assert.match(h.sent[0].json.message, /ghost-ns.*不存在/)
  assert.equal(h.provisionCalls.length, 0, '预检失败不进供给')
  assert.equal(keyRow(h, id).allowed_namespaces, null)
})

test('BYO key PATCH 加「集群里不存在的 ns」→ 200 不预检(自管 RBAC,「先配 key 后建 ns」对 BYO 合法)', async () => {
  const h = makeHarness({ missingNs: ['ghost-ns'] })
  const id = h.seedKey({ boundSA_name: 'my-sa' })
  h.setBody({ allowed_namespaces: ['ghost-ns'] })
  await h.call('PATCH', `/api/admin/apikeys/${id}/namespaces`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.k8sCalls.filter(p => p.startsWith('/api/v1/namespaces/')).length, 0, 'BYO 不做 ns 预检')
  assert.equal(keyRow(h, id).allowed_namespaces, '["ghost-ns"]')
})
