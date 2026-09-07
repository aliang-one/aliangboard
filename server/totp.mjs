// TOTP 两步验证纯模块(Wave 3 §1.1,零依赖——node:crypto 全覆盖):
//   - RFC 4648 base32(无 padding)编解码 —— Google Authenticator 系密钥格式
//   - RFC 6238 TOTP(HMAC-SHA1 / 30s 步长 / 6 位码 / 默认 ±1 窗宽容 / 常数时间比较)
//   - 恢复码:10 字符 base32 分组 XXXXX-XXXXX,SHA-256 哈希入库(明文仅启用时一次性下发)
// RFC 6238 附录 B 测试向量在 ./totp.test.mjs 钉死(T=59 → '287082' 等)。
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_MS = 30_000
const DIGITS = 6

// RFC 4648 base32 编码,不带 '=' padding(otpauth URI 与 Google Authenticator 惯例)。
export function base32Encode(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  let bits = 0, value = 0, out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31] // 尾部零填充位
  return out
}

// RFC 4648 base32 解码:容忍大小写/padding/内空格;非法字符抛错(调用方 verifyTotp 容错捕获)。
export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[\s=]+/g, '')
  let bits = 0, value = 0
  const bytes = []
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error(`invalid base32 character: ${ch}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Buffer.from(bytes) // 尾部不足 8 位的零填充位丢弃(编码时的对称行为)
}

// 生成 TOTP 密钥:20 随机字节(160 位,RFC 4226 推荐长度)→ 32 字符 base32。
export function generateTotpSecret() {
  return base32Encode(randomBytes(20))
}

// otpauth:// URI(认证器 App 扫码/手输通用格式);username 需 URI 转义(空格/中文/冒号)。
export function otpauthUri(secret, username, issuer = 'AliangBoard') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}`
}

// RFC 4226 HOTP:counter 8 字节大端 → HMAC-SHA1 → 动态截断 → 31 位无符号整数。
function hotpValue(keyBytes, counter) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', keyBytes).update(buf).digest()
  const off = h[h.length - 1] & 0x0f
  return ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
}

function codeString(value) {
  return String(value % 10 ** DIGITS).padStart(DIGITS, '0')
}

// 时刻 t(ms)的 TOTP 码——测试构造「当前时刻有效码」用;与 verifyTotp 同一计算路径。
export function totpCodeAt(secret, t) {
  const key = base32Decode(secret)
  return codeString(hotpValue(key, Math.floor(t / STEP_MS)))
}

// 校验 TOTP 码:±window(默认 1,共 3 窗)任一命中即通过。
// code 必须是 6 位数字字符串,其余形态一律 false;坏 secret 不抛(恒 false)。
// 比较为常数时间(timingSafeEqual),且不因命中提前退出(防窗序时序侧信道)。
export function verifyTotp(secret, code, { window = 1, now = Date.now() } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false
  let key
  try { key = base32Decode(secret) } catch { return false }
  if (!key.length) return false
  const counter = Math.floor(now / STEP_MS)
  let ok = false
  for (let i = -window; i <= window; i++) {
    const expect = Buffer.from(codeString(hotpValue(key, counter + i)), 'latin1')
    const actual = Buffer.from(code, 'latin1')
    if (expect.length === actual.length && timingSafeEqual(expect, actual)) ok = true
  }
  return ok
}

// 恢复码归一化:大写 + 去全部空白(登录输入容错:前后空格/分组间空格/小写)。
export function hashRecoveryCode(plaintext) {
  const norm = String(plaintext).toUpperCase().replace(/\s+/g, '')
  return createHash('sha256').update(norm, 'utf8').digest('hex')
}

// 生成 n 个恢复码:10 字符 base32(50 位熵)分组 XXXXX-XXXXX;哈希入库,明文仅一次性下发。
export function generateRecoveryCodes(n = 10) {
  const out = []
  for (let i = 0; i < n; i++) {
    const chars = base32Encode(randomBytes(10)).slice(0, 10)
    const plaintext = `${chars.slice(0, 5)}-${chars.slice(5)}`
    out.push({ plaintext, hash: hashRecoveryCode(plaintext) })
  }
  return out
}
