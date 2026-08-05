// LLM 客户端测试(注入 mock fetch,不发真请求)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createLlmClient } from './llm.mjs'

function mockFetch(response, capture = {}) {
  return async (url, init) => {
    capture.url = url; capture.init = init
    const body = init.body ? JSON.parse(init.body) : {}
    capture.body = body
    if (response.throw) throw new Error(response.throw)
    return { ok: response.ok !== false, status: response.status || 200, text: async () => typeof response.text === 'string' ? response.text : JSON.stringify(response.text) }
  }
}

test('chat: POST /chat/completions + Bearer + model,返回 choices[0].message', async () => {
  const cap = {}
  const c = createLlmClient({ baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat', fetch: mockFetch({ text: { choices: [{ message: { role: 'assistant', content: 'hi' } }] } }, cap) })
  const msg = await c.chat({ messages: [{ role: 'user', content: 'hello' }] })
  assert.equal(msg.content, 'hi')
  assert.equal(cap.url, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(cap.init.headers.authorization, 'Bearer sk-x')
  assert.equal(cap.body.model, 'deepseek-chat')
})

test('chat: 带 tools → body 含 tools + tool_choice=auto', async () => {
  const cap = {}
  const c = createLlmClient({ baseURL: 'http://localhost:11434/v1', model: 'qwen2.5', fetch: mockFetch({ text: { choices: [{ message: {} }] } }, cap) })
  await c.chat({ messages: [], tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] })
  assert.deepEqual(cap.body.tool_choice, 'auto')
  assert.equal(cap.body.tools.length, 1)
  assert.ok(!cap.init.headers.authorization, '无 apiKey 时不发 authorization')
})

test('chat: HTTP 错误 → 抛带 status + message', async () => {
  const c = createLlmClient({ baseURL: 'https://x', apiKey: 'k', model: 'm', fetch: mockFetch({ ok: false, status: 401, text: { error: { message: 'invalid api key' } } }) })
  await assert.rejects(() => c.chat({ messages: [] }), /LLM HTTP 401: invalid api key/)
})

test('chat: 非 JSON 响应 → 抛清晰错误', async () => {
  const c = createLlmClient({ baseURL: 'https://x', model: 'm', fetch: mockFetch({ text: '<html>nginx error</html>' }) })
  await assert.rejects(() => c.chat({ messages: [] }), /非 JSON/)
})
