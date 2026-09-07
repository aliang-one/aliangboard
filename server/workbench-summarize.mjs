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

// 毒记忆事故加固(2026-08-31):三条摘要链路(轮次 recap/compact/项目记忆)共享同款硬性约束——
// 瞬时能力结论(「缺少某接口」)一旦入摘要会被后续轮滚动重写无限传播,固化成持久先验。
// 单一事实源:三处一律 ${CAPABILITY_CONSTRAINT} 内插,禁止再手抄字面(终审 I3:手抄副本在
// 措辞收紧时静默脱钩,projectRecap 链路曾因此三缺一)。
export const CAPABILITY_CONSTRAINT =
  '硬性约束:工具、能力、权限的可用性随时可能因部署/配置变化,禁止把"某功能不可用/缺少某接口"这类瞬时状态写入摘要;摘要只记录稳定的项目事实、目标与决策。'

export const SUMMARIZE_PROMPT =
  '把以下对话老片段压成紧凑 recap,保留关键决策、涉及资源、结论与未决问题,丢弃寒暄/中间步骤细节。用中文,不超过 300 字。' + CAPABILITY_CONSTRAINT

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
// 落库竞态防线(conv-lifecycle-01,2026-09-07):重读+钳制+条件写,见 await 后注释。
const COMPACT_KEEP_RECENT = 2
const COMPACT_MIN_MESSAGES = 4
export async function compactConversation(db, convId, llmClient, instruction = '') {
  const conv = getConversation(db, convId)
  if (!conv) return { ok: false, status: 404, message: 'wbc.convNotFound' }
  if (conv.status === 'running' || conv.status === 'paused') return { ok: false, status: 400, message: 'wbc.compactBusy' }
  const msgs = listMessages(db, convId)
  if (msgs.length <= COMPACT_MIN_MESSAGES - 1) return { ok: false, status: 400, message: 'wbc.compactShort' }
  const maxSeq = getMaxSeq(db, convId)
  const entryUpTo = conv.summarizedUpTo ?? 0 // 条件写守卫期望值:await 前定格,落库时校验未被并发推进
  const fold = msgs.filter(m => m.seq <= maxSeq - COMPACT_KEEP_RECENT)
  const transcript = [
    ...(conv.recap ? [`(此前摘要)\n${conv.recap}`] : []),
    ...fold.map(m => `${m.role}: ${m.content}`),
  ].join('\n')
  const instruct = String(instruction || '').trim().slice(0, 200)
  try {
    const out = await llmClient.chat({
      messages: [
        { role: 'system', content: `你是对话压缩器。把下面的对话历史压缩成一份忠实、信息密集的中文摘要:保留已做出的决定、关键事实/数据、尚未解决的问题。${instruct ? `用户特别要求:${instruct}` : ''}${CAPABILITY_CONSTRAINT}` },
        { role: 'user', content: transcript },
      ],
    })
    const recap = out?.content?.trim()
    if (!recap) return { ok: false, status: 502, message: 'wbc.compactFailed' }
    // 落库前竞态防线(conv-lifecycle-01,P2 数据丢失):await LLM 是秒级窗口,期间 regenerate/edit
    // 截断(消息大幅回退,水位被路由钳回)或状态翻转都可能发生——按入口陈旧 maxSeq 无条件落库
    // 会使 summarizedUpTo 高于现存/未来消息 seq,buildHistory 把此后 append 的新消息(seq 取现存
    // 最大+1 会复用被删 seq)永久跳过,LLM 对最新轮次静默失明。三道防线(maybeSummarize dev29 钳制
    // + maybeSummarizeProject 条件写同款):
    // ①重读会话:已不存在 → 404;翻转为 running/paused(resume 状态会被落库破坏)→ 放弃;
    // ②水位钳制:min(入口 maxSeq-KEEP, 现存 maxSeq)——截断使 maxSeq 回退时不越过现存最大;
    // ③条件写:WHERE COALESCE(summarizedUpTo,0)=入口值——窗口内并发摘要/另一次 compact 已推进
    //   水位则 changes=0 → 放弃(整体替换式 recap 会把并发增量摘要覆写回旧口径)。
    // 重读→钳制→落库为零 await 同步块(node:sqlite 同步执行即原子,前提=网关单进程不变式),
    // 与 resume/regenerate 路由的 TOCTOU 收口同构。
    const cur = getConversation(db, convId)
    if (!cur) return { ok: false, status: 404, message: 'wbc.convNotFound' }
    if (cur.status === 'running' || cur.status === 'paused') return { ok: false, status: 400, message: 'wbc.compactBusy' }
    const upToFinal = Math.min(maxSeq - COMPACT_KEEP_RECENT, getMaxSeq(db, convId))
    const res = db.prepare(
      'UPDATE workbench_conversations SET recap=?, summarizedUpTo=? WHERE id=? AND COALESCE(summarizedUpTo,0)=?'
    ).run(recap, upToFinal, convId, entryUpTo)
    if (res.changes === 0) return { ok: false, status: 409, message: 'wbc.compactRaced' }
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
  // 乐观锁快照(gap2-02,2026-09-07 审计):await LLM 期间 setProjectRecap 可能人工清空/精编
  // (两分支都递增 recapRev)。本写入自身不递增 rev(只有人工写计数)——连续两轮自动摘要
  // 互不挤兑,水位守卫已覆盖同批/更新批的自动写竞争。
  const revAtSnapshot = project.recapRev ?? 0
  const transcript = [
    ...(project.projectRecap ? [`(此前项目摘要)\n${project.projectRecap}`] : []),
    ...pending.map(h => `${h.role}: ${String(h.content || '').slice(0, 800)}`),
  ].join('\n')
  try {
    const out = await llmClient.chat({
      messages: [
        { role: 'system', content: `你负责维护一份项目记忆摘要。把「此前项目摘要」与「新增对话」滚动合并为一份新摘要:保留已做出的决定、关键事实与数据、尚未解决的问题;丢弃过程性闲聊;中文,紧凑,不超过 500 字。输出只有摘要本身。${CAPABILITY_CONSTRAINT}` },
        { role: 'user', content: transcript },
      ],
    })
    const recap = out?.content?.trim()
    if (!recap) return false
    // 长度硬钳(prompt 的「不超过 500 字」只是请求,LLM 不服从时不能无界落库+每轮注入)
    const capped = recap.length > 2000 ? recap.slice(0, 2000) + '…(截断)' : recap
    // 落库为条件写(竞态防线):pending 读取后 await LLM 期间,另一任务可能已完成同批/更新
    // 摘要的写入——无条件 UPDATE 会把新 recap 覆写回旧内容(内容回退,水位因 MAX 不回退,
    // 无法自愈)。守卫 COALESCE(historyWatermark,0) < maxTs:不满足则 changes=0 → 本次丢弃。
    // gap2-02 追加 AND COALESCE(recapRev,0)=快照值:人工清空/精编在窗口内发生(rev 已推进)
    // 则丢弃——尤其清空分支归零了水位,水位守卫「< maxTs」反而放行,rev 是唯一拦截线
    // (清掉的毒 recap 不被迟到摘要复活、人工精编不被静默覆盖)。
    const maxTs = pending[pending.length - 1].ts
    const res = db.prepare(
      'UPDATE workbench_projects SET projectRecap=?, historyWatermark=? WHERE id=? AND COALESCE(historyWatermark,0) < ? AND COALESCE(recapRev,0)=?'
    ).run(capped, maxTs, projectId, maxTs, revAtSnapshot)
    if (res.changes === 0) return false // 已有同批/更新的摘要落库,或人工写在快照后发生 → 丢弃
    return true
  } catch { return false }
}
