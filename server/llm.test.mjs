// LLM 客户端测试(注入 mock fetch,不发真请求)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { probeReasoningSupport, createLlmClient } from './llm.mjs'

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

// dev32: 深思考模型 reasoning_content(及 reasoning 别名)增量——累积/回调/返回,此前整段丢弃
test('chatStream: reasoning_content 增量 → onReasoning 回调 + 返回值带 reasoning;content 不混入', async () => {
  const rDeltas = [], cDeltas = []
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"先分析问题"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"再决定查日志"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"结论是"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning":"补充思考"}}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks, {}) })
  const msg = await c.chatStream({}, { onDelta: t => cDeltas.push(t), onReasoning: t => rDeltas.push(t) })
  assert.equal(msg.reasoning, '先分析问题再决定查日志补充思考')
  assert.deepEqual(rDeltas, ['先分析问题', '再决定查日志', '补充思考'])
  assert.equal(msg.content, '结论是')
  assert.deepEqual(cDeltas, ['结论是'], 'content 与 reasoning 互不混入')
})

// dev33: 思考能力探测——reasoning 增量命中/仅 content/总限超时,三态判定
test('probeReasoningSupport: 思考模型(先 reasoning 后 content)→ supported + 采样', async () => {
  const client = {
    chatStream: async (_m, { onReasoning, onDelta }) => {
      onReasoning('Let me compute. ')
      onReasoning('1+1=2.')
      onDelta('2')
      return { role: 'assistant', content: '2', reasoning: 'Let me compute. 1+1=2.' }
    },
  }
  const r = await probeReasoningSupport(client)
  assert.equal(r.supported, true)
  assert.equal(r.sawContent, true)
  assert.equal(r.sample, 'Let me compute. 1+1=2.')
  assert.equal(r.timedOut, false)
})

test('probeReasoningSupport: 非 thinking 模型(仅 content)→ 不支持', async () => {
  const client = { chatStream: async (_m, { onDelta }) => { onDelta('2'); return { role: 'assistant', content: '2' } } }
  const r = await probeReasoningSupport(client)
  assert.equal(r.supported, false)
  assert.equal(r.sawContent, true)
})

test('probeReasoningSupport: 慢模型总限超时 → 按已见字段给结论,不挂死', async () => {
  const client = { chatStream: () => new Promise(() => {}) } // 永不返回
  const r = await probeReasoningSupport(client, { totalMs: 30 })
  assert.equal(r.timedOut, true)
  assert.equal(r.supported, false, '超时未见任何 token → 判不支持(附 timedOut 供 UI 提示)')
})

// 2026-08-25: temperature/maxTokens 透传(空串/undefined 不带,用模型默认)
test('chat: temperature/maxTokens 有值才进 body(空串/undefined 不带)', async () => {
  const ok = { choices: [{ message: { role: 'assistant', content: 'hi' } }] }
  const cap1 = {}
  const c1 = createLlmClient({ baseURL: 'http://x/v1', model: 'm', temperature: 0.2, maxTokens: 4096, fetch: mockFetch({ text: ok }, cap1) })
  await c1.chat({ messages: [] })
  assert.equal(cap1.body.temperature, 0.2)
  assert.equal(cap1.body.max_tokens, 4096)
  const cap2 = {}
  const c2 = createLlmClient({ baseURL: 'http://x/v1', model: 'm', temperature: '', fetch: mockFetch({ text: ok }, cap2) })
  await c2.chat({ messages: [] })
  assert.ok(!('temperature' in cap2.body) && !('max_tokens' in cap2.body), '空串不带')
})
