import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

// Test factory: mirrors production schema in server/index.mjs (Task 1).
// Reused by Task 2+ tests and T3/T4.
export function makeAuthzDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, username TEXT UNIQUE, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0, createdAt INTEGER)`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT UNIQUE, apiServer TEXT NOT NULL, nsAuthMode TEXT DEFAULT 'open')`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, PRIMARY KEY(userId,clusterId))`)
  db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, createdBy TEXT)`)
  db.exec(`CREATE TABLE group_members (groupId TEXT NOT NULL, userId TEXT NOT NULL, addedBy TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(groupId,userId))`)
  db.exec(`CREATE TABLE ns_grants (id TEXT PRIMARY KEY, subjectType TEXT NOT NULL, subjectId TEXT NOT NULL, clusterId TEXT NOT NULL, namespace TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'view', grantedBy TEXT, grantedAt INTEGER NOT NULL, UNIQUE(subjectType,subjectId,clusterId,namespace))`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(userId)`)
  return db
}

test('schema:唯一约束生效(重复成员/重复授权均抛)', () => {
  const db = makeAuthzDb()
  db.prepare("INSERT INTO groups VALUES ('g1','grp-a',1,'root')").run()
  db.prepare("INSERT INTO group_members VALUES ('g1','u1',null,1)").run()
  assert.throws(() => db.prepare("INSERT INTO group_members VALUES ('g1','u1',null,2)").run())
  db.prepare("INSERT INTO ns_grants VALUES ('n1','group','g1','c1','team-a','view',null,1)").run()
  assert.throws(() => db.prepare("INSERT INTO ns_grants VALUES ('n2','group','g1','c1','team-a','operate',null,2)").run())
})

// === Task 2: authz.mjs 决策函数 ===
import { effectiveGrants, canAccessCluster, canAccessNs, levelForRequest, sweepOrphanGrants } from './authz.mjs'

// 夹具:u1(user,分配 c1+c2,直接 grant team-a:view,组 g1(grant team-b:operate)成员);
// u2(分配 c1,无 grant);a1(admin);c1=allowlist,c2=open,u1 也分配 c2
function seedGrants(db) {
  const ins = {
    user: db.prepare('INSERT INTO platform_users VALUES (?,?,?,?,?)'),
    cluster: db.prepare('INSERT INTO clusters VALUES (?,?,?,?)'),
    uc: db.prepare('INSERT INTO user_clusters VALUES (?,?)'),
    grant: db.prepare('INSERT INTO ns_grants VALUES (?,?,?,?,?,?,?,?)'),
    group: db.prepare('INSERT INTO groups VALUES (?,?,?,?)'),
    member: db.prepare('INSERT INTO group_members VALUES (?,?,?,?)'),
  }
  ins.user.run('u1', 'user1', 'user', 0, 1)
  ins.user.run('u2', 'user2', 'user', 0, 1)
  ins.user.run('a1', 'admin1', 'admin', 0, 1)
  ins.user.run('u3', 'user3', 'user', 1, 1) // disabled
  ins.cluster.run('c1', 'allowlist-one', 'https://k8s', 'allowlist')
  ins.cluster.run('c2', 'open-one', 'https://k8s', 'open')
  ins.cluster.run('c3', 'allowlist-two', 'https://k8s', 'allowlist')
  ins.uc.run('u1', 'c1')
  ins.uc.run('u1', 'c2')
  ins.uc.run('u2', 'c1')
  ins.group.run('g1', 'grp-a', 1, 'root')
  ins.member.run('g1', 'u1', 'root', 1)
  ins.grant.run('n1', 'user', 'u1', 'c1', 'team-a', 'view', 'root', 1)
  ins.grant.run('n2', 'group', 'g1', 'c1', 'team-b', 'operate', 'root', 1)
}

test('四态:直接授权/组授权取高档/admin 全量/open 模式不参与', () => {
  const db = makeAuthzDb()
  seedGrants(db)
  const g = effectiveGrants(db, { userId: 'u1', role: 'user' })
  assert.equal(g.clusters.get('c1').ns.get('team-a'), 'view')   // 直接
  assert.equal(g.clusters.get('c1').ns.get('team-b'), 'operate') // 组,高档
  assert.equal(canAccessNs(db, { userId: 'u1', role: 'user' }, 'c1', 'team-a', 'view'), true)
  assert.equal(canAccessNs(db, { userId: 'u1', role: 'user' }, 'c1', 'team-a', 'operate'), false) // 档位不足
  assert.equal(canAccessNs(db, { userId: 'u1', role: 'user' }, 'c1', 'team-x', 'view'), false)   // 未授权
  assert.equal(canAccessNs(db, { userId: 'u1', role: 'user' }, 'c2', 'anything', 'view'), true)  // open 模式全通
  assert.equal(canAccessCluster(db, { userId: 'u1', role: 'user' }, 'c1'), true)
  assert.equal(canAccessCluster(db, { userId: 'u1', role: 'user' }, 'c9'), false) // 未分配
  assert.equal(canAccessNs(db, { userId: 'a1', role: 'admin' }, 'c1', 'whatever', 'operate'), true)
  assert.equal(canAccessNs(db, null, 'c1', 'team-a', 'view'), false) // 匿名
})

test('禁用用户 → 空 grants;admin principal → ALL 内部态', () => {
  const db = makeAuthzDb(); seedGrants(db)
  assert.equal(canAccessCluster(db, { userId: 'u1', role: 'user' }, 'c3'), false) // 分配了才可见:c3 未分配
  assert.equal(canAccessNs(db, { userId: 'u3', role: 'user' }, 'c1', 'team-a', 'view'), false) // disabled
  const a = effectiveGrants(db, { userId: 'a1', role: 'admin' })
  assert.deepEqual({ role: a.role, clusters: a.clusters }, { role: 'admin', clusters: 'ALL' })
  assert.equal(canAccessCluster(db, { userId: 'a1', role: 'admin' }, 'c9'), true)
})

test('sweepOrphanGrants:删用户/组后残留行被清', () => {
  const db = makeAuthzDb(); seedGrants(db)
  db.prepare("DELETE FROM platform_users WHERE id='u1'").run()
  db.prepare("DELETE FROM groups WHERE id='g1'").run()
  const r = sweepOrphanGrants(db)
  assert.ok(r.members >= 1 && r.grants >= 1)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM ns_grants WHERE subjectId IN ('u1','g1')").get().c, 0)
})

test('levelForRequest:GET→view;写→operate;exec 子资源→operate', () => {
  assert.equal(levelForRequest('GET'), 'view')
  assert.equal(levelForRequest('POST'), 'operate')
  assert.equal(levelForRequest('GET', 'exec'), 'operate')
  assert.equal(levelForRequest('GET', 'logs'), 'operate')
})
