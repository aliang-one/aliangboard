// 异步 summarizer(SP1 Task 3):对话变长时把老轮次蒸馏成 recap,前移 summarizedUpTo。
// 被 runConversation(agent-runner)在每轮结束后调用;失败静默(返回 false),绝不阻塞对话。
// llmClient 走真实 createLlmClient(server/llm.mjs)的 chat({messages}) → message{role,content}。
import {
  listMessages,
  getMaxSeq,
  updateConversation,
  getConversation,
  getProject,
  unsummarizedProjectHistory,
} from './workbench-projects.mjs'
// 注:compactConversation 的 message 返回消息键(wbc.compactShort 等),HTTP 层
// msg(req, out.message) 翻译;未登记键回落原文(与 cancel 端点同款兜底)。

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

// 手动 compact(spec §4.4,2026-08-28):全量重摘要(含旧 recap 作为输入)→ 新 recap 整体替换;
// 保最近 KEEP_RECENT=2 条全文(summarizedUpTo=最大seq-2)。先摘要成功再落库(失败不动 DB)。
// 门禁:仅终态(done/failed/cancelled;running/paused 会破坏 resume 状态);消息 ≤3 拒绝。
const COMPACT_KEEP_RECENT = 2
const COMPACT_MIN_MESSAGES = 4
export async function compactConversation(db, convId, llmClient, instruction = '') {
  const conv = getConversation(db, convId)
  if (!conv) return { ok: false, status: 404, message: 'wbc.convNotFound' }
  if (conv.status === 'running' || conv.status === 'paused') return { ok: false, status: 400, message: 'wbc.compactBusy' }
  const msgs = listMessages(db, convId)
  if (msgs.length <= COMPACT_MIN_MESSAGES - 1) return { ok: false, status: 400, message: 'wbc.compactShort' }
  const maxSeq = getMaxSeq(db, convId)
  const fold = msgs.filter(m => m.seq <= maxSeq - COMPACT_KEEP_RECENT)
  const transcript = [
    ...(conv.recap ? [`(此前摘要)\n${conv.recap}`] : []),
    ...fold.map(m => `${m.role}: ${m.content}`),
  ].join('\n')
  const instruct = String(instruction || '').trim().slice(0, 200)
  try {
    const out = await llmClient.chat({
      messages: [
        { role: 'system', content: `你是对话压缩器。把下面的对话历史压缩成一份忠实、信息密集的中文摘要:保留已做出的决定、关键事实/数据、尚未解决的问题。${instruct ? `用户特别要求:${instruct}` : ''}` },
        { role: 'user', content: transcript },
      ],
    })
    const recap = out?.content?.trim()
    if (!recap) return { ok: false, status: 502, message: 'wbc.compactFailed' }
    updateConversation(db, convId, { recap, summarizedUpTo: maxSeq - COMPACT_KEEP_RECENT }, { touch: false })
    return { ok: true, recap }
  } catch (e) {
    console.error('[compact] 摘要失败:', e?.message || e)
    return { ok: false, status: 502, message: 'wbc.compactFailed' }
  }
}

// 项目级滚动摘要(2026-08-29 spec §3.2):新增未摘要 history ≥ 阈值时,旧摘要+新增历史滚动重摘要。
// 成功才落库(workbench_projects 无 updatedAt,直 UPDATE);失败/空产出静默 false(append 路由 fire,下轮重试)。
const PROJECT_SUMMARY_THRESHOLD = 8
export async function maybeSummarizeProject(db, projectId, llmClient) {
  const project = getProject(db, projectId)
  if (!project) return false
  const pending = unsummarizedProjectHistory(db, projectId)
  if (pending.length < PROJECT_SUMMARY_THRESHOLD) return false
  const transcript = [
    ...(project.projectRecap ? [`(此前项目摘要)\n${project.projectRecap}`] : []),
    ...pending.map(h => `${h.role}: ${String(h.content || '').slice(0, 800)}`),
  ].join('\n')
  try {
    const out = await llmClient.chat({
      messages: [
        { role: 'system', content: '你负责维护一份项目记忆摘要。把「此前项目摘要」与「新增对话」滚动合并为一份新摘要:保留已做出的决定、关键事实与数据、尚未解决的问题;丢弃过程性闲聊;中文,紧凑,不超过 500 字。输出只有摘要本身。' },
        { role: 'user', content: transcript },
      ],
    })
    const recap = out?.content?.trim()
    if (!recap) return false
    // 落库前防并发回退:只推进水位(取 pending 最大 ts 与现值较大者)
    const maxTs = pending[pending.length - 1].ts
    db.prepare('UPDATE workbench_projects SET projectRecap=?, historyWatermark=MAX(COALESCE(historyWatermark,0),?) WHERE id=?').run(recap, maxTs, projectId)
    return true
  } catch { return false }
}
