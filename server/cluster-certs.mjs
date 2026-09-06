// 集群证书可观测(2026-09-06 设计 docs/superpowers/specs/2026-09-06-cluster-cert-observability-design.md):
// X509 解析(node:crypto)+ TLS 严/宽双拨归因(node:tls)+ kubernetes.io/tls Secret 扫描 +
// cert-manager 合并。出口只有派生描述符(指纹/主体/日期),绝不含 PEM/DER/私钥。
// tlsConnect/requestFn/now 全量可注入 → 可脱离真实集群单测(对标 cluster-probe 的抽模块约定)。
import { X509Certificate, createHash } from 'node:crypto'
import * as nodeTls from 'node:tls'
import { isIP } from 'node:net'

const DEFAULT_TTL = 60_000     // 报告缓存窗口:页面轮询 + 铃铛共享,不重复拨号
const DEFAULT_TIMEOUT = 5_000  // 单次 TLS 握手上限(cluster-probe 同款量级)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// X509Certificate.validTo 形如 "Sep  3 10:37:21 2036 GMT"。Date.parse 在 V8 可解;
// 兜底走月份名映射(不依赖实现对非 ISO 日期的宽容度)。
export function parseCertDate(str) {
  if (!str) return null
  const direct = Date.parse(str)
  if (!Number.isNaN(direct)) return direct
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})/.exec(String(str))
  if (!m) return null
  const mi = MONTHS.indexOf(m[1])
  if (mi < 0) return null
  return Date.UTC(Number(m[6]), mi, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
}

// 描述符 = 本模块证书的唯一出口形态(绝不含 PEM/DER)。
export function describeCert(x509, now) {
  const validFrom = parseCertDate(x509.validFrom)
  const validTo = parseCertDate(x509.validTo)
  return {
    subject: String(x509.subject || '').replace(/\n/g, ', '),
    issuer: String(x509.issuer || '').replace(/\n/g, ', '),
    validFrom, validTo,
    daysLeft: validTo == null ? null : Math.ceil((validTo - now()) / 86_400_000),
    sans: String(x509.subjectAltName || '').split(/,\s*/).filter(Boolean),
    fingerprint256: x509.fingerprint256 || null,
    isCA: x509.ca === true, // 注意:X509Certificate 无 isCA 属性,CA 标记在 .ca
  }
}

export function parseCertChain(pem, now) {
  if (!pem) return []
  const out = []
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
  for (const m of String(pem).matchAll(re)) {
    try { out.push(describeCert(new X509Certificate(m[0]), now)) } catch { /* 坏块跳过 */ }
  }
  return out
}

const CA_MISMATCH_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_CHAIN_INCOMPLETE'])
const NET_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'])

export function classifyTlsError(code) {
  if (code === 'CERT_HAS_EXPIRED') return 'cert-expired'
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'hostname-mismatch'
  if (CA_MISMATCH_CODES.has(code)) return 'ca-mismatch'
  if (NET_CODES.has(code)) return 'unreachable'
  return 'error'
}

// 单次 TLS 拨号:resolve 永不 reject(错误折成 {ok:false,code,message});socket 用后即毁。
// 注入式 tlsConnect(默认 node:tls.connect)签名:opts → 带 once/setTimeout/getPeerCertificate/destroy 的 socket。
function tlsDial(tlsConnect, { host, port, servername, ca, rejectUnauthorized, timeout }) {
  return new Promise(resolve => {
    let settled = false
    const done = v => { if (!settled) { settled = true; resolve(v) } }
    let socket
    try { socket = tlsConnect({ host, port, servername, ca: ca || undefined, rejectUnauthorized, timeout }) }
    catch (e) { return done({ ok: false, code: 'DIAL_ERROR', message: e?.message || String(e) }) }
    if (!socket || typeof socket.once !== 'function') return done({ ok: false, code: 'DIAL_ERROR', message: 'tlsConnect 返回非 socket' })
    socket.setTimeout(timeout, () => { try { socket.destroy() } catch { /* noop */ } done({ ok: false, code: 'ETIMEDOUT', message: 'tls handshake timeout' }) })
    socket.once('secureConnect', () => {
      try {
        // getPeerCertificate(true) 自 leaf 起带 issuerCertificate 链;空对象无 raw → 停走。
        const chain = []
        let cur = socket.getPeerCertificate(true)
        const seen = new Set()
        let guard = 0
        while (cur && cur.raw && cur.raw.length && !seen.has(cur) && guard++ < 8) {
          seen.add(cur)
          try { chain.push(new X509Certificate(cur.raw)) } catch { /* 坏块跳过 */ }
          cur = cur.issuerCertificate
        }
        try { socket.destroy() } catch { /* noop */ }
        done({ ok: true, chain })
      } catch (e) {
        try { socket.destroy() } catch { /* noop */ }
        done({ ok: false, code: 'PEER_ERROR', message: e?.message || String(e) })
      }
    })
    socket.once('error', err => { try { socket.destroy() } catch { /* noop */ } done({ ok: false, code: err?.code || null, message: err?.message || String(err) }) })
  })
}

// 严/宽双拨:宽拨(rejectUnauthorized:false)拿 peer 链 + 可达性;严拨(存储 CA)裁决信任。
// 独立 node:tls 直拨而非 getDispatcher:与其 sig 缓存 / K8S_INSECURE_SKIP_TLS_VERIFY 解耦,自带短超时,用后即毁。
export async function probeConnection(tlsConnect, { apiServer, ca, insecure, timeout = DEFAULT_TIMEOUT, now = Date.now }) {
  const u = apiServer instanceof URL ? apiServer : new URL(String(apiServer))
  // IP 型 apiServer(kubeadm 常态,如 https://10.0.0.1:6443)禁止塞 servername(Node 直接抛
  // ERR_INVALID_ARG_VALUE)——省略后身份校验自动走证书的 IP SAN,行为与 kubectl 一致。
  const base = { host: u.hostname, port: Number(u.port || 443) }
  if (!isIP(u.hostname)) base.servername = u.hostname
  const loose = await tlsDial(tlsConnect, { ...base, rejectUnauthorized: false, timeout })
  if (!loose.ok) {
    return { trust: NET_CODES.has(loose.code) ? 'unreachable' : 'error', reachable: false, reasonCode: loose.code || null, reason: loose.message || '', peerChain: [] }
  }
  const peerChain = loose.chain.map(x => describeCert(x, now))
  if (!ca || insecure) return { trust: 'unverified', reachable: true, reasonCode: null, reason: '', peerChain }
  const strict = await tlsDial(tlsConnect, { ...base, ca, rejectUnauthorized: true, timeout })
  if (strict.ok) return { trust: 'trusted', reachable: true, reasonCode: null, reason: '', peerChain }
  return { trust: classifyTlsError(strict.code), reachable: true, reasonCode: strict.code || null, reason: strict.message || '', peerChain }
}
