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

// 单条工具结果 → 喂 LLM 的字符串归一 + 截断(超过 max 字符硬截断 + 标记)。
// 归一(2026-08-26 审计加固):string 直用;undefined/null → 占位(JSON.stringify(undefined)
// 返 undefined,.length 抛 TypeError——一个工具无返回会炸整轮对话);Error → message
// (否则 stringify 成 '{}' 静默吞失败信息);BigInt/循环引用 → String 兜底不抛。
export function clampToolContent(content, max = MAX_TOOL_CONTENT_CHARS) {
  let s
  if (typeof content === 'string') s = content
  else if (content == null) s = '(工具无返回值)'
  else if (content instanceof Error) s = content.message || String(content)
  else { try { s = JSON.stringify(content) ?? '(工具无返回值)' } catch { s = String(content) } }
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`
}

// trace 持久化/推流的工具结果截断(2026-08-27 一致性审计):get_resource/describe 等返回
// 全量 K8s 对象,此前 appendTrace/busEmit 原样落库推流 → conv.trace 随大对象线性膨胀,
// GET /:id(降级 2s/看门狗 10s 轮询)与 turnSnapshot(重连)载荷放大。
// 与 clampToolContent(喂 LLM,8192 字符)分工:本函数只管「存/流」面,返回新事件对象
// (浅拷贝 + result 替换),超限 result → 截断串 + resultTruncated/resultOriginalBytes 标记;
// 前端 fmtResult 对字符串 result 直显,零改动。tool_start/denied/assistant 等事件原样返回。
const TRACE_RESULT_MAX_BYTES = 32768
export function clampTraceStep(e, cap = TRACE_RESULT_MAX_BYTES) {
  if (!e || e.type !== 'tool' || e.result == null) return e
  let full
  if (typeof e.result === 'string') full = e.result
  else { try { full = JSON.stringify(e.result) ?? '' } catch { full = String(e.result) } }
  const originalBytes = Buffer.byteLength(full, 'utf8')
  if (originalBytes <= cap) return e
  const cut = Buffer.from(full, 'utf8').subarray(0, cap).toString('utf8')
  return {
    ...e,
    result: cut + `\n…[result truncated: ${originalBytes}B > ${cap}B]`,
    resultTruncated: true,
    resultOriginalBytes: originalBytes,
  }
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

export function createAgent({ chat, toolDefs = [], execTool, needsApproval = () => false, maxSteps = MAX_STEPS, budgetChars = DEFAULT_BUDGET_CHARS }) {
  // chat: async (messages, toolDefs) => assistantMessage {role, content, tool_calls?}
  // toolDefs: LLM 工具定义(OpenAI tools 格式)
  // execTool: async (name, args) => 结果(string 或对象,转字符串喂回 LLM)
  // needsApproval(name, args) => bool | Promise<bool>:写工具遇 checkpoint(不自动执行,交人审);
  //   可异步(runner 注入 dynamicApproval 按运行时策略裁决,如 SSH 按服务器放宽)
  // run({ system, history, onStep, resume }):
  //   resume = { messages, queue, denied, steps, toolCallId, approved } —— 续跑某个 pending 写工具

  let idSeq = 0
  // 盖章 id 的唯一性(2026-08-27 审计):旧 `gen_${idSeq}` 每实例从 0 重计——跨轮(新 run/resume
  // 都新建 agent)可重复,前端 decidedApprovals 按_id 去重会误命中旧决策 → 审批不弹死锁。
  // 实例随机 tag 保证跨实例、跨进程重启都不撞(LLM 带的 call_xxx 原生 id 不受影响)。
  const runTag = Math.random().toString(36).slice(2, 8)
  // OpenAI 兼容 tool_call 都带 id;缺失时盖章一个稳定 id(写回 tc,保证 checkpoint→resume 一致)
  function callId(tc) { if (!tc.id) tc.id = `gen_${runTag}_${idSeq++}`; return tc.id }
  // 参数解析(2026-08-31 工具链审计修复⑥):合法 JSON → 对象;非法 → undefined——调用方不再
  // 拿 {} 照跑工具,而是把「参数非合法 JSON + 原文截断」作为工具回执喂回 LLM(可自纠)。
  function parseArgs(tc) { try { return JSON.parse(tc.function?.arguments || '{}') } catch { return undefined } }

  async function run({ system, history = [], onStep, onDelta, onReasoning, refreshSystem, resume } = {}) {
    // 初始化:resume 从回传状态续跑;否则从 system + history 起
    let messages, queue = [], denied = [], steps = 0
    let wrappedUp = false // 收尾轮每 run 至多一次(2026-09-03)
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
        if (!isResumeTarget && await needsApproval(name, args)) {
          return { status: 'pending_approval', messages, pending: { toolCallId: id, name, args }, queue: [...queue], denied, steps }
        }

        queue.shift()
        resumeToolCallId = null // 该 resume 已消费(后续同队列的写工具会再次 checkpoint)

        // resume 目标走「裁决快照」语义(2026-08-29 审计):用户批准恒执行、拒绝恒拒绝,
        // 不再现场重问 needsApproval——否则挂起窗口内策略放宽会把人「拒绝」翻案成直接执行。
        // 队列中后续写工具 isResumeTarget 已复位,回到上方正常 checkpoint 咨询。
        if (isResumeTarget && !resumeApproved) {
          denied.push({ name, args })
          messages.push({ role: 'tool', tool_call_id: id, content: `用户拒绝了该操作(${name})` })
          onStep?.({ type: 'denied', name, args, ts: Date.now() })
          continue
        }

        // 修复⑥:畸形 JSON 参数 → 不执行、不审批弹窗后白跑,回执说明 + 原文截断喂回 LLM 自纠。
        // (置于 denied 分支之后:resume 拒绝语义不受影响;execTool/审计不被垃圾参数触发。)
        if (args === undefined) {
          const raw = String(tc.function?.arguments ?? '')
          const feedback = `工具 ${name} 的参数不是合法 JSON,未执行。原始参数(截断): ${raw.slice(0, 200)}。请用合法 JSON 重新调用。`
          messages.push({ role: 'tool', tool_call_id: id, content: feedback })
          onStep?.({ type: 'tool', name, args: {}, result: feedback, ts: Date.now() })
          continue
        }

        // 执行前发 tool_start(UI 出"正在跑哪个工具"的 running 态;工具执行是串行 await,
        // 同一时刻至多一个 start 未配对。消费方(workbench-agent)不持久化此瞬态事件)
        onStep?.({ type: 'tool_start', name, args, ts: Date.now() })
        let result
        try { result = await execTool(name, args) }
        catch (e) { result = formatToolError(e) }
        messages.push({ role: 'tool', tool_call_id: id, content: clampToolContent(result) })
        onStep?.({ type: 'tool', name, args, result, ts: Date.now() })
      }

      // 2) 队列空 → 下一轮 chat(受 maxSteps 约束;0/负数 = 不设限,仅上下文预算兜底)
      if (maxSteps > 0 && steps >= maxSteps) {
        // 收尾轮(2026-09-03):到上限不再硬断——注入系统收尾指令、不带工具,强制基于已有信息终答。
        // truncated 仍 true:前端据此亮「已达步数上限」标;每 run 至多一次(极端二次到顶走旧兜底文案)。
        if (!wrappedUp) {
          wrappedUp = true
          messages.push({ role: 'user', content: `(系统提示:已达到最大执行步数 ${maxSteps},请立即基于以上已获得的信息给出最终回答,不要再调用任何工具。)` })
          steps++
          const assistant = await chat(messages, [], (onDelta || onReasoning) ? { onDelta, onReasoning } : {})
          messages.push(assistant)
          onStep?.({ type: 'assistant', message: assistant, ts: Date.now() })
          return { content: assistant.content, steps, denied, truncated: true }
        }
        return { content: '(达到最大步数,未给出终答)', steps, denied, truncated: true }
      }
      steps++
      let truncated = false
      if (messages.length > 1) {
        const t = trimMessages(messages, budgetChars)
        messages = t.messages; truncated = t.truncated
      }
      // T5:每轮 chat 前重置 messages[0]——@-ref 漂移修复:让 LLM 每轮看到 ref 的最新状态(由 run/resumeConversation 注入的 refreshSystem 钩子)。
      if (refreshSystem && messages[0]?.role === 'system') {
        messages[0] = { role: 'system', content: await refreshSystem() }
      }
      const assistant = await chat(messages, toolDefs, (onDelta || onReasoning) ? { onDelta, onReasoning } : {})
      messages.push(assistant)
      onStep?.({ type: 'assistant', message: assistant, ts: Date.now() })
      const toolCalls = assistant.tool_calls || []
      if (!toolCalls.length) return { content: assistant.content, steps, denied, truncated }   // 终答
      queue = [...toolCalls]
      resumeToolCallId = null // 新 turn,旧 resume 标记失效
    }
  }
  return { run }
}
