// 托管 mint 契约:mode=managed(默认)→ 先供给(幂等 SSA)后落库,saManaged=1,SA 名服务端生成;
// 供给失败 → 502 且不落库;BYO(boundSA_name/mode=byo)→ 旧行为 saManaged=0。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createApiKeysSchema, listKeys } from './auth-keys.mjs'
import { createAdminRoutes } from './routes/admin.mjs'

function makeHarness({ provisionResult } = {}) {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const sent = []
  let body = {}
  const provisionCalls = []
  const routes = createAdminRoutes({
    db, sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    readBody: async () => body, requireAdmin: () => ({ userId: 'u1', role: 'admin', username: 'admin' }),
    getCluster: id => ({ id, apiServer: 'https://10.0.0.1:6443', authHeader: 'Bearer admin', insecure: 1, clusterId: id }),
    provisionCluster: async (row, spec) => { provisionCalls.push({ row, spec }); return provisionResult || { ok: true, applied: [], failed: [], total: 5 } },
  })
  return { db, sent, provisionCalls, setBody: b => { body = b }, call: (m, p) => routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) }
}

test('托管 mint:不填 boundSA_name → 供给先行(SA 名=aliangboard-mcp-<id8>)+ saManaged=1 + 回传明文', async () => {
  const h = makeHarness()
  h.setBody({ mode: 'managed', owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', tier: 'read' })
  await h.call('POST', '/api/admin/apikeys')
  assert.equal(h.sent[0].status, 200)
  const k = h.sent[0].json.apikey
  assert.equal(k.saManaged, 1)
  assert.match(k.boundSA_name, /^aliangboard-mcp-[0-9a-f]{8}$/)
  assert.ok(k.plaintext, '明文仅此次返回')
  assert.equal(h.provisionCalls.length, 1)
  assert.equal(h.provisionCalls[0].spec.namespace, 'ns')
  assert.equal(h.provisionCalls[0].spec.name, k.boundSA_name)
  assert.equal(h.provisionCalls[0].spec.tier, 'read')
  assert.equal(listKeys(h.db).length, 1)
})

test('托管 mint 失败 → 502 + failed 明细 + 不落库', async () => {
  const h = makeHarness({ provisionResult: { ok: false, applied: [], failed: [{ kind: 'ServiceAccount', name: 'sa', error: 'forbidden' }], total: 1 } })
  h.setBody({ owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', tier: 'read' })
  await h.call('POST', '/api/admin/apikeys')
  assert.equal(h.sent[0].status, 502)
  assert.match(h.sent[0].json.message, /集群身份创建失败.*forbidden/)
  assert.equal(listKeys(h.db).length, 0)
})

test('BYO mint(boundSA_name 给了)→ 不调供给,saManaged=0,行为与旧版一致', async () => {
  const h = makeHarness()
  h.setBody({ owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'my-sa', tier: 'read' })
  await h.call('POST', '/api/admin/apikeys')
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.apikey.saManaged, 0)
  assert.equal(h.provisionCalls.length, 0)
})

test('托管 mint 缺 deps(未接线)→ 503 明确报错,不落库', async () => {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const sent = []
  const routes = createAdminRoutes({ db, sendJson: (r, s, j) => { sent.push({ status: s, json: j }) }, readBody: async () => ({ owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns' }), requireAdmin: () => ({ role: 'admin', username: 'admin' }) })
  await routes.handle({ method: 'POST', on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL('http://x/api/admin/apikeys'))
  assert.equal(sent[0].status, 503)
  assert.equal(listKeys(db).length, 0)
})
