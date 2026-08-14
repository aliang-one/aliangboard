// 资源量 <-> {数值, 单位} 互转的纯函数,供 ResourceInput 组件把 K8s 规范串
// (如 "4000m" / "512Mi" / "0.5")拆成「数字框 + 单位下拉」,再把 数字+单位 合成回
// 规范串交给 buildResources 原样下发。这样用户只能输数字(单位走下拉),避免脏串。
//
// CPU: cores(无后缀,可小数 0.5) | m(整数毫核 500/4000)
// Memory: Mi/Gi/Ki/Ti(整数 + 二进制后缀)

export const RESOURCE_UNITS = {
  cpu: [{ label: 'cores', value: '' }, { label: 'm', value: 'm' }],
  memory: [{ label: 'Mi', value: 'Mi' }, { label: 'Gi', value: 'Gi' }, { label: 'Ki', value: 'Ki' }, { label: 'Ti', value: 'Ti' }],
}

// "4000m" → { num: '4000', unit: 'm' }; "0.5" → { num: '0.5', unit: '' }; "" → { num: '', unit: <默认> }
// 后缀不在单位表内(或裸数)→ 回退到该类资源第一个单位(cpu=cores, memory=Mi),保留数值。
export function parseQuantity(str, kind = 'cpu') {
  const units = RESOURCE_UNITS[kind] || RESOURCE_UNITS.cpu
  const fallback = units[0].value
  const s = String(str == null ? '' : str).trim()
  if (!s) return { num: '', unit: fallback }
  const m = s.match(/^(\d+(?:\.\d+)?)([A-Za-z]*)$/)
  if (!m) return { num: '', unit: fallback }
  const suffix = m[2]
  const unit = units.some(u => u.value === suffix) ? suffix : fallback
  return { num: m[1], unit }
}

// {数值, 单位} → 规范串。cores 保留小数;m/Ki/Mi/Gi/Ti 取整。空/负/非法 → ''(清空)。
export function formatQuantity(num, unit, kind = 'cpu') {
  if (num === '' || num == null) return ''
  const n = Number(num)
  if (!Number.isFinite(n) || n < 0) return ''
  const decimalAllowed = kind === 'cpu' && unit === ''
  const out = decimalAllowed ? String(n) : String(Math.round(n))
  return out + unit
}
