// W4b 工作台工具 + 双-principal 桥测试(registry 工作台工具 + createAgentRunner workbench 模式)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { registry } from './tool-registry.mjs'
import { createAgentRunner } from './agent-runner.mjs'

function seqChat(messages) { let i = 0; return async () => messages[Math.min(i++, messages.length - 1)] }
const tc = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const fin = content => ({ role: 'assistant', content })

test('registry:工作台工具在 workbenchToolDefs,且不在 forTier(K8s tier 不含它们)', () => {
  const wbNames = registry.workbenchToolDefs().map(t => t.function.name)
  assert.ok(wbNames.includes('read_ledger') && wbNames.includes('read_project_file') && wbNames.includes('write_project_file'))
  const k8sForOp = registry.forTier('operator')
  assert.ok(!k8sForOp.includes('read_ledger') && !k8sForOp.includes('write_project_file'), '工作台工具不应出现在 K8s forTier')
  // requiringApproval 含 write_project_file(K8s scale/restart 也在)
  const req = registry.requiringApproval()
  assert.ok(req.includes('write_project_file') && req.includes('scale'))
})

test('工作台 runner:read_ledger → ctx.wb.readLedger 被调 → 结果喂回 → 终答', async () => {
  const calls = []
  const wb = { readLedger: async () => { calls.push('ledger'); return '# 集群能力\n- nginx 入口' }, readFile: async () => '', writeFile: async () => {} }
  const llmClient = { chat: seqChat([tc('1', 'read_ledger', {}), fin('集群有 nginx 入口')]) }
  const { run, toolDefs } = createAgentRunner({ llmClient, workbench: wb })
  assert.ok(toolDefs.some(t => t.function.name === 'read_ledger'), 'offered 含 read_ledger')
  const out = await run({ history: [{ role: 'user', content: '集群有什么入口' }] })
  assert.equal(out.content, '集群有 nginx 入口')
  assert.deepEqual(calls, ['ledger'])
})

test('工作台 write_project_file → checkpoint;resume 批准 → ctx.wb.writeFile 被调', async () => {
  const writes = []
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async (p, c) => { writes.push({ p, c }) } }
  const llmClient = { chat: seqChat([tc('1', 'write_project_file', { path: 'manifests/cm.yaml', content: 'apiVersion: v1' }), fin('已写 manifests/cm.yaml')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb })
  const cp = await run({ history: [{ role: 'user', content: '写个 cm' }] })
  assert.equal(cp.status, 'pending_approval')
  assert.equal(cp.pending.name, 'write_project_file')
  assert.deepEqual(writes, [], 'checkpoint 时不应写')
  const out = await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: true } })
  assert.equal(out.content, '已写 manifests/cm.yaml')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].p, 'manifests/cm.yaml')
})

test('工作台 write_project_file resume 拒绝 → 不写,记 denied', async () => {
  const writes = []
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async (p, c) => { writes.push(p) } }
  const llmClient = { chat: seqChat([tc('1', 'write_project_file', { path: 'a.yaml', content: 'x' }), fin('好,不写了')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb })
  const cp = await run({ history: [] })
  const out = await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: false } })
  assert.equal(out.content, '好,不写了')
  assert.deepEqual(writes, [], '拒绝时不写')
  assert.equal(out.denied.length, 1)
})
