// scan-double-encoded-secrets 分类器校准测试 — 语料全部来自 2026-10-04 实测:
//   helm "9000"(CLICKHOUSE_PORT)/kubectl "true"/nursor-test "asd","aaaa" 实锤/babycare 共键证明。
import test from 'node:test'
import assert from 'node:assert/strict'
import { strictB64, classifyValue, classifySecret, DEFAULT_WINDOW } from './scan-double-encoded-secrets.mjs'

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

test('strictB64:只认 canonical(round-trip 一致)', () => {
  assert.equal(strictB64(b64('aaaa')).toString('utf8'), 'aaaa')
  assert.equal(strictB64('QQ==').toString('utf8'), 'A')
  assert.equal(strictB64('9000').toString('hex'), 'f74d34') // 纯数字 4 字也是合法 b64(校准坑)
  assert.equal(strictB64('YWFhYW'), null) // 长度非 4 倍
  assert.equal(strictB64('!!!!'), null) // 字母表外
  assert.equal(strictB64(''), null)
  // 填充坑存档:'YWFhYWE=' 是 5 字节 "aaaaa" 的 b64,不是 "aaaa" 的 —— 语料一律现算,不手写
  assert.equal(strictB64('YWFhYWE=').toString('utf8'), 'aaaaa')
})

test('classifyValue:正常单编码(明文非 b64 形态)= plain', () => {
  // URL 含 ':' ⇒ 剥一层后不可能再是合法 b64(babycare DATABASE_URL 共键证明的根)
  assert.equal(classifyValue(b64('postgres://u:p@db:5432/x')).tier, 'plain')
  assert.equal(classifyValue(b64('任意中文密码!')).tier, 'plain')
})

test('classifyValue:b64²(文本)= damaged-text(nursor-test "asd" 实锤)', () => {
  const c = classifyValue(b64(b64('asd')))
  assert.equal(c.tier, 'damaged-text')
  assert.equal(c.layers, 2)
  assert.equal(c.innermost.head, 'asd')
})

test('classifyValue:b64³(文本)= deep-b64(nursor-test a1 "aaaaa" 实锤,len16)', () => {
  const v = b64(b64(b64('aaaaa')))
  assert.equal(v.length, 16)
  const c = classifyValue(v)
  // 剥 3 层:enc³ 值→enc²→enc¹→"aaaaa"(5 字,非 4 倍长,不再剥);文本明文就在最里层
  assert.equal(c.tier, 'deep-b64')
  assert.equal(c.layers, 3)
})

test('classifyValue:明文本身是 b64 形态("9000"/"true"/openssl key)= ambiguous-binary', () => {
  assert.equal(classifyValue(b64('9000')).tier, 'ambiguous-binary')
  assert.equal(classifyValue(b64('true')).tier, 'ambiguous-binary')
  const opensslStyle = Buffer.alloc(48).fill(7).toString('base64') // 64 字符 b64 形态明文
  assert.equal(classifyValue(b64(opensslStyle)).tier, 'ambiguous-binary')
})

test('classifySecret:豁免类型(helm/dockerconfigjson/sa-token)', () => {
  const s = classifySecret({ type: 'helm.sh/release.v1', data: { release: b64(b64('\x1f\x8bgzip')) } }, null)
  assert.equal(s.keys.release.verdict, 'exempt-type')
})

test('classifySecret:病窗内平台写入 + 文本 b64² 无共键 = damaged(nursor-test/test 全景)', () => {
  const s = classifySecret(
    { type: 'Opaque', data: { sdfsa: b64(b64('asd')), a1: b64(b64(b64('aaaa'))) } },
    { managedFields: [{ manager: 'aliangboard', operation: 'Apply', time: '2026-09-28T14:47:35Z' }], creationTimestamp: '2026-09-28T14:46:59Z' }
  )
  assert.equal(s.platformTouch, 'platform-in-window')
  assert.equal(s.keys.sdfsa.verdict, 'damaged')
  assert.equal(s.keys.a1.verdict, 'damaged')
})

test('classifySecret:共键证明 —— ambiguous 键 + 正确文本共键 = likely-benign(babycare/tunnul 裁决)', () => {
  const opensslStyle = Buffer.alloc(48).fill(7).toString('base64')
  const s = classifySecret(
    { type: 'Opaque', data: { JWT_SECRET: b64(opensslStyle), DATABASE_URL: b64('postgres://u@db/x') } },
    { managedFields: [{ manager: 'aliangboard', operation: 'Apply', time: '2026-08-28T04:37:31Z' }], creationTimestamp: '2026-08-25T12:13:59Z' }
  )
  assert.equal(s.platformTouch, 'platform-in-window')
  assert.equal(s.hasPlainCowitness, true)
  assert.equal(s.keys.JWT_SECRET.verdict, 'likely-benign-b64shaped')
  assert.equal(s.keys.DATABASE_URL.verdict, 'ok')
})

test('classifySecret:ambiguous 无共键 + 病窗内平台写 = needs-adjudication(唯一须人工裁决形态)', () => {
  const s = classifySecret(
    { type: 'Opaque', data: { FLAG: b64('true') } },
    { managedFields: [{ manager: 'aliangboard', operation: 'Apply', time: '2026-09-01T00:00:00Z' }] }
  )
  assert.equal(s.keys.FLAG.verdict, 'needs-adjudication')
})

test('classifySecret:非平台 manager(helm/kubectl/Mozilla)= likely-benign("9000" 校准)', () => {
  const s = classifySecret(
    { type: 'Opaque', data: { CLICKHOUSE_PORT: b64('9000') } },
    { managedFields: [{ manager: 'helm', operation: 'Update', time: '2025-03-12T04:01:44Z' }] }
  )
  assert.equal(s.platformTouch, 'other-manager')
  assert.equal(s.keys.CLICKHOUSE_PORT.verdict, 'likely-benign-b64shaped')
})

test('classifySecret:created==Apply 同秒 = create-only,不按病窗论处(anydoor-prober 实测形态)', () => {
  const opensslStyle = Buffer.alloc(48).fill(7).toString('base64')
  const s = classifySecret(
    { type: 'Opaque', data: { INTERNAL_API_KEY: b64(opensslStyle) } },
    { managedFields: [{ manager: 'aliangboard', operation: 'Apply', time: '2026-09-12T16:13:11Z' }], creationTimestamp: '2026-09-12T16:13:11Z' }
  )
  assert.equal(s.platformTouch, 'platform-create-only')
  assert.equal(s.keys.INTERNAL_API_KEY.verdict, 'likely-benign-b64shaped')
})

test('classifySecret:damaged-text × 共键证明 —— 明文本身是 b64(PEM)的 *_BASE64 键(tunnul PIKO 实测)', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIGHAgEA\n-----END PRIVATE KEY-----\n'
  const s = classifySecret(
    { type: 'Opaque', data: { KEY_BASE64: b64(b64(pem)), DATABASE_URL: b64('postgres://u@db/x') } },
    { managedFields: [{ manager: 'aliangboard', operation: 'Apply', time: '2026-08-31T05:34:59Z' }], creationTimestamp: '2026-08-28T07:29:27Z' }
  )
  assert.equal(s.platformTouch, 'platform-in-window')
  assert.equal(s.keys.KEY_BASE64.tier, 'damaged-text') // 形态上是 b64²(文本)
  assert.equal(s.keys.KEY_BASE64.verdict, 'likely-benign-cowitness') // 共键在 ⇒ 写入正确 ⇒ 明文即 b64(PEM)
})

test('classifySecret:平台 Apply 后被他方(curl 修复)再写 → other-manager(tencent-cos 实测)', () => {
  const key = Buffer.alloc(24).fill(3).toString('base64') // 32 字 b64 形态明文
  const s = classifySecret(
    { type: 'Opaque', data: { cos_secret_key: b64(key) } },
    { managedFields: [
      { manager: 'aliangboard', operation: 'Apply', time: '2026-09-22T05:10:17Z' },
      { manager: 'curl', operation: 'Update', time: '2026-09-22T05:40:25Z' }
    ], creationTimestamp: '2026-09-22T05:05:07Z' }
  )
  assert.equal(s.platformTouch, 'other-manager')
  assert.equal(s.keys.cos_secret_key.verdict, 'likely-benign-b64shaped')
})

test('classifySecret:managedFields 缺失(list 面)时 ambiguous 保守降级为 likely-benign,由单对象 GET 收紧', () => {
  const s = classifySecret({ type: 'Opaque', data: { X: b64('9000') } }, null)
  assert.equal(s.platformTouch, 'unknown')
  assert.equal(s.keys.X.verdict, 'likely-benign-b64shaped')
})

test('DEFAULT_WINDOW:覆盖 v1.0.0–38 病窗(约 2026-08-10 起)', () => {
  assert.ok(DEFAULT_WINDOW.start < '2026-08-15')
  assert.ok(DEFAULT_WINDOW.end > '2026-10-01')
})
