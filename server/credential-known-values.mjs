// server/credential-known-values.mjs
// 已知凭据值登记表(2026-10-24 凭据审计 P0-1:值级兜底洗涤)。
// 背景:落库结构化洗涤(workbench-persist 的 scrubReadResult)认「read_credential 结果块」的形状,
// 而喂 LLM 的工具内容有 8192 字符 / trace 32KB 两道截断钳制(agent.mjs)——JSON 被切成裸串后
// 结构化洗涤整体失明,🔓明文随截断残留落库并随 resume 回放(审计 HIGH,红线 7 破口)。
// 本表在值进入 LLM 上下文的三个登记点(substitute 物化注入值 / read 🔓明文 / runAdapter 适配器
// 消费值)收下值(+「名#字段」溯源),两条洗脱形态:
//   - scrubKnownValues:值 → maskValue 指纹。trace / messages / audit requestSummary 等纯记录面。
//   - scrubToPlaceholderValues:值 → {{cred:名#字段}} 占位符。pendingApproval 落库专用——resume
//     要按原 args 重新执行,指纹会把命令跑坏;占位符在 resume 时经 substitute 重新物化,
//     落库无明文(红线 7)且功能不破。
// 语义边界:与 substitute 的 per-call scrub 同款「已知值精确替换」——base64 等变换形态洗不了
// (spec §14 显式接受残余);LLM 正文复述不在此洗(裁决 #2,与 text 字段同权)。
// 前提:网关单进程不变式(CLAUDE.md)——本表只活在进程内存,不落盘,有界(512 条 FIFO)。
//
// 状态轴向(state-guard)注:刻意**不**用 kernel createTtlStore/registry——本表存的是凭据明文
// 值本身,/api/admin/state 的 store.snapshot() 枚举面会把明文值暴露给管理端点,违背本模块的
// 存在目的。故用单个模块级数组(插入序 + FIFO 逐最旧 + some() 去重,≤512 条 ×4KB 上界 2MB),
// kernel 只服务「可观测状态」,本表是「必须不可观测状态」。
import { maskValue } from './secret-mask.mjs'

const MAX_ENTRIES = 512
// 短于 4 的值做全局精确替换会大面积误伤普通文本(单字符密码洗掉全文所有该字符),不登记
const MIN_VALUE_LEN = 4

const entries = []  // [{ value, mask, ref? }],插入序;逐出最旧

// 值进入 LLM 上下文时登记。ref='名#字段'(可选):三个登记点都拿得到,占位符洗依赖它。
// 返回是否已登记(重复登记幂等 true,ref 以首次为准)。
export function rememberCredentialValue(v, ref) {
  if (typeof v !== 'string' || v.length < MIN_VALUE_LEN) return false
  if (entries.some(p => p.value === v)) return true
  if (entries.length >= MAX_ENTRIES) entries.shift()
  entries.push({ value: v, mask: maskValue(v), ...(ref ? { ref } : {}) })
  return true
}

function sortedEntries() {
  return entries.length > 1 ? [...entries].sort((a, b) => b.value.length - a.value.length) : entries
}

// 已知值精确洗 → 指纹。幂等(指纹不含原值);O(entries × includes),调用点都在持久化/审计
// 边界,量级可忽略。
export function scrubKnownValues(text) {
  const s = String(text ?? '')
  if (!s || !entries.length) return s
  let x = s
  for (const p of sortedEntries()) {
    if (x.includes(p.value)) x = x.split(p.value).join(p.mask)
  }
  return x
}

// 已知值精确洗 → 占位符。只有带 ref 的登记值参与(无可物化来源的值洗回占位符会让 resume
// 的 substitute 拒执行,fail-closed 变 fail-broken);无 ref 值交由 scrubKnownValues 指纹兜底。
export function scrubToPlaceholderValues(text) {
  const s = String(text ?? '')
  if (!s || !entries.length) return s
  let x = s
  for (const p of sortedEntries()) {
    if (p.ref && x.includes(p.value)) x = x.split(p.value).join(`{{cred:${p.ref}}}`)
  }
  return x
}

// 当前登记集快照(供纯函数持久化层作第二参透传;[{value, mask, ref?}])。
export function currentKnownCredentialValues() {
  return entries.map(p => ({ value: p.value, mask: p.mask, ...(p.ref ? { ref: p.ref } : {}) }))
}

// 测试隔离用:清空登记表(生产禁用语义;名字显式带 ForTest)
export function resetCredentialValuesForTest() {
  entries.length = 0
}
