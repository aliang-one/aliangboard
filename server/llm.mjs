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
  return { chat, model, endpoint }
}
