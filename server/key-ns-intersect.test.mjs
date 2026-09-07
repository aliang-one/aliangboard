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
import { resolveApiKey, createApiKeyTools } from './api-key-tools.mjs'
import { createAuditSchema } from './audit.mjs'

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

// W2 审计 P0-②(2026-09-07):交集档位映射 + 部分收权接入执行面。
// 原状:resolveApiKey 算出 _nsScope 但零消费方——runBoundedTool 仍用 key 自身 ns 集,
// 部分收权是死代码;交集也忽略 grant 档位(operator key 在 owner 仅 view 的 ns 照跑 operator)。
test('档位映射:operator key 在 owner 仅 view 的 ns → 该 ns 不入 _nsScope', () => {
  const db = makeAuthzDb()
  const k = seedKeyDb(db, { tier: 'operator', boundSA_namespace: 'team-b', allowed_namespaces: JSON.stringify(['team-a']) })
  const row = resolveApiKey(db, reqOf(k))
  assert.ok(row)
  assert.deepEqual([...row._nsScope], ['team-b'], 'team-a owner 仅 view,低于 operator 所需 operate 档 → 剔除')
})

test('e2e 部分收权:owner 失去 team-b 后经 key 调 team-b → 触网前 PERMISSION_DENIED;team-a 正常过 ns 门', async () => {
  const db = makeAuthzDb()
  createAuditSchema(db) // 正控会走到 reserveAudit(过门后)
  const k = seedKeyDb(db)
  db.prepare("DELETE FROM ns_grants WHERE subjectId='u1' AND namespace='team-b'").run()
  const row = resolveApiKey(db, reqOf(k))
  assert.ok(row, 'team-a 交集仍在,key 存活(部分收权不一失全失)')

  let net = 0
  const netMarker = async () => { net++; throw new Error('NET_MARKER') }
  const { callTool } = createApiKeyTools({ db, requestFn: netMarker, execFn: netMarker, applyYamlFn: netMarker, ephemeralFn: netMarker })
  const cluster = { apiServer: 'https://k8s' }

  // owner 已失权的 ns:拒绝必须发生在触网之前
  await assert.rejects(
    () => callTool(row, cluster, 'list_resources', { kind: 'pods', namespace: 'team-b' }, 'mcp'),
    (e) => e.code === 'PERMISSION_DENIED' && /team-b/.test(e.detail || e.message),
  )
  assert.equal(net, 0, '失权 ns 的拒绝必须先于任何网络出站')

  // 正控:owner 仍有权的 ns 过 ns 门(到达网络阶段即证明门放行;NET_MARKER 即边界)
  await assert.rejects(
    () => callTool(row, cluster, 'list_resources', { kind: 'pods', namespace: 'team-a' }, 'mcp'),
    /NET_MARKER/,
  )
  assert.equal(net, 1)
})
