# LLM 层硬化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给工作台 AI 的 LLM/Agent 层补齐 5 项(streaming / token 硬截断 / @-ref 漂移修复 / admin 提示词 / tool 结果截断),让 chat 流式输出、长对话不爆上下文、agent 不基于旧资源快照决策、admin 档认得自己的高危工具。

**Architecture:** approach A——5 项各自落在最合适的现有文件,新增 1 个 SSE 端点 + 1 个事件总线小模块(`conv-bus.mjs`),不动其余外部接口。LLM 客户端加流式 `chatStream`;agent 加 `trimMessages` 预算裁剪 + `onDelta`/`refreshSystem` 钩子;`run/resumeConversation` 经 bus 透出事件给 SSE 端点;前端 `EventSource` 替代轮询。

**Tech Stack:** Node `http`(无框架)+ node:sqlite + node:events + 原生 `ReadableStream`/`TextDecoder`(零依赖)。测试:server 用 `node:test` + `node:assert`;前端用 vitest + happy-dom。

## Global Constraints

- **零新增依赖**:`chatStream` 用原生 fetch + `ReadableStream` + `TextDecoder` 解 SSE,不引 SDK / 不引 tiktoken(token 用字符估算)。
- **测试基线**:`npm test`(server,`node --test server/*.test.mjs`)+ `npm run test:unit`(vitest)+ `npm run typecheck`(`node --check`)。每个 task 结束全绿才进下一个。
- **migration 幂等**:加列用 `try { db.exec('ALTER TABLE … ADD COLUMN …') } catch { /* 列已存在 */ }`(先例:`server/auth-keys.mjs:29-30`、`server/audit.mjs:33`)。
- **node:sqlite 绑定**:`updateConversation` 已强制 undefined→null / 对象→JSON(`server/workbench-projects.mjs:67-83`),新增字段沿用,别踩 undefined 绑定坑。
- **worktree**:本计划在 `worktree-feat+llm-layer-hardening` 分支执行,完成后与路由模块化计划(`2026-08-11-index-mjs-route-modularization.md`)无冲突——后者后做,搬的是本计划硬化后的代码。
- **行为逐字节**:除本计划明示的行为变更(streaming/截断/刷新/admin prompt),其余逻辑不动。

## File Structure(目标)

```
server/
  conv-bus.mjs          # 新建:per-convId 事件总线(node:events)
  conv-bus.test.mjs     # 新建:总线单测
  llm.mjs               # 改:+ chatStream(流式 chat)
  llm.test.mjs          # 改:+ chatStream 测试(mock fetch 返回 ReadableStream)
  agent.mjs             # 改:+ trimMessages + clampToolContent + onDelta/refreshSystem 钩子
  agent.test.mjs        # 改:+ trim/截断/onDelta 测试
  agent-runner.mjs      # 改:chat 切到有 onDelta 时用 chatStream
  index.mjs             # 改:fetchRefContext 提取 + references 落库 + run/resume 接 bus + SSE 端点 + admin prompt 分支
  workbench-projects.mjs# 改:conversations 表 + references 列 + createConversation 加参数
src/components/workbench/
  conv-stream.js        # 新建:applyStreamEvent(state, evt) 纯函数(前端事件归约)
  conv-stream.test.js   # 新建:事件归约单测
  WorkbenchChat.vue     # 改:EventSource 替代轮询 + delta 拼接,保留 pollOnce 兜底
```

---

### Task 1: conv-bus 事件总线

**Files:**
- Create: `server/conv-bus.mjs`
- Create: `server/conv-bus.test.mjs`

**Interfaces:**
- Produces: `emit(convId, event)` / `subscribe(convId, fn)` / `unsubscribe(convId, fn)` / `dispose(convId)`。后续 Task 7 的 `run/resumeConversation` 用 `emit`,SSE 端点用 `subscribe`/`unsubscribe`,终结时 `dispose`。

- [ ] **Step 1: 写失败测试** `server/conv-bus.test.mjs`

```javascript
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { emit, subscribe, unsubscribe, dispose } from './conv-bus.mjs'

test('subscribe 收到 emit 的事件', () => {
  const got = []
  const fn = e => got.push(e)
  subscribe('t1', fn)
  emit('t1', { type: 'delta', text: 'a' })
  assert.deepEqual(got, [{ type: 'delta', text: 'a' }])
  unsubscribe('t1', fn)
})

test('unsubscribe 后不再收到', () => {
  const got = []
  const fn = e => got.push(e)
  subscribe('t2', fn)
  unsubscribe('t2', fn)
  emit('t2', { type: 'delta', text: 'b' })
  assert.equal(got.length, 0)
})

test('多订阅者都收到', () => {
  const a = [], b = []
  const fa = e => a.push(e), fb = e => b.push(e)
  subscribe('t3', fa); subscribe('t3', fb)
  emit('t3', { type: 'status' })
  assert.equal(a.length, 1); assert.equal(b.length, 1)
  dispose('t3')
})

test('dispose 清理该 convId 所有监听', () => {
  const got = []
  subscribe('t4', e => got.push(e))
  dispose('t4')
  emit('t4', { type: 'end' })
  assert.equal(got.length, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/conv-bus.test.mjs`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 写实现** `server/conv-bus.mjs`

```javascript
import { EventEmitter } from 'node:events'

// per-convId 事件总线。生产者:run/resumeConversation(detached);消费者:SSE 端点。
// 模块级单例——一个进程内所有对话共享。
const bus = new EventEmitter()
bus.setMaxListeners(100) // 同一 conv 可能多个 SSE 客户端(断线重连期间)

export function emit(convId, event) { bus.emit(convId, event) }
export function subscribe(convId, fn) { bus.on(convId, fn) }
export function unsubscribe(convId, fn) { bus.off(convId, fn) }
export function dispose(convId) { bus.removeAllListeners(convId) }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/conv-bus.test.mjs`
Expected: PASS(4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/conv-bus.mjs server/conv-bus.test.mjs
git commit -m "feat(server): conv-bus 事件总线(per-convId,SSE 用)"
```

---

### Task 2: LLM `chatStream`(流式 chat)

**Files:**
- Modify: `server/llm.mjs`(在 `createLlmClient` 内加 `chatStream`,`return { chat, chatStream, model, endpoint }`)
- Modify: `server/llm.test.mjs`(加流式 mock + 测试)

**Interfaces:**
- Produces: `client.chatStream({ messages, tools, toolChoice }, { onDelta })` → `{ role:'assistant', content, tool_calls? }`(与 `chat` 同结构)。`onDelta(text)` 每个 content 增量回调。Task 4 的 agent-runner 在有 `onDelta` 时切到它。

- [ ] **Step 1: 写失败测试**(追加到 `server/llm.test.mjs`)

```javascript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/llm.test.mjs`
Expected: FAIL(`chatStream is not a function`)

- [ ] **Step 3: 写实现**(在 `server/llm.mjs` 的 `createLlmClient` 内,`chat` 函数之后加 `chatStream`,并加入 return)

```javascript
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/llm.test.mjs`
Expected: PASS(含原有 chat 测试 + 新 3 个)

- [ ] **Step 5: Commit**

```bash
git add server/llm.mjs server/llm.test.mjs
git commit -m "feat(server): LLM chatStream 流式(SSE 解析+tool_calls 合并)"
```

---

### Task 3: token 硬截断(trimMessages + 单条截断)

**Files:**
- Modify: `server/agent.mjs`(加 `trimMessages` / `clampToolContent`;`run` 里 push tool 时 clamp、chat 前 trim)
- Modify: `server/agent.test.mjs`(加测试)

**Interfaces:**
- Produces: 导出 `trimMessages(messages, budget)` → `{ messages, truncated }`;`clampToolContent(content, max=8192)` → `string`。`run` 返回值增加 `truncated: bool`。Task 4 在同一 `run` 里继续加 `onDelta`。

- [ ] **Step 1: 写失败测试**(追加到 `server/agent.test.mjs`,import 行加 `trimMessages, clampToolContent`)

```javascript
import { createAgent, formatToolError, trimMessages, clampToolContent } from './agent.mjs'

test('clampToolContent: 短内容原样返回', () => {
  assert.equal(clampToolContent('hello'), 'hello')
})

test('clampToolContent: 超长内容截断 + 尾标', () => {
  const big = 'x'.repeat(9000)
  const out = clampToolContent(big, 8192)
  assert.ok(out.startsWith('x'.repeat(8192)))
  assert.ok(out.includes('truncated'))
})

test('trimMessages: 预算内不动 + truncated=false', () => {
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }]
  const { messages, truncated } = trimMessages(msgs, 100000)
  assert.equal(messages.length, 2)
  assert.equal(truncated, false)
})

test('trimMessages: 超预算丢最旧 user/tool,保 system + 尾部', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'A'.repeat(20000) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'B'.repeat(20000) },
    { role: 'user', content: 'recent' },
  ]
  const { messages, truncated } = trimMessages(msgs, 10000)
  assert.equal(truncated, true)
  assert.equal(messages[0].role, 'system')              // system 保住
  assert.equal(messages[messages.length - 1].content, 'recent') // 最近保住
  // 丢掉的 tool(c1)对应的 assistant.tool_calls 应被清;若 assistant 无 content 且 tool_calls 空了 → 一并丢
  const orphan = messages.find(m => m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === 'c1'))
  assert.equal(orphan, undefined)
})

test('trimMessages: 丢 tool 时连带清 assistant.tool_calls 的悬空 id', () => {
  const msgs = [
    { role: 'system', content: 's' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'keep', type: 'function', function: { name: 'g', arguments: '{}' } },
      { id: 'drop', type: 'function', function: { name: 'f', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'drop', content: 'X'.repeat(30000) },
    { role: 'tool', tool_call_id: 'keep', content: 'short' },
    { role: 'user', content: 'q' },
  ]
  const { messages } = trimMessages(msgs, 5000)
  const asst = messages.find(m => m.role === 'assistant')
  assert.deepEqual(asst.tool_calls.map(t => t.id), ['keep'])  // drop 被清,keep 留
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/agent.test.mjs`
Expected: FAIL(`trimMessages is not exported`)

- [ ] **Step 3: 写实现**(在 `server/agent.mjs` 顶部常量区 + `createAgent` 之前加导出函数,`run` 内集成)

顶部加常量与函数:
```javascript
const MAX_TOOL_CONTENT_CHARS = 8192
const DEFAULT_BUDGET_CHARS = 60000

export function clampToolContent(content, max = MAX_TOOL_CONTENT_CHARS) {
  const s = typeof content === 'string' ? content : JSON.stringify(content)
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`
}

// 预算裁剪:超 budget 字符时,从最旧的非 system 消息丢起,保留 system + 尾部;
// 丢弃 tool 消息时,连带从对应 assistant.tool_calls 删该 id(若 tool_calls 清空则丢掉该 assistant),防悬空。
export function trimMessages(messages, budget = DEFAULT_BUDGET_CHARS) {
  const total = messages.reduce((n, m) => n + JSON.stringify(m).length, 0)
  if (total <= budget) return { messages, truncated: false }
  const startIdx = messages[0]?.role === 'system' ? 1 : 0
  const kept = messages.slice()
  const droppedToolIds = new Set()
  let cur = total
  for (let i = startIdx; i < kept.length - 1 && cur > budget; i++) {
    const m = kept[i]
    if (m.role === 'system') continue
    cur -= JSON.stringify(m).length
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
  return { messages: out, truncated: true }
}
```

`run` 内集成两处(在现有 `run` 函数体里改):

push tool message 处(原 `messages.push({ role: 'tool', tool_call_id: id, content: typeof result === 'string' ? result : JSON.stringify(result) })`)改为:
```javascript
        messages.push({ role: 'tool', tool_call_id: id, content: clampToolContent(result) })
```

chat 调用前(原 `const assistant = await chat(messages, toolDefs)`)改为:
```javascript
      let truncated = false
      if (messages.length > 1) {
        const t = trimMessages(messages)
        messages = t.messages; truncated = t.truncated
      }
      const assistant = await chat(messages, toolDefs)
      messages.push(assistant)
      onStep?.({ type: 'assistant', message: assistant })
      const toolCalls = assistant.tool_calls || []
      if (!toolCalls.length) return { content: assistant.content, steps, denied, truncated }   // 终答
      queue = [...toolCalls]
      resumeToolCallId = null
```
> 注意:`maxSteps` 截断的 return 已带 `truncated: true`,无需改。中间轮的 `truncated` 只在终答时透出(够用——前端只关心最终是否精简过)。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/agent.test.mjs`
Expected: PASS(含原有 + 新 5 个)

- [ ] **Step 5: Commit**

```bash
git add server/agent.mjs server/agent.test.mjs
git commit -m "feat(server): token 硬截断(单条 tool 8192 字符 + 整体预算 trimMessages)"
```

---

### Task 4: agent 透传 `onDelta` + runner 切 chatStream

**Files:**
- Modify: `server/agent.mjs`(`run` 加 `onDelta` 参数 + chat 调用传 `{ onDelta }`)
- Modify: `server/agent.test.mjs`(加测试)
- Modify: `server/agent-runner.mjs`(chat 切流式)

**Interfaces:**
- Produces: `run({ system, history, onStep, onDelta, resume })`;agent 把 `chat(messages, toolDefs, { onDelta })` 透传给 runner 提供的 chat。Task 7 在 `run/resumeConversation` 传 `onDelta: text => emit(convId, {type:'delta', text})`。

- [ ] **Step 1: 写失败测试**(追加到 `server/agent.test.mjs`)

```javascript
test('agent 把 onDelta 透传给 chat 的第三参 opts.onDelta', async () => {
  let captured
  const chat = async (messages, tools, opts) => { captured = opts?.onDelta; return final('done') }
  const deltas = []
  const run = createAgent({ chat, execTool: async () => '' }).run
  await run({ system: 's', history: [{ role: 'user', content: 'x' }], onDelta: t => deltas.push(t) })
  assert.equal(typeof captured, 'function')
  captured('你'); captured('好')
  assert.deepEqual(deltas, ['你', '好'])
})

test('agent 无 onDelta 时,chat 第三参为 undefined(回退非流式)', async () => {
  let captured
  const chat = async (messages, tools, opts) => { captured = opts; return final('done') }
  const run = createAgent({ chat, execTool: async () => '' }).run
  await run({ system: 's', history: [{ role: 'user', content: 'x' }] })
  assert.deepEqual(captured, {})
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/agent.test.mjs`
Expected: FAIL(chat 收到的 opts 不对)

- [ ] **Step 3: 写实现**

`server/agent.mjs` `run` 函数签名(原 `async function run({ system, history = [], onStep, resume } = {})`)改为:
```javascript
  async function run({ system, history = [], onStep, onDelta, resume } = {}) {
```
chat 调用(上 Task 改过的 `const assistant = await chat(messages, toolDefs)`)改为:
```javascript
      const assistant = await chat(messages, toolDefs, { onDelta })
```

`server/agent-runner.mjs`(原 `const chat = (messages, tools) => llmClient.chat({ messages, tools })`)改为:
```javascript
  const chat = (messages, tools, opts) =>
    opts?.onDelta ? llmClient.chatStream({ messages, tools }, { onDelta: opts.onDelta })
                  : llmClient.chat({ messages, tools })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/agent.test.mjs && node --test server/agent-runner.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/agent.mjs server/agent.test.mjs server/agent-runner.mjs
git commit -m "feat(server): agent 透传 onDelta,runner 有 onDelta 时切 chatStream"
```

---

### Task 5: @-ref 漂移修复(references 落库 + 每轮刷新)

**Files:**
- Modify: `server/workbench-projects.mjs`(`createConversationsSchema` 后加 migration;`createConversation` 加 `references` 参数 + INSERT 列)
- Modify: `server/index.mjs`(提取 `KIND_API_PATH` + `fetchRefContext`;POST 端点 system 不含 ref、存 references;`run/resumeConversation` 传 `refreshSystem`)
- Modify: `server/agent.mjs`(`run` 加 `refreshSystem` 钩子,每轮 chat 前重置 messages[0])
- Test: `server/workbench-repos.test.mjs`(现有)加 references 用例;`server/agent.test.mjs` 加 refreshSystem 用例

**Interfaces:**
- Consumes: Task 3 的 `trimMessages`(refreshSystem 在 trim 之后调,保证刷新后的 system 已含最新 ref、且不被 trim 当旧消息丢——system 是 messages[0],trim 永远保)。
- Produces: `fetchRefContext(references, k8sSession)` → `string`(`''` 表示无 ref)。`createConversation(db, { projectId, system, userMessage, references })`。

- [ ] **Step 1: 写失败测试**

`server/agent.test.mjs` 追加:
```javascript
test('agent 每轮 chat 前调 refreshSystem() 重置 messages[0]', async () => {
  const calls = []
  const chat = async (messages) => { calls.push(messages[0].content); return calls.length === 1 ? toolCall('c1', 'f', {}) : final('done') }
  let n = 0
  const refreshSystem = async () => `sys@${++n}`
  const run = createAgent({ chat, execTool: async () => 'r' }).run
  await run({ system: 'sys@0', history: [{ role: 'user', content: 'q' }], refreshSystem })
  assert.deepEqual(calls, ['sys@1', 'sys@2'])  // 两轮 chat,每轮都刷新
})
```

`server/workbench-repos.test.mjs`(确认现有 import 了 `createConversation`,照其风格)追加 references 落库用例:
```javascript
test('createConversation 落库 references(JSON)', () => {
  // 复用现有测试里的 db fixture(看文件顶部怎么建 in-memory db)
  const conv = createConversation(db, { projectId: 'p1', system: 's', userMessage: 'hi', references: [{ kind: 'pods', namespace: 'default', name: 'nginx' }] })
  const row = getConversation(db, conv.id)
  assert.deepEqual(JSON.parse(row.references), [{ kind: 'pods', namespace: 'default', name: 'nginx' }])
})
```
> 若现有 fixture 的 db 未加 references 列,先在 fixture 的 schema 调用后补一句 `try { db.exec('ALTER TABLE workbench_conversations ADD COLUMN references TEXT') } catch {}` 或直接调 `createConversationsSchema(db)`(它本 task 会加 migration)。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/agent.test.mjs && node --test server/workbench-repos.test.mjs`
Expected: FAIL

- [ ] **Step 3a: workbench-projects.mjs 加 migration + createConversation**

`createConversationsSchema` 函数末尾(`CREATE INDEX` 之后)加:
```javascript
  try { db.exec('ALTER TABLE workbench_conversations ADD COLUMN references TEXT') } catch { /* 列已存在 */ }
```
`createConversation` 改为(加 references 参数 + INSERT 列):
```javascript
export function createConversation(db, { projectId, system, userMessage, references }) {
  if (!projectId || !userMessage) throw new Error('createConversation 缺 projectId / userMessage')
  const id = randomUUID(); const ts = Date.now()
  db.prepare(`INSERT INTO workbench_conversations
    (id,projectId,status,system,userMessage,references,steps,trace,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, projectId, 'running', system ?? '', userMessage, JSON.stringify(references || []), 0, '[]', ts, ts)
  return getConversation(db, id)
}
```

- [ ] **Step 3b: index.mjs 提取 fetchRefContext + KIND_API_PATH**

在 `index.mjs` 顶部辅助函数区(和其它 helper 一起)加:
```javascript
const KIND_API_PATH = {
  pods: (ns, name) => `/api/v1/namespaces/${ns}/pods/${name}`,
  services: (ns, name) => `/api/v1/namespaces/${ns}/services/${name}`,
  configmaps: (ns, name) => `/api/v1/namespaces/${ns}/configmaps/${name}`,
  secrets: (ns, name) => `/api/v1/namespaces/${ns}/secrets/${name}`,
  deployments: (ns, name) => `/apis/apps/v1/namespaces/${ns}/deployments/${name}`,
  statefulsets: (ns, name) => `/apis/apps/v1/namespaces/${ns}/statefulsets/${name}`,
  daemonsets: (ns, name) => `/apis/apps/v1/namespaces/${ns}/daemonsets/${name}`,
  ingresses: (ns, name) => `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses/${name}`,
  namespaces: (_ns, name) => `/api/v1/namespaces/${name}`,
}
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms))])
}
// 并发 fetch 所有 references 的最新资源,拼成 refContext 块。单个 5s 超时;失败/404 → 标 not found(漂移感知)。
async function fetchRefContext(references, k8sSession) {
  if (!Array.isArray(references) || !references.length || !k8sSession) return ''
  const tasks = references.map(async ref => {
    const pathFn = KIND_API_PATH[ref.kind]
    const label = `[${ref.kind}/${ref.namespace || ''}/${ref.name}]`
    if (!pathFn) return `${label}: (不支持的 kind)`
    try {
      const res = await withTimeout(requestKubernetes(k8sSession, pathFn(ref.namespace || '', ref.name)), 5000, `ref ${ref.kind}/${ref.name}`)
      return `${label}:\n${JSON.stringify(res.body, null, 2)}`
    } catch (e) { return `${label}: (not found / 已删除)` }
  })
  const blocks = await Promise.all(tasks)
  return `\n\nReferenced resources (当前状态,供你参考):\n${blocks.join('\n\n')}`
}
```

POST 端点(`index.mjs:1093-1143`):**删掉**端点内局部 `KIND_API_PATH` 定义和内联 fetch 循环;system 不再拼 refContext;改为调 `fetchRefContext` 拿首屏 ref 给前端 + 存 references:
```javascript
    const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(project.clusterId)
    const k8sSession = cluster ? { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now() } : null
    const refContext = await fetchRefContext(input.references, k8sSession)
    const fetchedResources = []   // 首屏给前端的资源卡(从 refContext 之外另 fetch 一次供 ResourceCard;若想复用可解析 refContext,这里保持原行为最小改动)
    if (Array.isArray(input.references) && input.references.length && k8sSession) {
      for (const ref of input.references) {
        const pathFn = KIND_API_PATH[ref.kind]
        if (!pathFn) continue
        try { const r = await withTimeout(requestKubernetes(k8sSession, pathFn(ref.namespace || '', ref.name)), 5000, ''); fetchedResources.push(r.body) } catch { /* not found,前端不显示 */ }
      }
    }
    const system = '你是 aliangboard 工作台助手。流程:read_ledger …(原文不变,不含 refContext)'   // ⚠️ 把现有那段工作台 prompt 原文保留,仅去掉末尾 `+ refContext`
    const conv = createConversation(db, { projectId: input.projectId, system, userMessage: String(input.message), references: input.references })
    runConversation(conv.id, llmClient, k8sSession)
    return sendJson(res, 200, { id: conv.id, status: 'running', references: fetchedResources })
```
> 注意:`runConversation` 现在多收一个 `k8sSession` 参数(下一步用它刷新 ref)。

- [ ] **Step 3c: run/resumeConversation 传 refreshSystem + k8sSession**

`runConversation`(`index.mjs:1048-1065`)改为:
```javascript
async function runConversation(convId, llmClient, k8sSession) {
  try {
    const conv = getConversation(db, convId); if (!conv) return
    const project = getProject(db, conv.projectId)
    if (!project) { updateConversation(db, convId, { status: 'failed', error: '项目不存在' }); return }
    const { ctx } = buildWbCtx(project)
    const { run } = createAgentRunner({ llmClient, workbench: ctx })
    let refs = []; try { refs = JSON.parse(conv.references || '[]') } catch { refs = [] }
    const refreshSystem = async () => conv.system + await fetchRefContext(refs, k8sSession)
    const out = await run({
      system: conv.system,
      history: [{ role: 'user', content: conv.userMessage }],
      refreshSystem,
      onStep: e => appendTrace(db, convId, e),
    })
    handleAgentResult(convId, project, out)
  } catch (err) {
    updateConversation(db, convId, { status: 'failed', error: err.message })
  }
}
```
`resumeConversation`(`index.mjs:1068-1090`):同样从 conv 重建 cluster/k8sSession + refs + refreshSystem,传给 `run`。在 `const { ctx } = buildWbCtx(project)` 之后加:
```javascript
    const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(project.clusterId)
    const k8sSession = cluster ? { ...buildCallContext({ /* 同 POST 端点那 6 字段 */ }), createdAt: Date.now() } : null
    let refs = []; try { refs = JSON.parse(conv.references || '[]') } catch { refs = [] }
    const refreshSystem = async () => conv.system + await fetchRefContext(refs, k8sSession)
```
并在 `run({ resume: {...}, onStep, refreshSystem })` 加 `refreshSystem`。
> 提取一个 `buildK8sSession(clusterId)` 小函数避免 POST/resume 重复那 6 字段——可选优化,plan 不强制。

`server/agent.mjs` `run` 加 `refreshSystem` 参数 + 每轮 chat 前(trim 之后、chat 之前)调用:
签名加参数:`async function run({ system, history = [], onStep, onDelta, refreshSystem, resume } = {})`
trim 之后、`chat` 之前加:
```javascript
      if (refreshSystem && messages[0]?.role === 'system') {
        messages[0] = { role: 'system', content: await refreshSystem() }
      }
```

approve/deny 端点(`index.mjs:1168-1191`):`resumeConversation(id, true/false, llmClient)` 调用要补 k8sSession——改签名为 `resumeConversation(id, approved, llmClient)` 内部自己按 conv.projectId 重建 k8sSession(上面的 Step 3c 已在 resume 内部重建,所以 approve/deny 端点的调用签名不变,仍是 `resumeConversation(id, true, llmClient)`)。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/agent.test.mjs && node --test server/workbench-repos.test.mjs && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/workbench-projects.mjs server/index.mjs server/agent.mjs server/agent.test.mjs server/workbench-repos.test.mjs
git commit -m "fix(server): @-ref 每轮刷新修漂移(references 落库+refreshSystem 钩子)"
```

---

### Task 6: admin 档提示词

**Files:**
- Modify: `server/index.mjs`(K8s system prompt 按 tier 三分支)

**Interfaces:**
- Produces: `k8sSystemPrompt(tier)` → `string`(read / operator / admin)。提取成函数便于单测。

- [ ] **Step 1: 定位现有 K8s prompt 构造点**

Run: `grep -n "你是 aliangboard 集群" server/index.mjs`
Expected: 命中 2 行(read 档、operator 档),在 K8s agent 调用端点(`/api/key/*` 或 agent runner 构造处)附近。记下行号。

- [ ] **Step 2: 写失败测试**(新建 `server/k8s-prompt.test.mjs`)

```javascript
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { k8sSystemPrompt } from './index.mjs'

test('read 档:只读诊断,不含高危工具', () => {
  const p = k8sSystemPrompt('read')
  assert.ok(p.includes('debug 助手'))
  assert.ok(!p.includes('exec_pod'))
  assert.ok(!p.includes('delete_resource'))
})

test('operator 档:含 scale/restart,不含 admin 高危工具', () => {
  const p = k8sSystemPrompt('operator')
  assert.ok(p.includes('scale') || p.includes('restart'))
  assert.ok(!p.includes('exec_pod'))
})

test('admin 档:教 5 个高危工具 + 谨慎原则', () => {
  const p = k8sSystemPrompt('admin')
  for (const t of ['exec_pod', 'kubectl_debug', 'update_image', 'rollout_undo', 'delete_resource']) {
    assert.ok(p.includes(t), `admin prompt 应提及 ${t}`)
  }
  assert.ok(p.includes('仅在用户明确要求') || p.includes('最小代价'))
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test server/k8s-prompt.test.mjs`
Expected: FAIL(`k8sSystemPrompt` 未导出 / index.mjs 不可直接 import)

> 若 `index.mjs` 不可作为模块 import(它在启动时 side-effect),把 `k8sSystemPrompt` 提取到 `server/k8s-prompt.mjs`,index.mjs 从那 import;测试 import `./k8s-prompt.mjs`。

- [ ] **Step 4: 写实现**

新建 `server/k8s-prompt.mjs`:
```javascript
const READ_PROMPT = '你是 aliangboard 集群 debug 助手。用提供的工具(list_resources/get_resource/get_pod_logs/get_events)调查用户的问题,给出简洁诊断。你只能读,不能改资源。'
const OPERATOR_PROMPT = '你是 aliangboard 集群 debug/运维 助手。先用只读工具(list_resources/get_resource/get_pod_logs/get_events)调查问题。需要扩缩容(scale)或滚动重启(restart)时直接调用——平台会弹出审批,用户批准后才执行,被拒会告知你。'
const ADMIN_PROMPT = '你是 aliangboard 集群高级运维助手。先用只读工具(list_resources/get_resource/get_pod_logs/get_events/can_i/rollout_history)调查问题。除扩缩容(scale)、滚动重启(restart)外,你还有高风险工具:exec_pod(进容器执行)、kubectl_debug(注入临时容器排查)、update_image(更新镜像)、rollout_undo(回滚到历史 revision)、delete_resource(删除资源)。这些工具破坏性大,仅在用户明确要求或诊断确有必要时使用,调用前用简短一句话说明意图。所有写操作都会弹审批,被拒会告知你。优先用只读手段定位根因,改动从最小代价开始。'

export function k8sSystemPrompt(tier) {
  if (tier === 'admin') return ADMIN_PROMPT
  if (tier === 'operator') return OPERATOR_PROMPT
  return READ_PROMPT
}
```
`index.mjs` 顶部 `import { k8sSystemPrompt } from './k8s-prompt.mjs'`,把 Step 1 grep 到的两处内联 prompt 替换为 `k8sSystemPrompt(keyRow.tier)`(原 read/operator 分支通常已是 tier 判断,现在统一一个函数调用)。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test server/k8s-prompt.test.mjs && npm run typecheck`
Expected: PASS

- [ ] **Step 5b: 确认未破坏现有 K8s agent 路径**(若 `server/api-key-tools.test.mjs` / `mcp.test.mjs` 里有断言 prompt 文本,grep 确认或更新)

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/k8s-prompt.mjs server/k8s-prompt.test.mjs server/index.mjs
git commit -m "feat(server): admin 档提示词(tier 三分支,教 5 个高危工具)"
```

---

### Task 7: run/resumeConversation 接 bus + SSE 端点

**Files:**
- Modify: `server/index.mjs`(`run/resumeConversation` emit 事件;新增 `GET /api/workbench/conversations/:id/stream`)

**Interfaces:**
- Consumes: Task 1 的 `emit/subscribe/unsubscribe/dispose`、Task 4 的 `onDelta`、Task 5 的 `refreshSystem`。
- Produces: SSE 端点推 `hello | status | step | delta | approval | end` 事件(见 spec §4.1.4)。Task 8 前端消费。

- [ ] **Step 1: 在 `index.mjs` 顶部 import bus**

```javascript
import { emit as busEmit, subscribe as busSubscribe, unsubscribe as busUnsubscribe, dispose as busDispose } from './conv-bus.mjs'
```

- [ ] **Step 2: 改 `runConversation` / `resumeConversation` 透出事件 + 终结清理**

在 Task 5 改过的 `runConversation` 基础上,把 `onStep` / 新增 `onDelta` / 状态变更都 emit,并加终结清理。替换函数体:
```javascript
async function runConversation(convId, llmClient, k8sSession) {
  try {
    const conv = getConversation(db, convId); if (!conv) return
    const project = getConversationProject(conv)   // 见下:抽出的 project 获取 + not-found 处理
    if (!project) { updateConversation(db, convId, { status: 'failed', error: '项目不存在' }); busEmit(convId, { type:'status', status:'failed', error:'项目不存在' }); busEmit(convId, { type:'end' }); busDispose(convId); return }
    busEmit(convId, { type: 'status', status: 'running' })
    const { ctx } = buildWbCtx(project)
    const { run } = createAgentRunner({ llmClient, workbench: ctx })
    let refs = []; try { refs = JSON.parse(conv.references || '[]') } catch { refs = [] }
    const refreshSystem = async () => conv.system + await fetchRefContext(refs, k8sSession)
    const out = await run({
      system: conv.system,
      history: [{ role: 'user', content: conv.userMessage }],
      refreshSystem,
      onDelta: text => busEmit(convId, { type: 'delta', text }),
      onStep: e => { appendTrace(db, convId, e); busEmit(convId, { type: 'step', step: e }) },
    })
    handleAgentResult(convId, project, out)
    finalizeConvEmit(convId, out)
  } catch (err) {
    updateConversation(db, convId, { status: 'failed', error: err.message })
    busEmit(convId, { type: 'status', status: 'failed', error: err.message })
    busEmit(convId, { type: 'end' }); busDispose(convId)
  }
}
function finalizeConvEmit(convId, out) {
  if (out.status === 'pending_approval') {
    busEmit(convId, { type: 'approval', pending: out.pending })
    busEmit(convId, { type: 'status', status: 'paused' })
    busEmit(convId, { type: 'end' })     // paused 也关 SSE(前端 approve 后重连);bus 不 dispose(resume 续用)
  } else {
    busEmit(convId, { type: 'status', status: 'done' })
    busEmit(convId, { type: 'end' })
    busDispose(convId)                    // done 才清理
  }
}
```
`resumeConversation` 同样:`busEmit(convId,{type:'status',status:'running'})` 开头、`onDelta`/`onStep` 同上、结尾 `finalizeConvEmit(convId, out)`、catch 同上。把 `getConversationProject(conv)` 内联为原 `getProject(db, conv.projectId)`(这里只是为了示例简洁才命名;实现时直接用原逻辑)。

- [ ] **Step 3: 加 SSE 端点**(放在 `GET /:id` 端点之后,`index.mjs:1157` 附近)

```javascript
// GET /api/workbench/conversations/:id/stream — SSE 实时事件流
if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/stream$/) && req.method === 'GET') {
  const ps = requireAdmin(req, res); if (!ps) return
  const id = url.pathname.split('/')[4]
  const conv = getConversation(db, id)
  if (!conv) return sendJson(res, 404, { message: '对话不存在' })
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const send = (evt) => { try { res.write('data: ' + JSON.stringify(evt) + '\n\n') } catch { /* 客户端已断 */ } }
  send({ type: 'hello', convId: id, status: conv.status })
  if (conv.status === 'done' || conv.status === 'failed') {
    send({ type: 'status', status: conv.status, ...(conv.error ? { error: conv.error } : {}) })
    send({ type: 'end' }); res.end(); return
  }
  busSubscribe(id, send)
  const keepalive = setInterval(() => { try { res.write(': keepalive\n\n') } catch {} }, 15000)
  req.on('close', () => { clearInterval(keepalive); busUnsubscribe(id, send) })
}
```

- [ ] **Step 4: 测试**(integration:起 server + 注入 fake LLM + 订阅 bus 断言事件序列)

先确认现有 server 测试的 server 启动模式:Run `grep -rn "createServer\|listen\|http.createServer" server/*.test.mjs | head`
若现有 `server/static.test.mjs` 或 `mcp.test.mjs` 有 `startServer()` helper,复用它;否则在本测试内内联 `const server = http.createServer(...)`:看 `index.mjs` 是否 export 了 handler 或 createServer。若 index.mjs 未 export,在本 task 顺手 export 一个 `createAliangboardServer({db, ...})` 或直接 export 请求处理函数供测试注入 fake LLM。

> 实现者注意:若起完整 server 过重,**最小可行测**是把 `runConversation` 改造为可注入 `createAgentRunner` 的工厂,或直接测 `finalizeConvEmit`(它纯函数):
```javascript
// server/conv-emit.test.mjs(若 finalizeConvEmit 导出)
test('finalizeConvEmit: pending_approval → approval+paused+end, 不 dispose', () => {
  const events = []
  // 临时 subscribe 一个 convId,调 finalizeConvEmit,断言 events
  // 注:bus 是模块单例,测试用唯一 convId
})
```
SSE 的 HTTP 层(writeHead/write/keepalive/req close)作为手测验证(见 Step 5)。

- [ ] **Step 5: 跑测试 + 手测**

Run: `npm test`
手测(配好 LLM 后):启动网关 → 前端先用 curl 验证 SSE:
```bash
# 假设已有 platform token 和一个 conv id
curl -N -H "x-platform-token: <token>" http://localhost:3000/api/workbench/conversations/<id>/stream
# 期望:先 data: {"type":"hello",...};run 开始后 data: {"type":"delta","text":"..."} 逐字;终结 data: {"type":"end"}
```
Expected: 收到 hello + delta 序列 + end;15s 内有 `: keepalive`。

- [ ] **Step 6: Commit**

```bash
git add server/index.mjs server/conv-emit.test.mjs
git commit -m "feat(server): run/resume 接 bus + GET /conversations/:id/stream SSE 端点"
```

---

### Task 8: 前端 streaming(EventSource + delta 拼接)

**Files:**
- Create: `src/components/workbench/conv-stream.js`(纯事件归约)
- Create: `src/components/workbench/__tests__/conv-stream.test.js`
- Modify: `src/components/workbench/WorkbenchChat.vue`(用 EventSource,保留 pollOnce 兜底)

**Interfaces:**
- Produces: `applyStreamEvent(state, evt)` → `state'`(归约 chat 状态:content/trace/status/pendingApproval)。`WorkbenchChat.vue` 的 `streamConv(id)` 用 EventSource 收事件 → 调 `applyStreamEvent`。

- [ ] **Step 1: 写失败测试** `src/components/workbench/__tests__/conv-stream.test.js`

```javascript
import { test, expect } from 'vitest'
import { applyStreamEvent } from '../conv-stream'

const fresh = () => ({ status: 'thinking', content: '', trace: [], steps: 0, denied: [], truncated: false, pendingApproval: null, error: '' })

test('hello 事件:对齐 status', () => {
  const s = applyStreamEvent(fresh(), { type: 'hello', status: 'running' })
  expect(s.status).toBe('thinking')
})

test('delta 事件:拼接到 content', () => {
  let s = fresh()
  s = applyStreamEvent(s, { type: 'delta', text: '你' })
  s = applyStreamEvent(s, { type: 'delta', text: '好' })
  expect(s.content).toBe('你好')
})

test('step(tool)事件:追加 trace', () => {
  let s = fresh()
  s = applyStreamEvent(s, { type: 'step', step: { type: 'tool', name: 'list_resources', args: {}, result: 'x' } })
  expect(s.trace).toHaveLength(1)
  expect(s.trace[0].name).toBe('list_resources')
})

test('approval 事件:置 pendingApproval', () => {
  const s = applyStreamEvent(fresh(), { type: 'approval', pending: { toolCallId: 'c1', name: 'scale', args: {} } })
  expect(s.pendingApproval.name).toBe('scale')
})

test('status=done 事件:置 done', () => {
  const s = applyStreamEvent(fresh(), { type: 'status', status: 'done' })
  expect(s.status).toBe('done')
})

test('status=failed 带 error', () => {
  const s = applyStreamEvent(fresh(), { type: 'status', status: 'failed', error: 'boom' })
  expect(s.status).toBe('error')
  expect(s.error).toBe('boom')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/workbench/__tests__/conv-stream.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 写实现** `src/components/workbench/conv-stream.js`

```javascript
// 把 SSE 事件归约成 chat turn 状态。纯函数,无副作用,便于测试。
export function applyStreamEvent(state, evt) {
  if (!evt || typeof evt !== 'object') return state
  switch (evt.type) {
    case 'hello':
      return { ...state, status: evt.status === 'done' ? 'done' : evt.status === 'failed' ? 'error' : 'thinking' }
    case 'delta':
      return { ...state, content: (state.content || '') + (evt.text || '') }
    case 'step':
      return { ...state, trace: [...state.trace, evt.step] }
    case 'approval':
      return { ...state, pendingApproval: evt.pending, status: 'pending_approval' }
    case 'status': {
      if (evt.status === 'done') return { ...state, status: 'done' }
      if (evt.status === 'paused') return { ...state, status: 'pending_approval' }
      if (evt.status === 'failed') return { ...state, status: 'error', error: evt.error || '' }
      if (evt.status === 'running') return { ...state, status: 'thinking' }
      return state
    }
    case 'end':
      return state   // 连接终结,不改状态(由 status 决定终态)
    default:
      return state
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/workbench/__tests__/conv-stream.test.js`
Expected: PASS

- [ ] **Step 5: WorkbenchChat.vue 接 EventSource**

在 `WorkbenchChat.vue` 的 `<script setup>` 里(import `applyStreamEvent` from `./conv-stream`),在 `startPolling` 旁边加 `startStreaming`:
```javascript
import { applyStreamEvent } from './conv-stream'

let es = null
function stopStreaming() { if (es) { es.close(); es = null } }
function startStreaming(id) {
  stopStreaming()
  const token = localStorage.getItem('platform_token') || ''   // 按现有鉴权存储调整(看 workbenchApi 怎么带 token)
  const url = `/api/workbench/conversations/${id}/stream`
  // EventSource 不支持自定义 header;若平台用 x-platform-token,改用 query 或 cookie。见下方说明。
  es = new EventSource(url)
  es.onmessage = (ev) => {
    const evt = JSON.parse(ev.data)
    const agentTurn = turns.value.find(x => x.role === 'assistant')
    if (!agentTurn) return
    const next = applyStreamEvent({
      status: agentTurn.status, content: agentTurn.content, trace: agentTurn.trace || [],
      steps: agentTurn.steps, denied: agentTurn.denied || [], truncated: !!agentTurn.truncated,
      pendingApproval: pendingApproval.value, error: agentTurn.error || '',
    }, evt)
    updateTurn(agentTurn._id, next)
    if (evt.type === 'approval' && evt.pending) {
      pendingApproval.value = { turnId: agentTurn._id, toolCallId: evt.pending.toolCallId, name: evt.pending.name, args: evt.pending.args }
    }
    if (evt.type === 'status' && (evt.status === 'done' || evt.status === 'failed')) {
      stopStreaming(); sending.value = false; scrollToBottom()
    }
    if (evt.type === 'end' && (agentTurn.status === 'done' || agentTurn.status === 'pending_approval' || agentTurn.status === 'error')) {
      stopStreaming(); sending.value = false
    }
  }
  es.onerror = () => {
    // EventSource 会自动重连;若已终结则关闭,否则降级轮询一次对齐
    if (agentTurnDoneOrFinal()) stopStreaming()
  }
}
```
**鉴权说明**:`EventSource` 不能加自定义 header。平台现在用 `x-platform-token` header。两个解法二选一(实现者选):
1. SSE 端点额外接受 `?token=<platform_token>` query(在 `requireAdmin` 里:header 缺失时回退 query)。
2. 平台改用 cookie 鉴权(EventSource 自动带 cookie)。
**推荐 1**(改动最小):`requirePlatform` 里 `const token = req.headers['x-platform-token'] || new URL(req.url, 'http://x').searchParams.get('token')`。本 task 在 `index.mjs` 的 `requirePlatform` 加 query 回退 + 测试。
把现有触发 `startPolling(id)` 的调用点(发消息后、approve 后)改为 `startStreaming(id)`,保留 `pollOnce` 作 `es.onerror` 降级兜底(断线时 `pollOnce(id)` 对齐一次)。

- [ ] **Step 6: 鉴权 query 回退测试**(若选方案 1)

`server/` 加一个 requirePlatform query 回退用例(或在现有 auth 测试里加),断言 `?token=` 能通过 `requireAdmin`。

- [ ] **Step 7: 跑测试 + 手测**

Run: `npm run test:unit && npm run typecheck`
手测:发消息看逐字流式 + tool 卡片穿插;approve 后续流;断网重连对齐。

- [ ] **Step 8: Commit**

```bash
git add src/components/workbench/conv-stream.js src/components/workbench/__tests__/conv-stream.test.js src/components/workbench/WorkbenchChat.vue server/index.mjs
git commit -m "feat(workbench): chat 流式输出(EventSource+delta 拼接,轮询降级兜底)"
```

---

### Task 9: 全量门禁 + 端到端手测

**Files:** 无(验证 task)

- [ ] **Step 1: 全量门禁**

Run: `npm run i18n:check && npm run typecheck && npm test && npm run test:unit && npm run build`
Expected: 全绿。
> 注:`src/views/__tests__/_allViewsMount.test.js > mount AuditLogs.vue` 是 pre-existing 环境依赖失败(挂载时连 :443、测试环境无网关),与本工作无关,不阻断。若其余测试红,修到绿。

- [ ] **Step 2: 端到端手测(配好 LLM)**

逐项验:
1. 工作台发消息 → 看到逐字流式(delta)+ tool 卡片穿插(step)+ 终结(end)。
2. 刷几十次大日志(让 agent 连续调 `get_pod_logs tail=10000`)→ 不爆窗口,终答带"已精简早期上下文"或行为正常(truncated)。
3. `@pod:nginx` 发消息 → 改这个 pod(如重启)→ 再追问 → agent 用上新状态(refreshSystem 生效,不是旧快照)。
4. 用 admin tier 的 API key 发 K8s 消息 → agent 认得 `exec_pod/delete_resource` 等(用上 admin prompt)。
5. 写操作弹审批 → approve → 流式续跑 → done。
6. 断网/刷新页面 → SSE 重连,GET /:id 对齐后继续。

- [ ] **Step 3: 更新 spec 完成标志 + 收尾 commit**

```bash
git commit --allow-empty -m "chore: LLM 层硬化 5 项完成,全量门禁绿+端到端通过"
```

---

## 风险与对策(实施期)

| 风险 | 对策 |
|---|---|
| `chatStream` tool_calls 合并写错 → agent 收残缺 tool_call | Task 2 测试覆盖 index 合并 + arguments 增量;手测一次含工具调用的流式对话 |
| `trimMessages` 丢错致 `tool_call_id` 悬空 → OpenAI 400 | Task 3 专门测悬空清理(丢 tool 连带清 assistant.tool_calls);保 system + 尾部 |
| `refreshSystem` 首轮把 ref 拼两次(POST + run 第一次 chat) | 接受(轻微浪费);或 POST 不 fetch、首屏靠 SSE hello 后的 step——本 plan 选简单 |
| EventSource 鉴权(header 不支持) | Task 8 方案 1:`requirePlatform` 加 `?token=` query 回退 |
| SSE 长连被代理超时 | 15s keepalive 注释行(Task 7) |
| conv-bus 内存泄漏 | done/failed `dispose`(Task 7);SSE `req.on('close')` unsubscribe(Task 7) |
| index.mjs 不可直接 import 做单测 | 把 K8s prompt 提取到独立模块(Task 6);`finalizeConvEmit` 若要单测也提取或导出 |

## 完成标志

- 9 个 task 全绿,全量门禁通过(`AuditLogs.vue` pre-existing 失败豁免)。
- 端到端手测 6 项通过。
- 之后路由模块化计划可直接搬本 plan 硬化后的 `index.mjs` 对话端点到 `routes/workbench-conversations.mjs`。

## Self-Review(写完自查)

- **Spec 覆盖**:spec §4.1 streaming → Task 1/2/4/7/8;§4.2 token → Task 3;§4.3 @-ref → Task 5;§4.4 admin → Task 6;§5 数据结构 → Task 5;§7 测试 → 各 task Step 1。✓ 无遗漏。
- **类型一致**:`chatStream` 签名、`run` 的 `onDelta`/`refreshSystem`、`finalizeConvEmit`、`applyStreamEvent` 在各 task 间命名一致。✓
- **占位符**:Task 6/7 的 grep 定位步骤是「精确指令」非占位;Task 8 鉴权给了确定方案(推荐 1)。✓
