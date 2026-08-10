// K8s 资源量（quantity）解析与格式化——单一数据源。
// metrics.k8s.io 返回的用量与节点 allocatable / 容器 requests 都是 K8s quantity 字符串，
// 这里统一解析为可计算的数值，再格式化回展示格式（"124m"、"1Gi"）。
// 纯函数、零依赖：scripts/test.mjs 可经相对路径直接 import（无 @/ 别名）。
export function cpuToMilli(q) {
  if (q == null || q === '') return 0
  const s = String(q).trim()
  if (s.endsWith('n')) return Math.round(Number(s.slice(0, -1)) / 1e6)   // nanocores → m
  if (s.endsWith('u')) return Math.round(Number(s.slice(0, -1)) / 1e3)   // microcores → m
  if (s.endsWith('m')) return Number(s.slice(0, -1)) || 0                // millicores
  const n = Number(s)
  return isNaN(n) ? 0 : n * 1000                                         // cores → m
}

// 毫核整数 → K8s quantity 字符串（保存/下发时用）。空值返回 ''，由调用方决定是否带该字段。
export const milliToCpu = m => (m == null || m === '' ? '' : `${m}m`)

export function memToKi(q) {
  if (q == null || q === '') return 0
  const s = String(q).trim()
  const m = s.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/)
  if (!m) return 0
  const num = Number(m[1])
  const suf = m[2] || ''
  const mult = {
    Ki: 1, Mi: 1024, Gi: 1024 ** 2, Ti: 1024 ** 3, Pi: 1024 ** 4, Ei: 1024 ** 5,
    k: 1000 / 1024, M: 1e6 / 1024, G: 1e9 / 1024, T: 1e12 / 1024, P: 1e15 / 1024, E: 1e18 / 1024,
  }
  return Math.round(num * (suf ? (mult[suf] ?? 1) : 1 / 1024))           // 无后缀视为裸字节
}

// 用量/容量格式化（供视图展示）
export const formatCpu = milli => (milli == null ? '—' : Math.round(milli) + 'm')
export const formatMem = ki => {
  if (ki == null) return '—'
  if (ki >= 1024 ** 3) return (ki / 1024 ** 3).toFixed(ki % 1024 ** 3 ? 1 : 0) + 'Ti'
  if (ki >= 1024 ** 2) return (ki / 1024 ** 2).toFixed(ki % 1024 ** 2 ? 1 : 0) + 'Gi'
  if (ki >= 1024) return Math.round(ki / 1024) + 'Mi'
  return Math.round(ki) + 'Ki'
}
