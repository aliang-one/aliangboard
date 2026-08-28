// server/secret-mask.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { maskSecretResource, MASK_PATTERN } from './secret-mask.mjs'
import { createHash } from 'node:crypto'

const b64 = s => Buffer.from(s, 'utf8').toString('base64')
const secret = () => ({ kind: 'Secret', apiVersion: 'v1', metadata: { name: 'db-cred', namespace: 'ns1' },
  data: { username: b64('admin'), password: b64('s3cr3t-pass') }, stringData: { token: 'plain-token' } })

test('Secret:data/stringData 值掩码为指纹形态,字段名保留', () => {
  const s = secret()
  const out = maskSecretResource(s)
  assert.notEqual(out, s, '返回新对象')
  assert.deepEqual(Object.keys(out.data).sort(), ['password', 'username'], '字段名保留')
  assert.match(out.data.username, MASK_PATTERN)
  assert.match(out.data.password, MASK_PATTERN)
  assert.match(out.stringData.token, MASK_PATTERN)
  // N 与指纹内容:b64('admin') 解码后 5 chars;sha1(b'admin') 前 8 hex 可独立验证
  assert.ok(out.data.username.includes('(5 chars,'))
  assert.equal(out.data.username, `*** (5 chars, #${createHash('sha1').update('admin').digest('hex').slice(0, 8)})`)
  // stringData 未编码:原文 'plain-token' 11 chars,指纹=sha1 原文
  assert.ok(out.stringData.token.includes('(11 chars,'))
})

test('非 Secret 资源:原引用返回,零改动', () => {
  const pod = { kind: 'Pod', metadata: { name: 'p1' }, spec: { containers: [] } }
  assert.equal(maskSecretResource(pod), pod)
  const nil = maskSecretResource(null)
  assert.equal(nil, null)
})

test('幂等:掩码形状再掩原样返回', () => {
  const once = maskSecretResource(secret())
  const twice = maskSecretResource(once)
  assert.deepEqual(twice, once)
  assert.equal(twice.data.username, once.data.username)
})

test('不 mutate 入参', () => {
  const s = secret()
  const before = s.data.password
  maskSecretResource(s)
  assert.equal(s.data.password, before, '原对象未变')
})

test('防御:非字符串值归一;不可 base64 解码回退原文长度', () => {
  const out = maskSecretResource({ kind: 'Secret', data: { weird: 12345, bad: '!!!not-base64!!!' } })
  assert.match(String(out.data.weird), MASK_PATTERN)
  assert.ok(out.data.bad.includes('(16 chars,'), '原文长度回退')
})

test('MASK_PATTERN 形状自锁', () => {
  assert.ok(MASK_PATTERN.test('*** (24 chars, #a1b2c3d4)'))
  assert.ok(!MASK_PATTERN.test('*** (24 chars, a1b2c3d4)'))
  assert.ok(!MASK_PATTERN.test('YWJjZA=='))
})
