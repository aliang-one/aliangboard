// /api/admin/presence-config 契约:GET 默认值+来源(default/db);PUT 数字校验(非数字 400)、
// clamp(99→20/0→1)、持久化(写回 platform_settings)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createWorkbenchSchema } from './workbench-projects.mjs'
import { createAdminRoutes } from './routes/admin.mjs'

function makeHarness({ requireAdmin } = {}) {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  db.exec(`CREATE TABLE IF NOT EXISTS platform_settings ( key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER NOT NULL )`)
  const sent = []
  let body = {}
  const res = { writeHead: () => {}, end: () => {} }
  const getSetting = k => db.prepare('SELECT value FROM platform_settings WHERE key=?').get(k)?.value
  const setSetting = (k, v) => db.prepare('INSERT INTO platform_settings (key,value,updatedAt) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt').run(k, String(v), Date.now())
  const routes = createAdminRoutes({
    db, sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    readBody: async () => body, requireAdmin: requireAdmin || (() => ({ userId: 'u1', role: 'admin' })),
    getSetting, setSetting,
  })
  return { db, sent, setBody: b => { body = b }, call: (m, p) => routes.handle({ method: m, on: () => {} }, res, new URL(`http://x${p}`)) }
}

test('GET:无配置 → 默认 5/30,来源 default', async () => {
  const h = makeHarness()
  assert.ok(await h.call('GET', '/api/admin/presence-config'))
  assert.deepEqual(h.sent[0].json, { maxItems: 5, windowMin: 30, maxItemsSource: 'default', windowMinSource: 'default' })
})

test('PUT:合法数字持久化,GET 回 db 来源', async () => {
  const h = makeHarness()
  h.setBody({ maxItems: 8, windowMin: 45 })
  assert.ok(await h.call('PUT', '/api/admin/presence-config'))
  assert.equal(h.sent[0].status, 200)
  await h.call('GET', '/api/admin/presence-config')
  assert.deepEqual(h.sent[1].json, { maxItems: 8, windowMin: 45, maxItemsSource: 'db', windowMinSource: 'db' })
})

test('PUT:clamp(99→20、0→1)', async () => {
  const h = makeHarness()
  h.setBody({ maxItems: 99, windowMin: 0 })
  await h.call('PUT', '/api/admin/presence-config')
  await h.call('GET', '/api/admin/presence-config')
  assert.equal(h.sent[1].json.maxItems, 20)
  assert.equal(h.sent[1].json.windowMin, 1)
})

test('PUT:非数字/缺字段 → 400,不落库', async () => {
  const h = makeHarness()
  h.setBody({ maxItems: 'abc' })
  await h.call('PUT', '/api/admin/presence-config')
  assert.equal(h.sent[0].status, 400)
  await h.call('GET', '/api/admin/presence-config')
  assert.equal(h.sent[1].json.maxItemsSource, 'default')
})

test('requireAdmin 拒绝', async () => {
  const h = makeHarness({ requireAdmin: (req, res) => { res.writeHead(403, {}); res.end(); return null } })
  assert.ok(await h.call('GET', '/api/admin/presence-config'))
  assert.equal(h.sent.length, 0)
})
