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
// 二阶段(2026-09-06 计量缺陷B):phase1 只丢 user/tool、恒保 assistant → assistant 体积大
// (多轮长文)时裁完仍超预算,provider 400。phase2 按「轮」从最旧整组丢弃:一条 assistant
// (非末条)及其后连续的 tool 消息为一组(assistant 和它的 tool 一起走,不产生孤儿 tool),
// 循环直到达标;若某组的 tool 连到末条(末条恰是该 assistant 的 tool 结果),该组不可丢
// ——丢 assistant 会孤儿、丢 tool 违反保尾部,system + 该配对即裁剪下限。
// 预算计量投影(salvage-gap 审计 2026-09-08 B3):assistant 的内部字段 reasoning/finishReason
// 不发给 provider(llm.mjs sanitizeMessages 请求边界消毒),也不该吃预算——旧 JSON.stringify(m)
// 全量口径让深思考模型的 reasoning 全文虚占预算,提前触发裁剪丢轮。口径与白名单投影一致
// (tool_calls 是真载荷,全额计)。
const budgetSize = m => JSON.stringify(
  m?.role === 'assistant'
    ? { role: m.role, content: m.content, ...(Array.isArray(m.tool_calls) && m.tool_calls.length ? { tool_calls: m.tool_calls } : {}) }
    : m
).length

export function trimMessages(messages, budget = DEFAULT_BUDGET_CHARS) {
  const total = messages.reduce((n, m) => n + budgetSize(m), 0)
  if (total <= budget) return { messages, truncated: false }
  const startIdx = messages[0]?.role === 'system' ? 1 : 0
  const kept = messages.slice()
  const droppedToolIds = new Set()
  // 最新一条 user 与 system 同属不可裁集(2026-09-09 审计 bug①):phase1 只丢 user/tool,长对话
  // 把 user 裁光 → 发往 provider 的 messages 只剩 system+assistant → GLM error 1214「messages
  // 参数非法」→ 整轮 400 死循环。保「最新」而非「全部」:旧 user 保持可丢,预算强制不失效。
  let lastUserIdx = -1
  for (let i = 0; i < kept.length; i++) if (kept[i]?.role === 'user') lastUserIdx = i
  let cur = total
  for (let i = startIdx; i < kept.length - 1 && cur > budget; i++) {
    const m = kept[i]
    if (m.role === 'system' || m.role === 'assistant' || i === lastUserIdx) continue  // 不丢 system/assistant/最新 user
    cur -= budgetSize(m)
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
  // phase2:仍超预算 → assistant 轮从最旧整组丢弃(assistant + 其后连续 tool 一体走,无孤儿)
  if (cur > budget) {
    cur = out.reduce((n, m) => n + budgetSize(m), 0)  // 悬空清理可能已丢 assistant,重算
    while (cur > budget) {
      const idx = out.findIndex((m, i) => m.role === 'assistant' && i < out.length - 1)
      if (idx === -1) break                                    // 无可丢的 assistant 轮(只剩 system+末条)
      let end = idx + 1
      while (end < out.length && out[end].role === 'tool') end++
      if (end >= out.length) break                             // 组触末条:末条是该轮的 tool → 到下限,不可拆
      for (let i = idx; i < end; i++) cur -= budgetSize(out[i])
      out.splice(idx, end - idx)
    }
  }
  // phase3(2026-09-09 审计 T3):裁剪下限(system+末组)自身超预算 → 尾部内容二次钳制。
  // 只截 content、绝不 drop(丢末条 user 重造 1214 形态;丢 tool 产孤儿 tool_call);顺序:
  // 先从尾部倒序钳 tool(标记与 clampToolContent 同款,模型可感知残缺),仍超才钳末条 user。
  // system 恒不钳(prompt/refs 注入是系统资产,钳了改变行为语义)。记账精确:cur 减 content
  // 旧长、加 keep+标记实长;keep 预留 32 字符标记上界,保证钳后 cur ≤ budget。
  if (cur > budget) {
    // 容量闸:钳制只在该轮「可钳内容(tool+user)足以吸收全部超发」时进行——system 独大
    // (refs/记忆注入)时钳谁都是徒劳的语义损毁,保持旧语义原样超发返回(路由层输入上限与
    // provider 报错兜底);超大贴片/巨型工具结果才值得且能够钳回预算内。
    const clampable = out.reduce((n, m) => n + (m.role === 'tool' || m.role === 'user' ? String(m.content ?? '').length : 0), 0)
    if (cur - budget <= clampable) {
      const MARKER_PAD = 32
      const clampContent = (m) => {
        const s = String(m.content ?? '')
        const rest = cur - s.length // 本条 content 之外的其余总量
        let keep = Math.min(s.length, Math.max(0, budget - rest - MARKER_PAD))
        const marker = `\n…[truncated ${s.length - keep} chars]`
        m.content = s.slice(0, keep) + marker
        cur = rest + m.content.length
      }
      for (let i = out.length - 1; i >= 0 && cur > budget; i--) {
        if (out[i].role === 'tool') clampContent(out[i])
      }
      if (cur > budget) {
        for (let i = out.length - 1; i >= 0; i--) if (out[i].role === 'user') { clampContent(out[i]); break }
      }
    }
  }
  return { messages: out, truncated: true }
}

export function createAgent({ chat, toolDefs = [], execTool, needsApproval = () => false, shouldAbort, maxSteps = MAX_STEPS, budgetChars = DEFAULT_BUDGET_CHARS, retryDelays }) {
  // chat: async (messages, toolDefs) => assistantMessage {role, content, tool_calls?}
  // toolDefs: LLM 工具定义(OpenAI tools 格式)
  // execTool: async (name, args) => 结果(string 或对象,转字符串喂回 LLM)
  // needsApproval(name, args) => bool | Promise<bool>:写工具遇 checkpoint(不自动执行,交人审);
  //   可异步(runner 注入 dynamicApproval 按运行时策略裁决,如 SSH 按服务器放宽)
  // shouldAbort(2026-09-06 审计#3)(可选)async () => bool:轻量取消检查点——用户点「停止」
  //   后 cancelConversation 只置 DB 状态,agent 循环原本无人查它,队列剩余工具与后续 LLM 轮
  //   照跑(在途 LLM 流不可中断属已知边界,但工具副作用不该继续发生)。检查点两处:工具
  //   队列每个工具开头(needsApproval 咨询之前)与主循环每轮 chat 前;取消即抛错 run() reject。
  //   缺省(undefined)时行为零变化。
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

  // chat 容错(2026-09-06「对话尾巴不展示」排查;2026-09-09 审计 F1 按类别分流):首 token 前
  // (未吐任何 delta/reasoning)失败自动重试——sub2api/litellm 类代理的瞬时 400/502 多发生在
  // 建连/首 token。已吐 delta 后失败不重试:流式重试从头再吐,前端已拼接的内容会重复。chat 是
  // 纯生成调用(无副作用),重试安全。分流(F1):
  //   5xx/网络类(llm throw 附 status≥500,或无 status 的网络层错误)→ 共 3 次尝试 + 指数退避
  //     (代理常在同 1-2s 内仍不健康,零延迟重试白烧;退避乘 jitter 防齐步);
  //   4xx → 保持单次立即重试(便宜;sub2api/litellm 瞬时 400 在案,勿按状态码武断放弃);
  //   取消/换绑(CancelledError/InvalidatedError)→ 绝不重试;超时类(Idle/StreamDeadline)
  //     → 单次立即重试(多重退避会把单轮挂到数十分钟)。
  // retryDelays 为测试缝(注入 [0,0] 跳过真实 sleep),生产缺省 [300, 1500]。
  const RETRY_DELAYS = retryDelays || [300, 1500]
  const errKind = (e) => {
    if (e?.name === 'CancelledError' || e?.name === 'InvalidatedError') return 'cancel'
    if (e?.name === 'IdleTimeoutError' || e?.name === 'StreamDeadlineError') return 'timeout'
    const s = Number(e?.status)
    if (s >= 500) return 'transient'
    if (s >= 400) return 'client'
    return 'network'
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  async function chatWithRetry(messages, tools, opts = {}) {
    let sawDelta = false
    const wrapped = {}
    if (opts?.onDelta) wrapped.onDelta = t => { sawDelta = true; opts.onDelta(t) }
    if (opts?.onReasoning) wrapped.onReasoning = t => { sawDelta = true; opts.onReasoning(t) }
    try {
      return await chat(messages, tools, wrapped)
    } catch (e) {
      if (sawDelta) throw e
      if (errKind(e) === 'cancel') throw e
      if (errKind(e) === 'transient' || errKind(e) === 'network') {
        let last = e
        for (const d of RETRY_DELAYS) {
          await sleep(d * (0.5 + Math.random()))
          try { return await chat(messages, tools, wrapped) } catch (e2) {
            if (sawDelta) throw e2
            if (errKind(e2) === 'cancel') throw e2
            last = e2
          }
        }
        throw last
      }
      return await chat(messages, tools, wrapped)
    }
  }

  // maxSteps=0(不限制)的独立硬兜底(2026-09-09 审计 T1):上下文预算不是终止条件——trim 的
  // 裁剪不动点([system,assistant(tc),tool] 滑动窗)使上下文恒低于预算,循环无任何内部出口
  // (每轮=1 次真实计费 LLM 调用+1 次工具执行)。硬顶=200(与 UI 步数上限同值,语义「0≈上限
  // 档」),复用收尾轮机制到点强制终答;steps 跨 resume 累计,审批乒乓无法重置硬顶。
  const HARD_CAP = 200
  const stepCap = maxSteps > 0 ? maxSteps : HARD_CAP

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
        // 取消检查点①(2026-09-06 审计#3):每个工具开头(needsApproval 咨询之前)——
        // 取消即抛错中止,队列剩余工具的副作用不再发生;run() reject 交上层 catch 处置。
        if (shouldAbort && await shouldAbort()) throw new Error('对话已取消,中止工具执行')
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

      // 2) 队列空 → 下一轮 chat(受 stepCap 约束;maxSteps=0 → HARD_CAP=200 硬顶兜底,见 stepCap 注)
      // 取消检查点②(2026-09-06 审计#3;对抗审查后置于 maxSteps 分支之前):取消后不再发起
      // 任何后续 chat——含收尾轮(纯生成无工具,虽无副作用但结果注定被丢弃,省一次调用)。
      // 在途 LLM 流本身不可中断属已知边界,此处拦的是「下一轮」。
      if (shouldAbort && await shouldAbort()) throw new Error('对话已取消,中止工具执行')
      if (steps >= stepCap) {
        // 收尾轮(2026-09-03):到上限不再硬断——注入系统收尾指令、不带工具,强制基于已有信息终答。
        // truncated 仍 true:前端据此亮「已达步数上限」标;每 run 至多一次(极端二次到顶走旧兜底文案)。
        if (!wrappedUp) {
          wrappedUp = true
          // 到上限时刻消息最长,必须先按预算裁剪再收尾 chat,否则可能超预算被 provider 400 整轮 failed
          const t = trimMessages(messages, budgetChars)
          messages = t.messages
          messages.push({ role: 'user', content: `(系统提示:已达到最大执行步数 ${stepCap},请立即基于以上已获得的信息给出最终回答,不要再调用任何工具。)` })
          steps++
          const assistant = await chatWithRetry(messages, [], (onDelta || onReasoning) ? { onDelta, onReasoning } : {})
          messages.push(assistant)
          onStep?.({ type: 'assistant', message: assistant, ts: Date.now() })
          return { content: assistant.content, steps, denied, truncated: true, cutByLength: assistant.finishReason === 'length' }
        }
        return { content: '(达到最大步数,未给出终答)', steps, denied, truncated: true }
      }
      steps++
      let truncated = false // 注意:此处 trimMessages 的裁剪旗标不透传到返回值——
      // out.truncated 的语义是「步数上限截断/收尾轮」(唯一消费方 conv-events.mjs),预算裁剪不经此亮标
      // T5(@-ref 漂移修复):每轮 chat 前重置 messages[0],让 LLM 看到 ref 的最新状态(由 run/resumeConversation 注入的 refreshSystem 钩子)。
      // 须在 trim 之前(2026-09-06 计量缺陷A):recap/@refs 注入可达 ~50KB,若发生在裁剪之后
      // 则不计预算 → 实际上下文可超预算;先重写再裁,重写体积计入(system 恒保不会被裁掉)。
      if (refreshSystem && messages[0]?.role === 'system') {
        messages[0] = { role: 'system', content: await refreshSystem() }
      }
      if (messages.length > 1) {
        const t = trimMessages(messages, budgetChars)
        messages = t.messages
      }
      const assistant = await chatWithRetry(messages, toolDefs, (onDelta || onReasoning) ? { onDelta, onReasoning } : {})
      messages.push(assistant)
      onStep?.({ type: 'assistant', message: assistant, ts: Date.now() })
      const toolCalls = assistant.tool_calls || []
      // 终答(正常完成,不携带步数上限旗标);cutByLength(2026-09-06):finish_reason=length
      // = provider 输出上限掐断,前端亮标,不再静默截断。
      if (!toolCalls.length) return { content: assistant.content, steps, denied, truncated: false, cutByLength: assistant.finishReason === 'length' }
      queue = [...toolCalls]
      resumeToolCallId = null // 新 turn,旧 resume 标记失效
    }
  }
  return { run }
}
