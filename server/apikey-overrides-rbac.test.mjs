// overrides PATCH 先供给后落库契约(2026-08-27,gap① 收口):overrides 加开工具面抬 rbacTier →
// 只改 DB 会造「策略允许、RBAC 403」;语义对齐托管 mint/ns PATCH「先供给后落库」,供给失败 → 502 + 明细,DB 不动。
// 档名变更(read→operator/admin)后 sweep 旧档名 best-effort;BYO 只落库(rbac='byo-self-managed')。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createApiKeysSchema, mintKey, listKeys } from './auth-keys.mjs'
import { createAdminRoutes } from './routes/admin.mjs'

function makeHarness({ provisionResult, noProvision } = {}) {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const sent = []
  let body = {}
  const provisionCalls = [], sweepCalls = []
  const deps = {
    db, sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    readBody: async () => body, requireAdmin: () => ({ userId: 'u1', role: 'admin', username: 'admin' }),
    getCluster: id => ({ id, apiServer: 'https://10.0.0.1:6443', authHeader: 'Bearer admin', insecure: 1, clusterId: id }),
    provisionCluster: async (row, spec) => { provisionCalls.push({ row, spec }); return provisionResult || { ok: true, applied: [], failed: [], total: 5 } },
    sweepStaleCluster: async (row, spec) => { sweepCalls.push({ row, spec }); return { deleted: [], errors: [] } },
  }
  if (noProvision) { delete deps.provisionCluster }
  const routes = createAdminRoutes(deps)
  const seedKey = (extra = {}) => mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'aliangboard-mcp-deadbeef', tier: 'read', ...extra }).id
  return { db, sent, provisionCalls, sweepCalls, setBody: b => { body = b }, seedKey, call: (m, p) => routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) }
}
const keyRow = (h, id) => listKeys(h.db).find(k => k.id === id)

test('托管 key overrides 加开危险工具 → 按抬档后 tier(admin)先供给成功才落库+sweep 旧档名', async () => {
  const h = makeHarness()
  const id = h.seedKey({ saManaged: 1 })
  h.setBody({ tool_overrides: { allow: ['exec_pod'] } })
  await h.call('PATCH', `/api/admin/apikeys/${id}/overrides`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.rbac, 'provisioned')
  assert.equal(h.provisionCalls[0].spec.tier, 'admin')          // read + allow exec_pod → rbacTier admin
  assert.equal(h.provisionCalls[0].spec.name, 'aliangboard-mcp-deadbeef')
  assert.equal(keyRow(h, id).tool_overrides, JSON.stringify({ allow: ['exec_pod'] }))
  assert.equal(h.sweepCalls.length, 1, '档名 read→admin 变更 → sweep 旧档名')
  assert.equal(h.sweepCalls[0].spec.keepTier, 'admin')
})

test('托管 key overrides 不变档(仅 deny)→ 仍先供给(幂等 SSA),不 sweep', async () => {
  const h = makeHarness()
  const id = h.seedKey({ saManaged: 1 })
  h.setBody({ tool_overrides: { deny: ['scale'] } })
  await h.call('PATCH', `/api/admin/apikeys/${id}/overrides`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.provisionCalls[0].spec.tier, 'read')
  assert.equal(h.sweepCalls.length, 0)
})

test('供给失败 → 502 + failed 明细,DB 不动(不给假成功)', async () => {
  const h = makeHarness({ provisionResult: { ok: false, applied: [], failed: [{ kind: 'Role', name: 'x', namespace: 'ns', error: 'forbidden' }], total: 1 } })
  const id = h.seedKey({ saManaged: 1 })
  h.setBody({ tool_overrides: { allow: ['scale'] } })
  await h.call('PATCH', `/api/admin/apikeys/${id}/overrides`)
  assert.equal(h.sent[0].status, 502)
  assert.ok(h.sent[0].json.failed.length >= 1)
  assert.equal(keyRow(h, id).tool_overrides, null)
})

test('BYO key → 只落库,不供给,响应 byo-self-managed', async () => {
  const h = makeHarness()
  const id = h.seedKey({ saManaged: 0 })
  h.setBody({ tool_overrides: { allow: ['scale'] } })
  await h.call('PATCH', `/api/admin/apikeys/${id}/overrides`)
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.rbac, 'byo-self-managed')
  assert.equal(h.provisionCalls.length, 0)
  assert.equal(keyRow(h, id).tool_overrides, JSON.stringify({ allow: ['scale'] }))
})

test('key 不存在 → 404(现行行为保持)', async () => {
  const h = makeHarness()
  h.setBody({ tool_overrides: null })
  await h.call('PATCH', '/api/admin/apikeys/nope/overrides')
  assert.equal(h.sent[0].status, 404)
})

test('网关未注入供给能力 → 503', async () => {
  const h = makeHarness({ noProvision: true })
  const id = h.seedKey({ saManaged: 1 })
  h.setBody({ tool_overrides: { allow: ['scale'] } })
  await h.call('PATCH', `/api/admin/apikeys/${id}/overrides`)
  assert.equal(h.sent[0].status, 503)
  assert.equal(keyRow(h, id).tool_overrides, null)
})
