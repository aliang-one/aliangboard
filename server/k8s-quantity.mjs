// K8s 资源数量解析(dev24 wb_top):metrics.k8s.io 的 usage 与 resources.limits 的
// 数量字符串 → 统一数值,算"用量/上限"百分比(OOM 前兆/CPU 打满一眼可见)。
// 纯函数、零依赖,便于单测。
//
// CPU 形态: "250m"(0.25 核) | "2"(2 核) | "1.5"
// 内存形态: "128974848"(字节) | "1289748Ki" | "123Mi" | "1Gi" | "1Ti"(二进制后缀,
//           K8s 语义 Ki/Mi/Gi/Ti/Pi/Ei 为 1024 进制)

const MEM_UNITS = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 }

// → 核数(number) | null(空/不可解析)
export function parseCpu(s) {
  if (s == null || s === '') return null
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)(m)?$/)
  if (!m) return null
  const n = Number(m[1])
  return m[2] ? n / 1000 : n
}

// → 字节数(number) | null。不接受十进制后缀(K/M/G——K8s 资源 API 只产二进制后缀)
export function parseMem(s) {
  if (s == null || s === '') return null
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei)?$/)
  if (!m) return null
  const n = Number(m[1])
  return m[2] ? n * MEM_UNITS[m[2]] : n
}

// 用量相对上限的百分比(向下取整)。usage/limit 任一不可解析 → null(不给假数)
export function pctOf(usage, limit) {
  const u = parseCpu(usage) ?? parseMem(usage)
  const l = parseCpu(limit) ?? parseMem(limit)
  if (u == null || l == null || l <= 0) return null
  return Math.floor((u / l) * 100)
}
