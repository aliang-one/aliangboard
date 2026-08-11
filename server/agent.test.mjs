// Agent loop 测试(mock chat + mock execTool;写操作走 checkpoint/resume 人审)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createAgent, formatToolError, trimMessages, clampToolContent } from './agent.mjs'

// mock chat:按顺序返回一组 assistant message(最后一条若无 tool_calls 即终答)
function mockChat(responses) {
  let i = 0
  return async () => responses[Math.min(i++, responses.length - 1)]
}
const toolCall = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const final = content => ({ role: 'assistant', content })

test('LLM 直接终答(无 tool call)→ 返回 content,1 步', async () => {
  const run = createAgent({ chat: mockChat([final('你好')]), execTool: async () => 'x' }).run
  const out = await run({ system: '你是助手', history: [{ role: 'user', content: 'hi' }] })
  assert.equal(out.content, '你好')
  assert.equal(out.steps, 1)
  assert.equal(out.denied.length, 0)
})

test('调只读 tool → execTool → 终答(2 步)', async () => {
  const calls = []
  const execTool = async (name) => { calls.push(name); return { kind: 'pods', count: 3 } }
  const run = createAgent({ chat: mockChat([toolCall('1', 'list_resources', { kind: 'pods', namespace: 'ns' }), final('找到 3 个 pod')]), execTool }).run
  const out = await run({ history: [{ role: 'user', content: '列 pod' }] })
  assert.equal(out.content, '找到 3 个 pod')
  assert.equal(out.steps, 2)
  assert.deepEqual(calls, ['list_resources'])
})

test('写 tool(scale)→ checkpoint:返回 pending_approval,不执行 execTool', async () => {
  const calls = []
  const run = createAgent({
    chat: mockChat([toolCall('1', 'scale', { namespace: 'ns', kind: 'deployments', name: 'd1', replicas: 3 })]),
    execTool: async (n) => { calls.push(n); return 'ok' },
    needsApproval: n => n === 'scale',
  }).run
  const out = await run({ history: [{ role: 'user', content: '扩 d1 到 3' }] })
  assert.equal(out.status, 'pending_approval')
  assert.equal(out.pending.name, 'scale')
  assert.equal(out.pending.toolCallId, '1')
  assert.deepEqual(out.pending.args, { namespace: 'ns', kind: 'deployments', name: 'd1', replicas: 3 })
  assert.ok(out.queue.length >= 1 && out.queue[0].id === '1', 'queue 头应是 pending 的写工具')
  assert.ok(out.messages.length >= 1, '应回传 messages 供 resume')
  assert.deepEqual(calls, [], 'checkpoint 时不应执行 execTool')
})

test('resume 批准 → 执行 scale → 终答', async () => {
  const calls = []
  const run = createAgent({
    chat: mockChat([toolCall('1', 'scale', { namespace: 'ns', kind: 'deployments', name: 'd1', replicas: 3 }), final('已扩到 3')]),
    execTool: async (n, a) => { calls.push({ n, a }); return { scaledTo: a.replicas } },
    needsApproval: n => n === 'scale',
  }).run
  const cp = await run({ history: [{ role: 'user', content: '扩 d1 到 3' }] })
  assert.equal(cp.status, 'pending_approval')
  const out = await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: true } })
  assert.equal(out.content, '已扩到 3')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].n, 'scale')
  assert.deepEqual(calls[0].a, { namespace: 'ns', kind: 'deployments', name: 'd1', replicas: 3 })
  assert.equal(out.denied.length, 0)
})

test('resume 拒绝 → 不执行 execTool,记 denied,LLM 收到拒绝 → 终答', async () => {
  const calls = []
  const steps = []
  const run = createAgent({
    chat: mockChat([toolCall('1', 'scale', { replicas: 0 }), final('好的,不扩了')]),
    execTool: async (n) => { calls.push(n); return 'ok' },
    needsApproval: n => n === 'scale',
  }).run
  const cp = await run({ history: [], onStep: s => steps.push(s) })
  assert.equal(cp.status, 'pending_approval')
  const out = await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: false }, onStep: s => steps.push(s) })
  assert.equal(out.content, '好的,不扩了')
  assert.deepEqual(calls, [], '拒绝时 execTool 不应被调')
  assert.equal(out.denied.length, 1)
  assert.equal(out.denied[0].name, 'scale')
  assert.ok(steps.some(s => s.type === 'denied'), '应有 denied step')
})

test('read 档(needsApproval 恒 false)→ 写工具也直接执行,不 checkpoint', async () => {
  const calls = []
  const run = createAgent({
    chat: mockChat([toolCall('1', 'scale', { replicas: 3 }), final('done')]),
    execTool: async (n) => { calls.push(n); return 'ok' },
    needsApproval: () => false,
  }).run
  const out = await run({ history: [] })
  assert.equal(out.content, 'done')
  assert.deepEqual(calls, ['scale'])
  assert.equal(out.status, undefined, '不应 checkpoint')
})

test('同 turn 连续两个写工具 → 第一个 checkpoint,resume 后第二个再 checkpoint', async () => {
  const calls = []
  const run = createAgent({
    chat: mockChat([toolCall('1', 'scale', { name: 'd1', replicas: 3 }), toolCall('2', 'scale', { name: 'd2', replicas: 2 }), final('都扩好了')]),
    execTool: async (n, a) => { calls.push(a.name); return 'ok' },
    needsApproval: n => n === 'scale',
  }).run
  // 第一轮:LLM 一次回了两个 scale → 第一个 checkpoint
  let cp = await run({ history: [{ role: 'user', content: '扩 d1 和 d2' }] })
  assert.equal(cp.status, 'pending_approval')
  assert.equal(cp.pending.args.name, 'd1')
  // 批准 d1 → 执行 d1 后,队列里 d2 再次 checkpoint
  cp = await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: true } })
  assert.equal(cp.status, 'pending_approval')
  assert.equal(cp.pending.args.name, 'd2')
  assert.deepEqual(calls, ['d1'], '只执行了 d1')
  // 批准 d2 → 终答
  const out = await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: true } })
  assert.equal(out.content, '都扩好了')
  assert.deepEqual(calls, ['d1', 'd2'])
})

test('失控循环(一直 tool call 不终答)→ maxSteps 截断', async () => {
  const run = createAgent({
    chat: mockChat([toolCall('1', 'list_resources', {}), toolCall('2', 'list_resources', {}), toolCall('3', 'list_resources', {})]),
    execTool: async () => 'more',
    maxSteps: 3,
  }).run
  const out = await run({})
  assert.equal(out.truncated, true)
  assert.equal(out.steps, 3)
})

// --- formatToolError:工具失败观察串(让 LLM 知道为何失败,可自我纠正)---
test('formatToolError: PD 带 detail → 观察含 detail', () => {
  const e = new Error('PERMISSION_DENIED: policy'); e.code = 'PERMISSION_DENIED'; e.detail = "namespace 'default' 超出该 API key 绑定作用域 'anydoor'"
  assert.match(formatToolError(e), /namespace 'default' 超出该 API key 绑定作用域 'anydoor'/)
})
test('formatToolError: 普通 error(无 detail)→ 含 message', () => {
  assert.match(formatToolError(new Error('缺 path')), /缺 path/)
})

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
