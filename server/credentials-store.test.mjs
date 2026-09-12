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

test('deleteCredential + materializeField 解密失败固定码', () => {
  const db = makeDb()
  const s = createCredential(db, KEY, { name: 'n', fields: [{ key: 'p', type: 'password', value: 'v' }] })
  assert.throws(() => materializeField(db, randomBytes(32), s.id, 'p'), /CRED_DECRYPT_FAILED/)
  assert.equal(materializeField(db, KEY, s.id, 'missing'), null)
  assert.equal(deleteCredential(db, s.id), true)
  assert.equal(getCredentialSanitized(db, s.id), null)
  assert.equal(deleteCredential(db, s.id), false)
})
