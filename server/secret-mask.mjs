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
