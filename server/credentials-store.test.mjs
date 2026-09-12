// server/credentials-store.test.mjs
// 凭据存储层:字段袋加密落库/sanitize 零值/校验拒绝。夹具照 distill.test.mjs(:memory: + 随机 key)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import {
  createCredentialsSchema, validateCredentialInput, createCredential,
  listCredentials, getCredentialSanitized,
  updateCredential, deleteCredential, materializeField,
  grantCredentialUse, revokeCredentialUse, listCredentialGrants, hasCredentialGrant, resolveCredentialRef,
} from './credentials-store.mjs'

function makeDb() { const db = new DatabaseSync(':memory:'); createCredentialsSchema(db); return db }
const KEY = randomBytes(32)

test('createCredential:fields 落库为 v1: 密文,sanitize 行零值', () => {
  const db = makeDb()
  const s = createCredential(db, KEY, {
    name: 'gh-token', description: 'GitHub', tags: ['git'],
    exposeToAi: true,
    fields: [
      { key: 'user', type: 'text', value: 'liang' },
      { key: 'api_token', type: 'password', value: 'ghp_hunter2secret' },
    ],
  }, 'u1')
  assert.ok(s.id && s.name === 'gh-token' && s.exposeToAi === true)
  assert.deepEqual(s.fields, [{ key: 'user', type: 'text' }, { key: 'api_token', type: 'password' }])
  // 落库侧:fields JSON 只有密文
  const raw = db.prepare('SELECT fields FROM workbench_credentials WHERE id=?').get(s.id)
  const arr = JSON.parse(raw.fields)
  assert.ok(!raw.fields.includes('liang') && !raw.fields.includes('ghp_hunter2secret'), '明文不得落库')
  assert.match(arr[0].enc, /^v1:/); assert.match(arr[1].enc, /^v1:/)
  // 列表同 sanitize
  assert.deepEqual(listCredentials(db)[0].fields, s.fields)
  assert.equal(getCredentialSanitized(db, 'nope'), null)
})

test('校验:重名 key/掩码回写/超限/坏 type 全拒', () => {
  const masked = '*** (12 chars, #abcd1234)'
  const errs = validateCredentialInput({ name: 'x', fields: [
    { key: 'a', type: 'text', value: '1' }, { key: 'A', type: 'text', value: '2' },   // 大小写不敏感重复
    { key: 'b', type: 'text', value: masked },                                        // 掩码回写
    { key: 'c', type: 'banana', value: '1' },                                         // 坏 type
    { key: 'd', type: 'text', value: 'x'.repeat(16385) },                             // 超限(值超 16KB = maxValueLen+1)
  ] })
  assert.ok(errs.length >= 4, JSON.stringify(errs))
  // 非字符串非 null 的 value(如数组)须拒——否则会漏过 16KB/掩码检查,再被 encryptField String() 强转
  assert.ok(validateCredentialInput({ name: 'x', fields: [{ key: 'a', type: 'text', value: ['y'] }] }).length >= 1)
  // 非字符串 tag(如数字)须拒——否则 String() 强转后静默落库
  assert.ok(validateCredentialInput({ name: 'x', fields: [], tags: ['a', 5] }).length >= 1, '非字符串标签拒')
  // 掩码回写在 create 侧也 400
  assert.throws(() => createCredential(db0(), KEY, { name: 'x', fields: [{ key: 'b', type: 'text', value: masked }] }), /掩码/)
  function db0() { return makeDb() }
})

test('updateCredential 三态:password 留空保持 / null 清除 / 值覆盖;text 全量替换', () => {
  const db = makeDb()
  const s = createCredential(db, KEY, { name: 'n', fields: [
    { key: 'pwd', type: 'password', value: 'old-secret' },
    { key: 'note', type: 'text', value: 'hello' },
    { key: 'gone', type: 'text', value: 'x' },
  ] })
  const upd = updateCredential(db, KEY, s.id, { fields: [
    { key: 'pwd', type: 'password' },                 // 无 value = 保持
    { key: 'note', type: 'text', value: 'world' },    // 覆盖
    // gone 未出现 = 移除
  ] })
  assert.deepEqual(upd.fields.map(f => f.key), ['pwd', 'note'])
  assert.equal(materializeField(db, KEY, s.id, 'pwd').value, 'old-secret', '留空保持')
  assert.equal(materializeField(db, KEY, s.id, 'note').value, 'world')
  // null = 清除
  const upd2 = updateCredential(db, KEY, s.id, { fields: [{ key: 'pwd', type: 'password', value: null }, { key: 'note', type: 'text', value: 'world' }] })
  assert.deepEqual(upd2.fields.map(f => f.key), ['note'])
  assert.equal(materializeField(db, KEY, s.id, 'pwd'), null)
  // 值 = 覆盖加密(新密文 ≠ 旧密文,明文可解)
  updateCredential(db, KEY, s.id, { fields: [{ key: 'pwd', type: 'password', value: 'new-secret' }, { key: 'note', type: 'text', value: 'world' }] })
  assert.equal(materializeField(db, KEY, s.id, 'PWD').value, 'new-secret', '大小写不敏感')
  // 元数据直改
  const upd3 = updateCredential(db, KEY, s.id, { name: 'n2', exposeToAi: true, tags: ['a'], description: 'd' })
  assert.equal(upd3.name, 'n2'); assert.equal(upd3.exposeToAi, true); assert.deepEqual(upd3.tags, ['a'])
  assert.equal(updateCredential(db, KEY, 'nope', {}), null)
})

test('§5.4 校验共用:update 路径 tags/description 同钳(create 侧 description 上限同生效)', () => {
  const db = makeDb()
  const s = createCredential(db, KEY, { name: 'n', fields: [] })
  // PATCH 9 tags → 抛(≤8 规则与 create 共用)
  assert.throws(() => updateCredential(db, KEY, s.id, { tags: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }), /标签数超上限/)
  assert.throws(() => updateCredential(db, KEY, s.id, { tags: ['x'.repeat(25)] }), /标签超 24 字符/)
  assert.throws(() => updateCredential(db, KEY, s.id, { tags: ['ok', 5] }), /标签须为字符串/)
  // PATCH >2000 描述 → 抛;create >2000 描述 → 抛(两侧同一上限)
  assert.throws(() => updateCredential(db, KEY, s.id, { description: 'x'.repeat(2001) }), /描述超 2000 字符/)
  assert.throws(() => createCredential(db, KEY, { name: 'n2', description: 'x'.repeat(2001), fields: [] }), /描述超 2000 字符/)
  // 合法边界放行:8 tags × 24 字符 + 恰 2000 描述
  const ok = updateCredential(db, KEY, s.id, { tags: ['a'.repeat(24), 'b', 'c', 'd', 'e', 'f', 'g', 'h'], description: 'x'.repeat(2000) })
  assert.equal(ok.tags.length, 8); assert.equal(ok.description.length, 2000)
  // 未提交项不校验:只改 name 不碰 tags/description
  assert.equal(updateCredential(db, KEY, s.id, { name: 'n3' }).name, 'n3')
})

test('deleteCredential + materializeField 解密失败固定码', () => {
  const db = makeDb()
  const s = createCredential(db, KEY, { name: 'n', fields: [{ key: 'p', type: 'password', value: 'v' }] })
  assert.throws(() => materializeField(db, randomBytes(32), s.id, 'p'), /CRED_DECRYPT_FAILED/)
  assert.equal(materializeField(db, KEY, s.id, 'missing'), null)
  assert.equal(deleteCredential(db, s.id), true)
  assert.equal(getCredentialSanitized(db, s.id), null)
  assert.equal(deleteCredential(db, s.id), false)
})

test('grants:授权/收回/命中/幂等/按凭据列表', () => {
  const db = makeDb()
  const s = createCredential(db, KEY, { name: 'gh', exposeToAi: true, fields: [{ key: 'k', type: 'text', value: 'v' }] })
  assert.equal(hasCredentialGrant(db, s.id, 'http_request'), false)
  assert.deepEqual(grantCredentialUse(db, s.id, 'http_request', 'u1'), { ok: true })
  assert.deepEqual(grantCredentialUse(db, s.id, 'http_request', 'u2'), { ok: false })   // 幂等:已存在
  assert.equal(hasCredentialGrant(db, s.id, 'http_request'), true)
  assert.equal(hasCredentialGrant(db, s.id, 'db_query'), false)
  const gs = listCredentialGrants(db, s.id)
  assert.equal(gs.length, 1); assert.equal(gs[0].adapter, 'http_request'); assert.equal(gs[0].grantedBy, 'u1')
  assert.equal(revokeCredentialUse(db, s.id, 'http_request'), true)
  assert.equal(revokeCredentialUse(db, s.id, 'http_request'), false)
  assert.equal(hasCredentialGrant(db, s.id, 'http_request'), false)
})

test('resolveCredentialRef:id 优先/同名歧义回暴露候选/not-found 与 not-exposed 可区分', () => {
  const db = makeDb()
  const a = createCredential(db, KEY, { name: 'dup', exposeToAi: true, fields: [{ key: 'k', type: 'text', value: 'v' }] })
  createCredential(db, KEY, { name: 'dup', exposeToAi: true, fields: [{ key: 'k', type: 'text', value: 'v' }] })
  createCredential(db, KEY, { name: 'hid', exposeToAi: false, fields: [{ key: 'k', type: 'text', value: 'v' }] })
  assert.equal(resolveCredentialRef(db, a.id).ok, true)
  assert.equal(resolveCredentialRef(db, 'dup').reason, 'ambiguous')
  assert.equal(resolveCredentialRef(db, 'dup').candidates.length, 2)
  assert.equal(resolveCredentialRef(db, 'hid').reason, 'not-exposed')
  assert.equal(resolveCredentialRef(db, 'nope').reason, 'not-found')
  assert.deepEqual(resolveCredentialRef(db, ''), { ok: false, reason: 'not-found', candidates: [] })
})
