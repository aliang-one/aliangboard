// Wave 4 OIDC Task 1:零依赖 JWT 验签(jwt-verify.mjs)。
// 政策(计划 Task 1):**真签名非 mock**——generateKeyPairSync 生成 RSA/EC 真钥、
// JWK 直接取 export({format:'jwk'})(真实形状)、crypto.sign 真签、HS256 用 randomBytes secret。
// 每个通过分支 + 每个 throw 分支各一例。
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign, createHmac } from 'node:crypto'

import {
  base64urlDecode, decodeJwtSegments, jwkToKeyObject, verifyJwtSignature, verifyIdToken,
} from './jwt-verify.mjs'

// === 夹具:真钥(模块加载一次,全文件复用) ===
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const rsaJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-1', alg: 'RS256' }
const otherRsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const otherRsaJwk = { ...otherRsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-other', alg: 'RS256' }
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const ecJwk = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-1', alg: 'ES256' }
const hsSecret = randomBytes(32)
const hsJwk = { kty: 'oct', kid: 'oct-1', alg: 'HS256', k: hsSecret.toString('base64url') }

// 段编码/签名辅助(镜像生产实现的输入形状)
const b64u = (buf) => Buffer.from(buf).toString('base64url')
function encodeSegments(header, claims) {
  return `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`
}
function signToken(header, claims, kind, key, secret) {
  const signingInput = Buffer.from(encodeSegments(header, claims))
  if (kind === 'rs256') return `${signingInput}.${b64u(sign('RSA-SHA256', signingInput, key))}`
  if (kind === 'es256') return `${signingInput}.${b64u(sign('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }))}`
  return `${signingInput}.${b64u(createHmac('sha256', secret).update(signingInput).digest())}`
}
// 时间单位裁决:claims 的 NumericDate 按 RFC 7519 是**秒**;opts.now 是毫秒(Date.now() 惯例,
// 计划原文)。实现内部归一到秒再比较(直接裸比会把一切真 token 判 expired)。
const NOW_MS = 1_760_000_000_000
const NOW_S = Math.floor(NOW_MS / 1000)
const baseClaims = (over = {}) => ({
  iss: 'https://idp.example.com', aud: 'aliangboard', sub: 'user-42',
  exp: NOW_S + 3600, iat: NOW_S - 1, nonce: 'n-abc', ...over,
})

// === base64urlDecode ===
test('base64urlDecode:round-trip 随机字节 + 空串 + 单字节', () => {
  const buf = randomBytes(33)
  assert.deepEqual(base64urlDecode(b64u(buf)), buf)
  assert.deepEqual(base64urlDecode(''), Buffer.alloc(0))
  assert.deepEqual(base64urlDecode('AQ'), Buffer.from([1]))
})

// === decodeJwtSegments ===
test('decodeJwtSegments:三段合法 → header/claims 对象 + signature Buffer', () => {
  const token = signToken({ alg: 'RS256', typ: 'JWT', kid: 'rsa-1' }, baseClaims(), 'rs256', rsa.privateKey)
  const seg = decodeJwtSegments(token)
  assert.equal(seg.header.alg, 'RS256')
  assert.equal(seg.header.kid, 'rsa-1')
  assert.equal(seg.claims.sub, 'user-42')
  assert.ok(Buffer.isBuffer(seg.signature))
  assert.ok(seg.signature.length > 0)
})

test('decodeJwtSegments:段数错/非法字符/非 JSON/非对象 → throw malformed', () => {
  const good = signToken({ alg: 'RS256', kid: 'k' }, baseClaims(), 'rs256', rsa.privateKey)
  assert.throws(() => decodeJwtSegments(good.replace(/\.[^.]*$/, '')), /malformed/) // 2 段
  assert.throws(() => decodeJwtSegments(`${good}.x`), /malformed/) // 4 段
  assert.throws(() => decodeJwtSegments('!!.{}.AAAB'), /malformed/) // 非法字符
  assert.throws(() => decodeJwtSegments(`${b64u('not json')}.${b64u('{}')}.AAAB`), /malformed/)
  assert.throws(() => decodeJwtSegments(`${b64u('{}')}.${b64u('not json')}.AAAB`), /malformed/)
  assert.throws(() => decodeJwtSegments(`${b64u('[1,2]')}.${b64u('{}')}.AAAB`), /malformed/) // header 非对象
  assert.throws(() => decodeJwtSegments(`${b64u('{}')}.${b64u('[1,2]')}.AAAB`), /malformed/) // claims 非对象
  assert.throws(() => decodeJwtSegments(`a.b.`), /malformed/) // 空签名段
})

// === jwkToKeyObject ===
test('jwkToKeyObject:RSA JWK → KeyObject(验签可用)', () => {
  const key = jwkToKeyObject(rsaJwk)
  const signingInput = Buffer.from(encodeSegments({ alg: 'RS256' }, baseClaims()))
  assert.ok(verifyJwtSignature({ alg: 'RS256' }, sign('RSA-SHA256', signingInput, rsa.privateKey), signingInput, key))
})

test('jwkToKeyObject:EC P-256 JWK → KeyObject(验签可用)', () => {
  const key = jwkToKeyObject(ecJwk)
  const signingInput = Buffer.from(encodeSegments({ alg: 'ES256' }, baseClaims()))
  const rawSig = sign('sha256', signingInput, { key: ec.privateKey, dsaEncoding: 'ieee-p1363' })
  assert.ok(verifyJwtSignature({ alg: 'ES256' }, rawSig, signingInput, key))
})

test('jwkToKeyObject:oct JWK → Buffer(= 解码后 secret)', () => {
  const key = jwkToKeyObject(hsJwk)
  assert.ok(Buffer.isBuffer(key))
  assert.deepEqual(key, hsSecret)
})

test('jwkToKeyObject:未知 kty → throw unsupported-key', () => {
  assert.throws(() => jwkToKeyObject({ kty: 'foo' }), /unsupported-key/)
})

// === verifyJwtSignature ===
test('verifyJwtSignature:RS256 真签 true / 篡改 payload false / 换钥 false', () => {
  const key = jwkToKeyObject(rsaJwk)
  const si = Buffer.from(encodeSegments({ alg: 'RS256' }, baseClaims()))
  assert.equal(verifyJwtSignature({ alg: 'RS256' }, sign('RSA-SHA256', si, rsa.privateKey), si, key), true)
  const si2 = Buffer.from(encodeSegments({ alg: 'RS256' }, baseClaims({ sub: 'tampered' })))
  assert.equal(verifyJwtSignature({ alg: 'RS256' }, sign('RSA-SHA256', si, rsa.privateKey), si2, key), false)
  assert.equal(verifyJwtSignature({ alg: 'RS256' }, sign('RSA-SHA256', si, rsa.privateKey), si, jwkToKeyObject(otherRsaJwk)), false)
})

test('verifyJwtSignature:ES256 原始 R||S(P1363)真签 true;DER 编码签名 false', () => {
  const key = jwkToKeyObject(ecJwk)
  const si = Buffer.from(encodeSegments({ alg: 'ES256' }, baseClaims()))
  const rawSig = sign('sha256', si, { key: ec.privateKey, dsaEncoding: 'ieee-p1363' })
  assert.equal(rawSig.length, 64) // P-256:32+32
  assert.equal(verifyJwtSignature({ alg: 'ES256' }, rawSig, si, key), true)
  const derSig = sign('sha256', si, ec.privateKey) // node 默认 DER
  assert.equal(verifyJwtSignature({ alg: 'ES256' }, derSig, si, key), false)
})

test('verifyJwtSignature:HS256 真签 true / 错 secret false', () => {
  const key = jwkToKeyObject(hsJwk)
  const si = Buffer.from(encodeSegments({ alg: 'HS256' }, baseClaims()))
  const mac = createHmac('sha256', hsSecret).update(si).digest()
  assert.equal(verifyJwtSignature({ alg: 'HS256' }, mac, si, key), true)
  const wrong = createHmac('sha256', randomBytes(32)).update(si).digest()
  assert.equal(verifyJwtSignature({ alg: 'HS256' }, wrong, si, key), false)
})

test('verifyJwtSignature:alg 白名单外(none/RS512)→ throw unsupported-alg', () => {
  assert.throws(() => verifyJwtSignature({ alg: 'none' }, Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(1)), /unsupported-alg/)
  assert.throws(() => verifyJwtSignature({ alg: 'RS512' }, Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(1)), /unsupported-alg/)
})

// 审 1-3:alg 混淆回归钉死——攻击者拿 RSA 公钥(PEM)当 HMAC secret 签 HS256 token、kid 指向 RSA JWK。
// 服务端 jwkToKeyObject(RSA) 恒返 KeyObject,createHmac 不吃非对称 KeyObject → 验签 false → bad-signature。
test('verifyIdToken:HS256 token 打 RSA kid(公钥当 HMAC secret 的经典混淆)→ bad-signature', () => {
  const pem = rsa.publicKey.export({ type: 'spki', format: 'pem' }) // 攻击方仅有的材料:公钥
  const header = { alg: 'HS256', typ: 'JWT', kid: 'rsa-1' }
  const signingInput = Buffer.from(encodeSegments(header, baseClaims()))
  const forged = `${signingInput}.${b64u(createHmac('sha256', pem).update(signingInput).digest())}`
  assert.throws(() => verifyIdToken(forged, ctx), /bad-signature/)
})

// === verifyIdToken(三种 alg 各一通过例 + 全部 throw 分支) ===
const jwks = { keys: [rsaJwk, ecJwk, hsJwk] }
const ctx = { jwks, issuer: 'https://idp.example.com', audience: 'aliangboard', nonce: 'n-abc', now: NOW_MS }

test('verifyIdToken:RS256 全绿 → 返回 claims', () => {
  const token = signToken({ alg: 'RS256', typ: 'JWT', kid: 'rsa-1' }, baseClaims(), 'rs256', rsa.privateKey)
  const { claims } = verifyIdToken(token, ctx)
  assert.equal(claims.sub, 'user-42')
})

test('verifyIdToken:ES256 全绿', () => {
  const token = signToken({ alg: 'ES256', typ: 'JWT', kid: 'ec-1' }, baseClaims(), 'es256', ec.privateKey)
  assert.equal(verifyIdToken(token, ctx).claims.sub, 'user-42')
})

test('verifyIdToken:HS256(oct 密钥)全绿', () => {
  const token = signToken({ alg: 'HS256', typ: 'JWT', kid: 'oct-1' }, baseClaims(), 'hs256', null, hsSecret)
  assert.equal(verifyIdToken(token, ctx).claims.sub, 'user-42')
})

test('verifyIdToken:aud 数组形态(含目标)通过;(不含目标)throw audience', () => {
  const arrOk = signToken({ alg: 'RS256', kid: 'rsa-1' }, baseClaims({ aud: ['other', 'aliangboard'] }), 'rs256', rsa.privateKey)
  assert.equal(verifyIdToken(arrOk, ctx).claims.sub, 'user-42')
  const arrBad = signToken({ alg: 'RS256', kid: 'rsa-1' }, baseClaims({ aud: ['other', 'third'] }), 'rs256', rsa.privateKey)
  assert.throws(() => verifyIdToken(arrBad, ctx), /audience/)
})

test('verifyIdToken:kid 不在 jwks → unknown-kid;header 无 kid → unknown-kid', () => {
  const noKid = signToken({ alg: 'RS256', kid: 'nope' }, baseClaims(), 'rs256', rsa.privateKey)
  assert.throws(() => verifyIdToken(noKid, ctx), /unknown-kid/)
  const missing = signToken({ alg: 'RS256' }, baseClaims(), 'rs256', rsa.privateKey)
  assert.throws(() => verifyIdToken(missing, ctx), /unknown-kid/)
})

test('verifyIdToken:签名坏 → bad-signature', () => {
  const foreign = signToken({ alg: 'RS256', kid: 'rsa-1' }, baseClaims(), 'rs256', otherRsa.privateKey)
  assert.throws(() => verifyIdToken(foreign, ctx), /bad-signature/)
})

test('verifyIdToken:issuer 不符 → issuer', () => {
  const t = signToken({ alg: 'RS256', kid: 'rsa-1' }, baseClaims({ iss: 'https://evil.example.com' }), 'rs256', rsa.privateKey)
  assert.throws(() => verifyIdToken(t, ctx), /issuer/)
})

test('verifyIdToken:exp 过去 → expired;exp 未来 → 过;exp 缺失 → expired(fail-closed)', () => {
  const past = signToken({ alg: 'RS256', kid: 'rsa-1' }, baseClaims({ exp: NOW_S - 1 }), 'rs256', rsa.privateKey)
  assert.throws(() => verifyIdToken(past, ctx), /expired/)
  const future = signToken({ alg: 'RS256', kid: 'rsa-1' }, baseClaims({ exp: NOW_S + 7200 }), 'rs256', rsa.privateKey)
  assert.equal(verifyIdToken(future, ctx).claims.sub, 'user-42')
  const missing = signToken({ alg: 'RS256', kid: 'rsa-1' }, baseClaims({ exp: undefined }), 'rs256', rsa.privateKey)
  assert.throws(() => verifyIdToken(missing, ctx), /expired/)
})

test('verifyIdToken:nonce 不符 → nonce;相符 → 过', () => {
  const bad = signToken({ alg: 'RS256', kid: 'rsa-1' }, baseClaims({ nonce: 'wrong' }), 'rs256', rsa.privateKey)
  assert.throws(() => verifyIdToken(bad, ctx), /nonce/)
  const ok = signToken({ alg: 'RS256', kid: 'rsa-1' }, baseClaims({ nonce: 'n-abc' }), 'rs256', rsa.privateKey)
  assert.equal(verifyIdToken(ok, ctx).claims.sub, 'user-42')
})

test('verifyIdToken:iat 未来超 5min 容差(300s)→ iat-future;容差内 → 过', () => {
  const far = signToken({ alg: 'RS256', kid: 'rsa-1' }, baseClaims({ iat: NOW_S + 600 }), 'rs256', rsa.privateKey)
  assert.throws(() => verifyIdToken(far, ctx), /iat-future/)
  const near = signToken({ alg: 'RS256', kid: 'rsa-1' }, baseClaims({ iat: NOW_S + 60 }), 'rs256', rsa.privateKey)
  assert.equal(verifyIdToken(near, ctx).claims.sub, 'user-42')
})
