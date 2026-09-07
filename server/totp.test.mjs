// TOTP 纯模块测试(Wave 3 Task 1):RFC 6238 附录 B 测试向量钉死 HOTP 计算,
// base32 往返 / 恢复码形状与归一化 / verifyTotp 窗口与输入校验。
// RFC 向量是 8 位码(94287082);本实现固定 6 位 → 取同一动态截断值的 mod 10^6
// (RFC 4226 附录 D:同 dt 值,d 位码 = dt mod 10^d),T=59 → '287082'、T=1111111109 → '081804'。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  base32Encode, base32Decode, generateTotpSecret, otpauthUri,
  verifyTotp, totpCodeAt, generateRecoveryCodes, hashRecoveryCode,
} from './totp.mjs'

// RFC 6238 附录 B 唯一 SHA-1 密钥(20 字节 '12345678901234567890' 的 base32)
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const RFC_SECRET_BYTES = Buffer.from('12345678901234567890', 'latin1')

test('base32:RFC 4648 编码(RFC 测试密钥往返)', () => {
  assert.equal(base32Encode(RFC_SECRET_BYTES), RFC_SECRET_B32)
  assert.deepEqual(base32Decode(RFC_SECRET_B32), RFC_SECRET_BYTES)
})

test('base32:随机字节往返(任意长度含非 5 倍数);无 padding 字符', () => {
  for (const n of [0, 1, 2, 5, 10, 16, 20, 32]) {
    const buf = Buffer.from([...Array(n)].map(() => Math.floor(Math.random() * 256)))
    const enc = base32Encode(buf)
    assert.ok(!enc.includes('='), '不产生 padding')
    assert.deepEqual(base32Decode(enc), buf, `${n} 字节往返`)
  }
})

test('base32:非法字符抛错(供 verifyTotp 容错捕获)', () => {
  assert.throws(() => base32Decode('AB1!'))
})

test('totpCodeAt:RFC 6238 向量(T=59 → 287082;T=1111111109 → 081804;T=1111111111 → 050471)', () => {
  assert.equal(totpCodeAt(RFC_SECRET_B32, 59_000), '287082')
  assert.equal(totpCodeAt(RFC_SECRET_B32, 1_111_111_109_000), '081804')
  assert.equal(totpCodeAt(RFC_SECRET_B32, 1_111_111_111_000), '050471')
})

test('verifyTotp:当窗/上一窗/下一窗通过(window=1),差两窗拒绝', () => {
  const now = 1_000_000_000_000 // 任取对齐点
  assert.equal(verifyTotp(RFC_SECRET_B32, totpCodeAt(RFC_SECRET_B32, now), { now }), true, '当窗')
  assert.equal(verifyTotp(RFC_SECRET_B32, totpCodeAt(RFC_SECRET_B32, now - 30_000), { now }), true, '上一窗')
  assert.equal(verifyTotp(RFC_SECRET_B32, totpCodeAt(RFC_SECRET_B32, now + 30_000), { now }), true, '下一窗')
  assert.equal(verifyTotp(RFC_SECRET_B32, totpCodeAt(RFC_SECRET_B32, now - 60_000), { now }), false, '上上窗拒')
  assert.equal(verifyTotp(RFC_SECRET_B32, totpCodeAt(RFC_SECRET_B32, now + 60_000), { now }), false, '下下窗拒')
})

test('verifyTotp:错码 false;非 6 位数字串 false(7 位/短码/含字母/数字类型)', () => {
  const now = Date.now()
  assert.equal(verifyTotp(RFC_SECRET_B32, '000000', { now }), false, '错码')
  assert.equal(verifyTotp(RFC_SECRET_B32, '1234567', { now }), false, '7 位')
  assert.equal(verifyTotp(RFC_SECRET_B32, '12345', { now }), false, '5 位')
  assert.equal(verifyTotp(RFC_SECRET_B32, '12345a', { now }), false, '含字母')
  assert.equal(verifyTotp(RFC_SECRET_B32, 123456, { now }), false, '数字类型而非字符串')
  assert.equal(verifyTotp(RFC_SECRET_B32, null, { now }), false, 'null')
})

test('verifyTotp:坏 secret(非法 base32/空)不抛,恒 false', () => {
  assert.equal(verifyTotp('!!!not-base32!!!', '123456'), false)
  assert.equal(verifyTotp('', '123456'), false)
})

test('generateTotpSecret:32 字符 base32(20 随机字节),两次生成不同', () => {
  const a = generateTotpSecret()
  const b = generateTotpSecret()
  assert.equal(a.length, 32)
  assert.match(a, /^[A-Z2-7]{32}$/)
  assert.notEqual(a, b, '随机性')
  assert.equal(base32Decode(a).length, 20)
})

test('otpauthUri:形状 otpauth://totp/<issuer>:<u>?secret=&issuer=,username 转义', () => {
  const uri = otpauthUri('ABC234DEF', 'alice')
  assert.equal(uri, 'otpauth://totp/AliangBoard:alice?secret=ABC234DEF&issuer=AliangBoard')
  // username 需 encodeURIComponent(空格/中文/冒号)
  const u2 = otpauthUri('ABC234DEF', 'a b:中')
  assert.ok(u2.startsWith('otpauth://totp/AliangBoard:a%20b%3A%E4%B8%AD?'))
})

test('generateRecoveryCodes:形状 XXXXX-XXXXX(10 base32 字符),哈希可由 hashRecoveryCode 复算', () => {
  const codes = generateRecoveryCodes(10)
  assert.equal(codes.length, 10)
  const seen = new Set()
  for (const c of codes) {
    assert.match(c.plaintext, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/)
    assert.equal(c.hash, hashRecoveryCode(c.plaintext), '哈希确定性')
    assert.ok(!seen.has(c.plaintext), '明文不重复')
    seen.add(c.plaintext)
  }
})

test('hashRecoveryCode:归一化(大写+去全部空白)——前后空格/分组间空格/小写同哈希', () => {
  assert.equal(hashRecoveryCode(' abcde-fghij '), hashRecoveryCode('ABCDE-FGHIJ'))
  // 内空格是「移除」而非「视作分隔符」:去空格后无 dash,与手输无 dash 同形
  assert.equal(hashRecoveryCode('abcde fghij'), hashRecoveryCode('abcdefghij'))
  assert.equal(hashRecoveryCode('abcde-fghij'), hashRecoveryCode('abcdE-fghIj'))
  // 不同码不同哈希
  assert.notEqual(hashRecoveryCode('abcde-fghij'), hashRecoveryCode('abcde-fghik'))
})
