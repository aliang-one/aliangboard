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
