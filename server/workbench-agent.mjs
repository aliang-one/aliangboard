// SP2: agent loop 从 index.mjs 抽出。factory 模式(同 createApiKeyTools)。
// 纯重构,zero behavior change —— 函数体从 index.mjs 逐字搬迁。
//
// 线程终态 → bus 事件序列(eventsForResult 在 conv-events.mjs,纯函数已可单测)。
// busEmit/busDispose 作 factory dep 注入(与 createAgentRunner 同理,便于单测 stub)。
import { buildHistory, appendMessage, getConversation, getProject, updateConversation, appendTrace, appendHistory } from './workbench-projects.mjs'
import { eventsForResult } from './conv-events.mjs'
import { clampTraceStep } from './agent.mjs'
import { getWorkbenchAiConfig } from './workbench-ai-config.mjs'

// deps: { db, buildWbCtx, buildK8sSession, fetchRefContext, createAgentRunner, busEmit, busDispose }
//   db                —— node:sqlite DatabaseSync(index.mjs 顶层构造)
//   buildWbCtx        —— (project) → { ctx, ... }(index.mjs 工作台 context 构造)
//   buildK8sSession   —— (clusterId) → k8sSession(index.mjs 重建 call-context)
//   fetchRefContext   —— (refs, k8sSession) → Promise<string>(index.mjs @-ref 拉取)
//   createAgentRunner —— ({ llmClient, workbench }) → { run, toolDefs }(agent-runner.mjs)
//   busEmit           —— (convId, evt) => void(conv-bus.mjs emit)
//   busDispose        —— (convId) => void(conv-bus.mjs dispose)
export function createWorkbenchAgent(deps) {
  const { db, buildWbCtx, buildK8sSession, fetchRefContext, createAgentRunner, busEmit, busDispose } = deps

// SRE 深调查步数上限(dev29):agent.mjs 默认 8 对"调查→诊断→行动"太紧(实测定位
// ImagePullBackOff 走了 26 步);工作台侧放宽到 16,env WB_MAX_STEPS 可调。
const WB_MAX_STEPS = Math.max(1, Number(process.env.WB_MAX_STEPS) || 16)

  // checkpoint → paused; done → done + history
  // tracker(R1):reasoning 与 content 同源同命运——终态/暂停一并落库,thinking 不再只活在 SSE。
  // traceJson(2026-08-25):本轮工具事件序列(已 JSON 串)。此前落 out.trace——runner 返回里
  // 根本没有该字段,恒为 "[]" → 前端重建历史时 ToolTrace 全不渲染(「聊天结束后看不到工具调用」)。
  function handleAgentResult(convId, project, out, tracker, traceJson) {
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
      appendMessage(db, { conversationId: convId, role: 'assistant', content: out.content || '', reasoning: tracker ? tracker.reasoning() : null, trace: traceJson || '[]' })
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
  // 三层防御:①每 200 字符把累计内容检查点写 conv.content(进程硬死也有数据可救,阈值防写放大)
  // ②失败 catch 把部分内容落成 assistant 消息 ③启动 salvageInterrupted 抢救检查点(workbench-projects)。
  // R1(2026-08-19):reasoning(思考)与 content 同款防御——此前只走 SSE,刷新即蒸发。
  // seed 化:初始累计取 conv 现有检查点(resume 续跑不覆写暂停前已落库的前半段;append/regenerate
  // 路由已复位 → seed 天然为空)。content/reasoning 各自独立阈值,任一过阈一次写两字段(不加写放大)。
  function trackPartial(convId, conv) {
    let partial = conv?.content || ''
    let reasoning = conv?.reasoning || ''
    let ckAt = partial.length
    let rCkAt = reasoning.length
    const checkpoint = () => updateConversation(db, convId, { content: partial, reasoning })
    return {
      onDelta: text => {
        partial += text
        if (partial.length - ckAt >= 200) { ckAt = partial.length; checkpoint() }
        busEmit(convId, { type: 'delta', text })
      },
      onReasoning: text => {
        reasoning += text
        if (reasoning.length - rCkAt >= 200) { rCkAt = reasoning.length; checkpoint() }
        busEmit(convId, { type: 'reasoning', text })
      },
      partial: () => partial,
      reasoning: () => reasoning,
      // 轮间清零(2026-08-25 交错渲染):assistant 轮完成时清累积——检查点语义回到「当前轮
      // partial」;已完成轮文本活在 trace。防跨轮全文经 conv.content 检查点 → snapshot/降级
      // 轮询回灌前端,与已清零的流式 content 打架(闪变源之一)。
      // 轮间清零(2026-08-25 交错渲染;2026-08-27 补持久化):assistant 轮完成时清累积并
      // **同步落库**——此前只清内存,DB conv.content 滞留旧轮最后检查点,窗口内(此刻→新轮
      // 首个 200 字检查点)重连 snapshot/降级轮询 R3 会把旧轮 partial 当当前轮流式文本回灌
      // (与旧轮 assistant chip 双显,后续 delta 拼错位)。所有读取方均有空值守卫,清零零副作用。
      resetRound: () => {
        partial = ''; reasoning = ''; ckAt = 0; rCkAt = 0
        checkpoint()
      },
    }
  }
  function salvagePartial(convId, err, tracker) {
    const partial = tracker ? tracker.partial() : ''
    const reasoning = tracker ? tracker.reasoning() : ''
    if (partial || reasoning) {
      updateConversation(db, convId, { status: 'failed', error: err.message, content: partial, reasoning })
      const trace = getConversation(db, convId)?.trace
      appendMessage(db, { conversationId: convId, role: 'assistant', content: partial, reasoning: reasoning || null, trace })
    } else {
      updateConversation(db, convId, { status: 'failed', error: err.message })
    }
  }
  // 静默终止审计(2026-08-27):salvage 落库自身抛错(DB 损坏/锁死)不得打断 catch 块后续的
  // busEmit(failed+end)——事件发不出去,前端就是无限 thinking 无提示;且本函数 detached
  // 调用(无 .catch),reject 会变 unhandledRejection 把网关进程带走。落库失败只记 stderr,
  // conv 留在 running 由启动时 salvageInterrupted 兜底标记。
  function safeSalvage(convId, err, tracker) {
    try { salvagePartial(convId, err, tracker) }
    catch (salvageErr) { console.error('[workbench-agent] salvage 落库失败(对话留待启动抢救):', salvageErr?.message || salvageErr) }
  }
  function finalizeConvEmit(convId, out) {
    const { events, dispose } = eventsForResult(out)
    for (const evt of events) busEmit(convId, evt)
    if (dispose) busDispose(convId)
  }

  // 后台跑对话(detached Promise,不阻塞 HTTP 响应)。k8sSession 内部按 conv.projectId 重建(T5)。
  // T7:全程把事件透到 conv-bus(status/delta/step/end/approval),供 SSE 订阅。
  async function runConversation(convId, llmClient, actor) {
    let tracker = null // 中断保全:catch 需读累计内容,须在 try 外声明
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
      const { ctx } = buildWbCtx(project)
      const { run } = createAgentRunner({
        llmClient, workbench: ctx, audit: { db, owner: actor?.username, clusterId: project.clusterId }, maxSteps: WB_MAX_STEPS,
        // 工具收紧(2026-08-25):每次 run 现读配置——禁用即时生效(权限回收语义)。
        // 提示词仍按对话创建时烘焙(conv.system),两者不同步属预期:追加指令面向新对话,禁用面向当下。
        disabledTools: getWorkbenchAiConfig(db).disabledTools,
      })
      const k8sSession = buildK8sSession(project.clusterId)
      let refs = []; try { refs = JSON.parse(conv.references || '[]') } catch { refs = [] }
      const refreshSystem = async () => conv.system + await fetchRefContext(refs, k8sSession)
      const history = buildHistory(db, conv)
      tracker = trackPartial(convId, conv)
      // 本轮事件累积(tool/denied + 瘦身 assistant 文本)——done 时随 assistant 消息落库,
      // 前端重建历史据此交错渲染(文本↔工具)。对话级 appendTrace(全事件)保持不变。
      const turnTrace = []
      const out = await run({
        system: conv.system,
        history,
        refreshSystem,
        onDelta: tracker.onDelta,
        onReasoning: tracker.onReasoning,
        // assistant 事件瘦身入 turnTrace({type,content,ts}——中间文本,交错渲染用;终答 content 恒等于
        // 末个 assistant 事件,前端据此去重);对话级 appendTrace 仍存全事件。tool_start 瞬态只推流不落库。
        // 2026-08-27:工具 result 存/流面前过 clampTraceStep(32KB 截断)——get_resource 等全量
        // 对象不再无界灌入 conv.trace/GET /:id/SSE;LLM feed 不受影响(agent.mjs 独立钳制)。
        onStep: raw => {
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
        },
      })
      // 用户已取消(cancelConversation 置 cancelled):终态结果丢弃——不覆盖状态、不追加项目历史;
      // 但已流出的部分内容+思考落 assistant 消息(用户裁决 2026-08-19,与 failed 抢救对称——
      // 此前全弃,刷新后用户看着流出来的答案蒸发)。无流出内容则不追加。
      if (getConversation(db, convId)?.status === 'cancelled') {
        if (tracker && (tracker.partial() || tracker.reasoning())) {
          appendMessage(db, { conversationId: convId, role: 'assistant', content: tracker.partial(), reasoning: tracker.reasoning() || null, trace: JSON.stringify(turnTrace) })
        }
        busEmit(convId, { type: 'end' })
        busDispose(convId)
        return
      }
      handleAgentResult(convId, project, out, tracker, JSON.stringify(turnTrace))
      finalizeConvEmit(convId, out)
    } catch (err) {
      safeSalvage(convId, err, tracker)
      busEmit(convId, { type: 'status', status: 'failed', error: err.message })
      busEmit(convId, { type: 'end' })
      busDispose(convId)
    }
  }

  // resume from paused。k8sSession 内部按 conv.projectId 重建(T5)。
  // T7:全程把事件透到 conv-bus,与 runConversation 对称。
  async function resumeConversation(convId, approved, llmClient, actor) {
    let tracker = null // 中断保全:catch 需读累计内容,须在 try 外声明
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
      const { ctx } = buildWbCtx(project)
      const { run } = createAgentRunner({
        llmClient, workbench: ctx, audit: { db, owner: actor?.username, clusterId: project.clusterId }, maxSteps: WB_MAX_STEPS,
        // 工具收紧(2026-08-25):每次 run 现读配置——禁用即时生效(权限回收语义)。
        // 提示词仍按对话创建时烘焙(conv.system),两者不同步属预期:追加指令面向新对话,禁用面向当下。
        disabledTools: getWorkbenchAiConfig(db).disabledTools,
      })
      const k8sSession = buildK8sSession(project.clusterId)
      let refs = []; try { refs = JSON.parse(conv.references || '[]') } catch { refs = [] }
      const refreshSystem = async () => conv.system + await fetchRefContext(refs, k8sSession)
      const pending = conv.pendingApproval ? JSON.parse(conv.pendingApproval) : null
      // P0(E)防御:无审批态不 resume(路由侧 CAS 后理论不可达;不写任何状态,
      // 以免把终态改写成 failed 吞掉已完成答案)。
      if (!pending) { busEmit(convId, { type: 'end' }); busDispose(convId); return }
      tracker = trackPartial(convId, conv)
      const out = await run({
        resume: {
          messages: JSON.parse(conv.messages), queue: JSON.parse(conv.queue),
          denied: JSON.parse(conv.denied), steps: conv.steps,
          toolCallId: pending.toolCallId, approved,
        },
        refreshSystem,
        onDelta: tracker.onDelta,
        onReasoning: tracker.onReasoning,
        onStep: raw => { const e = clampTraceStep(raw); if (e.type !== 'tool_start') appendTrace(db, convId, e); busEmit(convId, { type: 'step', step: e }) }, // tool_start 瞬态只推流不落库(重载后不会残留 running 态);result 存/流面截断同 runConversation
      })
      // 同 runConversation:取消后终态丢弃,但保留已流出的部分内容+思考(见 runConversation 注释)
      if (getConversation(db, convId)?.status === 'cancelled') {
        if (tracker && (tracker.partial() || tracker.reasoning())) {
          appendMessage(db, { conversationId: convId, role: 'assistant', content: tracker.partial(), reasoning: tracker.reasoning() || null, trace: getConversation(db, convId)?.trace })
        }
        busEmit(convId, { type: 'end' })
        busDispose(convId)
        return
      }
      // resume(审批续跑)done:整段 conv.trace 归一化后落消息级——assistant 全量形状
      // (message.content 嵌套)瘦身为平铺,与新对话路径一致(交错渲染消费统一形状)。
      let resumeTrace = []
      try { resumeTrace = JSON.parse(getConversation(db, convId)?.trace || '[]') } catch { resumeTrace = [] }
      handleAgentResult(convId, project, out, tracker, JSON.stringify(
        resumeTrace.map(e => e?.type === 'assistant' ? { type: 'assistant', content: e.message?.content || '', ts: e.ts } : e)
      ))
      finalizeConvEmit(convId, out)
    } catch (err) {
      safeSalvage(convId, err, tracker)
      busEmit(convId, { type: 'status', status: 'failed', error: err.message })
      busEmit(convId, { type: 'end' })
      busDispose(convId)
    }
  }

  // 用户主动停止运行中的对话(输错内容→停止→修改重发)。
  // 标记 cancelled + SSE 通知终结;后台 LLM 调用无法中断,run/resume 落库前的
  // cancelled 守卫会丢弃其结果(状态/历史不被覆盖)。
  function cancelConversation(convId) {
    const conv = getConversation(db, convId)
    if (!conv) return { ok: false, message: '对话不存在' }
    if (conv.status !== 'running' && conv.status !== 'paused') return { ok: false, message: '对话不在运行中' }
    updateConversation(db, convId, { status: 'cancelled', pendingApproval: null, error: '用户取消' })
    busEmit(convId, { type: 'status', status: 'cancelled', error: '用户取消' })
    busEmit(convId, { type: 'end' })
    busDispose(convId)
    return { ok: true }
  }

  return { runConversation, resumeConversation, cancelConversation }
}
