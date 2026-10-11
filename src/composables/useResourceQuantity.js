// 资源量 <-> {数值, 单位} 互转的纯函数,供 ResourceInput 组件把 K8s 规范串
// (如 "4000m" / "512Mi" / "0.5")拆成「数字框 + 单位下拉」,再把 数字+单位 合成回
// 规范串交给 mergeResources 原样下发。这样用户只能输数字(单位走下拉),避免脏串。
//
// 2026-10-11 换算层全量重写(工作流审计 12 项确认缺陷的根修):
// - 旧 parseQuantity 对外来后缀(1G/100u/2500000n/1e3)静默回退表首单位且保留数值——
//   '1G' 显示成 1 Mi、一触即写 1Mi(~954 倍缩水);'100u' 显示成 100 cores(百万倍)。
//   新实现对完整 K8s quantity 文法按物理量换算到表内单位,绝不改数量级。
// - 旧 formatQuantity 对 m/Ki/Mi/Gi/Ti 静默取整(框显 1.5 载荷 2Gi)。K8s 接受 '1.5Gi'/
//   '0.5m' 合法小数,新实现原样保留,框显=载荷。
// - convertNum(新增):单位下拉切换时按物理量换算数值(4000m→cores=4),配合 ResourceInput。
// - 单位表:cpu 表首改 m(空值默认单位,对齐 '250m' 量级占位语义);memory 增十进制 SI
//   (k/M/G/T)——集群常见的 '1G' 类值原样入表显示、原样保存,不再跨进制失真。
//
// CPU: cores(无后缀,可小数 0.5) | m(毫核,可小数)
// Memory: Mi/Gi/Ki/Ti(二进制) | k/M/G/T(十进制 SI),数值均可小数

export const RESOURCE_UNITS = {
  cpu: [{ label: 'm', value: 'm' }, { label: 'cores', value: '' }],
  memory: [{ label: 'Mi', value: 'Mi' }, { label: 'Gi', value: 'Gi' }, { label: 'Ki', value: 'Ki' }, { label: 'Ti', value: 'Ti' }, { label: 'k', value: 'k' }, { label: 'M', value: 'M' }, { label: 'G', value: 'G' }, { label: 'T', value: 'T' }],
}

// 完整 K8s quantity 文法的因子表(基准:cpu=毫核,memory=Ki)。十进制 SI 与二进制并存。
const CPU_FACTOR = { n: 1e-6, u: 1e-3, m: 1, '': 1e3, k: 1e6, M: 1e9, G: 1e12, T: 1e15, P: 1e18, E: 1e21 }
const MEM_FACTOR = { '': 1 / 1024, k: 1000 / 1024, M: 1e6 / 1024, G: 1e9 / 1024, T: 1e12 / 1024, P: 1e15 / 1024, E: 1e18 / 1024, Ki: 1, Mi: 1024, Gi: 1024 ** 2, Ti: 1024 ** 3, Pi: 1024 ** 4, Ei: 1024 ** 5 }

// 消浮点尾迹:0.1+0.2 类噪声归一到 12 位有效数字;整数原样。
// 定点承诺(审查修复):JS 对 |n|<1e-6 / ≥1e21 的 String() 走指数记法,直接拼单位后缀会产出
// K8s 文法非法串('1e-7m'/'1.024e-9T' → apiserver 422 且本层 parseRaw 回读不了)。
// 小数用 toFixed(20) 展开并截尾零;巨数走 BigInt 固化——format 的输出空间恒可被 parse 读回。
function decimalNormalize(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n)
  const p = parseFloat(n.toPrecision(12))
  const s = String(p)
  if (!/[eE]/.test(s)) return s
  if (Math.abs(p) < 1e21) {
    const fixed = p.toFixed(20).replace(/0+$/, '')
    return fixed.endsWith('.') ? fixed.slice(0, -1) : fixed
  }
  return String(BigInt(Math.round(p)))
}

// 完整文法解析:<数字>[后缀|e指数] → { numStr, suffix, exp };不匹配 → null。
// 后缀大小写敏感(K8s: k=千,M=兆;Ki/Mi 二进制);'E3' 视为指数、'E' 视为 exa。
function parseRaw(s) {
  const m = String(s == null ? '' : s).trim().match(/^(\d+(?:\.\d+)?|\.\d+)(.*)$/)
  if (!m) return null
  const rest = m[2]
  const e = rest.match(/^[eE]([-+]?\d+)$/)
  if (e) return { numStr: m[1], suffix: '', exp: Number(e[1]) }
  if (rest === '') return { numStr: m[1], suffix: '', exp: 0 }
  const BIN = { Ki: 1, Mi: 1, Gi: 1, Ti: 1, Pi: 1, Ei: 1 }
  if (BIN[rest] || /^[numkMGTEP]$/.test(rest)) return { numStr: m[1], suffix: rest, exp: 0 }
  return null
}

// 规范串 → 基准数值(cpu=毫核 / memory=Ki);空/非法 → null。
// 校验层(containerValidation.quantityValue)与换算层共用,单一文法事实源。
export function toBaseValue(str, kind = 'cpu') {
  const p = parseRaw(str)
  if (!p) return null
  const factor = (kind === 'cpu' ? CPU_FACTOR : MEM_FACTOR)[p.suffix]
  if (factor == null) return null
  const n = Number(p.numStr)
  if (!Number.isFinite(n) || n < 0) return null
  const v = n * factor * 10 ** p.exp
  return Number.isFinite(v) ? v : null
}

const EPS = 1e-9
function nearlyInteger(q) { return Math.abs(q - Math.round(q)) < EPS * Math.max(1, Math.abs(q)) }

// 外来值(不在表内的后缀/指数)→ 换算到表内最贴切单位,物理量不变。
//   cpu: 毫核值 >0 且 <1e6 且小数位 ≤3(0.1m/2.5m)用 m,否则 cores(十进制恒精确);
//   memory: 从大到小找整除的表内单位,找不到用数值落在 [1,1024) 的最大单位(裸字节退 Ki)。
function convertToTableUnit(baseValue, kind) {
  const units = RESOURCE_UNITS[kind] || RESOURCE_UNITS.cpu
  if (kind === 'cpu') {
    if (baseValue > 0 && baseValue < 1e6 && nearlyInteger(baseValue * 1e3)) return { num: decimalNormalize(baseValue), unit: 'm' }
    return { num: decimalNormalize(baseValue / 1e3), unit: '' }
  }
  const factors = units.map(u => ({ unit: u.value, f: MEM_FACTOR[u.value] })).sort((a, b) => b.f - a.f)
  for (const { unit, f } of factors) {
    const q = baseValue / f
    if (q >= 1 && nearlyInteger(q)) return { num: String(Math.round(q)), unit }
  }
  for (const { unit, f } of factors) {
    const q = baseValue / f
    if (q >= 1) return { num: decimalNormalize(q), unit }
  }
  const smallest = factors[factors.length - 1]
  return { num: decimalNormalize(baseValue / smallest.f), unit: smallest.unit }
}

// "4000m" → { num: '4000', unit: 'm' }; "0.5" → { num: '0.5', unit: '' }; "" → { num: '', unit: <表首> }
// 表内后缀原样拆分;外来后缀/科学计数按物理量换算到表内单位('100u'→0.1m、'1Pi'→1024Ti、
// '1500'字节→1.46484375Ki);非法 → 清空 + 表首单位。
export function parseQuantity(str, kind = 'cpu') {
  const units = RESOURCE_UNITS[kind] || RESOURCE_UNITS.cpu
  const fallback = units[0].value
  const s = String(str == null ? '' : str).trim()
  if (!s) return { num: '', unit: fallback }
  const p = parseRaw(s)
  if (!p) return { num: '', unit: fallback }
  if (p.exp === 0 && units.some(u => u.value === p.suffix)) return { num: p.numStr, unit: p.suffix }
  const v = toBaseValue(s, kind)
  if (v == null) return { num: '', unit: fallback }
  if (v === 0) return { num: '0', unit: fallback }
  return convertToTableUnit(v, kind)
}

// {数值, 单位} → 规范串。小数原样保留(K8s 接受 '1.5Gi'/'0.5m');空/负/非法 → ''(清空)。
export function formatQuantity(num, unit, kind = 'cpu') {
  if (num === '' || num == null) return ''
  const n = Number(num)
  if (!Number.isFinite(n) || n < 0) return ''
  return decimalNormalize(n) + unit
}

// 单位切换换算:数值从 from 单位换到 to 单位,物理量不变('4000'+m→cores='4'、'512'+Mi→Gi='0.5')。
// 数值空/非法 → null(调用方仅换单位);跨进制(G↔Mi)保 12 位有效数字。
export function convertNum(num, from, to, kind = 'cpu') {
  if (num === '' || num == null) return null
  const n = Number(num)
  if (!Number.isFinite(n) || n < 0) return null
  const table = kind === 'cpu' ? CPU_FACTOR : MEM_FACTOR
  const ff = table[from], tf = table[to]
  if (ff == null || tf == null || ff === tf) return String(decimalNormalize(n))
  return decimalNormalize((n * ff) / tf)
}
