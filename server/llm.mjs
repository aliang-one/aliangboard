// OpenAI 兼容 LLM 客户端(第二阶段 agent 用)。管理员配 baseURL + apiKey + model。
// 覆盖 OpenAI / DeepSeek / Qwen / Ollama / vLLM 等(都走 /chat/completions + tool-calling)。
// 超时模型(2026-08-16 断流修复):
//   chat(非流式):总时限 timeoutMs(默认 120s,env LLM_TIMEOUT_MS)。
//   chatStream(流式):**空闲超时** idleMs(默认 180s,env LLM_STREAM_IDLE_MS)——每读到
//   一个 chunk 重置计时,无总时限。旧实现两共用 AbortSignal.timeout(60s 总限):长回答/
//   慢思考模型读到一半被掐("回答一半就断流"的直接根因;首 token >60s 的深思考同样必死)。
import { fetch as defaultFetch } from 'undici'

// SSE 行尾三态(规范认 CR / LF / CRLF):事件终结符 = 空行(两个行尾),事件内部行分割同款。
// 只认 '\n\n' 时 CRLF 风格代理(\r\n\r\n 分隔)的流永不切出事件,整流瘫痪。
const EVENT_END = /\r\n\r\n|\r\r|\n\n/
const LINE_END = /\r\n|\r|\n/

export function createLlmClient({
  baseURL, apiKey, model, temperature, maxTokens, fetch = defaultFetch,
  timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 120000,
  idleMs = Number(process.env.LLM_STREAM_IDLE_MS) || 180000,
}) {
  if (!baseURL || !model) throw new Error('LLM 客户端缺 baseURL / model')
  const endpoint = baseURL.replace(/\/$/, '') + '/chat/completions'
  // 模型参数(admin 可配,空 = 不带、用模型默认;2026-08-25 AI 定制设计)
  const extras = {}
  if (temperature !== undefined && temperature !== null && temperature !== '') extras.temperature = Number(temperature)
  if (maxTokens !== undefined && maxTokens !== null && maxTokens !== '') extras.max_tokens = Number(maxTokens)
  // chat({messages, tools?, toolChoice?}) → assistant message {role, content, tool_calls?}
  async function chat({ messages, tools, toolChoice } = {}) {
    const body = { model, messages, ...extras }
    if (tools?.length) { body.tools = tools; body.tool_choice = toolChoice || 'auto' }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { throw new Error(`LLM 返回非 JSON(HTTP ${res.status}): ${text.slice(0, 200)}`) }
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${json.error?.message || json.message || text.slice(0, 200)}`)
    const choice = json.choices?.[0]
    const msg = choice?.message
    if (!msg) throw new Error('LLM 响应缺 choices[0].message')
    // finish_reason 透传(2026-09-06):'length' = 输出上限掐断,agent 据此亮 cutByLength 标,不再静默截断
    return choice.finish_reason ? { ...msg, finishReason: choice.finish_reason } : msg
  }

  // chatStream:流式版 chat。逐 chunk 解 OpenAI 兼容 SSE;content 累积并回调 onDelta;
  // tool_calls 按 index 合并分片。返回结构与 chat 一致。
  async function chatStream({ messages, tools, toolChoice } = {}, { onDelta, onReasoning } = {}) {
    const body = { model, messages, stream: true, ...extras }
    if (tools?.length) { body.tools = tools; body.tool_choice = toolChoice || 'auto' }
    // 空闲超时:每读到数据就重 arm;总时长不限。思考再久(深调查/长文)只要仍产 chunk 就活着。
    const ac = new AbortController()
    let idleTimer = null
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => ac.abort(Object.assign(new Error(`LLM 流式空闲超时(${Math.round(idleMs / 1000)}s 无数据)`), { name: 'IdleTimeoutError' })), idleMs)
    }
    armIdle()
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
      throw new Error(`LLM HTTP ${res.status}: ${msg}`)
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
    } finally { clearTimeout(idleTimer) }
  }
  return { chat, chatStream, model, endpoint }
}

// 探测模型是否流式透传思考 token(reasoning_content/reasoning)——「LLM 配置」页用,
// 告诉管理员当前模型切没切到能展示思考过程的模型(GLM/DeepSeek-R1 类;gpt-5.x 经
// 部分代理只发 content)。思考模型对任何输入都先吐 reasoning(实测),极小 prompt
// 即可判定;总限防慢模型挂死探测(超时按已见字段给结论)。
export async function probeReasoningSupport(client, { totalMs = 45000, prompt = '1+1=?(探测用,请直接回答)' } = {}) {
  let sawReasoning = false, sawContent = false, sample = ''
  const work = client.chatStream({ messages: [{ role: 'user', content: prompt }] }, {
    onReasoning: t => { sawReasoning = true; if (sample.length < 80) sample += String(t) },
    onDelta: () => { sawContent = true },
  })
  const guard = new Promise(resolve => setTimeout(resolve, totalMs, 'timeout'))
  const r = await Promise.race([work, guard])
  return { supported: sawReasoning, sawContent, sample: sample.slice(0, 80), timedOut: r === 'timeout' }
}
