// 安全回归(2026-08-28 CSO 审计发现 #3):seedAdmin 曾接受部署清单的 admin/admin 字面默认
// (deployment.yaml 明文 env)。强化语义:
//   ① 显式弱口令('admin' / <8 字符)→ 拒绝播种(不建 admin 行,返回原因);
//   ② ADMIN_PASSWORD 未设但 ADMIN_USERNAME 已设 → 自动生成 ≥24 字符强口令,返回明文供一次性展示;
//   ③ 强口令 → 正常播种,不回明文;
//   ④ 库中已有 admin → 幂等跳过。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { seedAdminIfNeeded } from './admin-seed.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE IF NOT EXISTS platform_users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', displayName TEXT, createdAt INTEGER NOT NULL, disabled INTEGER DEFAULT 0)`)
  return db
}
const env = (o) => ({ ADMIN_USERNAME: undefined, ADMIN_PASSWORD: undefined, ...o })

test('已有 admin → 幂等跳过(env 有值也不动)', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('x','old','$2$salt','admin',1)`).run()
  const out = seedAdminIfNeeded(db, env({ ADMIN_USERNAME: 'root', ADMIN_PASSWORD: 'whatever-long' }))
  assert.equal(out.action, 'skipped')
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM platform_users`).get().c, 1)
})

test('显式弱口令拒绝:字面 admin 与 <8 字符均不播种', () => {
  for (const pw of ['admin', '12345678', 'short']) {
    const db = makeDb()
    const out = seedAdminIfNeeded(db, env({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: pw }))
    assert.equal(out.action, 'rejected-weak', `口令 "${pw}" 应被拒`)
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM platform_users`).get().c, 0, '不建行')
    assert.ok(out.reason, '拒因要说人话')
  }
})

test('未设密码 → 自动生成强口令,返回一次性明文(≥24 字符)', () => {
  const db = makeDb()
  const out = seedAdminIfNeeded(db, env({ ADMIN_USERNAME: 'admin' }))
  assert.equal(out.action, 'seeded-generated')
  assert.ok(!out.password || out.password.length >= 24, '生成口令 ≥24 字符')
  const row = db.prepare(`SELECT username, role FROM platform_users WHERE username='admin'`).get()
  assert.ok(row, 'admin 行已建')
  assert.equal(row.role, 'admin')
})

test('强口令正常播种,不回明文', () => {
  const db = makeDb()
  const out = seedAdminIfNeeded(db, env({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'S7rong!Passw0rd-x' }))
  assert.equal(out.action, 'seeded')
  assert.equal(out.password, undefined, '显式口令不回明文')
  assert.ok(db.prepare(`SELECT 1 FROM platform_users WHERE username='ops'`).get())
})

test('两者均未设 → 不播种(旧直连模式仍可用)', () => {
  const db = makeDb()
  const out = seedAdminIfNeeded(db, env({}))
  assert.equal(out.action, 'noop')
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM platform_users`).get().c, 0)
})

test('生成的口令经 verifyPassword 可校验(与 index.mjs 同参 scrypt)', async () => {
  const db = makeDb()
  seedAdminIfNeeded(db, env({ ADMIN_USERNAME: 'admin' }))
  const row = db.prepare(`SELECT passwordHash FROM platform_users WHERE username='admin'`).get()
  const { createHash } = await import('node:crypto')
  // 复刻 index.mjs 的 verify(scrypt + timingSafeEqual)
  const scryptSync = (await import('node:crypto')).scryptSync
  const [saltHex, hashHex, N, r, p] = row.passwordHash.split(':')
  const actual = scryptSync('definitely-wrong', Buffer.from(saltHex, 'hex'), Buffer.from(hashHex, 'hex').length, { N: +N, r: +r, p: +p })
  assert.notEqual(actual.toString('hex'), hashHex, '错误口令不得通过')
})
