// W2 Phase C Task 1: key 请求时 ns 部分收权 —— resolveApiKey 第四段。
// owner 非 admin 且 key 所绑集群 nsAuthMode='allowlist' 时:
//   key effectiveNamespaces ∩ owner effectiveGrants 该集群 ns;
//   交集空 → null(key 即刻失效);否则 row._nsScope = Set(交集)。
// 服务 key(admin)/admin owner/open 集群 → 行为不变,无 _nsScope。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { makeAuthzDb } from './authz.test.mjs'
import { createApiKeysSchema, mintKey } from './auth-keys.mjs'
import { resolveApiKey } from './api-key-tools.mjs'

// 夹具:u1(user)分配 c1(allowlist,grant team-a/team-b)+ c2(open);
// a1(admin);key 默认绑 c1 boundNS=team-a,额外 ns team-b。
function seedKeyDb(db, keyOverrides = {}) {
  createApiKeysSchema(db)
  const ins = {
    user: db.prepare('INSERT INTO platform_users VALUES (?,?,?,?,?)'),
    cluster: db.prepare('INSERT INTO clusters VALUES (?,?,?,?)'),
    uc: db.prepare('INSERT INTO user_clusters VALUES (?,?)'),
    grant: db.prepare('INSERT INTO ns_grants VALUES (?,?,?,?,?,?,?,?)'),
  }
  ins.user.run('u1', 'user1', 'user', 0, 1)
  ins.user.run('a1', 'admin1', 'admin', 0, 1)
  ins.cluster.run('c1', 'allowlist-one', 'https://k8s', 'allowlist')
  ins.cluster.run('c2', 'open-one', 'https://k8s', 'open')
  ins.uc.run('u1', 'c1')
  ins.uc.run('u1', 'c2')
  ins.grant.run('n1', 'user', 'u1', 'c1', 'team-a', 'view', 'root', 1)
  ins.grant.run('n2', 'user', 'u1', 'c1', 'team-b', 'operate', 'root', 1)
  const key = mintKey(db, {
    owner: 'user1', clusterId: 'c1', boundSA_namespace: 'team-a', boundSA_name: 'sa',
    allowed_namespaces: JSON.stringify(['team-b']), ownerUserId: 'u1', ...keyOverrides,
  })
  return key
}
const reqOf = (k) => ({ headers: { authorization: `Bearer ${k.plaintext}` } })

test('部分交集:key 存活且 _nsScope = key ns ∩ owner grants', () => {
  const db = makeAuthzDb()
  const k = seedKeyDb(db) // key ns {team-a, team-b} ∩ grants {team-a, team-b} = 全集也走交集路径
  const row = resolveApiKey(db, reqOf(k))
  assert.ok(row)
  assert.ok(row._nsScope instanceof Set)
  assert.deepEqual([...row._nsScope].sort(), ['team-a', 'team-b'])
})

test('部分交集:owner 只剩 team-a → _nsScope 只剩 team-a', () => {
  const db = makeAuthzDb()
  const k = seedKeyDb(db)
  db.prepare("DELETE FROM ns_grants WHERE subjectId='u1' AND namespace='team-b'").run()
  const row = resolveApiKey(db, reqOf(k))
  assert.ok(row)
  assert.deepEqual([...row._nsScope], ['team-a'])
})

test('交集空:owner 失去 key 全部 ns → null(key 即刻失效)', () => {
  const db = makeAuthzDb()
  const k = seedKeyDb(db)
  db.prepare("DELETE FROM ns_grants WHERE subjectId='u1'").run()
  assert.equal(resolveApiKey(db, reqOf(k)), null)
})

test('open 集群:行为不变,无 _nsScope', () => {
  const db = makeAuthzDb()
  const k = seedKeyDb(db, { clusterId: 'c2', boundSA_namespace: 'team-a' })
  const row = resolveApiKey(db, reqOf(k))
  assert.ok(row)
  assert.equal(row._nsScope, undefined)
})

test('服务 key(无 ownerUserId):行为不变,无 _nsScope', () => {
  const db = makeAuthzDb()
  const k = seedKeyDb(db, { ownerUserId: null })
  const row = resolveApiKey(db, reqOf(k))
  assert.ok(row)
  assert.equal(row._nsScope, undefined)
})

test('admin owner:行为不变,无 _nsScope(即使集群 allowlist)', () => {
  const db = makeAuthzDb()
  const k = seedKeyDb(db, { ownerUserId: 'a1', owner: 'admin1' })
  const row = resolveApiKey(db, reqOf(k))
  assert.ok(row)
  assert.equal(row._nsScope, undefined)
})
