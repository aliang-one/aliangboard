// src/logic/podLogs.js
// Pod 日志纯逻辑：行解析（parseLogLine 从 PodDetail.vue 迁入）、查询串构造、前端过滤/高亮、
// 智能滚动判定、环形缓冲。零依赖，供 useLogViewer/LogViewerBody 消费。

const LEVEL_RE = { ERROR: /\berror\b/i, WARN: /\bwarn(?:ing)?\b/i }

// 单行日志 → { timestamp, level, message }：K8s log API 开 timestamps=true 时行首为 RFC3339。
export function parseLogLine(line) {
  const match = String(line).match(/^(\S+)\s(.*)$/)
  const timestamp = (match?.[1] || '').match(/^\d{4}-\d{2}-\d{2}T/) ? match?.[1] || '' : ''
  const message = timestamp ? match?.[2] || '' : String(line ?? '')
  const level = LEVEL_RE.ERROR.test(message) ? 'ERROR' : LEVEL_RE.WARN.test(message) ? 'WARN' : 'INFO'
  return { timestamp, level, message }
}

// kubectl logs 语义查询串：--tail / --since / --previous / --follow / --timestamps
export function buildLogQuery({ container = '', tailLines = 500, sinceSeconds = 0, previous = false, follow = false } = {}) {
  const q = new URLSearchParams({ timestamps: 'true', tailLines: String(tailLines) })
  if (container) q.set('container', container)
  if (sinceSeconds) q.set('sinceSeconds', String(sinceSeconds))
  if (previous) q.set('previous', 'true')
  if (follow) q.set('follow', 'true')
  return q
}

// 高亮拆分：按全局正则把消息切成 [{text, hit}] 片段（模板 v-for 渲染 span，不走 v-html，XSS 免疫）。
// 零宽匹配（如 /x*/）跳过推进 lastIndex 防死循环。
export function highlightSegments(text, regex) {
  const str = String(text ?? '')
  if (!regex) return [{ text: str, hit: false }]
  regex.lastIndex = 0
  const out = []
  let last = 0
  let m
  while ((m = regex.exec(str)) !== null) {
    if (m[0] === '') { regex.lastIndex++; continue }
    if (m.index > last) out.push({ text: str.slice(last, m.index), hit: false })
    out.push({ text: m[0], hit: true })
    last = m.index + m[0].length
  }
  if (last < str.length) out.push({ text: str.slice(last), hit: false })
  return out.length ? out : [{ text: '', hit: false }]
}

// 组合过滤器：级别多选 + 搜索（子串不区分大小写 / 正则）。非法正则 → error 提示且不过滤（防崩溃）。
// test 用非全局正则（全局 lastIndex 会污染 test 结果），highlight 用全局正则。
export function compileFilter({ search = '', useRegex = false, levels = ['ERROR', 'WARN', 'INFO'] } = {}) {
  const levelSet = new Set(levels?.length ? levels : ['ERROR', 'WARN', 'INFO'])
  let testRegex = null
  let hlRegex = null
  let error = ''
  const q = String(search ?? '').trim()
  if (q) {
    const src = useRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    try {
      testRegex = new RegExp(src, 'i')
      hlRegex = new RegExp(src, 'gi')
    } catch (e) {
      error = e?.message || 'invalid regex'
    }
  }
  return {
    error,
    test: line => levelSet.has(line?.level) && (!testRegex || testRegex.test(line?.message ?? '')),
    highlight: message => highlightSegments(message, hlRegex),
  }
}

// 距底 ≤ threshold 视为「贴底」（following 恢复条件）。直接接收 DOM 元素亦可（鸭子类型）。
export function isNearBottom({ scrollTop, scrollHeight, clientHeight }, threshold = 40) {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

// 环形缓冲：原地追加（单值或数组）并截头保尾。
export function pushCapped(arr, incoming, cap) {
  const items = Array.isArray(incoming) ? incoming : [incoming]
  arr.push(...items)
  if (arr.length > cap) arr.splice(0, arr.length - cap)
  return arr
}

export function levelCounts(lines) {
  const c = { ERROR: 0, WARN: 0, INFO: 0 }
  for (const l of lines || []) if (l?.level && c[l.level] != null) c[l.level]++
  return c
}
