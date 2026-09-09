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
  clampRecap,
} from './workbench-projects.mjs'
import { deriveSalvageContent } from './salvage-content.mjs'
import { trimBudgetChars, contextWindowFor } from './model-context.mjs'
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

// transcript 行构造(H2,2026-09-09 审计):空 assistant 行(salvage/preserve 落库的 content=''
// 形态,真实文本在 trace)与「继续」短行原样进摘要器 →「用户反复要求继续、助手零产出」→
// 毒 recap。回填:空行从 trace 的 assistant 块取文本(deriveSalvageContent 同源);纯工具
// 空轮回填为空 → 剔除。过滤只落 transcript 构造,严禁动 listMessages/buildHistory——前端
// 交错渲染靠空行的 trace 载荷,agent 发送侧已由 sanitizeMessages(llm.mjs)覆盖。
function transcriptLine(m) {
  const content = String(m.content || '')
  if (m.role === 'assistant' && !content.trim()) {
    let backfill = ''
    try { backfill = deriveSalvageContent('', JSON.parse(m.trace || '[]')) } catch { backfill = '' }
    return backfill ? `assistant: ${backfill}` : null
  }
  return `${m.role}: ${content}`
}

// per-conv in-flight 去重(H1,镜像 projectSummarizerInflight):messages 路由与 agent done
// 两触发点并发到达时双双读 pending → 两路 LLM 白烧 + 互以入口快照覆写丢段。测试注入缝同款。
const convSummarizerInflight = new Set()

// maybeSummarize(db, convId, llmClient, { thresholdTurns=12, recentKeep=8 }) → Promise<boolean>
// 返回 true=触发了摘要;false=未达阈值/无可摘/失败(不抛)。
export async function maybeSummarize(
  db,
  convId,
  llmClient,
  { thresholdTurns = 12, recentKeep = 8, inflight = convSummarizerInflight } = {},
) {
  if (inflight.has(convId)) return false
  inflight.add(convId)
  try {
    const conv = getConversation(db, convId)
    if (!conv) return false
    const allMsgs = listMessages(db, convId)
    const maxSeq = getMaxSeq(db, convId)
    const upToPrev = conv.summarizedUpTo ?? 0
    // H2④:触发计数改非空条数(空 assistant 行不驱动折叠节奏);水位算术保持 seq 制
    // (upTo/summarizedUpTo/regenWatermark 钳制全 seq 语义,混 count 制会击穿跳过防线)。
    const nonEmptyCount = allMsgs.filter(
      (m) => m.seq > upToPrev && m.seq <= maxSeq && !(m.role === 'assistant' && !String(m.content || '').trim()),
    ).length
    // METER-5(2026-09-09 审计):体积触发线——行数线(>12)对「轮次少而单轮大」的对话(几轮
    // 20-30KB 工具结论长答,生产症状形态)永不触发,体积型溢出只剩静默硬 trim。口径=Σcontent
    // (buildHistory 装配面;严禁按整 DB 行——trace/reasoning 大字段不入上下文)+ conv.recap
    // 自身(摘要越滚越大自己成为膨胀源);阈值与执法线单源(model-context)取半。
    // 口径=装配面(仅 seq>upToPrev;评审 Important#1:全量计数会让「历史已摘要」的对话
    // 永久越过体积线 → 每条新消息都白烧一次摘要 LLM)+ conv.recap 自身
    const volChars = allMsgs.filter(m => m.seq > upToPrev).reduce((n, m) => n + String(m.content || '').length, 0) + (conv.recap?.length || 0)
    const volumeTrigger = volChars > trimBudgetChars(contextWindowFor(llmClient?.model)) * 0.5
    if (!(nonEmptyCount > thresholdTurns || volumeTrigger)) return false
    // 触发线放宽保留窗(METER-5 复核:只提前触发不改保留是白摘——单轮 15KB 的对话摘后 8 行
    // 全文仍超预算):体积路径逐级 8→4(compact 手动全量语义是 2,自动通道不过激);
    // 末条 user 永不摘要(与 regenWatermark 的 lastUserSeq 语义对齐)。
    const keep = volumeTrigger ? Math.min(recentKeep, 4) : recentKeep
    const lastUser = [...allMsgs].reverse().find((m) => m.role === 'user')
    let upTo = maxSeq - keep
    if (lastUser && upTo >= lastUser.seq) upTo = lastUser.seq - 1
    if (upTo <= upToPrev) return false // 没新东西可摘(全在 recent 窗口内)
    const oldMsgs = allMsgs.filter((m) => m.seq <= upTo && m.seq > upToPrev)
    if (oldMsgs.length === 0) return false
    const lines = oldMsgs.map(transcriptLine).filter(Boolean)
    if (lines.length === 0) {
      // H2③:折叠窗内无有效内容(纯空轮)→ 无可摘,跳过 LLM 直接推进水位(否则每条新消息
      // 重触发判定)。CAS 同款:窗口内水位已被并发推进则放弃。
      const res = db.prepare(
        'UPDATE workbench_conversations SET summarizedUpTo=? WHERE id=? AND COALESCE(summarizedUpTo,0)=?',
      ).run(upTo, convId, upToPrev)
      return res.changes > 0
    }
    const transcript = lines.join('\n')
    try {
      const out = await llmClient.chat({
        messages: [
          { role: 'system', content: SUMMARIZE_PROMPT },
          { role: 'user', content: transcript },
        ],
      })
      const seg = out?.content?.trim()
      if (!seg) return false
      // H1(2026-09-09 审计)落库三防线:
      // ① maxSeq 回落守卫:窗口内 edit/regenerate 截断使消息回退 → 丢弃(等价 oldMsgs 复验,
      //   证明:吞没要求锚 f ≤ upTo=入口max-keep → 截后 max ≤ f+2 < 入口max,必被拦);
      // ② 水位钳制:upToFinal=min(upTo, 现存 maxSeq)(dev29 语义保留,seq 复用防吞新消息);
      // ③ CAS 条件写:WHERE COALESCE(summarizedUpTo,0)=入口值——窗口内并发摘要/compact 已
      //   推进水位则 changes=0 丢弃(双摘要互以入口快照 recap 覆写=静默丢段,生产「快失败
      //   run+用户重试」即触达)。recap 拼接基于入口快照无需重读:recap 仅两个写点且都
      //   co-move 水位,CAS 已串行化。
      const nowMax = getMaxSeq(db, convId)
      if (nowMax < maxSeq) return false
      const upToFinal = Math.min(upTo, nowMax)
      if (upToFinal <= upToPrev) return false
      // context-assembly-03(2026-09-07 审计批次三):追加式写点 64KB 硬钳——`${旧}\n\n${新}` 滚动
      // 增长,LLM 不服从「不超过 300 字」时无界落库,recap 每轮全量注入即上下文放大器。
      const newRecap = clampRecap(conv.recap ? `${conv.recap}\n\n${seg}` : seg)
      const res = db.prepare(
        'UPDATE workbench_conversations SET recap=?, summarizedUpTo=? WHERE id=? AND COALESCE(summarizedUpTo,0)=?',
      ).run(newRecap, upToFinal, convId, upToPrev)
      return res.changes > 0
    } catch (e) {
      // gap2-04(2026-09-07 审计批次三):静默 → 可见(不改语义,仍返 false 不阻塞对话)
      console.error('[wb-summarize] 轮次摘要失败:', e?.message || e)
      return false
    }
  } finally {
    inflight.delete(convId)
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
  // H2(2026-09-09):compact 输入同款过滤空 assistant 行 + trace 回填——compact 是已污染
  // conv.recap 的唯一清毒通道(无人工清空端点),过滤后的干净输入重写 recap 即完成清毒。
  const transcript = [
    ...(conv.recap ? [`(此前摘要)\n${conv.recap}`] : []),
    ...fold.map(transcriptLine).filter(Boolean),
  ].join('\n')
  const instruct = String(instruction || '').trim().slice(0, 200)
  try {
    const out = await llmClient.chat({
      messages: [
        { role: 'system', content: `你是对话压缩器。把下面的对话历史压缩成一份忠实、信息密集的中文摘要:保留已做出的决定、关键事实/数据、尚未解决的问题。${instruct ? `用户特别要求:${instruct}` : ''}${CAPABILITY_CONSTRAINT}` },
        { role: 'user', content: transcript },
      ],
    })
    const recapRaw = out?.content?.trim()
    if (!recapRaw) return { ok: false, status: 502, message: 'wbc.compactFailed' }
    // context-assembly-03:整体替换写点同钳 64KB(clampRecap 单源);返回值同步用钳后值(与落库一致)
    const recap = clampRecap(recapRaw)
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
// 成功才落库(workbench_projects 无 updatedAt,直 UPDATE);失败/空产出 false(append 路由 fire,
// 下轮重试;gap2-04 起失败落 console.error,不再全链路静默)。
const PROJECT_SUMMARY_THRESHOLD = 8

// gap2-01(2026-09-07 审计批次三):per-project in-flight 去重。messages 路由与 agent done 两
// 触发点 fire-and-forget 并发到达时,旧实现双双读 pending → 两路 LLM → 条件写只留一路(一次
// LLM 白烧)。内存 Set,单进程不变式(网关单进程);run 出函即清。测试注入缝 { inflight }:
// 传入独立 Set 可复现「双双重入」竞态(生产恒默认模块级,勿传)。
const projectSummarizerInflight = new Set()

// context-assembly-08 防重摘键(2026-09-07 审计批次三):projectId → 已喂给 LLM 的最大 history
// rowid。`ts >= 水位` 读法(unsummarizedProjectHistory)会把边界毫秒的已摘行重新读出,此键将其
// 滤掉(同批已摘行不重喂 LLM=不重摘)。内存态,单进程不变式:重启丢失=边界行最多重摘一次(滚动
// 合并语义下无害);水位为 0(从未摘/人工清空重摘全量)时键失效——全量重摘语义优先(见 floor)。
// 条目按 projectId 存续(项目删除后残留一个键,有界可忽略;randomUUID 不复用无串味面)。
const projectSummarizerFedRid = new Map()

export async function maybeSummarizeProject(db, projectId, llmClient, { inflight = projectSummarizerInflight } = {}) {
  if (inflight.has(projectId)) return false
  inflight.add(projectId)
  try {
    const project = getProject(db, projectId)
    if (!project) return false
    const wm = project.historyWatermark ?? 0
    // 防重摘下限:wm==0(从未摘/人工清空)时忽略键——清空重摘语义=从头吞全量
    const fedFloor = wm === 0 ? 0 : (projectSummarizerFedRid.get(projectId) ?? 0)
    const pending = unsummarizedProjectHistory(db, projectId).filter(r => (r.rid ?? 0) > fedFloor)
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
      // 防重摘键仅在条件写成功后推进(fix round 1,Important):changes=0 的丢弃路径不得提前
      // 推进——生产唯一可达的丢弃形态是「窗口内人工非空精编」(rev 不匹配而水位刻意不动:
      // setProjectRecap 非空分支契约=自动摘要继续增量),提前推进会把本批行被 rid>fedFloor
      // 永久滤出、永不并入 projectRecap,增量语义被击穿。同批/更新批赢家已自行写入 ≥ 本批的
      // 键值,丢弃方不推进无损;代价仅是极端边界形态(≥8 行同毫秒且全被水位线卡死)下每次触发
      // 重喂一次 LLM——宁浪费勿丢行。
      projectSummarizerFedRid.set(projectId, Math.max(...pending.map(r => r.rid ?? 0)))
      return true
    } catch (e) {
      // gap2-04:失败可见(不改语义,仍返 false 由下轮触发重试)
      console.error('[wb-summarize] 项目摘要失败:', e?.message || e)
      return false
    }
  } finally {
    inflight.delete(projectId) // gap2-01:run 结束清除(含早退/抛错路径)
  }
}
