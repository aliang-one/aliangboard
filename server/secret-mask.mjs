// server/secret-mask.mjs
// Secret 值脱敏单一事实源(spec 2026-08-28 §3.1):字段名保留、值→「长度+sha1 指纹」,
// AI 保留 key 核对/同值比对能力,只断明文通路。幂等(MASK_PATTERN 短路),不 mutate。
import { createHash } from 'node:crypto'

export const MASK_PATTERN = /^\*\*\* \(\d+ chars, #[0-9a-f]{8}\)$/

function maskValue(v) {
  const raw = typeof v === 'string' ? v : String(v)
  if (MASK_PATTERN.test(raw)) return raw // 幂等短路:已掩码原样返回
  let decoded
  try { decoded = Buffer.from(raw, 'base64').toString('utf8') } catch { decoded = null }
  // base64 解码总"成功"(宽松);判可解码:重编码 round-trip 一致才算干净解码
  const roundTripOk = decoded != null && Buffer.from(decoded, 'utf8').toString('base64') === raw
  const bytes = roundTripOk ? decoded : raw
  const n = bytes.length
  const fp = createHash('sha1').update(bytes, 'utf8').digest('hex').slice(0, 8)
  return `*** (${n} chars, #${fp})`
}

export function maskSecretResource(resource) {
  if (!resource || resource.kind !== 'Secret') return resource
  const out = { ...resource }
  for (const field of ['data', 'stringData']) {
    const src = resource[field]
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      out[field] = Object.fromEntries(Object.entries(src).map(([k, v]) => [k, maskValue(v)]))
    }
  }
  return out
}

// CSO 2026-08-30 #4:自由文本(日志/exec stdout/文件内容)的高精度敏感模式打码。
// 刻意只收高置信模式(JWT 两段以上结构/PEM 私钥块/AKIA),避免误伤诊断信息。
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
const AKIA_RE = /\bAKIA[0-9A-Z]{16}\b/g
export function maskSensitiveText(text) {
  const s = String(text ?? '')
  if (!s) return s
  return s.replace(PEM_RE, '[redacted-private-key]').replace(JWT_RE, '[redacted-jwt]').replace(AKIA_RE, '[redacted-aws-key]')
}
