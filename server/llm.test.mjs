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

// I-审计(2026-08-26):delta.content 无 typeof 守卫(reasoning 有,content 没有——不对称)。
// 多模态代理/畸形 delta 发数组形态 content 时,`content += 数组` 会产生逗号拼接或
// [object Object] 直接进对话+落库。守卫:非字符串形态 JSON.stringify 并入(保内容不产乱串)。
test('chatStream: delta.content 非字符串(多模态数组/对象)→ JSON 串并入,不产生 [object Object]/逗号拼接', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":[{"type":"text","text":"看图"}]}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"结论"}}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks) })
  const msg = await c.chatStream({ messages: [] })
  assert.ok(msg.content.includes('"type":"text"') && msg.content.includes('看图'), '数组形态以 JSON 串保全并入')
  assert.ok(msg.content.endsWith('结论'), '后续正常字符串 delta 照常拼接')
  assert.ok(!msg.content.includes('[object Object]'))
})

test('chatStream: delta.content 空串/null 跳过(不回调 onDelta)', async () => {
  const deltas = []
  const chunks = [
    'data: {"choices":[{"delta":{"content":""}}]}\n\n',
    'data: {"choices":[{"delta":{"content":null}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks) })
  const msg = await c.chatStream({ messages: [] }, { onDelta: t => deltas.push(t) })
  assert.equal(msg.content, 'x')
  assert.deepEqual(deltas, ['x'])
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

// ── finish_reason 透传(2026-09-06「对话尾巴不展示」排查):provider 单响应输出上限掐断
// 生成时此前全链路无人读,静默截断无任何标记。契约:chat/chatStream 把 choices[0].finish_reason
// 以 finishReason 字段随结果返回(缺失则不带该字段)。
test('chat: finish_reason 透传为 finishReason', async () => {
  const c = createLlmClient({ baseURL: 'https://x', model: 'm', fetch: mockFetch({ text: { choices: [{ message: { role: 'assistant', content: '被掐断的回答' }, finish_reason: 'length' }] } }) })
  const msg = await c.chat({ messages: [] })
  assert.equal(msg.content, '被掐断的回答')
  assert.equal(msg.finishReason, 'length')
})

test('chat: 无 finish_reason → 不带 finishReason 字段', async () => {
  const c = createLlmClient({ baseURL: 'https://x', model: 'm', fetch: mockFetch({ text: { choices: [{ message: { role: 'assistant', content: 'hi' } }] } }) })
  const msg = await c.chat({ messages: [] })
  assert.equal('finishReason' in msg, false)
})

test('chatStream: finish_reason 透传为 finishReason', async () => {
  const chunks = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '答案前半' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }) + '\n\n',
    'data: [DONE]\n\n',
  ]
  const c = createLlmClient({ baseURL: 'https://x', model: 'm', fetch: mockFetchStream(chunks) })
  const msg = await c.chatStream({ messages: [] }, {})
  assert.equal(msg.content, '答案前半')
  assert.equal(msg.finishReason, 'length')
})

// ── SSE 行尾 CRLF 兼容(2026-09-06):事件终结符只认 '\n\n' 时,CRLF 风格代理
// (\r\n\r\n 分隔)的流永不切出事件,整流瘫痪(内容恒空、finishReason 恒丢)。
// 契约:事件终结符按 SSE 规范认 CR/LF/CRLF 三种行尾(/\r\n\r\n|\r\r|\n\n/),
// 按 match[0].length 从 buf 切除;事件内部行按三种行尾分割后逐行 trim + data: 处理。
test('chatStream: CRLF 行尾事件流正确解析', async () => {
  const deltas = []
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\r\n\r\n',
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }) + '\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ]
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks) })
  const msg = await c.chatStream({ messages: [] }, { onDelta: t => deltas.push(t) })
  assert.equal(msg.content, '你好')
  assert.equal(deltas.length, 2, 'onDelta 恰好两次,无假事件无丢失')
  assert.deepEqual(deltas, ['你', '好'])
  assert.equal(msg.finishReason, 'length')
})

test('chatStream: \\r\\n 跨 chunk 断裂不产生假事件/不丢事件', async () => {
  const deltas = []
  // 完整流 = 'data:{...甲...}\r\n\r\n data:{...乙...}\r\n\r\n data:[DONE]\r\n\r\n',
  // 把事件终结符的 '\r' 与 '\n\r\n...' 拆进相邻 chunk——拼齐前不得切成"半事件"。
  const chunks = [
    'data: {"choices":[{"delta":{"content":"甲"}}]}\r',
    '\n\r\ndata: {"choices":[{"delta":{"content":"乙"}}]}\r',
    '\n\r\ndata: [DONE]\r\n\r\n',
  ]
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks) })
  const msg = await c.chatStream({ messages: [] }, { onDelta: t => deltas.push(t) })
  assert.deepEqual(deltas, ['甲', '乙'], '断在行尾中间不产出假 delta、拼齐后不丢 delta')
  assert.equal(msg.content, '甲乙')
})

// ── agent-loop-04(2026-09-07 审计):流内 error 事件与空终态不得静默吞 ──
// 旧解析层两条静默路径:JSON 合法但无 delta → continue——上游在流中段发 {"error":...} 事件
// (sub2api/litellm 类代理故障的典型形态)被无声跳过,半截答案照样标 done,用户无从知晓;
// 流结束 content/tool_calls/finishReason 三皆空也照样标 done。契约:前者抛「LLM 流内错误」
// (抛出点在已吐 delta 之后,agent.mjs chatWithRetry 的 sawDelta 谓词据此不重试,上抛交
// workbench-agent 的 salvage 路径保留半截内容并标 failed);后者抛「LLM 返回空响应」。
// 反向守卫:tool_calls 在场(纯工具轮)或 finishReason 在场(正常终止,content 空是模型
// 自由)都不算空,不抛。
test('chatStream: 流内 error 事件(已吐 delta 后)→ 抛「LLM 流内错误」,已吐内容先行送达', async () => {
  const deltas = []
  const chunks = [
    'data: {"choices":[{"delta":{"content":"答案前半"}}]}\n\n',
    'data: {"error":{"message":"upstream provider exploded"}}\n\n',
  ]
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks) })
  await assert.rejects(
    () => c.chatStream({ messages: [] }, { onDelta: t => deltas.push(t) }),
    /LLM 流内错误: upstream provider exploded/,
  )
  assert.deepEqual(deltas, ['答案前半'], '抛错前已吐 delta 全部送达(salvage 半截内容的数据来源)')
})

test('chatStream: 流内 error 无 message 字段 → JSON 串兜底,不抛 "undefined"', async () => {
  const chunks = ['data: {"error":{"code":502,"type":"upstream_error"}}\n\n']
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks) })
  await assert.rejects(() => c.chatStream({ messages: [] }), /LLM 流内错误: \{"code":502/)
})

// 终审修复(2026-09-07 批次二):error 与「空 choices 数组」并存的帧——旧谓词 `!obj.choices`
// 对空数组取 false,故障帧绕过抛错、落回本批刚杀掉的静默吞路径(空数组无 delta 可处理,继续
// 走 delta 处理等于整帧丢弃,半截答案照样标 done)。契约:空 choices 与缺席同形,同样抛。
test('chatStream: 流内 error 且 choices 为空数组 → 同样抛(空数组不豁免)', async () => {
  const deltas = []
  const chunks = [
    'data: {"choices":[{"delta":{"content":"半截"}}]}\n\n',
    'data: {"error":{"message":"provider died mid-stream"},"choices":[]}\n\n',
  ]
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks) })
  await assert.rejects(
    () => c.chatStream({ messages: [] }, { onDelta: t => deltas.push(t) }),
    /LLM 流内错误: provider died mid-stream/,
  )
  assert.deepEqual(deltas, ['半截'], '已吐 delta 照常先行送达(salvage 数据来源)')
})

// 反向边界守卫:error 与非空 choices 并存(个别代理混发正常 delta 附带 error 字段)不拦——
// 防过度收紧把合法帧误杀。
test('chatStream: error 与非空 choices 并存 → 不拦,照常走 delta 处理', async () => {
  const chunks = [
    'data: {"error":{"message":"soft warning"},"choices":[{"delta":{"content":"正常"}}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks) })
  const msg = await c.chatStream({ messages: [] })
  assert.equal(msg.content, '正常', '混发帧的 delta 正常产出,不误抛')
})

test('chatStream: [DONE] 终止但三皆空(无 content/tool_calls/finishReason)→ 抛「LLM 返回空响应」', async () => {
  const chunks = ['data: [DONE]\n\n']
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks) })
  await assert.rejects(() => c.chatStream({ messages: [] }), /LLM 返回空响应/)
})

test('chatStream: 自然断流(无 [DONE])三皆空同样抛「LLM 返回空响应」', async () => {
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream([]) }) // 流立即 close,零事件
  await assert.rejects(() => c.chatStream({ messages: [] }), /LLM 返回空响应/)
})

test('chatStream: 空终态守卫不误伤——纯工具轮(content 空 + tool_calls 在场)不抛', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"list_pods","arguments":"{}"}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks) })
  const msg = await c.chatStream({ messages: [] })
  assert.equal(msg.tool_calls.length, 1, '工具轮正常返回(agent 循环据此排工具队列)')
})

test('chatStream: 空终态守卫不误伤——content 空但 finish_reason 在场(正常终止形态)不抛', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const c = createLlmClient({ baseURL: 'http://x/v1', model: 'm', fetch: mockFetchStream(chunks) })
  const msg = await c.chatStream({ messages: [] })
  assert.equal(msg.finishReason, 'stop', '正常终止照常返回,不因 content 空误判')
})

// ═══ 批次三(agent-loop-05,2026-09-07 审计):chatStream 总时限 + 外部取消 signal ═══
// 旧超时模型只有空闲超时(每 chunk 重 arm)——「永远滴流的长尾流」每 30s 一个 chunk 即可
// 无限续命,失控 run 烧 LLM key 无人管。契约:每次 chatStream 调用一个总限(常量 10 分钟,
// 测试经 createLlmClient 的 streamTotalMs 参数注入短值——刻意无 env 通道),到点 abort 走与
// 空闲超时同一条抛错路径(→ workbench-agent catch → safeSalvage 保留半截内容标 failed);
// 外部 signal(用户取消接线:cancelConversation → AbortController.abort)与内部计时器共用
// 同一 abort 通道,reason 透传(取消语义靠 reason 区分,不以泛型 AbortError 吞掉)。
// 滴流桩:每 gapMs 吐一个 delta、永不 [DONE];maxChunks 耗尽后自抛诊断错——预期行为缺失时
// RED 可见(而非挂死测试进程)。abort 语义镜像真实 undici:read 竞速 fetch signal,以 reason 拒绝。
function dripFetch({ gapMs = 40, maxChunks = 20 } = {}) {
  const encoder = new TextEncoder()
  const state = { sig: null, left: maxChunks, seq: 0 }
  state.fetch = async (u, o) => {
    state.sig = o.signal
    return {
      ok: true, status: 200,
      body: { getReader: () => ({ cancel: async () => {}, read: () => {
        const sig = state.sig
        if (sig.aborted) return Promise.reject(sig.reason || new Error('aborted'))
        return new Promise((resolve, reject) => {
          const onAbort = () => { clearTimeout(t); reject(sig.reason || new Error('aborted')) }
          const t = setTimeout(() => {
            sig.removeEventListener('abort', onAbort)
            if (state.left <= 0) reject(new Error('stub: 滴流耗尽仍未断流(预期行为缺失)'))
            else { state.left--; resolve({ done: false, value: encoder.encode(`data: {"choices":[{"delta":{"content":"滴${state.seq++}"}}]}\n\n`) }) }
          }, gapMs)
          sig.addEventListener('abort', onAbort, { once: true })
        })
      } }) },
    }
  }
  return state
}

test('chatStream 总限: 滴流永不 [DONE](每 chunk 间隔 < idleMs,空闲超时拦不住)→ 到点抛总超时,已吐 delta 先行送达', async () => {
  const drip = dripFetch({ gapMs: 40, maxChunks: 20 })
  const c = createLlmClient({ baseURL: 'http://x', model: 'm', timeoutMs: 100000, idleMs: 100000, streamTotalMs: 200, fetch: drip.fetch })
  const deltas = []
  await assert.rejects(c.chatStream({}, { onDelta: t => deltas.push(t) }), /总超时/)
  assert.ok(deltas.length >= 2, `总限到点前已吐 delta 全部送达(salvage 半截内容的数据来源): ${deltas.length}`)
})

test('chatStream 总限: 总限内正常完成的流不受影响(紧窗不误伤正常长答)', async () => {
  const chunks = ['data: {"choices":[{"delta":{"content":"A"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"B"}}]}\n\n', 'data: [DONE]\n\n']
  let sig; const fake = async (u, o) => { sig = o.signal; return { ok: true, body: sseBody(chunks, 40, () => sig) } }
  const c = createLlmClient({ baseURL: 'http://x', model: 'm', timeoutMs: 100000, idleMs: 100000, streamTotalMs: 500, fetch: fake })
  const out = await c.chatStream({}, {})
  assert.equal(out.content, 'AB', '总限 500ms > 流总时长 ~120ms——正常完成不被掐')
})

test('chatStream 外部 signal(用户取消接线): abort → 在途 read 以 abort reason 拒绝(不静默烧完整轮)', async () => {
  const drip = dripFetch({ gapMs: 40, maxChunks: 20 })
  const c = createLlmClient({ baseURL: 'http://x', model: 'm', timeoutMs: 100000, idleMs: 100000, fetch: drip.fetch })
  const ac = new AbortController()
  const p = c.chatStream({}, { signal: ac.signal })
  setTimeout(() => ac.abort(Object.assign(new Error('用户取消,中止在途 LLM 流'), { name: 'CancelledError' })), 60)
  await assert.rejects(p, /用户取消,中止在途 LLM 流/)
})

// ── 请求边界消毒(salvage-gap 审计 2026-09-08:1214「messages 参数非法」根因)──
// 生产实证:流式 finalize 给 assistant 挂 reasoning/finishReason(agent.mjs 原样回传)、非流式
// {...msg} 直展透传 provider 原生 reasoning_content——智谱系后端严格校验 messages 报 400/1214。
// 契约:发送前消毒为 OpenAI schema 白名单 {role, content, tool_calls?};内部字段(供
// cutByLength/持久化)只在返回值携带,不进请求体。
import { sanitizeMessages } from './llm.mjs'

test('sanitizeMessages: assistant 剥 reasoning/finishReason/reasoning_content,保 content+tool_calls', () => {
  const dirty = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', reasoning: '思考过程...', finishReason: 'tool_calls', reasoning_content: '原生回声', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'assistant', content: '终答', reasoning: 'deep', finishReason: 'stop' },
  ]
  assert.deepEqual(sanitizeMessages(dirty), [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'assistant', content: '终答' },
  ])
})

test('sanitizeMessages: 空 content 且无 tool_calls 的 assistant 剔除(B1:空行是 1214 高危形状)', () => {
  const msgs = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: '', finishReason: 'stop' },
    { role: 'assistant', content: null, reasoning: 'only-thought' },
    { role: 'user', content: '继续' },
  ]
  assert.deepEqual(sanitizeMessages(msgs), [
    { role: 'user', content: 'q1' },
    { role: 'user', content: '继续' },
  ])
})

test('chat: 请求体 messages 经消毒(脏 assistant 不再直传)', async () => {
  const cap = {}
  const c = createLlmClient({ baseURL: 'https://x', model: 'm', fetch: mockFetch({ text: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } }, cap) })
  await c.chat({ messages: [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a1', reasoning: 'r', finishReason: 'stop' },
  ] })
  assert.deepEqual(cap.body.messages, [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a1' },
  ], '请求体不含 reasoning/finishReason')
})

test('chatStream: 请求体 messages 经消毒(resume 回喂 paused 脏数组同样干净)', async () => {
  const cap = {}
  const c = createLlmClient({ baseURL: 'https://x', model: 'm', fetch: mockFetchStream(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', 'data: [DONE]\n\n'], cap) })
  await c.chatStream({ messages: [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: '', reasoning_content: '原生回声', finishReason: 'tool_calls', tool_calls: [{ id: 't1', type: 'function', function: { name: 'n', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'r' },
  ] }, {})
  assert.deepEqual(cap.body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'n', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'r' },
  ], '请求体不含 reasoning_content/finishReason')
})
