// SP2: agent loop 从 index.mjs 抽出。factory 模式(同 createApiKeyTools)。
// 纯重构,zero behavior change —— 函数体从 index.mjs 逐字搬迁。
//
// 线程终态 → bus 事件序列(eventsForResult 在 conv-events.mjs,纯函数已可单测)。
// busEmit/busDispose 作 factory dep 注入(与 createAgentRunner 同理,便于单测 stub)。
import { buildHistory, appendMessage, getConversation, getProject, updateConversation, appendTrace, appendHistory } from './workbench-projects.mjs'
import { maybeSummarizeProject } from './workbench-summarize.mjs'
import { contextWindowFor, trimBudgetChars } from './model-context.mjs'
import { eventsForResult } from './conv-events.mjs'
import { clampTraceStep } from './agent.mjs'
import { getWorkbenchAiConfig, getMaxStepsConfig } from './workbench-ai-config.mjs'
import { workbenchExcludeTools } from './tool-registry.mjs'
import { buildProjectMemoryInjection } from './workbench-prompt.mjs'
// gap3-01(2026-09-07 审计批次二):换绑锚定——refreshSystem 装配前比对 refs 戳与当下
// project.clusterId,旧集群 ref 停用(不重拉)+ 注入作废注记。见 refs-normalize.mjs 文件头注。
import { splitStaleRefs, buildStaleRefsNote } from './refs-normalize.mjs'

// deps: { db, buildWbCtx, buildK8sSession, fetchRefContext, createAgentRunner, busEmit, busDispose }
//   db                —— node:sqlite DatabaseSync(index.mjs 顶层构造)
//   buildWbCtx        —— (project) → { ctx, ... }(index.mjs 工作台 context 构造)
//   buildK8sSession   —— (clusterId) → k8sSession(index.mjs 重建 call-context)
//   fetchRefContext   —— (refs, k8sSession) → Promise<string>(index.mjs @-ref 拉取)
//   createAgentRunner —— ({ llmClient, workbench }) → { run, toolDefs }(agent-runner.mjs)
//   busEmit           —— (convId, evt) => void(conv-bus.mjs emit)
//   busDispose        —— (convId) => void(conv-bus.mjs dispose)
// 动态审批白名单路由(2026-09-07 审计 F1 P0 收口,单一事实源):wb_ssh_job_* → 任务桥按其策略
// 裁决;其余 wb_ssh_*(exec/read_file/run)与 write_server_notes → 同步桥;**其余工具恒人审
// (直接 true,不进任何桥)**。旧版「其余全走同步桥」兜底 = P0:args 是 LLM 生成 JSON,
// wb_scale/wb_exec 等非 SSH 写工具的 schema 根本没有 server 字段,却被同步桥按
// resolve(args.server) 命中服务器的 aiApprovalPolicy 裁决——伪造一个指向 none/readonly 策略
// 暴露服务器的 server 即免审直执行(审计真模块端到端复现)。wb_ssh_run 由此从任务桥移回同步桥
// (两桥对它的裁决语义同款:none→免审/readonly→分类器/always→人审)。agent-bridge.needsApproval
// 另有同名前缀防御兜底(双保险,防未来路由再错配)。
// 两处装配点(run/resume)必须都走这里;被路由的桥缺位走默认收紧(true)。
// 纯函数:不落地/无副作用——needsApproval 在 checkpoint 与 resume 两处被咨询。
export async function routeDynamicApproval(n, args, sshBridge, sshJobs) {
  if (n.startsWith('wb_ssh_job_')) return sshJobs ? sshJobs.needsApproval(n, args) : true
  if (n.startsWith('wb_ssh_') || n === 'write_server_notes') return sshBridge ? sshBridge.needsApproval(n, args) : true
  return true
}

// 终答兜底块(2026-09-06「对话尾巴不展示」修复):轮未完成(失败/取消/步数硬断)时,已流出
// 的文本只活在 content——没有 assistant step 事件 → trace 无对应块 → 前端交错渲染模式只渲染
// trace 块,尾巴对用户永久不可见(生产近期 31% 消息中招)。纯函数:content 非空且 trace 末尾
// 无同文 assistant 块 → 追加一块并返回新数组;否则原样返回。同文判定兼容 conv.trace 全量形状
// (message.content 嵌套)。salvage/cancelled/done 三条落库路径共用,勿在调用点复刻判定。
export function ensureFinalTraceBlock(content, trace = []) {
  if (!content) return trace
  const last = trace[trace.length - 1]
  if (last?.type === 'assistant' && (last.content ?? last.message?.content) === content) return trace
  return [...trace, { type: 'assistant', content }]
}

export function createWorkbenchAgent(deps) {
  const { db, buildWbCtx, buildK8sSession, fetchRefContext, createAgentRunner, busEmit, busDispose } = deps

  // ── per-run epoch(2026-09-06 审计#3 对抗审查收口)──
  // 「停止→修改重发」是取消的主流程,而重发路由放行 cancelled 并置回 running——以共享
  // status 做取消信号会被新 run 击穿:旧 run 的检查点/落库前守卫读到 running 即放行,继续
  // 执行剩余工具、发起后续 LLM 轮、把终态与 bus 事件覆写到新 run 头上(路由 P0 守卫注释
  // 警告的「并发双 run 交错写」,'cancelled' 恰是那只守卫的盲区)。修法=每次 run 启动 bump
  // epoch(cancelConversation 刻意不 bump:纯取消须走「保留 partial」分支,bump 会使其恒被判
  // superseded 而永不可达,见其注释);旧 run 的 shouldAbort/落库前守卫/catch 分支一律先比
  // epoch,被取代(stale)即静默丢弃一切产出(不写库、不发事件、不 dispose——新 run 在用)。
  // 2026-09-07 审计 agent-loop-03 补:epoch 闸此前只在 run 出口查,在途流写点
  // (trackPartial.onDelta/onReasoning/checkpoint、makeOnStep 的 appendTrace/resetRound)无守卫,
  // 被取代 run 的残余流照样写库并向新 run 的 bus/SSE 快照发幽灵事件——现同样收到写点(见各写点)。
  // 内存 Map 依网关单进程不变式;重启清空=无在途 run,天然无害。
  const runEpoch = new Map()
  function claimRunEpoch(convId) { const n = (runEpoch.get(convId) || 0) + 1; runEpoch.set(convId, n); return n }
  function isSuperseded(convId, myEpoch) { return (runEpoch.get(convId) || 0) !== myEpoch }

  // ── 在途 run 登记(agent-loop-05 + cancel-races-05,2026-09-07 审计批次三)──
  // { controller, tracker }:controller = cancelConversation 主动 abort 在途 LLM 流的通道
  // (旧模型只置 DB cancelled + shouldAbort 检查点,拦「下一个工具/下一轮」,在途 fetch 任其
  // 烧完——深思考模型可达分钟级);tracker = SSE 重连快照前同步 flush 检查点的漏斗(阈值
  // 200 字/500ms 的滞后窗口归零)。注册在 claimRunEpoch 之后、try 之前(run 全程可被断/被
  // flush);finally 按 handle 身份摘除——「停止→改→重发」重叠窗口里新 run 已重注册,旧 run
  // 出口不得误删新 handle。paused(run 返回 pending_approval)后无在途流,登记随函数出口
  // 摘除;resume 再跑时重新注册。
  const activeRuns = new Map()
  function flushCheckpoint(convId) { activeRuns.get(convId)?.tracker?.checkpoint() }
  // DB 显式 cancelled(直改库兜底;读失败/行已删视为非取消,不误杀正常对话——与 EXISTENCE
  // 守卫分工:删行走各落库点的存在性守卫,这里只回答「用户取消了吗」)。
  function dbCancelled(convId) {
    try { return getConversation(db, convId)?.status === 'cancelled' } catch { return false }
  }
  // 取消中止信号(shouldAbort 装配用):epoch 过期(被新 run 取代——纯取消不 bump,见上)或 DB 显式 cancelled。
  function cancelSignal(convId, myEpoch) {
    return isSuperseded(convId, myEpoch) || dbCancelled(convId)
  }

// trackPartial 检查点触发阈值:字数维度(防写放大)或时间维度(压中途刷新滞后)任一过线即落库
const CK_CHARS = 200
const CK_TIME_MS = 500

  // checkpoint → paused; done → done + history
  // tracker(R1):reasoning 与 content 同源同命运——终态/暂停一并落库,thinking 不再只活在 SSE。
  // traceJson(2026-08-25):本轮工具事件序列(已 JSON 串)。此前落 out.trace——runner 返回里
  // 根本没有该字段,恒为 "[]" → 前端重建历史时 ToolTrace 全不渲染(「聊天结束后看不到工具调用」)。
  function handleAgentResult(convId, project, out, tracker, traceJson) {
    // EXISTENCE 守卫(终审 I5):对话行已被删(DELETE 项目/对话)时,run 的 cancelled 守卫
    // (getConversation(id)?.status === 'cancelled')读到 undefined 而放行,这里若不拦会把
    // 终态/消息/项目历史写进孤儿行——被删的数据「复活」一半,且 project.id 可能已不存在。
    if (!getConversation(db, convId)) return
    if (out.status === 'pending_approval') {
      const patch = {
        status: 'paused',
        messages: JSON.stringify(out.messages),
        queue: JSON.stringify(out.queue),
        denied: JSON.stringify(out.denied),
        pendingApproval: JSON.stringify(out.pending),
        steps: out.steps,
      }
      // paused 顺手落检查点:<200 字的 content/reasoning 尾巴此时不写,重启/resume 就丢
      if (tracker) { patch.content = tracker.partial(); patch.reasoning = tracker.reasoning() }
      updateConversation(db, convId, patch)
    } else {
      const patch = {
        status: 'done', messages: JSON.stringify(out.messages),
        content: out.content, steps: out.steps,
      }
      if (tracker) patch.reasoning = tracker.reasoning()
      updateConversation(db, convId, patch)
      // T4:多轮核心 —— done 时追加 assistant 消息到 workbench_messages(供下一轮 buildHistory 读取)。
      // 终答兜底(2026-09-06):硬断/异常路径的 out.content 没有对应 assistant step 事件
      // (如「(达到最大步数,未给出终答)」),不补块则交错模式对用户不可见。
      let traceArr = []
      try { traceArr = JSON.parse(traceJson || '[]') } catch { traceArr = [] }
      appendMessage(db, { conversationId: convId, role: 'assistant', content: out.content || '', reasoning: tracker ? tracker.reasoning() : null, trace: JSON.stringify(ensureFinalTraceBlock(out.content, traceArr)) })
      appendHistory(db, project.id, 'user', getConversation(db, convId).userMessage)
      appendHistory(db, project.id, 'assistant', out.content || '')
    }
  }

  // 后台跑对话(detached Promise,不阻塞 HTTP 响应)。
  // T4:改吃 buildHistory —— 多轮上下文(recap? + 近期全文 messages,末条是新 user 消息)。
  // 新建对话首条 user 消息由 POST /conversations 在 createConversation 前 append;
  // 续接对话新 user 消息由 POST /:id/messages append。runConversation 只读不写消息。
  // 对话终态 → bus 事件序列(pending_approval → paused 不 dispose;done → dispose)。T7。

  // 意外中断内容保全(2026-08-17):onDelta 原来只推 SSE 不落库,assistant 消息只在 done 追加,
  // 失败/进程死亡后用户看着流出来的答案会蒸发(重开从 messages 重建,只剩提问)。
  // 三层防御:①每 200 字符或 500ms(2026-08-29 时间维度)把累计内容检查点写 conv.content(进程硬死也有数据可救,阈值防写放大)
  // ②失败 catch 把部分内容落成 assistant 消息 ③启动 salvageInterrupted 抢救检查点(workbench-projects)。
  // R1(2026-08-19):reasoning(思考)与 content 同款防御——此前只走 SSE,刷新即蒸发。
  // seed 化:初始累计取 conv 现有检查点(resume 续跑不覆写暂停前已落库的前半段;append/regenerate
  // 路由已复位 → seed 天然为空)。content/reasoning 各自独立阈值,任一过阈一次写两字段(不加写放大)。
  // 时间维度(2026-08-29):「≥200 字或距上次落库 >500ms」任一触发——中途刷新当前轮滞后从
  // 200 字压到半秒;写频上界 2 次/秒(delta 到达才可能触发,静默零写)。两回调共享 lastCkAt
  // (checkpoint 内统一刷新),resetRound 的 checkpoint() 亦自然刷新。
  // F3 写点守卫(2026-09-07 审计 agent-loop-03):被取代 run 的在途流回调此前无 epoch 闸——
  // onDelta/onReasoning 继续检查点写库、makeOnStep 继续 appendTrace/resetRound 清零,并向新
  // run 的 bus/SSE 订阅者发幽灵 delta/step,A 的 resetRound 还会把
  // conv.content 抹空覆写新 run 的检查点(取消拦不断在途流,「停止→修改重发」重叠窗口对深思考
  // 模型可达分钟级)。全部写点前比对 epoch,stale 即静默 no-op;纯取消(未被取代)不拦——残余流
  // 继续累积/检查点正是 F2 保留分支(cancelled 落 assistant 消息)的数据来源。
  function trackPartial(convId, conv, myEpoch) {
    let partial = conv?.content || ''
    let reasoning = conv?.reasoning || ''
    let ckAt = partial.length
    let rCkAt = reasoning.length
    let lastCkAt = Date.now()
    const stale = () => isSuperseded(convId, myEpoch)
    // checkpoint 是唯一的 conv.content/reasoning 写库漏斗:闸收在这里,任何调用路径(阈值触发/
    // resetRound/未来新增调用方)被取代时都写不进新 run 的行。
    const checkpoint = () => { if (stale()) return; lastCkAt = Date.now(); updateConversation(db, convId, { content: partial, reasoning }) }
    const shouldCk = len => len >= CK_CHARS || Date.now() - lastCkAt > CK_TIME_MS
    return {
      onDelta: text => {
        if (stale()) return
        partial += text
        if (shouldCk(partial.length - ckAt)) { ckAt = partial.length; checkpoint() }
        busEmit(convId, { type: 'delta', text })
      },
      onReasoning: text => {
        if (stale()) return
        reasoning += text
        if (shouldCk(reasoning.length - rCkAt)) { rCkAt = reasoning.length; checkpoint() }
        busEmit(convId, { type: 'reasoning', text })
      },
      partial: () => partial,
      reasoning: () => reasoning,
      // cancel-races-05:SSE 重连快照读库前经 flushCheckpoint 同步落一次检查点(零滞后窗口);
      // 自带 stale 守卫,被取代 run 的句柄写不进新 run 的行(闸在 checkpoint 单点,所有调用路径同门)。
      checkpoint,
      // 轮间清零(2026-08-25 交错渲染):assistant 轮完成时清累积——检查点语义回到「当前轮
      // partial」;已完成轮文本活在 trace。防跨轮全文经 conv.content 检查点 → snapshot/降级
      // 轮询回灌前端,与已清零的流式 content 打架(闪变源之一)。
      // 轮间清零(2026-08-25 交错渲染;2026-08-27 补持久化):assistant 轮完成时清累积并
      // **同步落库**——此前只清内存,DB conv.content 滞留旧轮最后检查点,窗口内(此刻→新轮
      // 首个 200 字检查点)重连 snapshot/降级轮询 R3 会把旧轮 partial 当当前轮流式文本回灌
      // (与旧轮 assistant chip 双显,后续 delta 拼错位)。所有读取方均有空值守卫,清零零副作用。
      //
      // F2/F3 联锁(2026-09-07 审计 cancel-races-01/agent-loop-03;判定顺序即优先级,勿换):
      // ① supersede 先判:被取代则整段静默 no-op——连 partial 都不保留地不写不清。取代优先于
      //    保留:新 run 已拥有对话(epoch 已被 claimRunEpoch bump,重发路由也复位了 content/
      //    reasoning/trace),旧 run 此刻任何清零/检查点都是对新 run 产出的覆写与污染。
      // ② 纯取消(DB cancelled、未被取代——cancelConversation 刻意不 bump epoch)跳过清零与
      //    checkpoint 抹除:真实循环每轮 chat 完成必发 onStep({type:'assistant'})(agent.mjs
      //    246-248/226-228),而取消拦不断在途流,主流时序「看长答案中途点停止→流自然完成→
      //    assistant step 取消后到达」若照常清零,cancelled 保留分支(runConversation 落库前 /
      //    cancelledCatchGuard)读到的 partial 恒空 → 半截答案刷新蒸发(这正是 2026-08-19 用户
      //    裁决要防的形态;旧「取消保留」测试的桩在 onDelta 后直接 resolve、从不发 assistant
      //    step——桩形状掩蔽缺陷,教训:锁定取消语义的桩必须复刻真实循环的必发事件)。
      // ③ 其余(正常轮完成)照常清零+同步落库(② 之外的旧轮回灌窗口防御不变)。
      resetRound: () => {
        if (stale()) return
        if (dbCancelled(convId)) return
        partial = ''; reasoning = ''; ckAt = 0; rCkAt = 0
        checkpoint()
      },
    }
  }
  function salvagePartial(convId, err, tracker, traceArr = []) {
    // EXISTENCE 守卫(终审 I5,同 handleAgentResult):对话已被删时不再补录任何行,
    // 否则 catch 路径会把部分内容写成孤儿 assistant 消息。静默返回(catch 块后续的
    // busEmit failed+end 仍照发,前端不会被无限 thinking 卡住)。
    if (!getConversation(db, convId)) return
    const partial = tracker ? tracker.partial() : ''
    const reasoning = tracker ? tracker.reasoning() : ''
    if (partial || reasoning) {
      updateConversation(db, convId, { status: 'failed', error: err.message, content: partial, reasoning })
      // 消息级 trace 由调用方给「本轮事件」(run 段=turnTrace;resume 段=currentTurnTrace,
      // 含审批暂停前事件):旧实现拉 conv.trace 全对话累积,历史轮事件污染本轮交错渲染。
      // + 终答兜底块(轮未完成无 step 事件,已流出文本必须补块才在交错模式可见)。
      appendMessage(db, { conversationId: convId, role: 'assistant', content: partial, reasoning: reasoning || null, trace: JSON.stringify(ensureFinalTraceBlock(partial, traceArr)) })
    } else {
      updateConversation(db, convId, { status: 'failed', error: err.message })
    }
  }
  // 静默终止审计(2026-08-27):salvage 落库自身抛错(DB 损坏/锁死)不得打断 catch 块后续的
  // busEmit(failed+end)——事件发不出去,前端就是无限 thinking 无提示;且本函数 detached
  // 调用(无 .catch),reject 会变 unhandledRejection 把网关进程带走。落库失败只记 stderr,
  // conv 留在 running 由启动时 salvageInterrupted 兜底标记。
  function safeSalvage(convId, err, tracker, traceArr = []) {
    try { salvagePartial(convId, err, tracker, traceArr) }
    catch (salvageErr) { console.error('[workbench-agent] salvage 落库失败(对话留待启动抢救):', salvageErr?.message || salvageErr) }
  }
  function finalizeConvEmit(convId, out) {
    const { events, dispose } = eventsForResult(out)
    for (const evt of events) busEmit(convId, evt)
    if (dispose) busDispose(convId)
  }

  // onStep 统一工厂(2026-09-06 run/resume 对齐):trace 落库 + turnTrace 累积 + assistant
  // 轮完成清零检查点。此前 resume 的 onStep 只做 appendTrace+推流——缺 resetRound,续跑段
  // 多轮时 partial 跨轮累积,失败 salvage 把多轮拼接串整体落成一条消息(生产实例:
  // 408=26+212+50+7+113)。tracker 须在装配 onStep 前已赋值。
  // F3 写点守卫(2026-09-07 审计 agent-loop-03,与 trackPartial 同款):被取代 run 的 onStep
  // 整链 no-op——appendTrace/turnTrace/resetRound/busEmit 全静默(epoch 此前只在 run 出口查,
  // 这里补在写点;被取代 run 的 assistant 事件曾漏进新 run 的 bus/SSE 并污染 conv.trace 本轮切片)。
  function makeOnStep(convId, turnTrace, tracker, myEpoch) {
    return raw => {
      if (isSuperseded(convId, myEpoch)) return
      const e = clampTraceStep(raw)
      if (e.type !== 'tool_start') {
        appendTrace(db, convId, e)
        if (e.type === 'assistant') {
          turnTrace.push({ type: 'assistant', content: e.message?.content || '', ts: e.ts })
          tracker?.resetRound()   // 检查点轮间清零(见 trackPartial 注释)
        }
        else turnTrace.push(e)
      }
      busEmit(convId, { type: 'step', step: e })
    }
  }

  // 本轮事件切片(2026-09-06):消息级 trace 只该含「最后一条 user 消息之后」的本轮事件
  // (与前端 pollOnce live 对齐同口径,ts > lastMsgTs + 剔除 tool_start 瞬态 + assistant 全量
  // 形状瘦身为平铺)。resume 消息必须用它而非 run 段 turnTrace:审批续跑轮的暂停前事件
  // (中间文本/工具)也属于本轮,落库丢了交错渲染就断章;历史轮事件则必须排除(conv.trace
  // 是全对话累积,旧 resume-done 整包拉取会把历史轮灌进本轮消息)。
  function currentTurnTrace(convId) {
    // 全程防御(被 catch 块调用,自身抛错会吞掉 salvage/failed 事件序列):任何读失败 → 空切片
    let conv = null
    try { conv = getConversation(db, convId) } catch { return [] }
    let all = []; try { all = JSON.parse(conv?.trace || '[]') } catch { all = [] }
    let lastMsgTs = 0
    try { lastMsgTs = db.prepare('SELECT MAX(createdAt) AS m FROM workbench_messages WHERE conversationId=?').get(convId)?.m || 0 } catch { lastMsgTs = 0 }
    return all
      .filter(e => e && (e.ts || 0) > lastMsgTs && e.type !== 'tool_start')
      .map(e => e?.type === 'assistant' ? { type: 'assistant', content: e.message?.content ?? e.content ?? '', ts: e.ts } : e)
  }

  // 取消中止 catch 分支(2026-09-06 审计#3):agent 循环的 shouldAbort 检查点抛错(用户在 run
  // 期间点「停止」,DB 已被 cancelConversation 置 cancelled)落此——与 run/resume 落库前
  // cancelled 守卫完全同款的保留逻辑:已流出的 partial/reasoning 落 assistant 消息(trace 用
  // currentTurnTrace 本轮切片 + 终答兜底块,交错模式可见),end+dispose 收尾(cancelConversation
  // 已发过 status cancelled+end,重复 end 幂等无害);不发 failed 事件、不 safeSalvage。
  // 返回 true=已处置(调用方 return);对话不存在(EXISTENCE 语义)或库挂读失败视为非取消 →
  // 返回 false,调用方维持旧 safeSalvage 路径。
  function cancelledCatchGuard(convId, tracker) {
    try {
      let cancelled = false
      try { cancelled = getConversation(db, convId)?.status === 'cancelled' } catch { cancelled = false }
      if (!cancelled) return false
      if (tracker && (tracker.partial() || tracker.reasoning())) {
        appendMessage(db, { conversationId: convId, role: 'assistant', content: tracker.partial(), reasoning: tracker.reasoning() || null, trace: JSON.stringify(ensureFinalTraceBlock(tracker.partial(), currentTurnTrace(convId))) })
      }
      busEmit(convId, { type: 'end' })
      busDispose(convId)
      return true
    } catch (e) {
      // 落库自身抛错(同 safeSalvage 2026-08-27 契约):吞错保事件序列——但取消处置已尽力,
      // 返回 true 走静默退出,不再落 failed(取消语义下 failed 是误导)。
      console.error('[workbench-agent] cancelled 落库失败:', e?.message || e)
      return true
    }
  }

  // 后台跑对话(detached Promise,不阻塞 HTTP 响应)。k8sSession 内部按 conv.projectId 重建(T5)。
  // T7:全程把事件透到 conv-bus(status/delta/step/end/approval),供 SSE 订阅。
  async function runConversation(convId, llmClient, actor) {
    let tracker = null // 中断保全:catch 需读累计内容,须在 try 外声明
    let turnTrace = [] // 本段事件累积(失败 salvage 落消息级 trace 用,同在 try 外)
    const myEpoch = claimRunEpoch(convId) // per-run 令牌(对抗审查收口,见模块头注释)
    const runHandle = { controller: new AbortController(), tracker: null } // 在途登记(cancel abort + SSE flush,见 activeRuns 注)
    activeRuns.set(convId, runHandle)
    try {
      const conv = getConversation(db, convId)
      if (!conv) return
      const project = getProject(db, conv.projectId)
      if (!project) {
        updateConversation(db, convId, { status: 'failed', error: '项目不存在' })
        busEmit(convId, { type: 'status', status: 'failed', error: '项目不存在' })
        busEmit(convId, { type: 'end' })
        busDispose(convId)
        return
      }
      busEmit(convId, { type: 'status', status: 'running' })
      // principal(W2 Phase C Task 5):actor 由路由线程({userId, username, role}),
      // 供 buildWbCtx 工具执行面授权门执法——detached runner 无法依赖请求上下文。
      const principal = { userId: actor?.userId, role: actor?.role }
      const { ctx } = buildWbCtx(project, principal)
      // SSH 接线(Task 11,2026-08-28):动态审批按服务器策略(needsApproval 纯函数,checkpoint/resume 两处
      // 都会被咨询,不得有副作用);零暴露服务器时直接隐藏 wb_ssh_* 两工具。
      const sshBridge = ctx.ssh || null
      const sshJobs = ctx.sshJobs || null
      const exposedCount = sshBridge ? sshBridge.listExposed().length : 0
      const { run } = createAgentRunner({
        llmClient, workbench: ctx, audit: { db, owner: actor?.username, clusterId: project.clusterId }, maxSteps: getMaxStepsConfig(db), // 每次 run 现读(同 disabledTools 即时生效语义);0=不限制
        // 工具收紧(2026-08-25):每次 run 现读配置——禁用即时生效(权限回收语义)。
        // 提示词仍按对话创建时烘焙(conv.system),两者不同步属预期:追加指令面向新对话,禁用面向当下。
        disabledTools: getWorkbenchAiConfig(db).disabledTools,
        budgetChars: trimBudgetChars(contextWindowFor(llmClient.model)),
        // 动态审批白名单路由(2026-09-07 审计 F1):单一事实源 routeDynamicApproval,勿在装配点复刻谓词
        dynamicApproval: (sshBridge || sshJobs) ? (n, args) => routeDynamicApproval(n, args, sshBridge, sshJobs) : undefined,
        excludeTools: workbenchExcludeTools({ hasCluster: !!project.clusterId, sshExposedCount: exposedCount }),
        // 轻量取消检查点(2026-09-06 审计#3):agent 循环按 DB 取消态中止队列剩余工具与
        // 后续 LLM 轮(读库失败视为非取消,不误杀正常对话)。
        shouldAbort: () => cancelSignal(convId, myEpoch),
        // agent-loop-05(2026-09-07 审计批次三):取消断流通道——cancelConversation 主动 abort
        // 在途 fetch(与 shouldAbort 分工:检查点拦「下一个」,signal 断「在途的这一个」)。
        signal: runHandle.controller.signal,
      })
      const k8sSession = buildK8sSession(project.clusterId)
      let refs = []; try { refs = JSON.parse(conv.references || '[]') } catch { refs = [] }
      // gap3-01:换绑锚定。比对在装配前做一次,拆出 active/stale 两列——stale 不进拉取序列
      // (不再对当前集群静默重解析同名资源),改为注入作废注记(指引重新 @ 重锚定)。无戳
      // (存量老行/@server)恒 active,向后兼容。staleNote 在闭包外算好:refreshSystem 每轮
      // 重建 system 时追加同一常量串,不随轮数膨胀(refreshSystem 每 LLM 轮重写 messages[0])。
      const { active: activeRefs, stale: staleRefs } = splitStaleRefs(refs, project.clusterId)
      const staleNote = buildStaleRefsNote(staleRefs)
      // 项目记忆(T2,2026-08-29):每次 run 现读开关(权限回收语义同 disabledTools);
      // 开启时把 T1 维护的 projectRecap 拼入 system——注入格式(头注 caveat+尾部护栏)
      // 单源在 workbench-prompt.buildProjectMemoryInjection,勿在此内联字面(有静态守卫)。
      const pmEnabled = getWorkbenchAiConfig(db).projectMemory !== false
      const projectRecap = pmEnabled ? (getProject(db, conv.projectId)?.projectRecap || '') : ''
      const refreshSystem = async () => conv.system
        + buildProjectMemoryInjection(projectRecap)
        + await fetchRefContext(activeRefs, k8sSession, { db, principal, clusterId: project.clusterId }) // Phase C Task 6:逐 ref 过 refAllowed
        + staleNote
      const history = buildHistory(db, conv)
      tracker = trackPartial(convId, conv, myEpoch) // F3 写点守卫:tracker 各写点比对 epoch(见 trackPartial 注释)
      runHandle.tracker = tracker // 在途登记补挂:SSE flushCheckpoint 的检查点漏斗(见 activeRuns 注)
      // 本段事件累积(tool/denied + 瘦身 assistant 文本)——done/salvage 时随 assistant 消息落库,
      // 前端重建历史据此交错渲染(文本↔工具)。对话级 appendTrace(全事件)保持不变。
      turnTrace = []
      const out = await run({
        system: conv.system,
        history,
        refreshSystem,
        onDelta: tracker.onDelta,
        onReasoning: tracker.onReasoning,
        // onStep 统一走 makeOnStep(2026-09-06 run/resume 对齐,语义注释见工厂):assistant 事件
        // 瘦身入 turnTrace + 轮间清零;工具 result 存/流面前过 clampTraceStep(32KB 截断);
        // tool_start 瞬态只推流不落库。myEpoch=被取代 run 的 onStep 整链 no-op(F3 写点守卫)。
        onStep: makeOnStep(convId, turnTrace, tracker, myEpoch),
      })
      // 用户已取消(cancelConversation 置 cancelled):终态结果丢弃——不覆盖状态、不追加项目历史;
      // 但已流出的部分内容+思考落 assistant 消息(用户裁决 2026-08-19,与 failed 抢救对称——
      // 此前全弃,刷新后用户看着流出来的答案蒸发)。无流出内容则不追加。
      if (isSuperseded(convId, myEpoch)) return // 被新 run 取代(停止→改→重发):产出静默丢弃,不覆写新 run(对抗审查收口)
      if (getConversation(db, convId)?.status === 'cancelled') {
        if (tracker && (tracker.partial() || tracker.reasoning())) {
          appendMessage(db, { conversationId: convId, role: 'assistant', content: tracker.partial(), reasoning: tracker.reasoning() || null, trace: JSON.stringify(ensureFinalTraceBlock(tracker.partial(), turnTrace)) })
        }
        busEmit(convId, { type: 'end' })
        busDispose(convId)
        return
      }
      handleAgentResult(convId, project, out, tracker, JSON.stringify(turnTrace))
      finalizeConvEmit(convId, out)
      // gap2-04(2026-09-07 审计批次三):摘要 fire 不再静默吞错——内层 catch 已落日志,此处兜
      // detached reject(不吞=未捕获 rejection 杀进程;只记不阻对话)。
      maybeSummarizeProject(db, conv.projectId, llmClient).catch(e => console.error('[workbench-agent] 项目摘要失败:', e?.message || e)) // 项目记忆:done 后补 fire(A2;append 处保留兜底,水位幂等)
    } catch (err) {
      // 取消中止分支(2026-09-06 审计#3,先于 safeSalvage):shouldAbort 检查点抛错 = run 期间
      // 用户点了「停止」——保留已流出内容后收尾,不写 failed(详见 cancelledCatchGuard 注释)。
      if (isSuperseded(convId, myEpoch)) return // 被新 run 取代:静默退出——不 safeSalvage(会把新 run 标 failed)、不发事件(bus 属新 run)(对抗审查收口)
      if (cancelledCatchGuard(convId, tracker)) return
      safeSalvage(convId, err, tracker, turnTrace)
      busEmit(convId, { type: 'status', status: 'failed', error: err.message })
      busEmit(convId, { type: 'end' })
      busDispose(convId)
    } finally {
      // 在途登记摘除(身份守卫:被重发新 run 取代时句柄已易主,旧 run 出口不误删新 handle)
      if (activeRuns.get(convId) === runHandle) activeRuns.delete(convId)
    }
  }

  // resume from paused。k8sSession 内部按 conv.projectId 重建(T5)。
  // T7:全程把事件透到 conv-bus,与 runConversation 对称。
  async function resumeConversation(convId, approved, llmClient, actor) {
    let tracker = null // 中断保全:catch 需读累计内容,须在 try 外声明
    const myEpoch = claimRunEpoch(convId) // per-run 令牌(对抗审查收口,见模块头注释)
    const runHandle = { controller: new AbortController(), tracker: null } // 在途登记(cancel abort + SSE flush,与 run 路径同款)
    activeRuns.set(convId, runHandle)
    try {
      const conv = getConversation(db, convId)
      if (!conv) return
      const project = getProject(db, conv.projectId)
      if (!project) {
        updateConversation(db, convId, { status: 'failed', error: '项目不存在' })
        busEmit(convId, { type: 'status', status: 'failed', error: '项目不存在' })
        busEmit(convId, { type: 'end' })
        busDispose(convId)
        return
      }
      updateConversation(db, convId, { status: 'running', pendingApproval: null })
      busEmit(convId, { type: 'status', status: 'running' })
      const principal = { userId: actor?.userId, role: actor?.role } // Phase C:同 run,审批续跑同样过门
      const { ctx } = buildWbCtx(project, principal)
      // SSH 接线同 runConversation(resume 侧同样咨询 needsApproval——必须纯/幂等)。
      const sshBridge = ctx.ssh || null
      const sshJobs = ctx.sshJobs || null
      const exposedCount = sshBridge ? sshBridge.listExposed().length : 0
      const { run } = createAgentRunner({
        llmClient, workbench: ctx, audit: { db, owner: actor?.username, clusterId: project.clusterId }, maxSteps: getMaxStepsConfig(db), // 每次 run 现读(同 disabledTools 即时生效语义);0=不限制
        // 工具收紧(2026-08-25):每次 run 现读配置——禁用即时生效(权限回收语义)。
        // 提示词仍按对话创建时烘焙(conv.system),两者不同步属预期:追加指令面向新对话,禁用面向当下。
        disabledTools: getWorkbenchAiConfig(db).disabledTools,
        budgetChars: trimBudgetChars(contextWindowFor(llmClient.model)),
        // 动态审批白名单路由(2026-09-07 审计 F1):单一事实源 routeDynamicApproval,勿在装配点复刻谓词
        dynamicApproval: (sshBridge || sshJobs) ? (n, args) => routeDynamicApproval(n, args, sshBridge, sshJobs) : undefined,
        excludeTools: workbenchExcludeTools({ hasCluster: !!project.clusterId, sshExposedCount: exposedCount }),
        // 轻量取消检查点(2026-09-06 审计#3):与 run 路径同款(convId 闭包可用)。
        shouldAbort: () => cancelSignal(convId, myEpoch),
        // agent-loop-05(2026-09-07 审计批次三):取消断流通道,与 run 路径同款。
        signal: runHandle.controller.signal,
      })
      const k8sSession = buildK8sSession(project.clusterId)
      let refs = []; try { refs = JSON.parse(conv.references || '[]') } catch { refs = [] }
      // gap3-01:换绑锚定(与 run 路径同款,审批续跑同样过门)——stale 不重拉 + 常量注记。
      const { active: activeRefs, stale: staleRefs } = splitStaleRefs(refs, project.clusterId)
      const staleNote = buildStaleRefsNote(staleRefs)
      // 项目记忆(T2):与 run 路径同款注入(单源 buildProjectMemoryInjection)
      const pmEnabled = getWorkbenchAiConfig(db).projectMemory !== false
      const projectRecap = pmEnabled ? (getProject(db, conv.projectId)?.projectRecap || '') : ''
      const refreshSystem = async () => conv.system
        + buildProjectMemoryInjection(projectRecap)
        + await fetchRefContext(activeRefs, k8sSession, { db, principal, clusterId: project.clusterId }) // Phase C Task 6:同 run
        + staleNote
      const pending = conv.pendingApproval ? JSON.parse(conv.pendingApproval) : null
      // P0(E)防御:无审批态不 resume(路由侧 CAS 后理论不可达;不写任何状态,
      // 以免把终态改写成 failed 吞掉已完成答案)。
      if (!pending) { busEmit(convId, { type: 'end' }); busDispose(convId); return }
      tracker = trackPartial(convId, conv, myEpoch) // F3 写点守卫:同 run 路径(见 trackPartial 注释)
      runHandle.tracker = tracker // 在途登记补挂:同 run 路径(SSE flushCheckpoint 漏斗)
      const out = await run({
        resume: {
          messages: JSON.parse(conv.messages), queue: JSON.parse(conv.queue),
          denied: JSON.parse(conv.denied), steps: conv.steps,
          toolCallId: pending.toolCallId, approved,
        },
        refreshSystem,
        onDelta: tracker.onDelta,
        onReasoning: tracker.onReasoning,
        // 与 runConversation 同款(2026-09-06 对齐):assistant 轮完成清零检查点。turnTrace
        // 处传 throwaway——resume 落库不用段内累积,而用 currentTurnTrace(须含审批暂停前事件)。
        // myEpoch=被取代 run 的 onStep 整链 no-op(F3 写点守卫,同 run 路径)。
        onStep: makeOnStep(convId, [], tracker, myEpoch),
      })
      // 同 runConversation:取消后终态丢弃,但保留已流出的部分内容+思考(见 runConversation 注释)
      if (isSuperseded(convId, myEpoch)) return // 被新 run 取代(停止→改→重发):产出静默丢弃,不覆写新 run(对抗审查收口)
      if (getConversation(db, convId)?.status === 'cancelled') {
        if (tracker && (tracker.partial() || tracker.reasoning())) {
          appendMessage(db, { conversationId: convId, role: 'assistant', content: tracker.partial(), reasoning: tracker.reasoning() || null, trace: JSON.stringify(ensureFinalTraceBlock(tracker.partial(), currentTurnTrace(convId))) })
        }
        busEmit(convId, { type: 'end' })
        busDispose(convId)
        return
      }
      // resume(审批续跑)done:消息级 trace = 本轮事件切片(currentTurnTrace)——含审批暂停前
      // 的中间文本/工具事件(交错渲染不断章),排除历史轮(2026-09-06 前整包拉 conv.trace 全对话累积)。
      handleAgentResult(convId, project, out, tracker, JSON.stringify(currentTurnTrace(convId)))
      finalizeConvEmit(convId, out)
      maybeSummarizeProject(db, project.id, llmClient).catch(e => console.error('[workbench-agent] 项目摘要失败:', e?.message || e)) // gap2-04:同 run 路径,吞错改日志
    } catch (err) {
      // 取消中止分支(2026-09-06 审计#3,先于 safeSalvage,与 run 路径对称)。
      if (isSuperseded(convId, myEpoch)) return // 被新 run 取代:静默退出——不 safeSalvage(会把新 run 标 failed)、不发事件(bus 属新 run)(对抗审查收口)
      if (cancelledCatchGuard(convId, tracker)) return
      safeSalvage(convId, err, tracker, currentTurnTrace(convId))
      busEmit(convId, { type: 'status', status: 'failed', error: err.message })
      busEmit(convId, { type: 'end' })
      busDispose(convId)
    } finally {
      // 在途登记摘除(身份守卫,与 run 路径同款)
      if (activeRuns.get(convId) === runHandle) activeRuns.delete(convId)
    }
  }

  // 用户主动停止运行中的对话(输错内容→停止→修改重发)。
  // 标记 cancelled + SSE 通知终结 + **主动 abort 在途 LLM 流**(agent-loop-05,2026-09-07
  // 审计批次三:旧模型在途流「不可中断」是已知边界——shouldAbort 检查点拦的是「下一个工具/
  // 下一轮 chat」,在途 fetch 任其烧完,深思考模型可达分钟级)。abort 与 epoch 语义正交:
  // cancelConversation 刻意不 bump epoch(纯取消走「保留 partial」分支)——abort 只断流,
  // chatStream 以 abort reason 抛错 → catch → cancelledCatchGuard 读 DB cancelled → 半截
  // 内容照常落 assistant 消息;run 若在 abort 竞态下已自然完成,落库前 cancelled 守卫仍兜底
  // 丢弃迟到结果(状态/历史不被覆盖)。顺序=先置 DB 再 abort:abort 触发的 reject 走微任务,
  // 落地时 DB 必已是 cancelled(catch 分支判据稳定成立)。
  function cancelConversation(convId) {
    // 不 bump epoch:纯取消(未被重发)须走「保留 partial」分支(status=cancelled 判定);
    // 若用户随后重发,新 run 的 claimRunEpoch 自然使本 run 过期 → 静默丢弃。bump 放这里会把
    // 所有取消都误判成 superseded,perserve 分支永不可达(既有取消测试逮住)。
    const conv = getConversation(db, convId)
    if (!conv) return { ok: false, message: '对话不存在' }
    if (conv.status !== 'running' && conv.status !== 'paused') return { ok: false, message: '对话不在运行中' }
    updateConversation(db, convId, { status: 'cancelled', pendingApproval: null, error: '用户取消' })
    // 在途流断流(paused 无在途流——run 已返回,登记已摘;可选链空操作)。reason 带「用户取消」
    // 语义:经 ac.abort(reason) 透传为 fetch 的拒绝原因,不被泛型 AbortError 吞掉。
    activeRuns.get(convId)?.controller.abort(Object.assign(new Error('用户取消,中止在途 LLM 流'), { name: 'CancelledError' }))
    busEmit(convId, { type: 'status', status: 'cancelled', error: '用户取消' })
    busEmit(convId, { type: 'end' })
    busDispose(convId)
    return { ok: true }
  }

  return { runConversation, resumeConversation, cancelConversation, flushCheckpoint }
}
