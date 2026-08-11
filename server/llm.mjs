// OpenAI 兼容 LLM 客户端(第二阶段 agent 用)。管理员配 baseURL + apiKey + model。
// 覆盖 OpenAI / DeepSeek / Qwen / Ollama / vLLM 等(都走 /chat/completions + tool-calling)。
import { fetch as defaultFetch } from 'undici'

export function createLlmClient({ baseURL, apiKey, model, timeoutMs = 60000, fetch = defaultFetch }) {
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
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    if (!res.body) throw new Error('LLM 响应无 body(不支持流式)')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = '', content = '', toolCallsMap = {}
    const finalize = () => {
      const tool_calls = Object.keys(toolCallsMap).sort((a, b) => a - b)
        .map(k => toolCallsMap[k]).filter(t => t.function.name || t.function.arguments)
      return { role: 'assistant', content, ...(tool_calls.length ? { tool_calls } : {}) }
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2)
        const line = raw.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') { reader.cancel?.(); return finalize() }
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
  }
  return { chat, chatStream, model, endpoint }
}
