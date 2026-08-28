import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { loadOrCreateKey, encryptField, decryptField } from './crypt.mjs'

test('loadOrCreateKey: 首次生成 32B 密钥文件且权限 0600;二次读取同一把', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-crypt-'))
  try {
    const p = join(dir, 'ssh-crypt.key')
    const k1 = loadOrCreateKey(p)
    assert.equal(k1.length, 32)
    assert.ok(existsSync(p))
    assert.equal(statSync(p).mode & 0o777, 0o600)
    const k2 = loadOrCreateKey(p)
    assert.deepEqual(k2, k1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loadOrCreateKey: 已存在但长度非 32 → 抛错(密钥损坏不可静默)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-crypt-'))
  try {
    const p = join(dir, 'bad.key')
    const k = randomBytes(16)
    const fd = openSync(p, 'wx', 0o600)
    writeSync(fd, k)
    closeSync(fd)
    assert.throws(() => loadOrCreateKey(p), /32 字节/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('encryptField/decryptField: 空值返 null;roundtrip 一致;密文非明文', () => {
  const key = randomBytes(32)
  assert.equal(encryptField(key, ''), null)
  assert.equal(encryptField(key, null), null)
  const enc = encryptField(key, 's3cret-密码')
  assert.ok(enc.startsWith('v1:'))
  assert.ok(!enc.includes('s3cret'))
  assert.equal(decryptField(key, enc), 's3cret-密码')
})

test('decryptField: 错误密钥 → 抛错(GCM 认证失败);坏格式 → 抛格式错', () => {
  const key = randomBytes(32), other = randomBytes(32)
  const enc = encryptField(key, 'x')
  assert.throws(() => decryptField(other, enc))
  assert.throws(() => decryptField(key, 'garbage'))
})
