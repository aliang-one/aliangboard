// OpenAI 兼容 LLM 客户端(第二阶段 agent 用)。管理员配 baseURL + apiKey + model。
// 覆盖 OpenAI / DeepSeek / Qwen / Ollama / vLLM 等(都走 /chat/completions + tool-calling)。
// 超时模型(2026-08-16 断流修复):
//   chat(非流式):总时限 timeoutMs(默认 120s,env LLM_TIMEOUT_MS)。
//   chatStream(流式):**空闲超时** idleMs(默认 180s,env LLM_STREAM_IDLE_MS)——每读到
//   一个 chunk 重置计时,无总时限。旧实现两共用 AbortSignal.timeout(60s 总限):长回答/
//   慢思考模型读到一半被掐("回答一半就断流"的直接根因;首 token >60s 的深思考同样必死)。
import { fetch as defaultFetch } from 'undici'
import { makeChatWithRetry } from './llm-retry.mjs'

// SSE 行尾三态(规范认 CR / LF / CRLF):事件终结符 = 空行(两个行尾),事件内部行分割同款。
// 只认 '\n\n' 时 CRLF 风格代理(\r\n\r\n 分隔)的流永不切出事件,整流瘫痪。
const EVENT_END = /\r\n\r\n|\r\r|\n\n/
const LINE_END = /\r\n|\r|\n/

// chatStream 总时限(agent-loop-05,2026-09-07 审计批次三):流式只设空闲超时的旧模型对
// 「永远滴流的长尾流」无解——每 chunk 到达即重 arm 计时,间隔 < idleMs 的滴流(失控 run /
// 代理重试风暴)可无限续命烧 LLM key。总限 10 分钟:流式足够宽松(深思考长答分钟级仍余量;
// 多轮 run 各轮独立计时,总时长不受单轮限制),到点 abort 走与空闲超时同一条抛错路径
// (→ workbench-agent catch → safeSalvage 保留已流出内容标 failed)。
// 刻意常量、无 env 通道:admin 不应能把总限调成无限;测试经 createLlmClient 的 streamTotalMs
// 参数注入短值(与 timeoutMs/idleMs 同为工厂参数 seam,零 env 依赖)。
export const STREAM_TOTAL_MS = 10 * 60 * 1000

// R2(2026-10-13):HTTP 错误响应的 Retry-After(秒)→ 毫秒,附挂到抛出的错误对象
// (e.retryAfterMs)供 agent 退避梯取用——限流时段服务端明示「等多久」,自造退避不如听服务端。
// 只认秒数形态(RFC 允许 HTTP-date,但主流 LLM 网关发秒数;HTTP-date → undefined 走自造梯);
// 缺席/非数字/≤0 → undefined;封顶 120s(离谱大值不配挂死单轮,预算层另有上限)。
function retryAfterMsOf(res) {
  const v = Number(res?.headers?.get?.('retry-after'))
  return Number.isFinite(v) && v > 0 ? Math.min(Math.round(v * 1000), 120000) : undefined
}

// 请求边界消毒(2026-09-08 审计:1214「messages 参数非法」根因):agent 循环把上一轮 assistant
// 返回值原样 push 回 messages——流式 finalize 挂的 reasoning/finishReason(内部字段,供
// cutByLength/持久化)与非流式 {...msg} 直展透传的 provider 原生 reasoning_content,都会随
// 下一轮请求原样进 body。智谱系后端严格校验 messages(错误码 1214,文档明示思考内容要么
// 完整原序透传要么剔除),未知/回传字段即整组拒收——多轮工具对话第 2 轮起必带毒(离线复现
// 在案)。收口在本函数(chat/chatStream 两个请求体共用单点):白名单投影为 OpenAI schema
// {role, content, tool_calls?};返回值保持内部字段不动(finishReason 供 cutByLength,reasoning
// 供 tracker 落库)——只洗「发出去的」,不洗「留在内存的」。
// 空 content 且无 tool_calls 的 assistant 剔除:done 落库的空串行(workbench-agent:134)经
// buildHistory 原样回喂,是同款严格校验下的高危形状(剔除不改变语义——该行不携带信息)。
export function sanitizeMessages(messages) {
  const out = []
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (!m || typeof m !== 'object' || !m.role) continue
    if (m.role === 'assistant') {
      const tool_calls = Array.isArray(m.tool_calls) && m.tool_calls.length ? m.tool_calls : undefined
      const content = typeof m.content === 'string' ? m.content : (m.content == null ? '' : String(m.content))
      if (!content && !tool_calls) continue
      out.push(tool_calls ? { role: 'assistant', content, tool_calls } : { role: 'assistant', content })
      continue
    }
    if (m.role === 'tool') { out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content }); continue }
    out.push({ role: m.role, content: m.content })
  }
  return out
}

export function createLlmClient({
  baseURL, apiKey, model, temperature, maxTokens, contextWindow, fetch = defaultFetch,
  timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 120000,
  idleMs = Number(process.env.LLM_STREAM_IDLE_MS) || 180000,
  streamTotalMs = STREAM_TOTAL_MS,
}) {
  if (!baseURL || !model) throw new Error('LLM 客户端缺 baseURL / model')
  const endpoint = baseURL.replace(/\/$/, '') + '/chat/completions'
  // 模型参数(admin 可配,空 = 不带、用模型默认;2026-08-25 AI 定制设计)
  const extras = {}
  if (temperature !== undefined && temperature !== null && temperature !== '') extras.temperature = Number(temperature)
  if (maxTokens !== undefined && maxTokens !== null && maxTokens !== '') extras.max_tokens = Number(maxTokens)
  // chat({messages, tools?, toolChoice?}) → assistant message {role, content, tool_calls?}
  async function chat({ messages, tools, toolChoice } = {}) {
    const body = { model, messages: sanitizeMessages(messages), ...extras }
    if (tools?.length) { body.tools = tools; body.tool_choice = toolChoice || 'auto' }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { const e = new Error(`LLM 返回非 JSON(HTTP ${res.status}): ${text.slice(0, 200)}`); e.status = res.status; e.retryAfterMs = retryAfterMsOf(res); throw e }
    if (!res.ok) { const e = new Error(`LLM HTTP ${res.status}: ${json.error?.message || json.message || text.slice(0, 200)}`); e.status = res.status; e.retryAfterMs = retryAfterMsOf(res); throw e }
    const choice = json.choices?.[0]
    const msg = choice?.message
    if (!msg) throw new Error('LLM 响应缺 choices[0].message')
    // finish_reason 透传(2026-09-06):'length' = 输出上限掐断,agent 据此亮 cutByLength 标,不再静默截断
    return choice.finish_reason ? { ...msg, finishReason: choice.finish_reason } : msg
  }

  // chatStream:流式版 chat。逐 chunk 解 OpenAI 兼容 SSE;content 累积并回调 onDelta;
  // tool_calls 按 index 合并分片。返回结构与 chat 一致。
  // signal(第二参数 bag,agent-loop-05 取消接线):外部 AbortSignal(用户取消:cancelConversation
  // → AbortController.abort)与内部空闲/总限计时器共用同一 ac——任一触发即断流,abort reason
  // 透传(fetch 以 reason 拒绝,取消语义不被泛型 AbortError 吞掉)。缺省(未传)零变化。
  async function chatStream({ messages, tools, toolChoice } = {}, { onDelta, onReasoning, signal } = {}) {
    const body = { model, messages: sanitizeMessages(messages), stream: true, ...extras }
    if (tools?.length) { body.tools = tools; body.tool_choice = toolChoice || 'auto' }
    // 空闲超时:每读到数据就重 arm。思考再久(深调查/长文)只要仍产 chunk 就活着。
    // 总限(agent-loop-05):单次调用的硬上限,滴流长尾流到点即断(常量见 STREAM_TOTAL_MS 注)。
    const ac = new AbortController()
    if (signal) {
      if (signal.aborted) ac.abort(signal.reason)
      else signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true })
    }
    let idleTimer = null
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => ac.abort(Object.assign(new Error(`LLM 流式空闲超时(${Math.round(idleMs / 1000)}s 无数据)`), { name: 'IdleTimeoutError' })), idleMs)
    }
    armIdle()
    const deadlineTimer = setTimeout(() => ac.abort(Object.assign(new Error(`LLM 流式总超时(${Math.round(streamTotalMs / 1000)}s 到点仍未终态)`), { name: 'StreamDeadlineError' })), streamTotalMs)
    try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // 镜像 chat 的解析:优先提取 json.error.message,而非 raw body。
      let msg = text.slice(0, 200)
      try { const j = JSON.parse(text); msg = j.error?.message || j.message || msg } catch {}
      const err = new Error(`LLM HTTP ${res.status}: ${msg}`)
      err.status = res.status // agent 侧重试按类别分流(2026-09-09 审计 F1;2026-10-13 R2:429 亦进梯)
      err.retryAfterMs = retryAfterMsOf(res)
      throw err
    }
    if (!res.body) throw new Error('LLM 响应无 body(不支持流式)')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = '', content = '', reasoning = '', finishReason = null, toolCallsMap = {}
    const readChunk = async () => { const r = await reader.read(); armIdle(); return r }
    const finalize = () => {
      const tool_calls = Object.keys(toolCallsMap).sort((a, b) => a - b)
        .map(k => toolCallsMap[k]).filter(t => t.function.name || t.function.arguments)
      // 终态兜底(agent-loop-04,2026-09-07 审计):流结束时 content / tool_calls / finishReason
      // 三皆空 = 上游异常终止(连 finish_reason 都没发),旧实现照样标 done——空终答无任何错误
      // 提示。三条件任一在场即放行:tool_calls 在场 = 纯工具轮的正常形态(content 空是常态);
      // finishReason 在场 = 正常终止(content 空是模型自由);有 content 更不在话下。守卫只在
      // finalize 单点([DONE] 终止与自然断流两条终止路径共用),不误伤收尾轮/工具轮。
      if (!content && !tool_calls.length && !finishReason) throw new Error('LLM 返回空响应')
      // reasoning(DeepSeek-R1/Qwen 深思考的 reasoning_content,OpenAI o 系列为 reasoning):
      // 思考 token 也回调/返回——此前整段丢弃,前端只能干等 35-40s"思考中"。
      // finish_reason 透传(2026-09-06,同 chat):'length' = 输出上限掐断。
      return { role: 'assistant', content, ...(reasoning ? { reasoning } : {}), ...(finishReason ? { finishReason } : {}), ...(tool_calls.length ? { tool_calls } : {}) }
    }
    while (true) {
      const { done, value } = await readChunk()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // 终结符按 match[0].length 切除(CR/LF/CRLF 行尾宽窄不一);跨 chunk 断裂的行尾
      // (如 '...\r' + '\n\r\n...')在拼齐前不构成完整终结符,不会切出半事件。
      let m
      while ((m = EVENT_END.exec(buf)) !== null) {
        const raw = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length)
        // 事件内部逐行处理(SSE 事件可多行,只认 data: 行);[DONE]/JSON 容错/delta 处理不变。
        for (const rawLine of raw.split(LINE_END)) {
          const line = rawLine.trim()
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') { reader.cancel?.().catch(() => {}); return finalize() }
          let obj; try { obj = JSON.parse(payload) } catch { continue }
          // 流内 error 事件(agent-loop-04,2026-09-07 审计):上游/代理在流中段发 {"error":...}
          // (sub2api/litellm 类代理故障的典型形态)此前落进「无 delta → continue」被无声跳过——
          // 半截答案照样标 done,用户无从知晓中途故障。契约:error 在场且无 choices → 抛错。
          // 抛出点在已吐 delta 之后:agent.mjs chatWithRetry 的 sawDelta 谓词据此不重试(流式
          // 重试会从头再吐、前端已拼接内容重复),错误上抛交 workbench-agent 的 salvage 路径
          // 保留半截内容并标 failed(与中断保全语义一致);error 无 message 字段以 JSON 串兜底。
          // error 与非空 choices 并存的帧(个别代理混发)不拦,照常走 delta 处理;空 choices
          // 数组无 delta 可处理,与缺席同形照抛(终审修复:`!obj.choices` 对空数组取 false,
          // 故障帧曾绕过抛错落回静默吞)。
          if (obj.error && !obj.choices?.length) {
            reader.cancel?.().catch(() => {}) // 释放未读完的响应体(连接及时归还连接池)
            throw new Error('LLM 流内错误: ' + (obj.error?.message || JSON.stringify(obj.error).slice(0, 200)))
          }
          const delta = obj.choices?.[0]?.delta
          if (obj.choices?.[0]?.finish_reason) finishReason = obj.choices[0].finish_reason
          if (!delta) continue
          const rtext = delta.reasoning_content ?? delta.reasoning
          if (typeof rtext === 'string' && rtext) { reasoning += rtext; onReasoning?.(rtext) }
          // I-审计(2026-08-26):content 与 reasoning 同款守卫——多模态代理可能发数组形态
          // content,`content += 对象` 会产生 [object Object]/逗号拼接直接进对话+落库。非字符串 JSON 并入。
          if (delta.content) {
            const text = typeof delta.content === 'string' ? delta.content : JSON.stringify(delta.content)
            content += text; onDelta?.(text)
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0
              if (!toolCallsMap[i]) toolCallsMap[i] = { id: tc.id, type: tc.type || 'function', function: { name: '', arguments: '' } }
              if (tc.id) toolCallsMap[i].id = tc.id
              if (tc.function?.name) toolCallsMap[i].function.name += tc.function.name
              if (tc.function?.arguments) toolCallsMap[i].function.arguments += tc.function.arguments
            }
          }
        }
      }
    }
    return finalize()
    } finally { clearTimeout(idleTimer); clearTimeout(deadlineTimer) }
  }
  // contextWindow 透传暴露(2026-10-23):上文窗口显式配置(agent/summarize 经 resolveWindowTokens
  // 消费)。缺省/空串归一 null——消费点零值回落模型推导。
  const ctxWindow = Number(contextWindow)
  return { chat, chatStream, model, endpoint, contextWindow: Number.isFinite(ctxWindow) && ctxWindow > 0 ? ctxWindow : null }
}

// 探测模型是否流式透传思考 token(reasoning_content/reasoning)——「LLM 配置」页用,
// 告诉管理员当前模型切没切到能展示思考过程的模型(GLM/DeepSeek-R1 类;gpt-5.x 经
// 部分代理只发 content)。思考模型对任何输入都先吐 reasoning(实测),极小 prompt
// 即可判定;总限防慢模型挂死探测(超时按已见字段给结论)。
// 直呼穿重试梯(2026-10-25 盲区批):探测原为 race 超时单发,代理瞬时 5xx/429 一次即败。
// race 保留在内层 chat 适配器里(每次尝试各自的 totalMs 守卫,梯外不再包 → 不双超时);
// 守卫超时以 TimeoutError 抛出 → errKind 归 'timeout' 类 → 单次立即重试;两连超时定性
// → 按已见字段给结论(原「race 超时」语义保留),非超时错误照旧上抛。探测回调直连
// chatStream(不经重试梯 wrapped.sawDelta——探测无「前端已拼接」问题,重试零成本,
// 已见旗标跨尝试单调累积)。
export async function probeReasoningSupport(client, { totalMs = 45000, prompt = '1+1=?(探测用,请直接回答)' } = {}) {
  let sawReasoning = false, sawContent = false, sample = ''
  const chatRetry = makeChatWithRetry({
    chat: (messages, _tools, _wrapped) => Promise.race([
      client.chatStream({ messages }, {
        onReasoning: t => { sawReasoning = true; if (sample.length < 80) sample += String(t) },
        onDelta: () => { sawContent = true },
      }),
      new Promise((_resolve, reject) => setTimeout(() => reject(Object.assign(
        new Error(`模型探测总限(${Math.round(totalMs / 1000)}s 到点仍未终态)`),
        { name: 'TimeoutError' },
      )), totalMs)),
    ]),
  })
  try {
    await chatRetry([{ role: 'user', content: prompt }])
  } catch (e) {
    if (e?.name === 'TimeoutError') return { supported: sawReasoning, sawContent, sample: sample.slice(0, 80), timedOut: true }
    throw e
  }
  return { supported: sawReasoning, sawContent, sample: sample.slice(0, 80), timedOut: false }
}
