// GET /api/cluster-certs 契约:session 门已过(门外 ROUTE_AUTH),ns 门 namespace:null(集群级读,
// 对齐 registry-tags 先例:open 放行/allowlist 按集群授权/admin 短路),报告直传 200,上游失败 502。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createClusterCertsRoutes } from './cluster-certs.mjs'
import { authClassFor } from '../route-auth-map.mjs'

const REPORT = { connection: { trust: 'trusted', peerChain: [] }, caAnchors: [], secrets: { items: [], error: null }, certManagerInstalled: false, fetchedAt: 1 }

function makeHarness({ report = REPORT, gateResult = true } = {}) {
  const sent = [], gateCalls = []
  const routes = createClusterCertsRoutes({
    sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    msg: (req, code) => code,
    clusterCerts: { getCertsReport: async () => report },
    k8sGate: { gateK8sSession: (session, info) => { gateCalls.push({ session, info }); return gateResult } },
    levelForRequest: () => 'view',
  })
  return { sent, gateCalls, call: (m, p) => routes.handle({ method: m, on: () => {}, abSession: { apiServer: 'https://x' } }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) }
}

test('200:报告直传;ns 门收到 namespace:null + level:view + 会话本体', async () => {
  const h = makeHarness()
  assert.equal(await h.call('GET', '/api/cluster-certs'), true)
  assert.equal(h.sent[0].status, 200)
  assert.deepEqual(Object.keys(h.sent[0].json).sort(), ['caAnchors', 'certManagerInstalled', 'connection', 'fetchedAt', 'secrets'])
  assert.equal(h.gateCalls[0].info.namespace, null)
  assert.equal(h.gateCalls[0].info.level, 'view')
  assert.equal(h.gateCalls[0].info.method, 'GET')
  assert.equal(h.gateCalls[0].session.apiServer, 'https://x')
})

test('ns 门拒绝 → 403 nsForbidden;非目标路径/方法 → false 放行', async () => {
  const h = makeHarness({ gateResult: false })
  await h.call('GET', '/api/cluster-certs')
  assert.equal(h.sent[0].status, 403)
  assert.equal(h.sent[0].json.message, 'api.nsForbidden')
  const h2 = makeHarness()
  assert.equal(await h2.call('POST', '/api/cluster-certs'), false)
  assert.equal(await h2.call('GET', '/api/other'), false)
  assert.equal(h2.sent.length, 0)
})

test('上游失败 → 502 透出 message;无 message 兜底 api.clusterCertsFailed', async () => {
  const sent = []
  const routes = createClusterCertsRoutes({
    sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    msg: (req, code) => code,
    clusterCerts: { getCertsReport: async () => { throw Object.assign(new Error('boom'), { status: 502 }) } },
    k8sGate: { gateK8sSession: () => true },
    levelForRequest: () => 'view',
  })
  await routes.handle({ method: 'GET', on: () => {}, abSession: {} }, { writeHead: () => {}, end: () => {} }, new URL('http://x/api/cluster-certs'))
  assert.equal(sent[0].status, 502)
  assert.equal(sent[0].json.message, 'boom')

  const routes2 = createClusterCertsRoutes({
    sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    msg: (req, code) => code,
    clusterCerts: { getCertsReport: async () => { throw new Error('') } },
    k8sGate: { gateK8sSession: () => true },
    levelForRequest: () => 'view',
  })
  await routes2.handle({ method: 'GET', on: () => {}, abSession: {} }, { writeHead: () => {}, end: () => {} }, new URL('http://x/api/cluster-certs'))
  assert.equal(sent[1].json.message, 'api.clusterCertsFailed')
})

test('ROUTE_AUTH 登记:GET /api/cluster-certs → session(门外不 404)', () => {
  assert.equal(authClassFor('GET', '/api/cluster-certs'), 'session')
})
