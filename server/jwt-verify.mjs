// Wave 4 OIDC Task 1:零依赖 JWT 验签纯模块(node:crypto 全覆盖,无新依赖)。
//   - base64url 解码(严格字符集校验——Buffer.from('base64url') 会静默忽略非法字符,须先白名单正则)
//   - JWK → KeyObject(node crypto 原生支持 { key: jwk, format: 'jwk' };oct → Buffer 作 HS256 secret)
//   - 验签:RS256(RSA-SHA256)/ ES256(sha256 + ieee-p1363——ES256 签名是原始 R||S 64 字节,非 DER)/
//     HS256(createHmac + timingSafeEqual 常数时间);alg 白名单 ['RS256','ES256','HS256']
//   - verifyIdToken:kid 匹配 JWKS → 验签 → iss/aud/exp/nonce/iat 全验(aud 兼容 string|string[];安全侧 fail-closed)
// 错误约定:throw new Error('<code>'),调用方按 e.message 分支(malformed/unknown-kid/bad-signature/
// issuer/audience/expired/nonce/iat-future/unsupported-alg/unsupported-key)。
// 时间单位:claims NumericDate 按 RFC 7519 为**秒**;opts.now 为毫秒(Date.now() 惯例)——内部归一到秒再比,
// iat 未来容差 5min(300s,计划原文 300000ms 同义)。
import { createPublicKey, createHmac, timingSafeEqual, verify as cryptoVerify } from 'node:crypto'

const B64URL_RE = /^[A-Za-z0-9_-]*$/
const ALLOWED_ALGS = ['RS256', 'ES256', 'HS256']
const IAT_FUTURE_TOLERANCE_S = 300

// base64url(RFC 4648 §5,无 padding)→ Buffer。纯解码语义:空串 → 空 Buffer;
// 非法字符 → throw malformed(Buffer.from('base64url') 会静默忽略非法字符,故先白名单正则)。
export function base64urlDecode(s) {
  if (typeof s !== 'string' || !B64URL_RE.test(s)) throw new Error('malformed')
  return Buffer.from(s, 'base64url')
}

// JWT 三段切分:header.payload.signature → { header, claims, signature:Buffer, signingInput:Buffer }。
// signingInput = 'header段.payload段' 的原始 ASCII 字节——签名覆盖的是 base64url 段本身而非再序列化
// 的 JSON(键序/空白不可复原),验签必须用它。任何格式错误统一 throw malformed。
export function decodeJwtSegments(token) {
  if (typeof token !== 'string') throw new Error('malformed')
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((x) => x.length === 0)) throw new Error('malformed')
  const [h, p, s] = parts
  let header, claims
  try {
    header = JSON.parse(base64urlDecode(h).toString('utf8'))
    claims = JSON.parse(base64urlDecode(p).toString('utf8'))
  } catch { throw new Error('malformed') } // JSON 解析失败或段非法
  const signature = base64urlDecode(s)
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('malformed')
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('malformed')
  return { header, claims, signature, signingInput: Buffer.from(`${h}.${p}`) }
}

// JWK → KeyObject(非对称)或 Buffer(oct,HS256 secret)。仅认 RSA/EC/oct,其余 throw unsupported-key。
// node crypto 原生吃 JWK 形状,这里只挑必要字段构造(kid/alg/use 等元数据不影响密钥材质)。
export function jwkToKeyObject(jwk) {
  if (!jwk || typeof jwk !== 'object') throw new Error('unsupported-key')
  if (jwk.kty === 'RSA') return createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })
  if (jwk.kty === 'EC') return createPublicKey({ key: { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' })
  if (jwk.kty === 'oct') return base64urlDecode(jwk.k)
  throw new Error('unsupported-key')
}

// 按 header.alg 验签:payload 是签名输入字节(decodeJwtSegments().signingInput)。
// 返回 boolean;alg 不在白名单 throw unsupported-alg;密钥类型不匹配等 crypto 异常按 false(验签失败)处理。
export function verifyJwtSignature(header, signature, payload, key) {
  const alg = header?.alg
  if (!ALLOWED_ALGS.includes(alg)) throw new Error('unsupported-alg')
  try {
    if (alg === 'RS256') return cryptoVerify('RSA-SHA256', payload, key, signature)
    if (alg === 'ES256') return cryptoVerify('sha256', payload, { key, dsaEncoding: 'ieee-p1363' }, signature)
    // HS256:常数时间比较(长度不等时 timingSafeEqual 抛错 → 按不匹配处理)
    const mac = createHmac('sha256', key).update(payload).digest()
    return mac.length === signature.length && timingSafeEqual(mac, signature)
  } catch { return false }
}

// ID token 全验(纯函数,验签材料由调用方给):kid 匹配 jwks.keys → 验签 → iss → aud → exp → nonce → iat。
// aud 兼容 string 与 string[](JWT 标准两形态);exp 缺失/非数按过期(fail-closed,OIDC id_token 必带 exp)。
// 校验顺序 = 计划原文:材料与签名先于 claims(签名不过,claims 不可信)。
export function verifyIdToken(token, { jwks, issuer, audience, nonce, now = Date.now() }) {
  const seg = decodeJwtSegments(token)
  const kid = seg.header.kid
  const matched = kid ? jwks?.keys?.find((k) => k && k.kid === kid) : null
  if (!matched) throw new Error('unknown-kid')
  const key = jwkToKeyObject(matched)
  if (!verifyJwtSignature(seg.header, seg.signature, seg.signingInput, key)) throw new Error('bad-signature')
  const claims = seg.claims
  if (claims.iss !== issuer) throw new Error('issuer')
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(audience) : claims.aud === audience
  if (!audOk) throw new Error('audience')
  const nowS = Math.floor(now / 1000)
  if (typeof claims.exp !== 'number' || claims.exp < nowS) throw new Error('expired')
  if (nonce !== undefined && claims.nonce !== nonce) throw new Error('nonce')
  if (typeof claims.iat === 'number' && claims.iat > nowS + IAT_FUTURE_TOLERANCE_S) throw new Error('iat-future')
  return { claims }
}
