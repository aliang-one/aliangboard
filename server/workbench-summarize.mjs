// 异步 summarizer(SP1 Task 3):对话变长时把老轮次蒸馏成 recap,前移 summarizedUpTo。
// 被 runConversation(agent-runner)在每轮结束后调用;失败静默(返回 false),绝不阻塞对话。
// llmClient 走真实 createLlmClient(server/llm.mjs)的 chat({messages}) → message{role,content}。
import {
  listMessages,
  getMaxSeq,
  updateConversation,
  getConversation,
} from './workbench-projects.mjs'

export const SUMMARIZE_PROMPT =
  '把以下对话老片段压成紧凑 recap,保留关键决策、涉及资源、结论与未决问题,丢弃寒暄/中间步骤细节。用中文,不超过 300 字。'

// maybeSummarize(db, convId, llmClient, { thresholdTurns=12, recentKeep=8 }) → Promise<boolean>
// 返回 true=触发了摘要;false=未达阈值/无可摘/失败(不抛)。
export async function maybeSummarize(
  db,
  convId,
  llmClient,
  { thresholdTurns = 12, recentKeep = 8 } = {},
) {
  const conv = getConversation(db, convId)
  if (!conv) return false
  const maxSeq = getMaxSeq(db, convId)
  const upToPrev = conv.summarizedUpTo ?? 0
  const unsummarized = maxSeq - upToPrev
  if (unsummarized <= thresholdTurns) return false // 未达阈值
  const upTo = maxSeq - recentKeep // 留 recentKeep 条全文
  if (upTo <= upToPrev) return false // 没新东西可摘(全在 recent 窗口内)
  const oldMsgs = listMessages(db, convId).filter((m) => m.seq <= upTo && m.seq > upToPrev)
  if (oldMsgs.length === 0) return false
  const transcript = oldMsgs.map((m) => `${m.role}: ${m.content}`).join('\n')
  try {
    const out = await llmClient.chat({
      messages: [
        { role: 'system', content: SUMMARIZE_PROMPT },
        { role: 'user', content: transcript },
      ],
    })
    const seg = out?.content?.trim()
    if (!seg) return false
    // 写入前防御钳制(dev29):await LLM 期间消息可能被 regenerate 截掉——appendMessage 的
    // seq 取"现存最大+1",新回复会复用被删 seq;不钳的话 upTo 会把复用 seq 的新消息也
    // 吞进"已摘要"(buildHistory 跳过全文)。当前水位已越过现存最大 → 放弃本轮写入。
    const upToFinal = Math.min(upTo, getMaxSeq(db, convId))
    if (upToFinal <= upToPrev) return false
    const newRecap = conv.recap ? `${conv.recap}\n\n${seg}` : seg
    updateConversation(db, convId, { recap: newRecap, summarizedUpTo: upToFinal }, { touch: false })
    return true
  } catch {
    return false // 摘失败不阻塞对话
  }
}
