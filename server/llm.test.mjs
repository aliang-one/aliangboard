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

// mock fetch 返回 SSE 流(ReadableStream)。chunks 是原始 'data: ...\n\n' 字符串。
function mockFetchStream(chunks, capture = {}) {
  return async (url, init) => {
    capture.url = url; capture.init = init
    capture.body = init.body ? JSON.parse(init.body) : {}
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c))
        controller.close()
      }
    })
    return { ok: true, status: 200, body: stream }
  }
}

test('chatStream: content delta 累积 + onDelta 回调 + body.stream=true', async () => {
  const cap = {}
  const deltas = []
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks, cap) })
  const msg = await c.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, { onDelta: t => deltas.push(t) })
  assert.equal(msg.content, '你好')
  assert.deepEqual(deltas, ['你', '好'])
  assert.equal(cap.body.stream, true)
})

test('chatStream: tool_calls 按 index 合并分片(name+arguments 增量)', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"list_resources","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"namespace\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"default\\"}"}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks) })
  const msg = await c.chatStream({ messages: [] })
  assert.equal(msg.tool_calls.length, 1)
  assert.equal(msg.tool_calls[0].id, 'call_1')
  assert.equal(msg.tool_calls[0].function.name, 'list_resources')
  assert.equal(msg.tool_calls[0].function.arguments, '{"namespace":"default"}')
})

test('chatStream: HTTP 错误抛', async () => {
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: async () => ({ ok: false, status: 500, text: async () => 'boom' }) })
  await assert.rejects(() => c.chatStream({ messages: [] }), /LLM HTTP 500/)
})

// I2 回归:chatStream HTTP 错误须像 chat 一样提取 json.error.message,而非抛 raw body。
test('chatStream: HTTP 错误提取 json.error.message(非 raw body)', async () => {
  const c = createLlmClient({
    baseURL: 'http://x/v1', model: 'm',
    fetch: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'Incorrect API key' } }) }),
  })
  await assert.rejects(() => c.chatStream({ messages: [] }), /Incorrect API key/)
})

// ═══ 断流修复:流式空闲超时(每 chunk 重 arm,无总时限) ═══
// 真实 undici 的 body read 会随 fetch signal abort 而拒绝——桩同样竞速 signal
function sseBody(chunks, gapMs, getSignal) {
  const encoder = new TextEncoder()
  let i = 0
  return { getReader() { return { read: () => {
    if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined })
    const c = chunks[i++]
    const sleep = new Promise(r => setTimeout(() => r({ done: false, value: encoder.encode(c) }), gapMs))
    const sig = getSignal?.()
    if (!sig) return sleep
    return Promise.race([sleep, new Promise((_, rej) => sig.addEventListener('abort', () => rej(sig.reason || new Error('aborted'))))])
  }, cancel: async () => {} } } }
}

test('chatStream 空闲超时:总时长超过旧总限但每 chunk 间隔 < idleMs → 不再被总限掐死(旧实现必 abort)', async () => {
  const chunks = ['data: {"choices":[{"delta":{"content":"A"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"B"}}]}\n\n', 'data: [DONE]\n\n']
  let sig1; const fake = async (u, o) => { sig1 = o.signal; return { ok: true, body: sseBody(chunks, 40, () => sig1) } } // 总时长 ~120ms > timeoutMs(60),每段 40ms < idle(80)
  const c = createLlmClient({ baseURL: 'http://x', model: 'm', timeoutMs: 60, idleMs: 80, fetch: fake })
  let got = ''
  const out = await c.chatStream({}, { onDelta: d => { got += d } })
  assert.equal(out.content, 'AB', '长总时长存活,内容完整')
  assert.equal(got, 'AB')
})

test('chatStream 空闲超时:chunk 间隔 > idleMs → 抛 LLM 流式空闲超时', async () => {
  const chunks = ['data: {"choices":[{"delta":{"content":"A"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"B"}}]}\n\n', 'data: [DONE]\n\n']
  let sig2; const fake = async (u, o) => { sig2 = o.signal; return { ok: true, body: sseBody(chunks, 120, () => sig2) } } // 间隔 120 > idle 50
  const c = createLlmClient({ baseURL: 'http://x', model: 'm', timeoutMs: 100000, idleMs: 50, fetch: fake })
  await assert.rejects(c.chatStream({}, {}), /空闲超时|TimeoutError|aborted/)
})
