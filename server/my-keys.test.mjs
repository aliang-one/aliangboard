// 自助访问令牌端点(2026-09-04 Wave1 §3.3):归属过滤 / tier 封顶 / TTL 钳制 / 托管供给 / 归属吊销。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createMyKeyRoutes } from './routes/my-keys.mjs'
import { createApiKeysSchema } from './auth-keys.mjs'
import { lookupKey } from './auth-keys.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, username TEXT UNIQUE, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0, createdAt INTEGER)`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT)`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, apiServer TEXT, authHeader TEXT, ca TEXT, cert TEXT, key TEXT, insecure INTEGER)`)
  createApiKeysSchema(db)
  db.prepare(`INSERT INTO platform_users (id,username,role,createdAt) VALUES ('u1','alice','user',1)`).run()
  db.prepare(`INSERT INTO user_clusters VALUES ('u1','c1')`).run()
  db.prepare(`INSERT INTO clusters (id,apiServer) VALUES ('c1','https://x')`).run()
  return db
}

function makeRoutes(db, over = {}) {
  const sent = []
  const deps = {
    db, sendJson: (_r, status, payload) => sent.push({ status, payload }),
    readBody: async (req) => req._body, requirePlatform: (req) => req._ps,
    randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2), writeAudit: () => {},
    getSetting: () => over._maxTtl ?? null,
    getCluster: (id) => db.prepare('SELECT * FROM clusters WHERE id=?').get(id) || null,
    provisionCluster: over._provision ?? (async () => ({ ok: true })),
    ...over._deps,
  }
  return { routes: createMyKeyRoutes(deps), sent, deps }
}

const REQ = { _ps: { userId: 'u1', username: 'alice', role: 'user' } }

test('POST:托管供给成功 → 200 回明文一次;落库行带 ownerUserId/expiresAt/saManaged', async () => {
  const db = makeDb(); const { routes, sent } = makeRoutes(db)
  const body = { clusterId: 'c1', namespace: 'team-a', tier: 'operator', label: 'ci', ttlDays: 30 }
  await routes.handle({ ...REQ, method: 'POST', _body: body }, {}, new URL('http://x/api/my/keys'))
  assert.equal(sent.at(-1).status, 200)
  const { apikey } = sent.at(-1).payload
  assert.ok(apikey.plaintext && apikey.plaintext.length >= 40)
  const row = lookupKey(db, apikey.plaintext)
  assert.equal(row.ownerUserId, 'u1'); assert.equal(row.saManaged, 1); assert.equal(row.tier, 'operator')
  assert.ok(row.expiresAt > Date.now())
})

test('POST:未分配集群 403;非法 tier 400;非法 ttl 400;供给失败 502 且不留行', async () => {
  const db = makeDb(); const { routes, sent } = makeRoutes(db)
  await routes.handle({ ...REQ, method: 'POST', _body: { clusterId: 'c9', namespace: 'n', tier: 'read' } }, {}, new URL('http://x/api/my/keys'))
  assert.equal(sent.at(-1).status, 403)
  await routes.handle({ ...REQ, method: 'POST', _body: { clusterId: 'c1', namespace: 'n', tier: 'admin' } }, {}, new URL('http://x/api/my/keys'))
  assert.equal(sent.at(-1).status, 400)
  await routes.handle({ ...REQ, method: 'POST', _body: { clusterId: 'c1', namespace: 'n', tier: 'read', ttlDays: 99999 } }, {}, new URL('http://x/api/my/keys'))
  assert.equal(sent.at(-1).status, 200)   // 超上限静默钳到默认 90(controller 裁决:钳制而非 400)
  assert.ok(lookupKey(db, sent.at(-1).payload.apikey.plaintext).expiresAt <= Date.now() + 91 * 86400000)
  const fail = makeRoutes(db, { _provision: async () => ({ ok: false, failed: [{ kind: 'rbac', error: 'boom' }] }) })
  const before = db.prepare('SELECT COUNT(*) c FROM api_keys').get().c
  await fail.routes.handle({ ...REQ, method: 'POST', _body: { clusterId: 'c1', namespace: 'n', tier: 'read' } }, {}, new URL('http://x/api/my/keys'))
  assert.equal(fail.sent.at(-1).status, 502)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM api_keys').get().c, before)   // 先供给后落库:失败无「出生即死亡」key(钳制案例已落 1 行)
})

test('POST:ttl 钳到 maxTtlDays(设置 7 → 999 请求得 ≤7 天)', async () => {
  const db = makeDb(); const { routes, sent } = makeRoutes(db, { _maxTtl: '7' })
  await routes.handle({ ...REQ, method: 'POST', _body: { clusterId: 'c1', namespace: 'n', tier: 'read', ttlDays: 999 } }, {}, new URL('http://x/api/my/keys'))
  const row = lookupKey(db, sent.at(-1).payload.apikey.plaintext)
  assert.ok(row.expiresAt <= Date.now() + 8 * 86400000)
})

test('POST:ttl 超上限静默钳制(未配置上限 90 → 999 请求得 ≤91 天,200 非 400)', async () => {
  const db = makeDb(); const { routes, sent } = makeRoutes(db)
  await routes.handle({ ...REQ, method: 'POST', _body: { clusterId: 'c1', namespace: 'n', tier: 'read', ttlDays: 999 } }, {}, new URL('http://x/api/my/keys'))
  assert.equal(sent.at(-1).status, 200)
  const row = lookupKey(db, sent.at(-1).payload.apikey.plaintext)
  assert.ok(row.expiresAt <= Date.now() + 91 * 86400000)
})

test('POST:ttl 非法(ttlDays 0 / 非数字)→ 400 ttlInvalid', async () => {
  const db = makeDb(); const { routes, sent } = makeRoutes(db)
  await routes.handle({ ...REQ, method: 'POST', _body: { clusterId: 'c1', namespace: 'n', tier: 'read', ttlDays: 0 } }, {}, new URL('http://x/api/my/keys'))
  assert.equal(sent.at(-1).status, 400)
  assert.equal(sent.at(-1).payload.message, '有效期须在 1-90 天内')
  await routes.handle({ ...REQ, method: 'POST', _body: { clusterId: 'c1', namespace: 'n', tier: 'read', ttlDays: 'abc' } }, {}, new URL('http://x/api/my/keys'))
  assert.equal(sent.at(-1).status, 400)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM api_keys').get().c, 0)
})

test('GET:只回自己的(含已吊销);DELETE:归属过滤,他人/不存在 404,成功后 key 失效', async () => {
  const db = makeDb(); const { routes, sent } = makeRoutes(db)
  db.prepare(`INSERT INTO api_keys (id,keyHash,prefix,owner,ownerUserId,clusterId,boundSA_namespace,boundSA_name,createdAt)
              VALUES ('k-mine','h1','p1','alice','u1','c1','n','s',1)`).run()
  db.prepare(`INSERT INTO api_keys (id,keyHash,prefix,owner,ownerUserId,clusterId,boundSA_namespace,boundSA_name,createdAt)
              VALUES ('k-other','h2','p2','bob','u2','c1','n','s',2)`).run()
  await routes.handle({ ...REQ, method: 'GET' }, {}, new URL('http://x/api/my/keys'))
  assert.equal(sent.at(-1).payload.apikeys.length, 1)
  await routes.handle({ ...REQ, method: 'DELETE' }, {}, new URL('http://x/api/my/keys/k-other'))
  assert.equal(sent.at(-1).status, 404)
  await routes.handle({ ...REQ, method: 'DELETE' }, {}, new URL('http://x/api/my/keys/k-mine'))
  assert.equal(sent.at(-1).status, 200)
  assert.ok(db.prepare('SELECT revokedAt FROM api_keys WHERE id=?').get('k-mine').revokedAt > 0)
})
