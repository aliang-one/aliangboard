// GET /api/admin/clusters 断连归因(2026-09-06 证书可观测):仅 Disconnected 行触发 classifyFromRow;
// 白名单透出 disconnectReason 且凭据列(authHeader/ca/cert/key)绝不入列。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createAdminRoutes } from './routes/admin.mjs'

function makeHarness({ rows, reason = 'ca-mismatch' } = {}) {
  const sent = [], classified = []
  const routes = createAdminRoutes({
    db: { prepare: (sql) => ({ all: () => (sql.includes('FROM clusters') ? rows : []), get: () => null, run: () => {} }) },
    sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    readBody: async () => ({}),
    requireAdmin: () => ({ role: 'admin', username: 'admin' }),
    clusterProber: { probeAll: async (rs) => rs, invalidate: () => {} },
    clusterCerts: { classifyFromRow: async (row) => { classified.push(row.id); return reason } },
    buildCallContext: c => c,
    requestKubernetes: async () => { throw new Error('不应被调') },
  })
  return { sent, classified, call: (m, p) => routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) }
}
const row = (id, status) => ({ id, name: 'n' + id, apiServer: 'https://x', authMethod: 'token', version: 'v', insecure: 0, nsAuthMode: 'open', createdBy: 'a', createdAt: 1, authHeader: 'Bearer secret', ca: 'PEM', cert: null, key: null, status })

test('Disconnected 行富化 disconnectReason;Healthy 行零调用;凭据列不入列', async () => {
  const h = makeHarness({ rows: [row('c1', 'Disconnected'), row('c2', 'Healthy')] })
  await h.call('GET', '/api/admin/clusters')
  assert.equal(h.sent[0].status, 200)
  const cs = h.sent[0].json.clusters
  assert.equal(cs[0].disconnectReason, 'ca-mismatch')
  assert.equal(cs[1].disconnectReason, undefined)
  assert.deepEqual(h.classified, ['c1'])
  const json = JSON.stringify(cs)
  assert.ok(!json.includes('Bearer secret') && !json.includes('authHeader') && !json.includes('"ca"'))
})

test('classifyFromRow 抛错不拖垮列表:行降级为无归因(其余照常)', async () => {
  const sent = [], classified = []
  const routes = createAdminRoutes({
    db: { prepare: (sql) => ({ all: () => (sql.includes('FROM clusters') ? [row('c1', 'Disconnected')] : []), get: () => null, run: () => {} }) },
    sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    readBody: async () => ({}),
    requireAdmin: () => ({ role: 'admin', username: 'admin' }),
    clusterProber: { probeAll: async (rs) => rs, invalidate: () => {} },
    clusterCerts: { classifyFromRow: async () => { throw new Error('dial failed') } },
    buildCallContext: c => c,
    requestKubernetes: async () => { throw new Error('不应被调') },
  })
  await routes.handle({ method: 'GET', on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL('http://x/api/admin/clusters'))
  assert.equal(sent[0].status, 200)
  assert.equal(sent[0].json.clusters.length, 1)
})
