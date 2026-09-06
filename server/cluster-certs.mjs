// 集群证书可观测(2026-09-06 设计 docs/superpowers/specs/2026-09-06-cluster-cert-observability-design.md):
// X509 解析(node:crypto)+ TLS 严/宽双拨归因(node:tls)+ kubernetes.io/tls Secret 扫描 +
// cert-manager 合并。出口只有派生描述符(指纹/主体/日期),绝不含 PEM/DER/私钥。
// tlsConnect/requestFn/now 全量可注入 → 可脱离真实集群单测(对标 cluster-probe 的抽模块约定)。
import { X509Certificate, createHash } from 'node:crypto'
import * as nodeTls from 'node:tls'

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
