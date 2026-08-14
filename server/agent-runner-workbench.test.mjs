// W4b 工作台工具 + 双-principal 桥测试(registry 工作台工具 + createAgentRunner workbench 模式)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { registry } from './tool-registry.mjs'
import { createAgentRunner } from './agent-runner.mjs'
import { createAuditSchema } from './audit.mjs'

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

test('audit:传 audit 上下文 → wb 工具执行写 reserve(started)+finalize(finalized)两行,source=workbench', async () => {
  const db = new DatabaseSync(':memory:')
  createAuditSchema(db)
  const wb = { readLedger: async () => '# 台账', readFile: async () => '', writeFile: async () => {} }
  const llmClient = { chat: seqChat([tc('1', 'read_ledger', {}), fin('done')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb, audit: { db, owner: 'admin-liang', clusterId: 'c1' } })
  await run({ history: [{ role: 'user', content: '看台账' }] })
  const rows = db.prepare('SELECT status,owner,clusterId,tool,source,result,verb FROM audit_log ORDER BY seq').all()
  assert.equal(rows.length, 2, 'reserve + finalize 各一行')
  assert.deepEqual(rows.map(r => r.status), ['started', 'finalized'])
  assert.equal(rows[1].tool, 'read_ledger')
  assert.equal(rows[1].source, 'workbench')
  assert.equal(rows[1].owner, 'admin-liang')
  assert.equal(rows[1].clusterId, 'c1')
  assert.equal(rows[1].result, 'ok')
  assert.equal(rows[1].verb, 'read')
})

test('audit:不传 audit(API key 路径)→ 不写 audit_log(由 callTool 自带审计,不重复)', async () => {
  const db = new DatabaseSync(':memory:')
  createAuditSchema(db)
  const wb = { readLedger: async () => '# 台账', readFile: async () => '', writeFile: async () => {} }
  const llmClient = { chat: seqChat([tc('1', 'read_ledger', {}), fin('done')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb })
  await run({ history: [{ role: 'user', content: '看台账' }] })
  assert.equal(db.prepare('SELECT count(*) AS c FROM audit_log').get().c, 0, 'API key 路径不在此处审计')
})

test('audit:写工具 exec 返回 {error}(wb_scale 被拒)→ finalize result=error(带 reason)', async () => {
  const db = new DatabaseSync(':memory:')
  createAuditSchema(db)
  // wb_scale 的 exec 包 try/catch:scale 抛错 → 返回 {error:msg};execTool 据此判 result=error
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async () => {}, scale: async () => { throw new Error('RBAC denied') } }
  const llmClient = { chat: seqChat([tc('1', 'wb_scale', { namespace: 'default', kind: 'deployments', name: 'nginx', replicas: 2 }), fin('扩容失败')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb, audit: { db, owner: 'admin', clusterId: 'c1' } })
  const cp = await run({ history: [] })
  assert.equal(cp.status, 'pending_approval')
  await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: true } })
  const rows = db.prepare('SELECT status,verb,result,reason,namespace,resource FROM audit_log ORDER BY seq').all()
  assert.equal(rows.length, 2, 'reserve + finalize')
  assert.equal(rows[1].verb, 'write')
  assert.equal(rows[1].result, 'error')
  assert.ok(rows[1].reason.includes('RBAC'), 'error 行带 reason')
  assert.equal(rows[1].namespace, 'default')
  assert.equal(rows[1].resource, 'deployments/nginx')
})

test('audit:写工具(write_project_file resume 批准)→ finalized verb=write result=ok', async () => {
  const db = new DatabaseSync(':memory:')
  createAuditSchema(db)
  const wb = { readLedger: async () => '', readFile: async () => '', writeFile: async () => {} }
  const llmClient = { chat: seqChat([tc('1', 'write_project_file', { path: 'a.yaml', content: 'x' }), fin('已写')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb, audit: { db, owner: 'admin', clusterId: 'c1' } })
  const cp = await run({ history: [] })
  assert.equal(cp.status, 'pending_approval')
  await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: true } })
  const rows = db.prepare('SELECT status,verb,result,resource FROM audit_log ORDER BY seq').all()
  assert.equal(rows.length, 2)
  assert.equal(rows[1].verb, 'write', 'write_project_file ∈ WRITE_TOOLS')
  assert.equal(rows[1].result, 'ok')
  assert.equal(rows[1].resource, 'a.yaml')
})

// dev22: 容器内诊断 exec 工具(wb_exec 需人审 / wb_read_pod_file 只读免审)
test('registry:wb_exec 需人审、wb_read_pod_file 免审,都在 workbenchToolDefs', () => {
  const names = registry.workbenchToolDefs().map(t => t.function.name)
  assert.ok(names.includes('wb_exec'), 'wb_exec 应注册')
  assert.ok(names.includes('wb_read_pod_file'), 'wb_read_pod_file 应注册')
  const req = registry.requiringApproval()
  assert.ok(req.includes('wb_exec'), 'wb_exec 需人审')
  assert.ok(!req.includes('wb_read_pod_file'), 'wb_read_pod_file 免审(路径白名单 → 只读语义)')
  assert.ok(!registry.forTier('admin').includes('wb_exec'), 'wb 工具不进 K8s forTier')
})

test('wb_exec → checkpoint;resume 批准 → ctx.wb.execInPod 收到命令参数', async () => {
  const got = []
  const wb = {
    readLedger: async () => '', readFile: async () => '', writeFile: async () => {},
    execInPod: async (args) => { got.push(args); return { pod: args.pod, exitCode: 0, stdout: 'succeeded!', stderr: '', timedOut: false, truncated: false } },
  }
  const llmClient = { chat: seqChat([tc('1', 'wb_exec', { namespace: 'default', pod: 'nginx-abc', command: 'nc -zv mysql-svc 3306' }), fin('网络通')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb })
  const cp = await run({ history: [] })
  assert.equal(cp.status, 'pending_approval', 'wb_exec 必须先 checkpoint 人审')
  assert.deepEqual(got, [], '未批准不执行')
  const out = await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: true } })
  assert.equal(out.content, '网络通')
  assert.equal(got.length, 1)
  assert.equal(got[0].command, 'nc -zv mysql-svc 3306')
  assert.equal(got[0].pod, 'nginx-abc')
})

test('wb_read_pod_file 免审直执行 → ctx.wb.readPodFile 被调(无 checkpoint)', async () => {
  const got = []
  const wb = {
    readLedger: async () => '', readFile: async () => '', writeFile: async () => {},
    readPodFile: async (args) => { got.push(args); return { pod: args.pod, path: args.path, content: 'key: value', truncated: false } },
  }
  const llmClient = { chat: seqChat([tc('1', 'wb_read_pod_file', { namespace: 'default', pod: 'nginx-abc', path: '/etc/app/config.yaml' }), fin('配置拿到了')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb })
  const out = await run({ history: [] })
  assert.equal(out.status, undefined, '无 checkpoint(免审)')
  assert.equal(out.content, '配置拿到了')
  assert.equal(got.length, 1)
  assert.equal(got[0].path, '/etc/app/config.yaml')
})

// dev24: wb_top 实时资源用量(免审,kubectl top 等价)
test('registry:wb_top 免审 + dispatch 透传 scope/namespace/pod', async () => {
  const names = registry.workbenchToolDefs().map(t => t.function.name)
  assert.ok(names.includes('wb_top'), 'wb_top 应注册')
  assert.ok(!registry.requiringApproval().includes('wb_top'), 'wb_top 免审(只读 metrics)')
  const got = []
  const wb = {
    readLedger: async () => '', readFile: async () => '', writeFile: async () => {},
    topUsage: async (args) => { got.push(args); return { scope: 'pods', namespace: args.namespace, count: 1, items: [{ name: 'nginx-1', containers: [{ name: 'app', cpu: '900m', memory: '900Mi', cpuPct: 90, memoryPct: 87 }] }] } },
  }
  const llmClient = { chat: seqChat([tc('1', 'wb_top', { scope: 'pods', namespace: 'default', pod: 'nginx-1' }), fin('内存快到上限')]) }
  const { run } = createAgentRunner({ llmClient, workbench: wb })
  const out = await run({ history: [] })
  assert.equal(out.status, undefined, '免审无 checkpoint')
  assert.equal(out.content, '内存快到上限')
  assert.deepEqual(got, [{ scope: 'pods', namespace: 'default', pod: 'nginx-1' }])
})
