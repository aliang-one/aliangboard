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

test('registry:工作台工具(apply/propose_learning/bootstrap_ledger;propose_ledger_update 已移除)在 workbenchToolDefs 且需人审', () => {
  const wb = registry.workbenchToolDefs().map(t => t.function.name)
  assert.ok(wb.includes('apply_project_manifests') && wb.includes('propose_learning') && wb.includes('bootstrap_ledger'))
  assert.ok(!wb.includes('propose_ledger_update'), 'propose_ledger_update 已移除(能力靠 survey,知识靠 distill)')
  const req = registry.requiringApproval()
  assert.ok(req.includes('apply_project_manifests') && req.includes('propose_learning') && req.includes('bootstrap_ledger'))
  assert.ok(!req.includes('propose_ledger_update'))
})

test('bootstrap_ledger → checkpoint;resume 批准 → ctx.wb.bootstrapLedger 被调,摘要喂回', async () => {
  const calls = []
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async () => {}, readManifests: async () => '', applyManifests: async () => ({ applied: [], failed: [] }), writeLedger: async () => {}, appendLearning: async () => {}, bootstrapLedger: async () => { calls.push('boot'); return { summary: '3 namespaces, IngressClasses=[nginx]', verifiedAt: '2026-08-06' } } }
  const llmClient = { chat: seqChat([tc('1', 'bootstrap_ledger', {}), fin('集群有 nginx 入口,3 个 namespace')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb })
  const cp = await run({ history: [] })
  assert.equal(cp.status, 'pending_approval')
  assert.deepEqual(calls, [], 'checkpoint 时未 survey')
  const out = await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: true } })
  assert.equal(out.content, '集群有 nginx 入口,3 个 namespace')
  assert.deepEqual(calls, ['boot'], 'resume 批准后 survey')
})

test('apply_project_manifests → checkpoint;resume 批准 → readManifests+applyManifests 被调', async () => {
  const calls = []
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async () => {}, readManifests: async () => { calls.push('read'); return 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm' }, applyManifests: async (yaml) => { calls.push(['apply', yaml]); return { applied: [{ kind: 'ConfigMap', name: 'cm' }], failed: [], total: 1 } }, writeLedger: async () => {}, appendLearning: async () => {} }
  const llmClient = { chat: seqChat([tc('1', 'apply_project_manifests', {}), fin('已 apply')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb })
  const cp = await run({ history: [] })
  assert.equal(cp.status, 'pending_approval')
  assert.deepEqual(calls, [], 'checkpoint 时未 read/apply(批准前不执行)')
  const out = await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: true } })
  assert.equal(out.content, '已 apply')
  assert.equal(calls.length, 2, 'read + apply')
})

test('registry.toolDefsFor: 按显式名字集取 def(忽略 minTier,使覆盖可越过 tier)', () => {
  const defs = registry.toolDefsFor(['get_pod_logs', 'exec_pod'])
  const names = defs.map(t => t.function.name)
  assert.ok(names.includes('get_pod_logs'))
  assert.ok(names.includes('exec_pod'))
  assert.equal(defs[0].type, 'function')
  // 未知名静默忽略(不抛)
  assert.equal(registry.toolDefsFor(['bogus_name']).length, 0)
  // 支持传 Set
  assert.ok(registry.toolDefsFor(new Set(['scale'])).map(t => t.function.name).includes('scale'))
})

test('propose_ledger_update 已移除:LLM 若调用 → 未知工具错误喂回(不再写台账)', async () => {
  const writes = []
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async () => {}, readManifests: async () => '', applyManifests: async () => ({ applied: [], failed: [] }), appendLearning: async () => {} }
  const llmClient = { chat: seqChat([tc('1', 'propose_ledger_update', { path: 'capabilities/x.md', content: 'x' }), fin('作罢')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb })
  const out = await run({ history: [] })
  // propose_ledger_update 不在 registry → execTool 抛"未知工具" → 当工具错误喂回 LLM → 终答
  assert.equal(out.content, '作罢')
  assert.deepEqual(writes, [], 'propose_ledger_update 不应再写任何东西')
})
