// OpenAI 兼容 LLM 客户端(第二阶段 agent 用)。管理员配 baseURL + apiKey + model。
// 覆盖 OpenAI / DeepSeek / Qwen / Ollama / vLLM 等(都走 /chat/completions + tool-calling)。
// 超时模型(2026-08-16 断流修复):
//   chat(非流式):总时限 timeoutMs(默认 120s,env LLM_TIMEOUT_MS)。
//   chatStream(流式):**空闲超时** idleMs(默认 180s,env LLM_STREAM_IDLE_MS)——每读到
//   一个 chunk 重置计时,无总时限。旧实现两共用 AbortSignal.timeout(60s 总限):长回答/
//   慢思考模型读到一半被掐("回答一半就断流"的直接根因;首 token >60s 的深思考同样必死)。
import { fetch as defaultFetch } from 'undici'

export function createLlmClient({
  baseURL, apiKey, model, fetch = defaultFetch,
  timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 120000,
  idleMs = Number(process.env.LLM_STREAM_IDLE_MS) || 180000,
}) {
  if (!baseURL || !model) throw new Error('LLM 客户端缺 baseURL / model')
  const endpoint = baseURL.replace(/\/$/, '') + '/chat/completions'
  // chat({messages, tools?, toolChoice?}) → assistant message {role, content, tool_calls?}
  async function chat({ messages, tools, toolChoice } = {}) {
    const body = { model, messages }
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
    const msg = json.choices?.[0]?.message
    if (!msg) throw new Error('LLM 响应缺 choices[0].message')
    return msg
  }

  // chatStream:流式版 chat。逐 chunk 解 OpenAI 兼容 SSE;content 累积并回调 onDelta;
  // tool_calls 按 index 合并分片。返回结构与 chat 一致。
  async function chatStream({ messages, tools, toolChoice } = {}, { onDelta } = {}) {
    const body = { model, messages, stream: true }
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
    let buf = '', content = '', toolCallsMap = {}
    const readChunk = async () => { const r = await reader.read(); armIdle(); return r }
    const finalize = () => {
      const tool_calls = Object.keys(toolCallsMap).sort((a, b) => a - b)
        .map(k => toolCallsMap[k]).filter(t => t.function.name || t.function.arguments)
      return { role: 'assistant', content, ...(tool_calls.length ? { tool_calls } : {}) }
    }
    while (true) {
      const { done, value } = await readChunk()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2)
        const line = raw.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') { reader.cancel?.().catch(() => {}); return finalize() }
        let obj; try { obj = JSON.parse(payload) } catch { continue }
        const delta = obj.choices?.[0]?.delta
        if (!delta) continue
        if (delta.content) { content += delta.content; onDelta?.(delta.content) }
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
    return finalize()
    } finally { clearTimeout(idleTimer) }
  }
  return { chat, chatStream, model, endpoint }
}
