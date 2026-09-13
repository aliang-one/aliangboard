// /api/admin/state:聚合快照端点(只回计数/水位;值与键永不离开进程)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminRoutes } from './routes/admin.mjs'

function makeRes() {
  return { code: 0, body: null, written(status, payload) { this.code = status; this.body = payload } }
}
const baseDeps = {
  db: { prepare: () => ({ get: () => null, all: () => [], run: () => ({ changes: 0 }) }), exec: () => {} },
  sendJson: (res, status, payload) => { res.written(status, payload) },
  readBody: async () => ({}),
  requireAdmin: () => true,
  stateOverview: () => ({
    ts: 123,
    stores: [{ name: 'mfaTickets', domain: 'auth', primitive: 'ttl', entries: 0 }],
    sweeps: [{ name: 'terminalSweep', cadenceMs: 60000, lastRunAt: 0, lastError: null, runs: 0 }],
  }),
}

test('GET /api/admin/state → 200 聚合快照透传', async () => {
  const routes = createAdminRoutes(baseDeps)
  const res = makeRes()
  const handled = await routes.handle({ method: 'GET' }, res, new URL('http://x/api/admin/state'))
  assert.equal(handled, true)
  assert.equal(res.code, 200)
  assert.equal(res.body.stores[0].name, 'mfaTickets')
  assert.equal(res.body.sweeps[0].cadenceMs, 60000)
})

test('非 GET 方法不命中(405 由通用面处理,本端点只挂 GET)', async () => {
  const routes = createAdminRoutes(baseDeps)
  const res = makeRes()
  const handled = await routes.handle({ method: 'POST' }, res, new URL('http://x/api/admin/state'))
  assert.equal(handled, false)
})
