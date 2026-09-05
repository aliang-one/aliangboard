// admin 安全策略端点(2026-09-04 Wave1 §3.3/§3.7):token-policy GET/PUT 与 password-policy PUT 校验。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createAdminRoutes } from './routes/admin.mjs'
import { createAuditSchema } from './audit.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  createAuditSchema(db)
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, username TEXT UNIQUE, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0, createdAt INTEGER)`)
  return db
}

function makeRoutes(db, { role = 'admin' } = {}) {
  const sent = []
  const store = new Map()
  const deps = {
    db, sendJson: (_r, s, p) => sent.push({ status: s, payload: p }), readBody: async (req) => req._body,
    requireAdmin: (req) => (req._ps?.role === 'admin' ? req._ps : (sent.push({ status: 401, payload: {} }), null)),
    getSetting: (k) => store.get(k) ?? null, setSetting: (k, v) => store.set(k, String(v)),
    writeAudit: () => {}, platformSessions: new Map(), sessions: new Map(),
  }
  return { routes: createAdminRoutes(deps), sent, store, role }
}

const ADMIN = { _ps: { userId: 'a1', username: 'root', role: 'admin' } }

test('token-policy:GET 初始 90;PUT 30 落 store;PUT 0/400/NaN 400', async () => {
  const db = makeDb(); const { routes, sent, store } = makeRoutes(db)
  const call = (method, body) => routes.handle({ ...ADMIN, method, _body: body }, {}, new URL('http://x/api/admin/token-policy'))
  await call('GET')
  assert.deepEqual(sent.at(-1).payload, { maxTtlDays: 90 })
  await call('PUT', { maxTtlDays: 30 })
  assert.equal(sent.at(-1).status, 200); assert.equal(store.get('apikey.maxTtlDays'), '30')
  await call('PUT', { maxTtlDays: 0 }); assert.equal(sent.at(-1).status, 400)
  await call('PUT', { maxTtlDays: 400 }); assert.equal(sent.at(-1).status, 400)
  await call('PUT', { maxTtlDays: NaN }); assert.equal(sent.at(-1).status, 400)
  await call('GET'); assert.deepEqual(sent.at(-1).payload, { maxTtlDays: 30 })
})

test('token-policy:非 admin 401(requireAdmin stub 返 null)', async () => {
  const db = makeDb(); const { routes, sent } = makeRoutes(db)
  await routes.handle({ _ps: { userId: 'u1', username: 'bob', role: 'user' }, method: 'PUT', _body: { maxTtlDays: 30 } }, {}, new URL('http://x/api/admin/token-policy'))
  assert.equal(sent.at(-1).status, 401)
})

test('password-policy PUT:minLength<8 400;合法落 JSON;GET 回显归一化策略', async () => {
  const db = makeDb(); const { routes, sent, store } = makeRoutes(db)
  const put = (body) => routes.handle({ ...ADMIN, method: 'PUT', _body: body }, {}, new URL('http://x/api/admin/password-policy'))
  const get = () => routes.handle({ ...ADMIN, method: 'GET' }, {}, new URL('http://x/api/admin/password-policy'))
  await put({ minLength: 3 }); assert.equal(sent.at(-1).status, 400)
  await put({ minLength: 12, requireDigit: true }); assert.equal(sent.at(-1).status, 200)
  assert.deepEqual(JSON.parse(store.get('auth.passwordPolicy')), { minLength: 12, requireMixed: false, requireDigit: true, requireSymbol: false })
  await get(); assert.equal(sent.at(-1).payload.policy.minLength, 12)
})
