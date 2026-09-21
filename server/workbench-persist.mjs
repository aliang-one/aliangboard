// server/workbench-persist.mjs
// trace 落库前洗涤(2026-09-20 凭据 spec §6):read_credential 工具结果块里 password 字段的
// 明文值 → maskValue 指纹。结构化洗(认块不匹配值)——read_credential 结果的 fields[].value 是
// 唯一合法明文载体(🔓通道),洗它即洗全部。纯函数:块级浅拷贝改副本,绝不 mutate 入参
// (运行中内存 trace 是 AI 当轮上下文,须保明文)。效果:明文只活在当轮运行;落库 / resume /
// recap / distill / compact 读到的恒为掩码。
import { maskValue } from './secret-mask.mjs'

function scrubReadResult(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.fields)) return result
  const fields = result.fields.map(f => {
    if (f?.type !== 'password' || f.plaintext !== true || typeof f.value !== 'string') return f
    const { plaintext, ...rest } = f
    return { ...rest, value: maskValue(f.value) }
  })
  return { ...result, fields }
}

export function persistableTrace(trace) {
  if (!Array.isArray(trace)) return trace
  return trace.map(b => (b && b.type === 'tool' && b.name === 'read_credential')
    ? { ...b, result: scrubReadResult(b.result) }
    : b)
}

// messages 列落库前洗(spec §11 红线7「含 messages」):role:'tool' 消息的 content 是工具结果
// JSON 字符串——read_credential 结果里带 plaintext:true 的 password 字段洗回指纹。解析失败/
// 形状不符(无 fields 数组)的 content 原串保留(不 round-trip,零格式扰动);非数组直通;
// 纯函数不 mutate。resume 语义(spec §6):重启/续跑读到掩码是设计行为,不是回归。
export function persistableMessages(messages) {
  if (!Array.isArray(messages)) return messages
  return messages.map(m => {
    if (!m || m.role !== 'tool' || typeof m.content !== 'string') return m
    let parsed
    try { parsed = JSON.parse(m.content) } catch { return m }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.fields)) return m
    return { ...m, content: JSON.stringify(scrubReadResult(parsed)) }
  })
}
