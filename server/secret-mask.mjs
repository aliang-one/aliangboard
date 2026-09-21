// server/secret-mask.mjs
// Secret 值脱敏单一事实源(spec 2026-08-28 §3.1):字段名保留、值→「长度+sha1 指纹」,
// AI 保留 key 核对/同值比对能力,只断明文通路。幂等(MASK_PATTERN 短路),不 mutate。
import { createHash } from 'node:crypto'

export const MASK_PATTERN = /^\*\*\* \(\d+ chars, #[0-9a-f]{8}\)$/

export function maskValue(v) {
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

// 已知值精确洗(2026-09-20 凭据注入 spec §7):深走对象树,对全部字符串值应用 scrub 函数。
// 与 maskSensitiveText(高置信模式洗)互补:那认 JWT/PEM/AKIA 形态,这只认调用方携带的确切值集
// (注入物化值)。深度上限 8 防循环引用炸栈。纯函数,不 mutate。
export function scrubDeep(value, scrub, depth = 0) {
  if (typeof value === 'string') return scrub(value)
  if (value == null || typeof value !== 'object' || depth > 8) return value
  if (Array.isArray(value)) return value.map(v => scrubDeep(v, scrub, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, scrub, depth + 1)
  return out
}

// C1(2026-09-20 final review)日志面两助手:execCapture 的两个 console.error 站点(cmd=/head=/hint)
// 只许见占位符版命令与洗净文本(红线 8:日志只见占位符版)。execWithCredInjection 把
// __credLog={command:占位符版, scrub} 随 lane 线下传,此处消费:
//   - logSafeCommand:cmd= 面优先占位符版;无 __credLog(非注入路径)原样——其余调用方零变化。
//   - logSafeFacet:自由文本面先整段洗再用——调用方须先本函数后 slice,先截断会把跨截断点的
//     物化值切成半截明文,scrub 认不出整值即穿透。纯函数。
export function logSafeCommand(actual, credLog) {
  return (credLog && typeof credLog.command === 'string') ? credLog.command : actual
}

export function logSafeFacet(text, credLog) {
  const s = String(text ?? '')
  return (credLog && typeof credLog.scrub === 'function') ? credLog.scrub(s) : s
}
