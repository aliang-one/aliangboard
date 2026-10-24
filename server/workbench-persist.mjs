// server/workbench-persist.mjs
// trace 落库前洗涤(2026-09-20 凭据 spec §6):read_credential 工具结果块里 password 字段的
// 明文值 → maskValue 指纹。结构化洗(认块不匹配值)——read_credential 结果的 fields[].value 是
// 唯一合法明文载体(🔓通道),洗它即洗全部。纯函数:块级浅拷贝改副本,绝不 mutate 入参
// (运行中内存 trace 是 AI 当轮上下文,须保明文)。效果:明文只活在当轮运行;落库 / resume /
// recap / distill / compact 读到的恒为掩码。
//
// 值级兜底(2026-10-24 凭据审计 P0-1,第二参 known):结构化洗单点依赖「结果可解析且 fields
// 是数组」,而喂 LLM 的工具内容有 8192 字符 / trace 32KB 截断钳制(agent.mjs)——JSON 被切成
// 裸串后结构化洗整体失明,🔓明文随截断残留落库(审计 HIGH)。known=当轮已知值集
// (credential-known-values 登记,workbench-agent 落盘点透传 currentKnownCredentialValues()),
// 对 tool 面(工具结果/裸串)按值精确洗;**LLM 正文复述不洗**(裁决 #2 显式残余,两函数都只
// 碰 tool 面即维持该裁决)。无 known 时行为与旧版逐字节一致。
import { maskValue } from './secret-mask.mjs'
import { currentKnownCredentialValues, scrubToPlaceholderValues } from './credential-known-values.mjs'

function scrubReadResult(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.fields)) return result
  const fields = result.fields.map(f => {
    if (f?.type !== 'password' || f.plaintext !== true || typeof f.value !== 'string') return f
    const { plaintext, ...rest } = f
    return { ...rest, value: maskValue(f.value) }
  })
  return { ...result, fields }
}

// known 值集 → 精确替换函数(长值优先,防短值子串切碎长值;≥4 字符,同登记表口径)。
function valueScrubFn(known) {
  if (!known || !known.length) return null
  const sorted = [...known].sort((a, b) => String(b.value).length - String(a.value).length)
  return s => {
    let x = s
    for (const p of sorted) {
      const v = p.value, m = p.mask || maskValue(v)
      if (typeof v === 'string' && v.length >= 4 && x.includes(v)) x = x.split(v).join(m)
    }
    return x
  }
}

function deepValueWash(value, scrub, depth = 0) {
  if (!scrub) return value
  if (typeof value === 'string') return scrub(value)
  if (value == null || typeof value !== 'object' || depth > 8) return value
  if (Array.isArray(value)) return value.map(v => deepValueWash(v, scrub, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = deepValueWash(v, scrub, depth + 1)
  return out
}

export function persistableTrace(trace, known) {
  if (!Array.isArray(trace)) return trace
  const scrub = valueScrubFn(known)
  return trace.map(b => {
    if (!b || b.type !== 'tool') return b
    if (b.name === 'read_credential') {
      const washed = { ...b, result: scrubReadResult(b.result) }
      return scrub ? { ...washed, result: deepValueWash(washed.result, scrub) } : washed
    }
    // 其他工具块:per-call scrub(execWithCredInjection)已在执行层洗过;这里兜截断窗口与
    // 登记值二次出现(如 🔓读到后模型把值拼进下一条命令的输出)
    return scrub ? { ...b, result: deepValueWash(b.result, scrub) } : b
  })
}

// messages 列落库前洗(spec §11 红线7「含 messages」):role:'tool' 消息的 content 是工具结果
// JSON 字符串——read_credential 结果里带 plaintext:true 的 password 字段洗回指纹。解析失败/
// 形状不符(无 fields 数组)的 content:无 known 时原串字节保留(不 round-trip,零格式扰动);
// 有 known 时值级兜底洗(截断裸串是审计 HIGH 形态,不再放行)。非数组直通;纯函数不 mutate。
// resume 语义(spec §6):重启/续跑读到掩码是设计行为,不是回归。
export function persistableMessages(messages, known) {
  if (!Array.isArray(messages)) return messages
  const scrub = valueScrubFn(known)
  return messages.map(m => {
    if (!m || m.role !== 'tool' || typeof m.content !== 'string') return m
    let parsed = null
    try { parsed = JSON.parse(m.content) } catch { parsed = null }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.fields)) {
      const washed = JSON.stringify(scrubReadResult(parsed))
      return scrub ? { ...m, content: scrub(washed) } : { ...m, content: washed }
    }
    return scrub ? { ...m, content: scrub(m.content) } : m
  })
}

// pendingApproval / queue 等 args 载体落库前的值级洗(审计「args 二次持久化」面):🔓明文被
// 模型转写进下一次工具 args 时,审批载荷与队列不得带明文落库。深走对象,纯函数。
export function scrubKnownDeep(value, known) {
  return deepValueWash(value, valueScrubFn(known))
}

// pendingApproval 落库专用:args 里的已知值洗回 {{cred:名#字段}} 占位符而非指纹——审批通过后
// resume 按原 args 重新执行,指纹会把命令跑坏;占位符在 resume 时经 substitute 重新物化,
// 落库无明文(红线 7)且功能不破。无溯源的登记值退回指纹兜底(占位符洗不了会 fail-broken)。
export function scrubPendingApprovalDeep(pending) {
  const known = currentKnownCredentialValues()
  const walk = (v, d = 0) => {
    if (typeof v === 'string') return scrubToPlaceholderValues(v)
    if (v == null || typeof v !== 'object' || d > 8) return v
    if (Array.isArray(v)) return v.map(x => walk(x, d + 1))
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = walk(val, d + 1)
    return out
  }
  const washed = walk(pending)
  // 无溯源值指纹兜底(一次性深洗,别对同一对象二次走)
  return deepValueWash(washed, valueScrubFn(known.filter(p => !p.ref)))
}
