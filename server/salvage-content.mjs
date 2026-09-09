// 抢救行 content 派生(2026-09-09 多维审计 WB-SALVAGE-2):失败/取消/暂停抢救行的落库点,
// partial 为空(轮间清零后新轮首调即死的典型形态)但本轮 trace 已有前轮 assistant 文本时,
// content 从「最终 trace」(先 ensureFinalTraceBlock 后的结果)的 assistant 块派生——
// 空 content 行对 LLM 侧=整轮失忆(「继续」重发时 sanitizeMessages 把空行从载荷剔除)、
// 对摘要器=「助手零产出」的毒输入(H2)。partial 非空时保持 partial(它就是终答文本)。
// 独立小模块(非 workbench-agent 导出):workbench-projects.salvageInterrupted 也要用,
// 从 workbench-agent import 会成环。纯函数,零依赖。
export function deriveSalvageContent(partial, finalTrace) {
  if (partial) return partial
  if (!Array.isArray(finalTrace)) return ''
  return finalTrace
    .filter(e => e?.type === 'assistant' && typeof e.content === 'string' && e.content)
    .map(e => e.content)
    .join('\n\n')
}
