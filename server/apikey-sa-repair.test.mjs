// repair/health/回收契约:托管修复幂等供给;BYO takeover 换托管名并改绑;health 聚合探测;吊销 best-effort 回收。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createApiKeysSchema, mintKey, revokeKey, listKeys } from './auth-keys.mjs'
import { createAdminRoutes } from './routes/admin.mjs'

function makeHarness({ probe, drift, teardownShouldThrow, sweepShouldThrow } = {}) {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const sent = []
  let body = {}
  const provisionCalls = [], teardownCalls = [], sweepCalls = []
  const routes = createAdminRoutes({
    db, sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    readBody: async () => body, requireAdmin: () => ({ userId: 'u1', role: 'admin', username: 'admin' }),
    getCluster: () => ({ id: 'c1', apiServer: 'https://x', authHeader: 'Bearer a', insecure: 1 }),
    provisionCluster: async (row, spec) => { provisionCalls.push(spec); return { ok: true, applied: [], failed: [], total: 5 } },
    teardownCluster: async (row, spec) => { teardownCalls.push(spec); if (teardownShouldThrow) throw new Error('net error'); return { deleted: [], errors: [] } },
    sweepStaleCluster: async (row, spec) => { sweepCalls.push(spec); if (sweepShouldThrow) throw new Error('sweep error'); return { deleted: [], errors: [] } },
    probeSa: async (row, ns, name) => (typeof probe === 'function' ? probe(ns, name) : { ok: true }),
    probeDrift: async (row, keyRow, shared) => (typeof drift === 'function' ? drift(keyRow) : { status: 'ok', issues: [] }),
  })
  return { db, sent, provisionCalls, teardownCalls, sweepCalls, setBody: b => { body = b }, call: (m, p) => routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) }
}

test('repair 托管 key:按行内 ns/name 幂等供给,不改绑;sweep 以同 tier 为 keepTier 调一次', async () => {
  const h = makeHarness()
  const k = mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'aliangboard-mcp-11111111', saManaged: 1 })
  h.setBody({})
  await h.call('POST', `/api/admin/apikeys/${k.id}/sa/repair`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.boundSA, 'ns/aliangboard-mcp-11111111')
  assert.equal(h.provisionCalls[0].name, 'aliangboard-mcp-11111111')
  assert.equal(h.provisionCalls[0].tier, h.sweepCalls[0].keepTier, 'sweep keepTier 与 provision tier 一致')
  assert.equal(h.sweepCalls.length, 1)
})

test('repair sweep 抛错:best-effort,修复仍 200', async () => {
  const h = makeHarness({ sweepShouldThrow: true })
  const k = mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', saManaged: 1 })
  h.setBody({})
  await h.call('POST', `/api/admin/apikeys/${k.id}/sa/repair`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.ok, true)
})

test('repair BYO key 无 takeover → 400,provision 不被调', async () => {
  const h = makeHarness()
  const k = mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'my-sa' })
  h.setBody({})
  await h.call('POST', `/api/admin/apikeys/${k.id}/sa/repair`)
  assert.equal(h.sent[0].status, 400)
  assert.equal(h.provisionCalls.length, 0)
  assert.equal(h.sweepCalls.length, 0)
})

test('repair BYO key + takeover:换托管名,行改绑 saManaged=1', async () => {
  const h = makeHarness()
  const k = mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'nursor', boundSA_name: 'nursor-debug' })
  h.setBody({ takeover: true })
  await h.call('POST', `/api/admin/apikeys/${k.id}/sa/repair`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.managed, true)
  assert.match(h.sent[0].json.boundSA, /^nursor\/aliangboard-mcp-[0-9a-f]{8}$/)
  const row = listKeys(h.db).find(r => r.id === k.id)
  assert.equal(row.saManaged, 1)
  assert.equal(row.boundSA_name, h.sent[0].json.boundSA.split('/')[1])
})

test('repair 不存在的 key → 404', async () => {
  const h = makeHarness()
  h.setBody({})
  await h.call('POST', '/api/admin/apikeys/nope/sa/repair')
  assert.equal(h.sent[0].status, 404)
})

test('health:聚合所有未吊销 key,透传 probe 结果(ok/detail)', async () => {
  const h = makeHarness({ probe: (ns, name) => (name === 'gone' ? { ok: false, detail: 'ServiceAccount 不存在' } : { ok: true }) })
  mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'ok-sa', saManaged: 1 })
  mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'gone' })
  await h.call('GET', '/api/admin/apikeys/health')
  assert.equal(h.sent[0].status, 200)
  const byName = Object.fromEntries(h.sent[0].json.health.map(x => [x.boundSA.split('/')[1], x]))
  assert.equal(byName['ok-sa'].ok, true)
  assert.equal(byName['ok-sa'].managed, true)
  assert.equal(byName['gone'].ok, false)
  assert.equal(byName['gone'].detail, 'ServiceAccount 不存在')
})

test('吊销托管 key:先 revoke 后 best-effort 回收;回收抛错不影响吊销结果', async () => {
  const h = makeHarness({ teardownShouldThrow: true })
  const k = mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', saManaged: 1, allowed_namespaces: null })
  await h.call('DELETE', `/api/admin/apikeys/${k.id}`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.revoked, true)
  assert.equal(h.teardownCalls.length, 1)
  assert.equal(h.teardownCalls[0].name, 'sa')
})

test('吊销 BYO key:不回收(身份不是平台的)', async () => {
  const h = makeHarness()
  const k = mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'my-sa' })
  await h.call('DELETE', `/api/admin/apikeys/${k.id}`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.teardownCalls.length, 0)
})

test('health:透传 rbac 字段;SA 挂 → unknown 短路且不跑 drift;probeDrift 抛错不阻塞', async () => {
  const h = makeHarness({ drift: () => ({ status: 'drift', issues: [{ type: 'role-missing', ns: 'ns' }] }) })
  mintKey(h.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa-a', saManaged: 1 })
  await h.call('GET', '/api/admin/apikeys/health')
  const x = h.sent[0].json.health[0]
  assert.equal(x.rbac.status, 'drift')
  assert.equal(x.rbac.issues[0].type, 'role-missing')

  let driftRan = 0
  const h2 = makeHarness({ probe: async () => ({ ok: false, detail: 'not found' }), drift: async () => { driftRan++; return { status: 'ok', issues: [] } } })
  mintKey(h2.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa-b', saManaged: 1 })
  await h2.call('GET', '/api/admin/apikeys/health')
  assert.equal(h2.sent[0].json.health[0].rbac.status, 'unknown') // SA 探测失败短路
  assert.equal(driftRan, 0)                                       // 短路 = 不调 drift

  const h3 = makeHarness({ drift: () => { throw new Error('boom') } })
  mintKey(h3.db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa-c', saManaged: 1 })
  await h3.call('GET', '/api/admin/apikeys/health')
  assert.equal(h3.sent[0].status, 200)
  assert.equal(h3.sent[0].json.health[0].rbac.status, 'unknown') // drift 抛错兜底,列表照常
})
