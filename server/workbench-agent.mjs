// SP2: agent loop 从 index.mjs 抽出。factory 模式(同 createApiKeyTools)。
// 纯重构,zero behavior change —— 函数体从 index.mjs 逐字搬迁。
//
// 线程终态 → bus 事件序列(eventsForResult 在 conv-events.mjs,纯函数已可单测)。
// busEmit/busDispose 作 factory dep 注入(与 createAgentRunner 同理,便于单测 stub)。
import { buildHistory, appendMessage, getConversation, getProject, updateConversation, appendTrace, appendHistory } from './workbench-projects.mjs'
import { eventsForResult } from './conv-events.mjs'

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
  function handleAgentResult(convId, project, out) {
    if (out.status === 'pending_approval') {
      updateConversation(db, convId, {
        status: 'paused',
        messages: JSON.stringify(out.messages),
        queue: JSON.stringify(out.queue),
        denied: JSON.stringify(out.denied),
        pendingApproval: JSON.stringify(out.pending),
        steps: out.steps,
      })
    } else {
      updateConversation(db, convId, {
        status: 'done', messages: JSON.stringify(out.messages),
        content: out.content, steps: out.steps,
      })
      // T4:多轮核心 —— done 时追加 assistant 消息到 workbench_messages(供下一轮 buildHistory 读取)。
      appendMessage(db, { conversationId: convId, role: 'assistant', content: out.content || '', trace: JSON.stringify(out.trace || []) })
      appendHistory(db, project.id, 'user', getConversation(db, convId).userMessage)
      appendHistory(db, project.id, 'assistant', out.content || '')
    }
  }

  // 后台跑对话(detached Promise,不阻塞 HTTP 响应)。
  // T4:改吃 buildHistory —— 多轮上下文(recap? + 近期全文 messages,末条是新 user 消息)。
  // 新建对话首条 user 消息由 POST /conversations 在 createConversation 前 append;
  // 续接对话新 user 消息由 POST /:id/messages append。runConversation 只读不写消息。
  // 对话终态 → bus 事件序列(pending_approval → paused 不 dispose;done → dispose)。T7。
  function finalizeConvEmit(convId, out) {
    const { events, dispose } = eventsForResult(out)
    for (const evt of events) busEmit(convId, evt)
    if (dispose) busDispose(convId)
  }

  // 后台跑对话(detached Promise,不阻塞 HTTP 响应)。k8sSession 内部按 conv.projectId 重建(T5)。
  // T7:全程把事件透到 conv-bus(status/delta/step/end/approval),供 SSE 订阅。
  async function runConversation(convId, llmClient, actor) {
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
      const { run } = createAgentRunner({ llmClient, workbench: ctx, audit: { db, owner: actor?.username, clusterId: project.clusterId }, maxSteps: WB_MAX_STEPS })
      const k8sSession = buildK8sSession(project.clusterId)
      let refs = []; try { refs = JSON.parse(conv.references || '[]') } catch { refs = [] }
      const refreshSystem = async () => conv.system + await fetchRefContext(refs, k8sSession)
      const history = buildHistory(db, conv)
      const out = await run({
        system: conv.system,
        history,
        refreshSystem,
        onDelta: text => busEmit(convId, { type: 'delta', text }),
        onStep: e => { if (e.type !== 'tool_start') appendTrace(db, convId, e); busEmit(convId, { type: 'step', step: e }) }, // tool_start 瞬态只推流不落库(重载后不会残留 running 态)
      })
      // 用户已取消(cancelConversation 置 cancelled):丢弃 agent 结果——不覆盖状态、不追加历史
      if (getConversation(db, convId)?.status === 'cancelled') {
        busEmit(convId, { type: 'end' })
        busDispose(convId)
        return
      }
      handleAgentResult(convId, project, out)
      finalizeConvEmit(convId, out)
    } catch (err) {
      updateConversation(db, convId, { status: 'failed', error: err.message })
      busEmit(convId, { type: 'status', status: 'failed', error: err.message })
      busEmit(convId, { type: 'end' })
      busDispose(convId)
    }
  }

  // resume from paused。k8sSession 内部按 conv.projectId 重建(T5)。
  // T7:全程把事件透到 conv-bus,与 runConversation 对称。
  async function resumeConversation(convId, approved, llmClient, actor) {
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
      const { run } = createAgentRunner({ llmClient, workbench: ctx, audit: { db, owner: actor?.username, clusterId: project.clusterId }, maxSteps: WB_MAX_STEPS })
      const k8sSession = buildK8sSession(project.clusterId)
      let refs = []; try { refs = JSON.parse(conv.references || '[]') } catch { refs = [] }
      const refreshSystem = async () => conv.system + await fetchRefContext(refs, k8sSession)
      const pending = JSON.parse(conv.pendingApproval)
      const out = await run({
        resume: {
          messages: JSON.parse(conv.messages), queue: JSON.parse(conv.queue),
          denied: JSON.parse(conv.denied), steps: conv.steps,
          toolCallId: pending.toolCallId, approved,
        },
        refreshSystem,
        onDelta: text => busEmit(convId, { type: 'delta', text }),
        onStep: e => { if (e.type !== 'tool_start') appendTrace(db, convId, e); busEmit(convId, { type: 'step', step: e }) }, // tool_start 瞬态只推流不落库(重载后不会残留 running 态)
      })
      // 同 runConversation:取消后丢弃结果
      if (getConversation(db, convId)?.status === 'cancelled') {
        busEmit(convId, { type: 'end' })
        busDispose(convId)
        return
      }
      handleAgentResult(convId, project, out)
      finalizeConvEmit(convId, out)
    } catch (err) {
      updateConversation(db, convId, { status: 'failed', error: err.message })
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
