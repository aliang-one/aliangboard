// agent-runner 测试:接底座(execTool=callTool)+ toolDefs 按 tier + 写操作审批。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createAgentRunner, buildToolDefs } from './agent-runner.mjs'

const KEY = (tier, extra = {}) => ({ id: 'k', owner: 'a', boundSA_namespace: 'ns', boundSA_name: 'sa', clusterId: 'c', tier, ...extra })
const CLUSTER = { id: 'c', apiServer: 'https://10.0.0.1:6443' }

// mock llm:按顺序返回(最后一条重复)
function seqChat(messages) {
  let i = 0
  return async () => messages[Math.min(i++, messages.length - 1)]
}
const tc = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const fin = content => ({ role: 'assistant', content })

test('buildToolDefs: read 档只读(无 scale);operator 含 scale/restart;OpenAI 格式', () => {
  const read = buildToolDefs('read').map(t => t.function.name)
  const op = buildToolDefs('operator').map(t => t.function.name)
  assert.ok(read.includes('list_resources') && !read.includes('scale'), 'read 不含 scale')
  assert.ok(op.includes('scale') && op.includes('restart'), 'operator 含写')
  assert.equal(buildToolDefs('read')[0].type, 'function', 'OpenAI tools 格式')
  assert.ok(buildToolDefs('read')[0].function.parameters, '带 parameters/inputSchema')
})

test('LLM 调只读 tool → 底座 callTool 被调 → 结果喂回 → 终答', async () => {
  const calls = []
  const apiKeyTools = { callTool: async (kr, c, name, args) => { calls.push({ name, args }); return { kind: 'pods', count: 2 } } }
  const llmClient = { chat: seqChat([tc('1', 'list_resources', { kind: 'pods', namespace: 'ns' }), fin('找到 2 个 pod')]) }
  const { run } = createAgentRunner({ llmClient, apiKeyTools, keyRow: KEY('read'), cluster: CLUSTER })
  const out = await run({ history: [{ role: 'user', content: '列 pod' }] })
  assert.equal(out.content, '找到 2 个 pod')
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'list_resources')
})

test('写 tool(scale)→ 经 onApproval;批准才调 callTool', async () => {
  const calls = []
  const apiKeyTools = { callTool: async (kr, c, n) => { calls.push(n); return { ok: true } } }
  const llmClient = { chat: seqChat([tc('1', 'scale', { name: 'd1', replicas: 3 }), fin('已扩到 3')]) }
  const { run } = createAgentRunner({ llmClient, apiKeyTools, keyRow: KEY('operator'), cluster: CLUSTER, onApproval: async () => true })
  const out = await run({})
  assert.equal(out.content, '已扩到 3'); assert.deepEqual(calls, ['scale'])
})

test('写 tool 审批被拒 → callTool 不调 + denied 记录 + LLM 收到拒绝', async () => {
  const calls = []
  const apiKeyTools = { callTool: async () => { calls.push('x'); return 'ok' } }
  const llmClient = { chat: seqChat([tc('1', 'scale', { replicas: 0 }), fin('好,不扩了')]) }
  const { run } = createAgentRunner({ llmClient, apiKeyTools, keyRow: KEY('operator'), cluster: CLUSTER, onApproval: async () => false })
  const out = await run({})
  assert.equal(out.content, '好,不扩了')
  assert.deepEqual(calls, [], '被拒时 callTool 不调')
  assert.equal(out.denied.length, 1); assert.equal(out.denied[0].name, 'scale')
})

test('read 档的 LLM 想调 scale → 底座 authorize 拒(callTool 抛 policy)→ 结果是错误文本,agent 继续', async () => {
  // 模拟 callTool 对 scale 抛 PERMISSION_DENIED(agent 把它当工具错误喂回 LLM)
  const apiKeyTools = { callTool: async (kr, c, name) => { if (name === 'scale') { const e = new Error('policy'); e.code = 'PERMISSION_DENIED'; throw e } return 'ok' } }
  const llmClient = { chat: seqChat([tc('1', 'scale', {}), fin('没权限,作罢')]) }
  const { run } = createAgentRunner({ llmClient, apiKeyTools, keyRow: KEY('read'), cluster: CLUSTER })
  const out = await run({})
  assert.equal(out.content, '没权限,作罢') // agent 把工具失败喂回 LLM,LLM 终答
})
