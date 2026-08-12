// 存储字节数 → 人类可读(二进制单位 B/Ki/Mi/Gi/Ti/Pi)。纯函数,不引 Vue,可零依赖测试。
// null/NaN/负 → '—'(供 UI 占位)。
const UNITS = ['B', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi']

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  let i = 0
  let v = n
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++ }
  if (i === 0) return `${Math.round(v)} B`
  // <10: 1 位小数(去尾 .0); ≥10: 整数
  const formatted = v < 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(0)
  return `${formatted} ${UNITS[i]}`
}

// K8s 资源数量字符串 → 字节数。二进制后缀 Ki/Mi/Gi/Ti/Pi/Ei(1024 进),
// 十进制后缀 K/M/G/T/P/E(1000 进,K8s 语义),裸数字 = 字节。非法 → null。
// 用于 NFS 共享检测:把 PVC 申请容量(spec.resources.requests.storage)转字节,
// 与 kubelet 的 capacityBytes 对比,差异巨大即为共享后端。
const BIN = { KI: 1024, MI: 1024 ** 2, GI: 1024 ** 3, TI: 1024 ** 4, PI: 1024 ** 5, EI: 1024 ** 6 }
const DEC = { K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 }

export function parseSizeToBytes(s) {
  if (s == null) return null
  if (typeof s === 'number') return (s >= 0 && Number.isFinite(s)) ? s : null
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([KMGTPE]i?|B)?$/i)
  if (!m) return null
  const num = parseFloat(m[1])
  if (!Number.isFinite(num)) return null
  const unit = (m[2] || '').toString()
  if (unit === '' || unit.toUpperCase() === 'B') return Math.round(num)
  const up = unit.toUpperCase()
  const factor = up.endsWith('I') ? (BIN[up] ?? null) : (DEC[up] ?? null)
  if (factor == null) return null
  return Math.round(num * factor)
}
