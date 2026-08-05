// Agent loop 测试(mock chat + mock execTool;写操作走 checkpoint/resume 人审)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createAgent } from './agent.mjs'

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
