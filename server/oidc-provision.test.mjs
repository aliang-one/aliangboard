// Wave 4 OIDC Task 3:JIT 建户 + claims 驱动组同步(oidc-provision.mjs,纯函数 + db 注入)。
// 夹具库镜像 index.mjs 迁移后的 platform_users 全列(authProvider/oidcSubject 两新列)+ groups/group_members。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { oidcSubjectOf, upsertOidcUser, syncGroupsFromClaims } from './oidc-provision.mjs'

export function makeProvisionDb() {
  const db = new DatabaseSync(':memory:')
  // 镜像 index.mjs 真实 DDL(审 1 Critical:passwordHash **NOT NULL**——夹具曾声明成可空,
  // 掩蔽了 JIT INSERT 传 NULL 在生产库必炸的回归;此处钉死真实约束)。
  db.exec(`CREATE TABLE platform_users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', displayName TEXT, createdAt INTEGER NOT NULL,
    disabled INTEGER DEFAULT 0, prefs TEXT,
    authProvider TEXT NOT NULL DEFAULT 'local', oidcSubject TEXT
  )`)
  db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, createdBy TEXT)`)
  db.exec(`CREATE TABLE group_members (groupId TEXT NOT NULL, userId TEXT NOT NULL, addedBy TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY (groupId, userId))`)
  db.exec(`CREATE UNIQUE INDEX idx_users_oidc_subject ON platform_users(oidcSubject)`)
  return db
}

const ISS = 'https://idp.example.com'

// === oidcSubjectOf ===
test('oidcSubjectOf:issuer|sub 拼接', () => {
  assert.equal(oidcSubjectOf(ISS, 'sub-1'), `${ISS}|sub-1`)
})

// === upsertOidcUser 三路 ===
test('upsert:新 subject → INSERT(authProvider=oidc,passwordHash=不可登录哨兵哈希,NOT NULL 约束下成功)', () => {
  const db = makeProvisionDb()
  const out = upsertOidcUser(db, { issuer: ISS, sub: 's1', username: 'alice', displayName: 'Alice A' })
  const row = db.prepare('SELECT * FROM platform_users WHERE oidcSubject=?').get(`${ISS}|s1`)
  assert.ok(out.user)
  assert.equal(out.user.id, row.id)
  assert.equal(row.username, 'alice')
  assert.equal(row.authProvider, 'oidc')
  // 审 1 Critical:生产 DDL passwordHash NOT NULL——存 hashPassword(randomUUID()) 哨兵
  // (随机 UUID 派生的 scrypt 哈希,口令无人知晓 → 本地密码登录恒 verify 失败)。
  // 注:verifyPassword 失败路径不可在此测(登录验证逻辑在 routes/auth 侧),哨兵格式钉死即够。
  assert.match(row.passwordHash, /^[0-9a-f]{32}:[0-9a-f]{128}:16384:8:1$/, 'scrypt 哨兵哈希(salt:hash:N:r:p)')
  assert.equal(row.displayName, 'Alice A')
  assert.equal(row.role, 'user')
})

test('upsert:hashPassword/randomUUID 可注入(生产接线点,Task 4 显式传或用缺省)', () => {
  const db = makeProvisionDb()
  const out = upsertOidcUser(db, { issuer: ISS, sub: 's1', username: 'alice', displayName: null }, {
    hashPassword: (pw) => `sentinel(${pw})`, randomUUID: () => 'fixed-uuid',
  })
  assert.equal(out.user.id, 'fixed-uuid')
  assert.equal(out.user.passwordHash, 'sentinel(fixed-uuid)')
})

test('upsert:已知 subject → UPDATE displayName(用户名不动,不建新行)', () => {
  const db = makeProvisionDb()
  upsertOidcUser(db, { issuer: ISS, sub: 's1', username: 'alice', displayName: 'Old Name' })
  const firstId = db.prepare('SELECT id FROM platform_users WHERE oidcSubject=?').get(`${ISS}|s1`).id
  const out = upsertOidcUser(db, { issuer: ISS, sub: 's1', username: 'alice', displayName: 'New Name' })
  assert.equal(out.user.displayName, 'New Name')
  assert.equal(out.user.id, firstId)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM platform_users').get().c, 1)
  assert.equal(out.user.username, 'alice')
})

test('upsert:username 被本地用户占用 → { error: usernameTaken },库零变更(不接管)', () => {
  const db = makeProvisionDb()
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u-local','bob','hash','user',1)").run()
  const out = upsertOidcUser(db, { issuer: ISS, sub: 's9', username: 'bob', displayName: 'Bob IdP' })
  assert.deepEqual(out, { error: 'usernameTaken' })
  const bob = db.prepare('SELECT * FROM platform_users WHERE username=?').get('bob')
  assert.equal(bob.id, 'u-local') // 本地用户原样
  assert.equal(db.prepare('SELECT COUNT(*) c FROM platform_users').get().c, 1)
})

test('upsert:username 被另一 OIDC 用户占用 → 同样 usernameTaken(UNIQUE 前置拦)', () => {
  const db = makeProvisionDb()
  upsertOidcUser(db, { issuer: ISS, sub: 's1', username: 'alice', displayName: 'Alice' })
  const out = upsertOidcUser(db, { issuer: ISS, sub: 's2', username: 'alice', displayName: 'Fake Alice' })
  assert.deepEqual(out, { error: 'usernameTaken' })
  assert.equal(db.prepare('SELECT COUNT(*) c FROM platform_users').get().c, 1)
})

// === syncGroupsFromClaims ===
test('syncGroups 首次:建组(createdBy=oidc)+ 成员(addedBy=oidc),created=2', () => {
  const db = makeProvisionDb()
  const { user } = upsertOidcUser(db, { issuer: ISS, sub: 's1', username: 'alice', displayName: 'Alice' })
  const out = syncGroupsFromClaims(db, user.id, ['dev', 'ops'])
  assert.equal(out.created, 2)
  const groups = db.prepare('SELECT name, createdBy FROM groups ORDER BY name').all()
  assert.deepEqual(groups.map((g) => g.name), ['dev', 'ops'])
  assert.ok(groups.every((g) => g.createdBy === 'oidc'))
  const members = db.prepare('SELECT groupId FROM group_members WHERE userId=?').all(user.id)
  assert.equal(members.length, 2)
  const addedBy = db.prepare('SELECT addedBy FROM group_members WHERE userId=?').all(user.id)
  assert.ok(addedBy.every((m) => m.addedBy === 'oidc'))
})

test('syncGroups 二次变更组:增减全量对齐(增 qa 删 dev 留 ops),组行保留', () => {
  const db = makeProvisionDb()
  const { user } = upsertOidcUser(db, { issuer: ISS, sub: 's1', username: 'alice', displayName: 'Alice' })
  syncGroupsFromClaims(db, user.id, ['dev', 'ops'])
  const out = syncGroupsFromClaims(db, user.id, ['ops', 'qa']) // dev 出,qa 入
  assert.equal(out.created, 1) // 只新建 qa
  const names = db.prepare('SELECT g.name FROM group_members m JOIN groups g ON g.id=m.groupId WHERE m.userId=? ORDER BY g.name').all(user.id)
  assert.deepEqual(names.map((n) => n.name), ['ops', 'qa'])
  assert.equal(db.prepare("SELECT COUNT(*) c FROM groups WHERE name='dev'").get().c, 1) // 组行不删(可能还有授权引用)
})

test('syncGroups 他人成员不被误删(DELETE 只打本 userId)', () => {
  const db = makeProvisionDb()
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u-b','bob','h','user',1)").run()
  const { user } = upsertOidcUser(db, { issuer: ISS, sub: 's1', username: 'alice', displayName: 'Alice' })
  syncGroupsFromClaims(db, user.id, ['dev'])
  db.prepare("INSERT INTO group_members (groupId,userId,addedBy,createdAt) VALUES ((SELECT id FROM groups WHERE name='dev'),'u-b','root',1)").run()
  syncGroupsFromClaims(db, user.id, ['ops']) // alice 离开 dev
  const bobStill = db.prepare("SELECT COUNT(*) c FROM group_members m JOIN groups g ON g.id=m.groupId WHERE m.userId='u-b' AND g.name='dev'").get().c
  assert.equal(bobStill, 1) // bob 仍在 dev
})

test('syncGroups 本地用户 no-op:{created:0},零组零成员', () => {
  const db = makeProvisionDb()
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u-local','bob','h','user',1)").run()
  const out = syncGroupsFromClaims(db, 'u-local', ['dev'])
  assert.deepEqual(out, { created: 0 })
  assert.equal(db.prepare('SELECT COUNT(*) c FROM groups').get().c, 0)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM group_members').get().c, 0)
})

test('syncGroups 重复组名去重(真 IdP 可重复发同组)→ 幂等单成员,不炸 PK', () => {
  const db = makeProvisionDb()
  const { user } = upsertOidcUser(db, { issuer: ISS, sub: 's1', username: 'alice', displayName: 'Alice' })
  const out = syncGroupsFromClaims(db, user.id, ['dev', 'ops', 'dev', 'ops', 'dev'])
  assert.equal(out.created, 2) // 重复条目不计新建
  const names = db.prepare('SELECT g.name FROM group_members m JOIN groups g ON g.id=m.groupId WHERE m.userId=? ORDER BY g.name').all(user.id)
  assert.deepEqual(names.map((n) => n.name), ['dev', 'ops'])
})

test('syncGroups 非 string[] 输入(混型/字符串/null)→ throw,库零变更', () => {
  const db = makeProvisionDb()
  const { user } = upsertOidcUser(db, { issuer: ISS, sub: 's1', username: 'alice', displayName: 'Alice' })
  for (const bad of [['dev', 5], 'dev', null, { 0: 'dev' }]) {
    assert.throws(() => syncGroupsFromClaims(db, user.id, bad), /groups/)
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM groups').get().c, 0)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM group_members').get().c, 0)
})

test('syncGroups 事务性:中途中炸 → 回滚(旧成员保留 + 本轮新组不留孤儿)', () => {
  const db = makeProvisionDb()
  const { user } = upsertOidcUser(db, { issuer: ISS, sub: 's1', username: 'alice', displayName: 'Alice' })
  syncGroupsFromClaims(db, user.id, ['dev']) // 先有一轮成功状态
  // 成员 INSERT 前炸:DELETE 已跑,靠事务回滚保住旧成员;本轮新组 qa 的 INSERT 也要一起回滚
  db.exec(`CREATE TRIGGER boom_member BEFORE INSERT ON group_members BEGIN SELECT RAISE(ABORT, 'boom'); END`)
  assert.throws(() => syncGroupsFromClaims(db, user.id, ['dev', 'qa']), /boom/)
  const still = db.prepare("SELECT COUNT(*) c FROM group_members m JOIN groups g ON g.id=m.groupId WHERE m.userId=? AND g.name='dev'").get(user.id).c
  assert.equal(still, 1, '旧成员必须回滚保留')
  assert.equal(db.prepare("SELECT COUNT(*) c FROM groups WHERE name='qa'").get().c, 0, '本轮新组不留孤儿')
})
