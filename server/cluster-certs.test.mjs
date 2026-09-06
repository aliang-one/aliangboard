// 纯层契约:X509 描述符(不含 PEM)/ 日期解析兜底 / TLS 错误归因表。
// 夹具:./test-fixtures/certs(自签,gen.sh 可再生成;断言从解析结果推导,注入 now 不依赖绝对日期)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseCertChain, parseCertDate, classifyTlsError } from './cluster-certs.mjs'

const FX = join(dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'certs')
const read = f => readFileSync(join(FX, f), 'utf8')

test('parseCertChain:叶子证书描述符(subject 压平/SANs/指纹/daysLeft 按注入 now)', () => {
  const validTo = parseCertDate('Sep  3 10:37:21 2036 GMT')
  const now = () => validTo - 90 * 86_400_000 // 距到期整 90 天
  const chain = parseCertChain(read('leaf1.pem'), now)
  assert.equal(chain.length, 1)
  const leaf = chain[0]
  assert.match(leaf.subject, /api\.demo\.local/)
  assert.ok(!leaf.subject.includes('\n'), 'subject 应压平为单行')
  assert.ok(leaf.sans.some(s => s.includes('api.demo.local')))
  assert.ok(leaf.sans.some(s => s.includes('127.0.0.1')))
  assert.ok(!leaf.isCA)
  assert.match(leaf.fingerprint256, /^[0-9A-F:]+$/)
  assert.equal(leaf.daysLeft, 90)
  assert.ok(leaf.validFrom < leaf.validTo)
})

test('parseCertChain:CA 证书 isCA=true;多块 PEM 成链;空/坏输入返回 []', () => {
  const cas = parseCertChain(read('ca1.pem'), Date.now)
  assert.equal(cas.length, 1)
  assert.ok(cas[0].isCA)
  assert.deepEqual(parseCertChain('', Date.now), [])
  assert.deepEqual(parseCertChain('not a pem', Date.now), [])
  const both = parseCertChain(read('leaf1.pem') + read('ca1.pem'), Date.now)
  assert.equal(both.length, 2)
})

test('parseCertDate:标准格式直解;双空格/月份名兜底;垃圾返回 null', () => {
  assert.equal(parseCertDate(''), null)
  assert.equal(parseCertDate('garbage'), null)
  const ms = parseCertDate('Sep  3 10:37:21 2036 GMT') // 双空格真实形态
  assert.equal(ms, Date.UTC(2036, 8, 3, 10, 37, 21))
})

test('classifyTlsError 归因表', () => {
  assert.equal(classifyTlsError('CERT_HAS_EXPIRED'), 'cert-expired')
  assert.equal(classifyTlsError('ERR_TLS_CERT_ALTNAME_INVALID'), 'hostname-mismatch')
  for (const c of ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']) assert.equal(classifyTlsError(c), 'ca-mismatch', c)
  for (const c of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']) assert.equal(classifyTlsError(c), 'unreachable', c)
  assert.equal(classifyTlsError('SOMETHING_ELSE'), 'error')
  assert.equal(classifyTlsError(null), 'error')
})
