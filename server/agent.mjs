// Agent loop(第二阶段):LLM think → 调底座 tool → 观察结果 → 再 think → 给方案。
// 与具体 LLM / tool 执行解耦:chat 与 execTool 都注入,便于单测。
// 写操作(scale/restart)走 checkpoint/resume 人审:循环遇到写工具不阻塞,
// 而是返回 pending_approval + 对话状态(messages/queue);客户端审批后回传 resume 续跑。
// 状态在浏览器↔网关往返,服务端无会话(与底座 stateless 原则一致)。
const MAX_STEPS = 8 // 防失控循环
const MAX_TOOL_CONTENT_CHARS = 8192
const DEFAULT_BUDGET_CHARS = 60000

// 工具执行失败的观察串(喂回 LLM):优先 detail(PERMISSION_DENIED 的具体原因,如 ns 越界),
// 让 LLM/用户能诊断为何失败而非只看到裸 "PERMISSION_DENIED: policy"。纯函数,便于单测。
export function formatToolError(e) {
  return `工具执行失败: ${e?.detail || e?.message || String(e)}`
}

// 单条工具结果截断:超过 max 字符时硬截断 + 标记
export function clampToolContent(content, max = MAX_TOOL_CONTENT_CHARS) {
  const s = typeof content === 'string' ? content : JSON.stringify(content)
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`
}

// 预算裁剪:超 budget 字符时,从最旧的非 system 消息丢起,保留 system + 尾部;
// 丢弃 tool 消息时,连带从对应 assistant.tool_calls 删该 id(若 tool_calls 清空则丢掉该 assistant),防悬空。
export function trimMessages(messages, budget = DEFAULT_BUDGET_CHARS) {
  const total = messages.reduce((n, m) => n + JSON.stringify(m).length, 0)
  if (total <= budget) return { messages, truncated: false }
  const startIdx = messages[0]?.role === 'system' ? 1 : 0
  const kept = messages.slice()
  const droppedToolIds = new Set()
  let cur = total
  for (let i = startIdx; i < kept.length - 1 && cur > budget; i++) {
    const m = kept[i]
    if (m.role === 'system' || m.role === 'assistant') continue  // 不丢 system/assistant
    cur -= JSON.stringify(m).length
    if (m.role === 'tool' && m.tool_call_id) droppedToolIds.add(m.tool_call_id)
    kept[i] = null
  }
  let out = kept.filter(Boolean)
  if (droppedToolIds.size) {
    out = out.map(m => {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        const filtered = m.tool_calls.filter(tc => !droppedToolIds.has(tc.id))
        if (filtered.length === 0) return null                       // tool_calls 全悬空 → 丢 assistant
        if (filtered.length !== m.tool_calls.length) return { ...m, tool_calls: filtered }
      }
      return m
    }).filter(Boolean)
  }
  return { messages: out, truncated: true }
}

export function createAgent({ chat, toolDefs = [], execTool, needsApproval = () => false, maxSteps = MAX_STEPS }) {
  // chat: async (messages, toolDefs) => assistantMessage {role, content, tool_calls?}
  // toolDefs: LLM 工具定义(OpenAI tools 格式)
  // execTool: async (name, args) => 结果(string 或对象,转字符串喂回 LLM)
  // needsApproval(name) => bool:写工具遇 checkpoint(不自动执行,交人审)
  // run({ system, history, onStep, resume }):
  //   resume = { messages, queue, denied, steps, toolCallId, approved } —— 续跑某个 pending 写工具

  let idSeq = 0
  // OpenAI 兼容 tool_call 都带 id;缺失时盖章一个稳定 id(写回 tc,保证 checkpoint→resume 一致)
  function callId(tc) { if (!tc.id) tc.id = `gen_${idSeq++}`; return tc.id }
  function parseArgs(tc) { try { return JSON.parse(tc.function?.arguments || '{}') } catch { return {} } }

  async function run({ system, history = [], onStep, onDelta, refreshSystem, resume } = {}) {
    // 初始化:resume 从回传状态续跑;否则从 system + history 起
    let messages, queue = [], denied = [], steps = 0
    let resumeToolCallId = null, resumeApproved = false
    if (resume) {
      messages = [...(resume.messages || [])]
      queue = [...(resume.queue || [])]
      denied = [...(resume.denied || [])]
      steps = resume.steps || 0
      resumeToolCallId = resume.toolCallId
      resumeApproved = !!resume.approved
    } else {
      messages = []
      if (system) messages.push({ role: 'system', content: system })
      messages.push(...history)
    }

    while (true) {
      // 1) 排空待处理工具队列(上一轮 chat 的 tool_calls,或 resume 带回的 queue)
      while (queue.length) {
        const tc = queue[0]
        const id = callId(tc)
        const name = tc.function?.name
        const args = parseArgs(tc)
        const isResumeTarget = resumeToolCallId && id === resumeToolCallId

        // 写操作且非本次 resume 目标 → checkpoint,把队列(含本条)交还客户端
        if (needsApproval(name) && !isResumeTarget) {
          return { status: 'pending_approval', messages, pending: { toolCallId: id, name, args }, queue: [...queue], denied, steps }
        }

        queue.shift()
        resumeToolCallId = null // 该 resume 已消费(后续同队列的写工具会再次 checkpoint)

        // 写工具走到这说明它是被批准的 resume 目标;被拒则记 denied 喂回 LLM
        if (needsApproval(name) && !resumeApproved) {
          denied.push({ name, args })
          messages.push({ role: 'tool', tool_call_id: id, content: `用户拒绝了该操作(${name})` })
          onStep?.({ type: 'denied', name, args })
          continue
        }

        let result
        try { result = await execTool(name, args) }
        catch (e) { result = formatToolError(e) }
        messages.push({ role: 'tool', tool_call_id: id, content: clampToolContent(result) })
        onStep?.({ type: 'tool', name, args, result })
      }

      // 2) 队列空 → 下一轮 chat(受 maxSteps 约束)
      if (steps >= maxSteps) return { content: '(达到最大步数,未给出终答)', steps, denied, truncated: true }
      steps++
      let truncated = false
      if (messages.length > 1) {
        const t = trimMessages(messages)
        messages = t.messages; truncated = t.truncated
      }
      // T5:每轮 chat 前重置 messages[0]——@-ref 漂移修复:让 LLM 每轮看到 ref 的最新状态(由 run/resumeConversation 注入的 refreshSystem 钩子)。
      if (refreshSystem && messages[0]?.role === 'system') {
        messages[0] = { role: 'system', content: await refreshSystem() }
      }
      const assistant = await chat(messages, toolDefs, onDelta ? { onDelta } : {})
      messages.push(assistant)
      onStep?.({ type: 'assistant', message: assistant })
      const toolCalls = assistant.tool_calls || []
      if (!toolCalls.length) return { content: assistant.content, steps, denied, truncated }   // 终答
      queue = [...toolCalls]
      resumeToolCallId = null // 新 turn,旧 resume 标记失效
    }
  }
  return { run }
}
