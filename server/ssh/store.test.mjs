import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import {
  ensureSshSchema, validateSshServerInput, sanitizeSshServer,
  createSshServer, updateSshServer, deleteSshServer,
  listSshServers, getSshServerRow, findSshServersByName,
  materializeCreds, recordHostKey, SSH_APPROVAL_POLICIES,
} from './store.mjs'

function freshDb() { const db = new DatabaseSync(':memory:'); ensureSshSchema(db); return db }
const KEY = randomBytes(32)

const VALID = { name: 'prod-web-1', host: '10.0.0.5', port: 22, username: 'ops',
  authMethod: 'password', password: 'pw123', sudoPassword: 'su', description: 'web 节点', clusterRef: 'prod', exposeToAi: true, aiApprovalPolicy: 'readonly', tags: ['web'] }

test('validateSshServerInput: 缺名/host/username 报错;authMethod=password 缺密码报错;privateKey 缺钥报错', () => {
  assert.ok(validateSshServerInput({}).length >= 3)
  assert.ok(validateSshServerInput({ name: 'a', host: 'h', username: 'u', authMethod: 'password' }).join().includes('密码'))
  assert.ok(validateSshServerInput({ name: 'a', host: 'h', username: 'u', authMethod: 'privateKey', password: 'x' }).join().includes('私钥'))
  assert.deepEqual(validateSshServerInput(VALID), [])
  assert.ok(validateSshServerInput({ ...VALID, port: 99999 }).join().includes('port'))
  assert.ok(validateSshServerInput({ ...VALID, aiApprovalPolicy: 'yolo' }).length > 0)
})

test('create → sanitize: enc* 字段与明文不出现在脱敏行;has* 布尔正确', () => {
  const db = freshDb()
  const row = createSshServer(db, KEY, VALID, 'admin')
  assert.equal(row.name, 'prod-web-1')
  assert.equal(row.hasPassword, true)
  assert.equal(row.hasSudoPassword, true)
  assert.equal(row.exposeToAi, true)
  const raw = getSshServerRow(db, row.id)
  for (const f of ['password', 'privateKey', 'passphrase', 'sudoPassword']) assert.equal(row[f], undefined)
  assert.ok(raw.encPassword && !raw.encPassword.includes('pw123'))
  assert.deepEqual(JSON.parse(raw.tags), ['web'])
})

test('update: 留空凭据 = 保持;传新值 = 覆盖;传 null = 清除;materialize roundtrip', () => {
  const db = freshDb()
  const { id } = createSshServer(db, KEY, VALID, 'admin')
  const u = updateSshServer(db, KEY, id, { description: '改了' })
  assert.equal(u.description, '改了')
  let m = materializeCreds(db, KEY, id)
  assert.equal(m.password, 'pw123')
  updateSshServer(db, KEY, id, { password: 'newpw' })
  assert.equal(materializeCreds(db, KEY, id).password, 'newpw')
  updateSshServer(db, KEY, id, { sudoPassword: null })
  assert.equal(materializeCreds(db, KEY, id).sudoPassword, null)
  assert.equal(materializeCreds(db, KEY, 'nope'), null)
})

test('materializeCreds: 密钥不对 → 抛 SSH_CRED_DECRYPT_FAILED(不返明文不返 null)', () => {
  const db = freshDb()
  const { id } = createSshServer(db, KEY, VALID, 'admin')
  assert.throws(() => materializeCreds(db, randomBytes(32), id), /SSH_CRED_DECRYPT_FAILED/)
})

test('listSshServers exposedOnly 只回暴露行;name 查找;hostKey 指纹落库;delete', () => {
  const db = freshDb()
  const a = createSshServer(db, KEY, VALID, 'admin')
  createSshServer(db, KEY, { ...VALID, name: 'dev-1', exposeToAi: false }, 'admin')
  assert.equal(listSshServers(db, { exposedOnly: true }).length, 1)
  assert.equal(findSshServersByName(db, 'dev-1').length, 1)
  recordHostKey(db, a.id, 'SHA256:abc')
  assert.equal(getSshServerRow(db, a.id).hostKeyFingerprint, 'SHA256:abc')
  assert.equal(deleteSshServer(db, a.id), true)
  assert.equal(deleteSshServer(db, a.id), false)
  assert.deepEqual(SSH_APPROVAL_POLICIES, ['always', 'readonly', 'none'])
})
