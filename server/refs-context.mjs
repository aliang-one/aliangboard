// @-ref 上下文块(Referenced resources ...)的单一来源与出参剥离。
//
// 背景(2026-08-16「卡片→刷新变 JSON」修复):旧版 POST /:id/messages 曾把 refsCtx 烤进
// user 消息 content 落库,live 渲染干净、刷新后从 messages 重建时原始 JSON 直接当文本显示。
// 现已改为干净落库 + refs 并入对话级 "references"(refreshSystem 每轮注入 system);本模块
// 的 strip 负责让历史已污染行在 GET 出参中恢复干净(库内原文不动,agent history/摘要不受影响)。
//
// 块语法(与 buildRefsContext / fetchRefContext 的产出一致):
//   Referenced resources (当前状态,供你参考):\n
//   [kind/namespace/name]:\n{...JSON...}     ← 成功取到的资源(JSON.stringify(body, null, 2))
//   [kind/namespace/name]: (not found)        ← 失败/不支持/空响应的单行备注
// 块间以 \n\n 相连;末块后 \n\n 接用户正文。
export const REFS_CTX_HEADER = 'Referenced resources (当前状态,供你参考):\n'

// 剥掉 content 开头的 refsCtx 块,返回用户正文。结构不符(无标记/JSON 未闭合/块后无 \n\n)
// 一律原样返回——宁滥勿删:错删用户正文比多显示一段 JSON 严重得多。
export function stripRefsContext(content) {
  if (typeof content !== 'string' || !content.startsWith(REFS_CTX_HEADER)) return content
  let i = REFS_CTX_HEADER.length
  let consumed = false // 至少吃掉一个完整块才动 content;只有头无块 → 视为用户正文,原样返回
  while (i < content.length && content[i] === '[') {
    const labelEnd = content.indexOf(']:', i)
    if (labelEnd < 0) return content
    let j = labelEnd + 2
    if (content[j] === '\n') {
      // JSON 块:平衡花括号扫描;字符串字面量内的 {} 与转义不计数
      j++
      if (content[j] !== '{') return content
      let depth = 0, inStr = false, esc = false
      for (; j < content.length; j++) {
        const c = content[j]
        if (esc) { esc = false; continue }
        if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
        if (c === '"') { inStr = true; continue }
        if (c === '{') depth++
        else if (c === '}') { depth--; if (depth === 0) { j++; break } }
      }
      if (depth !== 0) return content // 未闭合 → 不是完整 JSON 块,不动
    } else {
      // 单行备注块((not found) 等):吃到行尾
      const nl = content.indexOf('\n', j)
      if (nl < 0) return content
      j = nl
    }
    // 块结束必须是 \n\n(块间分隔,或与用户正文的分界)
    if (!content.startsWith('\n\n', j)) return content
    i = j + 2
    consumed = true
  }
  return consumed ? content.slice(i) : content
}
