// T4 测试:API key 签发/查询/吊销(内存 sqlite,零外部依赖)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import {
  createApiKeysSchema, hashKey, generateKeyPlaintext,
  mintKey, lookupKey, isActive, revokeKey, listKeys, setKeySaBinding,
} from './auth-keys.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  return db
}

test('hashKey: 确定性 + 不同输入不同 hash + 已知向量', () => {
  assert.equal(hashKey('abc'), hashKey('abc'))
  assert.notEqual(hashKey('abc'), hashKey('abd'))
  assert.equal(hashKey('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('generateKeyPlaintext: 高熵、base64url 字符集、每次不同', () => {
  const a = generateKeyPlaintext(), b = generateKeyPlaintext()
  assert.notEqual(a, b)
  assert.ok(a.length >= 40 && a.length <= 44, `base64url(32B) 长度 ~43,实际 ${a.length}`)
  assert.match(a, /^[A-Za-z0-9_-]+$/, '应为 base64url 字符集')
})

test('mintKey: 明文一次性返回;库里只存 hash(非明文);tier 默认 read;prefix 对', () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  assert.ok(k.plaintext && k.plaintext.length >= 40, '明文应返回')
  assert.equal(k.tier, 'read', '默认 tier=read')
  assert.equal(k.prefix, k.plaintext.slice(0, 8))
  assert.ok(k.id && k.createdAt)
  // 库里只存 hash,明文不入库
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(k.id)
  assert.equal(row.keyHash, hashKey(k.plaintext))
  assert.notEqual(row.keyHash, k.plaintext, 'hash ≠ 明文')
})

test('mintKey: 非法 tier / 缺必填字段 抛错', () => {
  const db = makeDb()
  assert.throws(() => mintKey(db, { owner: 'a', clusterId: 'c', boundSA_namespace: 'n', boundSA_name: 's', tier: 'god' }), /非法 tier/)
  assert.throws(() => mintKey(db, { owner: 'a' }), /必填字段/)
})

test('lookupKey: 正确明文命中、错误/空明文返回 null', () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const hit = lookupKey(db, k.plaintext)
  assert.ok(hit && hit.id === k.id)
  assert.equal(lookupKey(db, 'wrong-key'), null)
  assert.equal(lookupKey(db, ''), null)
  assert.equal(lookupKey(db, null), null)
})

test('revokeKey: 幂等;吊销后行仍在(可追溯)但 isActive=false', () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  assert.ok(isActive(lookupKey(db, k.plaintext)), '新 key active')
  assert.equal(revokeKey(db, k.id), true, '首次吊销 true')
  assert.equal(revokeKey(db, k.id), false, '重复吊销幂等 false')
  const row = lookupKey(db, k.plaintext)
  assert.ok(row, '吊销后行仍在')
  assert.equal(isActive(row), false)
})

test('listKeys: 不含 keyHash/明文,只 prefix;按 owner 过滤;按时间倒序', () => {
  const db = makeDb()
  const a = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const b = mintKey(db, { owner: 'bob', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const all = listKeys(db)
  assert.equal(all.length, 2)
  assert.equal(all[0].createdAt >= all[1].createdAt, true, '倒序')
  for (const r of all) {
    assert.ok(!('keyHash' in r), 'listKeys 不返回 keyHash')
    assert.ok(!('plaintext' in r), 'listKeys 不返回明文')
    assert.ok('prefix' in r)
  }
  assert.equal(listKeys(db, { owner: 'alice' }).map(r => r.id)[0], a.id)
  assert.equal(listKeys(db, { owner: 'bob' }).length, 1)
})

// --- Task 2: tool_overrides 承载(per-tool 权限覆盖)---
test('mintKey: tool_overrides 合法 → 存规范 JSON 串;listKeys/lookupKey 回带', () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'admin', tool_overrides: { deny: ['delete_resource'] } })
  assert.equal(k.tool_overrides, JSON.stringify({ deny: ['delete_resource'] }))
  const row = listKeys(db)[0]
  assert.equal(row.tool_overrides, JSON.stringify({ deny: ['delete_resource'] }))
  const byLookup = lookupKey(db, k.plaintext)
  assert.equal(byLookup.tool_overrides, JSON.stringify({ deny: ['delete_resource'] }))
})

test('mintKey: 无 tool_overrides → 列为 null', () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  assert.equal(k.tool_overrides, null)
  assert.equal(listKeys(db)[0].tool_overrides, null)
})

test('mintKey: 非法 tool_overrides(未知名/allow∩deny)→ 抛,不建 key', () => {
  const db = makeDb()
  assert.throws(() => mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tool_overrides: { allow: ['bogus'] } }), /未知工具/)
  assert.throws(() => mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tool_overrides: { allow: ['exec_pod'], deny: ['exec_pod'] } }), /不能同时/)
  assert.equal(listKeys(db).length, 0, '失败不建 key')
})

test('schema 幂等: 重复 createApiKeysSchema 不报错(tool_overrides 列已存在)', () => {
  const db = makeDb()
  assert.doesNotThrow(() => createApiKeysSchema(db))  // 二次调用
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tool_overrides: { allow: ['scale'] } })
  assert.ok(k.id)
})

// --- Task 2: allowed_namespaces 承载(跨 ns allowlist)---
test('mintKey: allowed_namespaces 合法 → 存 JSON 串;listKeys 回带', () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'anydoor', boundSA_name: 'sa', allowed_namespaces: ['dev', 'staging'] })
  assert.equal(k.allowed_namespaces, JSON.stringify(['dev', 'staging']))
  assert.equal(listKeys(db)[0].allowed_namespaces, JSON.stringify(['dev', 'staging']))
})
test('mintKey: 无 allowed_namespaces → 列为 null(向后兼容)', () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  assert.equal(k.allowed_namespaces, null); assert.equal(listKeys(db)[0].allowed_namespaces, null)
})
test('mintKey: 非法 ns 名 → 抛,不建 key', () => {
  const db = makeDb()
  assert.throws(() => mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', allowed_namespaces: ['BAD_ns'] }), /非法 namespace/)
  assert.equal(listKeys(db).length, 0, '失败不建 key')
})
test('schema 幂等: 二次 createApiKeysSchema 不报错', () => {
  const db = makeDb()
  assert.doesNotThrow(() => createApiKeysSchema(db))
})

// --- 托管列 + 可选 id + 改绑(Task: managed SA lifecycle)---
test('旧库无 saManaged 列 → createApiKeysSchema ALTER 补列,默认 0(BYO)', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE api_keys (id TEXT PRIMARY KEY, keyHash TEXT NOT NULL UNIQUE, prefix TEXT, owner TEXT NOT NULL,
    clusterId TEXT NOT NULL, boundSA_namespace TEXT NOT NULL, boundSA_name TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'read',
    tool_overrides TEXT, allowed_namespaces TEXT, label TEXT, createdBy TEXT, createdAt INTEGER NOT NULL, revokedAt INTEGER)`)
  createApiKeysSchema(db) // ALTER 补列
  const k = mintKey(db, { owner: 'a', clusterId: 'c', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  assert.equal(lookupKey(db, k.plaintext).saManaged, 0)
})

test('mintKey 接受可选 id + saManaged=1,原样落库并回传', () => {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const k = mintKey(db, { id: 'fixed-id-1', owner: 'a', clusterId: 'c', boundSA_namespace: 'ns', boundSA_name: 'sa', saManaged: 1 })
  assert.equal(k.id, 'fixed-id-1')
  const row = lookupKey(db, k.plaintext)
  assert.equal(row.id, 'fixed-id-1')
  assert.equal(row.saManaged, 1)
})

test('setKeySaBinding:改绑 ns/name/managed;已吊销 → false', () => {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const k = mintKey(db, { owner: 'a', clusterId: 'c', boundSA_namespace: 'ns', boundSA_name: 'old' })
  assert.equal(setKeySaBinding(db, k.id, { namespace: 'ns', name: 'aliangboard-mcp-11111111', managed: true }), true)
  const row = lookupKey(db, k.plaintext)
  assert.equal(row.boundSA_name, 'aliangboard-mcp-11111111')
  assert.equal(row.saManaged, 1)
  revokeKey(db, k.id)
  assert.equal(setKeySaBinding(db, k.id, { namespace: 'ns', name: 'x', managed: false }), false)
})
