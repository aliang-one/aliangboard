// Agent loop 测试(mock chat + mock execTool + mock onApproval)。
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
  const execTool = async (name, args) => { calls.push(name); return { kind: 'pods', count: 3 } }
  const run = createAgent({ chat: mockChat([toolCall('1', 'list_resources', { kind: 'pods', namespace: 'ns' }), final('找到 3 个 pod')]), execTool }).run
  const out = await run({ history: [{ role: 'user', content: '列 pod' }] })
  assert.equal(out.content, '找到 3 个 pod')
  assert.equal(out.steps, 2)
  assert.deepEqual(calls, ['list_resources'])
})

test('写 tool(scale)需审批 + 批准 → execTool 执行', async () => {
  const calls = []
  const run = createAgent({
    chat: mockChat([toolCall('1', 'scale', { name: 'd1', replicas: 3 }), final('已扩到 3')]),
    execTool: async (n) => { calls.push(n); return 'ok' },
    needsApproval: n => n === 'scale',
    onApproval: async () => true,
  }).run
  const out = await run({ history: [] })
  assert.equal(out.content, '已扩到 3')
  assert.deepEqual(calls, ['scale'])
  assert.equal(out.denied.length, 0)
})

test('写 tool 审批被拒 → 不执行 execTool,记 denied,LLM 收到拒绝信息', async () => {
  const calls = []
  const steps = []
  const run = createAgent({
    chat: mockChat([toolCall('1', 'scale', { replicas: 0 }), final('好的,不扩了')]),
    execTool: async (n) => { calls.push(n); return 'ok' },
    needsApproval: n => n === 'scale',
    onApproval: async () => false,
  }).run
  const out = await run({ history: [], onStep: s => steps.push(s) })
  assert.equal(out.content, '好的,不扩了')
  assert.deepEqual(calls, [], '被拒时 execTool 不应被调')
  assert.equal(out.denied.length, 1)
  assert.equal(out.denied[0].name, 'scale')
  assert.ok(steps.some(s => s.type === 'denied'), '应有 denied step')
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
