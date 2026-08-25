// GET /api/admin/clusters/:id/namespaces 契约:ns allowlist 下拉候选源。
// 必须用 key 绑定集群自己的凭据拉(非浏览器会话集群,多集群防错位);只回名字、字典序;失败 502。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createAdminRoutes } from './routes/admin.mjs'

const ns = name => ({ metadata: { name } })

function makeHarness({ clusterRow, k8s } = {}) {
  const sent = [], k8sCalls = []
  const routes = createAdminRoutes({
    db: {}, sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    readBody: async () => ({}), requireAdmin: () => ({ role: 'admin', username: 'admin' }),
    getCluster: id => (clusterRow && id === clusterRow.id) ? clusterRow : null,
    buildCallContext: c => ({ apiServer: c.apiServer, authHeader: c.authHeader, insecure: !!c.insecure }),
    requestKubernetes: async (ctx, path) => { k8sCalls.push({ ctx, path }); return k8s(path) },
  })
  return { sent, k8sCalls, call: (m, p) => routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) }
}

const ROW = { id: 'c1', apiServer: 'https://10.0.0.1:6443', authHeader: 'Bearer x', insecure: 1 }

test('200:只回名字且字典序;requestKubernetes 收到集群行凭据 + limit=500', async () => {
  const h = makeHarness({ clusterRow: ROW, k8s: async () => ({ body: { items: [ns('zeta'), ns('alpha'), ns('kube-system')] } }) })
  await h.call('GET', '/api/admin/clusters/c1/namespaces')
  assert.equal(h.sent[0].status, 200)
  assert.deepEqual(h.sent[0].json.namespaces, ['alpha', 'kube-system', 'zeta'])
  assert.equal(h.k8sCalls.length, 1)
  assert.equal(h.k8sCalls[0].path, '/api/v1/namespaces?limit=500')
  assert.equal(h.k8sCalls[0].ctx.authHeader, 'Bearer x')
  assert.equal(h.k8sCalls[0].ctx.apiServer, ROW.apiServer)
})

test('集群不存在 → 404,零 K8s 调用', async () => {
  const h = makeHarness({ clusterRow: null, k8s: async () => { throw new Error('不应被调') } })
  await h.call('GET', '/api/admin/clusters/nope/namespaces')
  assert.equal(h.sent[0].status, 404)
  assert.equal(h.k8sCalls.length, 0)
})

test('K8s 拉取失败 → 502 透出 message', async () => {
  const h = makeHarness({ clusterRow: ROW, k8s: async () => { throw Object.assign(new Error('boom'), { status: 401 }) } })
  await h.call('GET', '/api/admin/clusters/c1/namespaces')
  assert.equal(h.sent[0].status, 502)
  assert.match(h.sent[0].json.message, /boom/)
})
