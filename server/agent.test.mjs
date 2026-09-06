// Agent loop 测试(mock chat + mock execTool;写操作走 checkpoint/resume 人审)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createAgent, formatToolError, trimMessages, clampToolContent, clampTraceStep } from './agent.mjs'

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

test('失控循环(一直 tool call 不终答)→ 到上限触发收尾轮,强制终答', async () => {
  const run = createAgent({
    chat: mockChat([toolCall('1', 'list_resources', {}), toolCall('2', 'list_resources', {}), toolCall('3', 'list_resources', {}), final('基于以上信息,结论是 X')]),
    execTool: async () => 'more',
    maxSteps: 3,
  }).run
  const out = await run({})
  assert.equal(out.truncated, true)
  assert.equal(out.steps, 4, '3 轮工具 + 1 轮收尾')
  assert.equal(out.content, '基于以上信息,结论是 X')
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

// I-审计(2026-08-26):工具结果归一的三缺陷。此前 `JSON.stringify(content)`:
//   undefined → stringify 返 undefined → .length 抛 TypeError → 炸整轮对话(比显示 bug 严重);
//   Error 对象 → '{}' 静默吞失败信息;BigInt/循环引用 → 直接 throw。
test('clampToolContent: undefined → 占位串不抛(一个工具无返回不炸整轮对话)', () => {
  assert.equal(clampToolContent(undefined), '(工具无返回值)')
  assert.equal(clampToolContent(null), '(工具无返回值)')
})

test('clampToolContent: Error 对象 → message 串(失败信息不静默丢)', () => {
  assert.match(clampToolContent(new Error('boom')), /boom/)
})

test('clampToolContent: 不可 stringify(BigInt/循环引用)→ String 兜底不抛', () => {
  const out = clampToolContent({ v: 10n })
  assert.ok(typeof out === 'string' && out.length > 0, `返回字符串(实际 ${typeof out})`)
  const a = {}; a.self = a
  assert.doesNotThrow(() => clampToolContent(a))
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

test('agent 每轮 chat 前调 refreshSystem() 重置 messages[0]', async () => {
  const calls = []
  const chat = async (messages) => { calls.push(messages[0].content); return calls.length === 1 ? toolCall('c1', 'f', {}) : final('done') }
  let n = 0
  const refreshSystem = async () => `sys@${++n}`
  const run = createAgent({ chat, execTool: async () => 'r' }).run
  await run({ system: 'sys@0', history: [{ role: 'user', content: 'q' }], refreshSystem })
  assert.deepEqual(calls, ['sys@1', 'sys@2'])  // 两轮 chat,每轮都刷新
})

test('agent 无 refreshSystem 时,行为不变(system 保持初值)', async () => {
  const seen = []
  const chat = async (messages) => { seen.push(messages[0].content); return seen.length === 1 ? toolCall('c1', 'f', {}) : final('done') }
  const run = createAgent({ chat, execTool: async () => 'r' }).run
  await run({ system: 'sys0', history: [{ role: 'user', content: 'q' }] })
  assert.deepEqual(seen, ['sys0', 'sys0'])
})

test('agent resume 路径也调 refreshSystem(每轮 chat 前重置)', async () => {
  const calls = []
  const chat = async (messages) => { calls.push(messages[0].content); return final('done') }
  let n = 0
  const refreshSystem = async () => `r@${++n}`
  const run = createAgent({ chat, execTool: async () => 'r', needsApproval: () => false }).run
  // 先跑到一个 checkpoint(resume 入口)
  const cp = await run({
    system: 'init',
    history: [{ role: 'user', content: 'q' }],
    onStep: () => {},
  })
  // 即便 cp 已经是终答,我们这里直接构造 resume 场景:messages 含 system[0]
  calls.length = 0
  await run({
    resume: { messages: [{ role: 'system', content: 'init' }, { role: 'user', content: 'q' }], queue: [], denied: [], steps: 1 },
    refreshSystem,
  })
  assert.deepEqual(calls, ['r@1'])
})

// dev27: tool_start 事件(UI"正在跑哪个工具"的 running 态)
test('工具执行前发 tool_start(name+args),完成后发 tool(带 result);checkpoint/denied 不发', async () => {
  const steps = []
  const execTool = async (name) => {
    // 执行瞬间断言:start 已发、tool 未发(时序保证)
    const types = steps.map(s => s.type)
    assert.ok(types.includes('tool_start'), 'execTool 前应有 tool_start')
    assert.ok(!types.includes('tool'), 'execTool 前不应有完成事件')
    return `${name}-result`
  }
  const run = createAgent({
    chat: mockChat([toolCall('1', 'list_resources', { kind: 'pods' }), final('done')]),
    execTool,
    needsApproval: n => n === 'scale',
  }).run
  await run({ history: [{ role: 'user', content: '列 pod' }], onStep: e => steps.push(e) })
  const toolEvents = steps.filter(s => s.type === 'tool' || s.type === 'tool_start')
  assert.equal(toolEvents.length, 2, '一进一出配对')
  assert.equal(toolEvents[0].name, 'list_resources')
  assert.deepEqual(toolEvents[0].args, { kind: 'pods' })
  assert.equal(toolEvents[1].result, 'list_resources-result')
  const run2 = createAgent({
    chat: mockChat([toolCall('1', 'scale', { replicas: 2 })]),
    execTool: async () => 'ok',
    needsApproval: () => true,
  }).run
  const steps2 = []
  await run2({ history: [], onStep: e => steps2.push(e) })
  assert.ok(steps2.every(s => s.type !== 'tool_start'), 'checkpoint(未批准未执行)不发 tool_start')
})

// 2026-08-27 审计:盖章 id 跨实例唯一。旧 `gen_${idSeq}` 每实例从 0 重计——跨轮新 run/resume
// 新建 agent 后重复 → 前端 decidedApprovals 按 id 去重误命中旧决策 → 审批不弹死锁。
// 契约:LLM 未带 id 时,各实例(run/resume 每轮新建)盖出的 id 互不相等。
test('盖章 toolCall id 跨实例唯一(LLM 未带 id 时)', async () => {
  const noIdCall = () => ({ role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'write', arguments: '{}' } }] })
  const ids = new Set()
  for (let i = 0; i < 3; i++) {
    const agent = createAgent({ chat: async () => noIdCall(), execTool: async () => 'ok', needsApproval: () => true })
    const out = await agent.run({ history: [{ role: 'user', content: 'q' }] })
    assert.ok(out.status === 'pending_approval', '写工具 checkpoint')
    assert.match(out.pending.toolCallId, /^gen_/, '盖章 id 形如 gen_<tag>_<seq>')
    ids.add(out.pending.toolCallId)
  }
  assert.equal(ids.size, 3, '3 个实例的盖章 id 互不相等')
})
// 2026-08-27 审计:trace 存/流面的工具结果截断(与 clampToolContent 喂 LLM 面分工)
test('clampTraceStep:小结果原样返回(同引用);超限截断带标记;非 tool 事件不动', () => {
  const small = { type: 'tool', name: 'wb_get_resource', args: {}, result: { resource: { kind: 'Pod' } }, ts: 1 }
  assert.equal(clampTraceStep(small), small, '未超限返回原对象(零拷贝)')
  assert.equal(clampTraceStep({ type: 'assistant', message: { content: 'x' }, ts: 1 }).type, 'assistant', '非 tool 事件原样')
  assert.equal(clampTraceStep({ type: 'tool', name: 't', args: {}, ts: 1 }).result, undefined, 'result 为空不动')
  // 字符串 result 超限
  const s = clampTraceStep({ type: 'tool', name: 'wb_read_pod_file', args: {}, result: 'y'.repeat(50_000), ts: 1 }, 1024)
  assert.equal(s.resultTruncated, true)
  assert.ok(s.result.length < 1200 && s.result.includes('[result truncated'))
  assert.equal(s.resultOriginalBytes, 50_000)
  // 对象 result 超限(JSON 序列化超 1024 字节)
  const o = clampTraceStep({ type: 'tool', name: 'wb_get_resource', args: {}, result: { resource: { data: 'z'.repeat(5_000) } }, ts: 1 }, 1024)
  assert.equal(o.resultTruncated, true)
  assert.ok(o.result.startsWith('{"resource"'))
  assert.equal(clampTraceStep({ type: 'tool_start', name: 't', args: {}, ts: 1 }).type, 'tool_start', 'tool_start 瞬态不动')
})

// ── 2026-08-28 compact+余量 T2:裁剪预算注入(窗口 70% 派生,60K 固定线退役)──
test('createAgent budgetChars 注入:trimMessages 用注入预算而非 60K 缺省', async () => {
  // 预算 300 字符:2 条 user 各 160 字 → 总 320 > 300,最旧 user 应被丢
  const seen = []
  const chat = async (messages) => { seen.push(messages.map(m => m.content)); return { role: 'assistant', content: 'ok' } }
  const run = createAgent({ chat, execTool: async () => 'x', budgetChars: 300 }).run
  await run({ history: [
    { role: 'user', content: 'A'.repeat(160) },
    { role: 'assistant', content: 'B'.repeat(1) },
    { role: 'user', content: 'C'.repeat(160) },
  ] })
  const firstRound = seen[0]
  assert.ok(!firstRound.some(c => String(c).startsWith('A'.repeat(20))), '超注入预算,最旧 user 被裁')
  assert.ok(firstRound.some(c => String(c).startsWith('C'.repeat(20))), '最新 user 保留')
})

test('createAgent 未注入 budgetChars → 维持 60K 缺省(既有单测兼容)', async () => {
  // 60k 缺省下小对话不裁;断言经由已有 trimMessages 行为(此处仅锁 createAgent 不因缺参抛错)
  const run = createAgent({ chat: async () => ({ role: 'assistant', content: 'ok' }), execTool: async () => 'x' }).run
  const out = await run({ history: [{ role: 'user', content: 'hi' }] })
  assert.equal(out.content, 'ok')
})

test('裁决快照:resume 拒绝后即使策略放宽(needsApproval 转 false)也不翻案(2026-08-29 审计)', async () => {
  const calls = []
  let policy = 'always'
  const run = createAgent({
    chat: mockChat([toolCall('1', 'scale', { replicas: 0 }), final('好的,已尊重拒绝')]),
    execTool: async (n) => { calls.push(n); return 'ok' },
    needsApproval: n => (n === 'scale' ? policy === 'always' : false),
  }).run
  const cp = await run({ history: [] })
  assert.equal(cp.status, 'pending_approval')
  policy = 'none'                                    // 挂起窗口内策略放宽
  const out = await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: false } })
  assert.deepEqual(calls, [], '拒绝必须恒拒绝——策略放宽不得翻案')
  assert.equal(out.denied.length, 1)
})

test('裁决快照:resume 批准后即使策略收紧恒执行(批准不重问)', async () => {
  const calls = []
  let policy = 'always'
  const run = createAgent({
    chat: mockChat([toolCall('1', 'scale', { replicas: 3 }), final('已扩')]),
    execTool: async (n) => { calls.push(n); return 'ok' },
    needsApproval: n => (n === 'scale' ? policy === 'always' : false),
  }).run
  const cp = await run({ history: [] })
  assert.equal(cp.status, 'pending_approval')
  const out = await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: cp.pending.toolCallId, approved: true } })
  assert.equal(calls.length, 1, '批准恒执行')
  assert.equal(out.content, '已扩')
})

test('resume 目标之后队列中的新写工具:仍走正常 checkpoint(不继承批准)', async () => {
  const run = createAgent({
    chat: mockChat([toolCall('1', 'scale', { replicas: 3 }), toolCall('2', 'restart', { name: 'x' }), final('done')]),
    execTool: async () => 'ok',
    needsApproval: n => n === 'scale' || n === 'restart',
  }).run
  const cp = await run({ history: [] })
  assert.equal(cp.status, 'pending_approval')
  assert.equal(cp.pending.toolCallId, '1')
  const out = await run({ resume: { messages: cp.messages, queue: cp.queue, denied: cp.denied, steps: cp.steps, toolCallId: '1', approved: true } })
  assert.equal(out.status, 'pending_approval', '第二个写工具应再次 checkpoint')
  assert.equal(out.pending.toolCallId, '2')
})

// ── 2026-08-31 工具链审计修复⑥:畸形 JSON 参数不再静默变 {} ──
// 此前 parseArgs catch 后返 {},工具照跑后报「缺参数」——LLM 拿不到「参数本身是坏 JSON」
// 的信号,可能原地重试同款坏参数。修复:解析失败 → 不执行工具,回执带原文截断喂回 LLM 自纠。
test('畸形 JSON 参数 → 不执行工具,回执说明非合法 JSON 并带原文(可自纠)', async () => {
  const calls = []
  const chats = []
  const responses = [
    { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'list_resources', arguments: '{"kind": pods}' } }] },
    final('参数修好了'),
  ]
  let i = 0
  const chat = async (messages) => { chats.push(messages); return responses[Math.min(i++, responses.length - 1)] }
  const steps = []
  const run = createAgent({ chat, execTool: async (n, a) => { calls.push({ n, a }); return 'ok' } }).run
  const out = await run({ history: [{ role: 'user', content: '列 pod' }], onStep: s => steps.push(s) })
  assert.equal(out.content, '参数修好了')
  assert.deepEqual(calls, [], '解析失败不应执行工具')
  const receipt = chats[1].find(m => m.role === 'tool' && m.tool_call_id === '1')
  assert.ok(receipt, '下一轮 chat 应收到该 tool_call 的回执(OpenAI 契约不悬空)')
  assert.match(receipt.content, /不是合法 JSON/, '回执说明参数非合法 JSON')
  assert.match(receipt.content, /"kind": pods/, '回执带原文截断供 LLM 自纠')
  const toolStep = steps.find(s => s.type === 'tool' && s.name === 'list_resources')
  assert.ok(toolStep, '应有 tool step(UI/trace 可见,不静默)')
})

test('合法但缺字段的参数仍照常执行(解析成功不拦)', async () => {
  const calls = []
  const run = createAgent({
    chat: mockChat([toolCall('1', 'list_resources', { kind: 'pods' }), final('done')]),
    execTool: async (n, a) => { calls.push(a); return 'ok' },
  }).run
  await run({ history: [] })
  assert.deepEqual(calls, [{ kind: 'pods' }])
})

test('收尾轮:不带 tools + 注入系统收尾提示(2026-09-03)', async () => {
  const chats = []
  const chat = async (messages, tools) => {
    chats.push({ messages: [...messages], tools }) // 快照:messages 数组后续会被 push 复用(引用共享)
    return chats.length <= 2 ? toolCall(String(chats.length), 'list_resources', {}) : final('收尾答案')
  }
  const run = createAgent({ chat, execTool: async () => 'ok', maxSteps: 2 }).run
  const out = await run({})
  assert.equal(out.content, '收尾答案')
  assert.equal(out.truncated, true)
  const last = chats[chats.length - 1]
  assert.deepEqual(last.tools, [], '收尾轮不提供任何工具')
  assert.match(last.messages[last.messages.length - 1].content, /最大执行步数 2/)
})

test('maxSteps 0 = 不设限:超过旧默认 8 仍继续到终答', async () => {
  let execCount = 0
  const run = createAgent({
    chat: async () => (execCount >= 12 ? final('done') : toolCall('t' + execCount, 'list_resources', {})),
    execTool: async () => { execCount++; return 'ok' },
    maxSteps: 0,
  }).run
  const out = await run({})
  assert.equal(out.content, 'done')
  assert.ok(out.steps >= 13, `应跑满 12 轮工具 + 终答,实际 ${out.steps}`)
  assert.ok(!out.truncated)
})

// ── 2026-09-03 maxSteps 收尾轮修复波:F1/F2 ──
test('F1: 触发过预算裁剪的正常终答不携带 truncated 旗标(语义=步数上限截断)', async () => {
  // budgetChars 极小 → 上下文裁剪必然发生;但对话正常终答,out.truncated 必须为 false
  const run = createAgent({
    chat: mockChat([toolCall('1', 'list_resources', { kind: 'pods' }), final('done')]),
    execTool: async () => 'x'.repeat(200),
    budgetChars: 1,
  }).run
  const out = await run({})
  assert.equal(out.content, 'done')
  assert.equal(out.truncated, false, '预算裁剪不透传为步数上限旗标')
})

test('F2: 收尾轮 chat 前先按预算裁剪(到上限时刻消息最长,防超预算 400)', async () => {
  const bigResult = 'r'.repeat(600) // 每次 600 字符 × 3 轮,远超 500 预算
  let wrappedUpMessages = null
  let round = 0
  const chat = async (messages, tools) => {
    round++
    if (round <= 3) return toolCall(String(round), 'list_resources', {})
    wrappedUpMessages = messages
    return final('基于以上信息收尾')
  }
  const run = createAgent({ chat, execTool: async () => bigResult, budgetChars: 500, maxSteps: 3 }).run
  const out = await run({})
  assert.equal(out.truncated, true)
  assert.equal(out.content, '基于以上信息收尾')
  const size = JSON.stringify(wrappedUpMessages).length
  assert.ok(size <= 500 + 1000, `收尾轮消息序列化长度 ${size} 应 ≤ budget+1000 余量(system/收尾 user 提示不裁)`)
})

// ── chat 容错重试(2026-09-06「对话尾巴不展示」排查):sub2api/litellm 代理瞬时 400/502
// 常打死 final 轮(跑完全部工具只差总结)→ 整轮 failed。契约:首 token 前(未吐任何
// delta/reasoning)失败自动重试一次;已吐 delta 后失败不重试——流式重试会让前端内容重复拼接。

test('chat 首次失败(未吐 delta)→ 自动重试一次并成功', async () => {
  let calls = 0
  const chat = async () => {
    if (++calls === 1) throw new Error('LLM HTTP 502: Upstream service temporarily unavailable')
    return final('重试后的终答')
  }
  const out = await createAgent({ chat, execTool: async () => 'x' }).run({ history: [{ role: 'user', content: 'hi' }] })
  assert.equal(out.content, '重试后的终答')
  assert.equal(calls, 2, '失败一次,恰好重试一次')
})

test('chat 中间轮首 delta 前失败 → 同样重试(tool 轮救活)', async () => {
  let calls = 0
  const chat = async () => {
    if (++calls === 1) throw new Error('LLM HTTP 400: messages 参数非法')
    if (calls === 2) return toolCall('1', 'list_resources', { kind: 'pods' })
    return final('ok')
  }
  const out = await createAgent({ chat, execTool: async () => 'x' }).run({ history: [{ role: 'user', content: 'hi' }] })
  assert.equal(out.content, 'ok')
  assert.equal(calls, 3)
})

test('chat 已吐 delta 后失败 → 不重试,错误照抛(salvage 由上层接)', async () => {
  let calls = 0
  const chat = async (messages, tools, opts = {}) => {
    if (++calls === 1) { opts.onDelta?.('前半段'); throw new Error('midstream dead') }
    return final('不该走到这')
  }
  await assert.rejects(
    () => createAgent({ chat, execTool: async () => 'x' }).run({ history: [{ role: 'user', content: 'hi' }], onDelta: () => {} }),
    /midstream dead/,
  )
  assert.equal(calls, 1, '已吐 delta 不重试(前端内容会被重复拼接)')
})

test('重试也失败 → 抛第二次错误', async () => {
  let calls = 0
  const chat = async () => { calls++; throw new Error(`boom #${calls}`) }
  await assert.rejects(
    () => createAgent({ chat, execTool: async () => 'x' }).run({ history: [{ role: 'user', content: 'hi' }] }),
    /boom #2/,
  )
  assert.equal(calls, 2, '至多重试一次')
})

// ── finishReason=length → cutByLength 亮标(不再静默截断)──
test('终答 finishReason=length → out.cutByLength=true', async () => {
  const run = createAgent({ chat: mockChat([{ role: 'assistant', content: '被掐断的回答', finishReason: 'length' }]), execTool: async () => 'x' }).run
  const out = await run({ history: [{ role: 'user', content: 'hi' }] })
  assert.equal(out.content, '被掐断的回答')
  assert.equal(out.cutByLength, true)
})

test('正常终答不携带 cutByLength', async () => {
  const run = createAgent({ chat: mockChat([final('完整回答')]), execTool: async () => 'x' }).run
  const out = await run({ history: [{ role: 'user', content: 'hi' }] })
  assert.equal(out.cutByLength, false)
})

test('收尾轮 finishReason=length → cutByLength=true', async () => {
  let i = 0
  const chat = async () => ++i <= 3 ? toolCall(String(i), 'list_resources', {}) : { role: 'assistant', content: '收尾也被掐断', finishReason: 'length' }
  const run = createAgent({ chat, execTool: async () => 'x', maxSteps: 3 }).run
  const out = await run({ history: [{ role: 'user', content: 'hi' }] })
  assert.equal(out.truncated, true)
  assert.equal(out.cutByLength, true)
})

// ── 2026-09-06 上下文裁剪计量缺陷A:refreshSystem 须先于 trim ──
// 旧序:run 主循环先 trimMessages 再 refreshSystem 重写 messages[0] → recap/@refs 注入
// (可达 ~50KB)发生在裁剪之后、不计预算 → 实际发给 provider 的上下文可超预算。
// 契约:重写后的 system 体积计入裁剪(trim 发生在 system 替换之后),system 恒保不被裁掉。
test('refreshSystem 先于 trim:重写后的 system 体积计入裁剪(注入 ~50KB 后仍受控)', async () => {
  const bigSystem = 'R'.repeat(50000)
  let captured = null
  const chat = async (messages) => { captured = [...messages]; return final('done') }
  const run = createAgent({ chat, execTool: async () => 'x', budgetChars: 3000 }).run
  await run({
    system: 'sys-init',
    history: [{ role: 'user', content: 'A'.repeat(2000) }, { role: 'user', content: 'B-tail' }],
    refreshSystem: async () => bigSystem,
  })
  assert.ok(captured, 'chat 应被调用')
  const size = JSON.stringify(captured).length
  assert.ok(size < bigSystem.length + 300, `trim 须发生在 system 重写之后:总长 ${size} 应 ≤ 重写 system(${bigSystem.length})+末条+零头`)
  assert.equal(captured[0].content, bigSystem, 'system 为 refreshSystem 重写后的内容(恒保)')
  assert.ok(!captured.some(m => m.content === 'A'.repeat(2000)), '重写后超预算 → trim 实际发生,最旧 user 被裁')
  assert.equal(captured[captured.length - 1].content, 'B-tail', '末条保留')
})

// ── 2026-09-06 上下文裁剪计量缺陷B:trimMessages 二阶段 ──
// phase1 只丢 user/tool、恒保 assistant → 纯 assistant 多轮长文时裁完仍超预算,provider 400。
// phase2 契约:按「轮」从最旧丢——一条 assistant(非末条)及其后连续的 tool 消息为一组,
// 整组丢弃(assistant 和它的 tool 一起走,不产生孤儿 tool),循环直到达标或只剩 system+末条。
test('trimMessages 第二阶段:assistant 轮从最旧丢弃直到达标(纯 assistant 也可裁)', () => {
  const msgs = [
    { role: 'system', content: 's' },
    { role: 'assistant', content: 'A'.repeat(3000) },
    { role: 'assistant', content: 'B'.repeat(3000) },
    { role: 'assistant', content: 'C-tail' },
  ]
  const { messages, truncated } = trimMessages(msgs, 5000)
  assert.equal(truncated, true)
  assert.equal(messages[0].role, 'system', 'system 恒保')
  assert.ok(!messages.some(m => m.content?.startsWith('A'.repeat(20))), '最旧 assistant 轮被丢(phase1 无 user/tool 可丢,phase2 兜底)')
  assert.ok(messages.some(m => m.content?.startsWith('B'.repeat(20))), '丢一轮即达标,B 轮保留')
  assert.equal(messages[messages.length - 1].content, 'C-tail', '末条保留')
  const size = messages.reduce((n, m) => n + JSON.stringify(m).length, 0)
  assert.ok(size <= 5000 + 50, `裁后 ${size} 应 ≤ 预算 5000(+序列化零头)`)
})

test('trimMessages 第二阶段:assistant+tool 配对整组丢弃,不留孤儿 tool', () => {
  const tc = id => ({ id, type: 'function', function: { name: 'f', arguments: '{}' } })
  const msgs = [
    { role: 'system', content: 's' },
    { role: 'assistant', content: null, tool_calls: [tc('c1')] },
    { role: 'tool', tool_call_id: 'c1', content: 'X'.repeat(3000) },
    { role: 'assistant', content: 'B'.repeat(2000) },
    { role: 'assistant', content: 'C'.repeat(2000) },
    { role: 'user', content: 'tail-q' },
  ]
  const { messages, truncated } = trimMessages(msgs, 1500)
  assert.equal(truncated, true)
  assert.deepEqual(messages.map(m => m.role), ['system', 'user'], 'assistant 轮从最旧整组丢弃直到达标')
  assert.equal(messages[messages.length - 1].content, 'tail-q', '末条保留')
  // 不留孤儿 tool:剩余每条 tool 必有携带该 id 的 assistant;assistant 的 tool_calls 必有对应 tool 回执
  const toolIds = new Set(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id))
  const callIds = new Set(messages.filter(m => m.role === 'assistant').flatMap(m => (m.tool_calls || []).map(t => t.id)))
  for (const id of toolIds) assert.ok(callIds.has(id), `tool ${id} 无主(孤儿)`)
  for (const id of callIds) assert.ok(toolIds.has(id), `tool_call ${id} 无回执`)
  const size = messages.reduce((n, m) => n + JSON.stringify(m).length, 0)
  assert.ok(size <= 1500 + 50, `裁后 ${size} 应 ≤ 预算 1500(+零头)`)
})

test('trimMessages 第二阶段:末条为 tool 时与其 assistant 配对保留(不孤儿、不丢末条)', () => {
  const tc = id => ({ id, type: 'function', function: { name: 'f', arguments: '{}' } })
  const msgs = [
    { role: 'system', content: 's' },
    { role: 'assistant', content: 'B'.repeat(3000) },
    { role: 'assistant', content: null, tool_calls: [tc('c2')] },
    { role: 'tool', tool_call_id: 'c2', content: 'r' },
  ]
  const { messages, truncated } = trimMessages(msgs, 100)
  assert.equal(truncated, true)
  assert.deepEqual(messages.map(m => m.role), ['system', 'assistant', 'tool'], '裁到下限:system + 末轮配对(末条 tool 与其 assistant 一起走)')
  assert.ok(!messages.some(m => m.content?.startsWith('B'.repeat(20))), '中间纯文本 assistant 轮被丢')
  assert.deepEqual(messages[1].tool_calls.map(t => t.id), ['c2'], '配对完整:assistant 携带 tool_call')
  assert.equal(messages[2].tool_call_id, 'c2', '配对完整:tool 回执指向该 assistant')
})

// ── 2026-09-06 审计#3 轻量取消中止:agent 循环 shouldAbort 检查点 ──
// 用户点「停止」后 cancelConversation 只置 DB cancelled+发 SSE,agent 循环原本无人查它
// ——队列里剩余工具与后续 LLM 轮照跑(在途 LLM 流不可中断属已知边界,但工具副作用
// 不该继续发生)。契约:createAgent 可选 shouldAbort(async () => bool);检查点两处
// (工具队列每个工具开头 + 主循环每轮 chat 前),取消即抛错 run() reject;缺省零行为变化
// (既有测试即证)。上层(workbench-agent)注入「读对话状态 === cancelled」的闭包。
test('shouldAbort:第一个工具执行后取消 → 队列第二个工具不执行且 run reject(/取消/)', async () => {
  const calls = []
  let aborted = false
  const run = createAgent({
    chat: mockChat([{
      role: 'assistant', content: null,
      tool_calls: [
        { id: '1', type: 'function', function: { name: 'list_pods', arguments: '{}' } },
        { id: '2', type: 'function', function: { name: 'delete_pod', arguments: '{}' } },
      ],
    }]),
    execTool: async (n) => { calls.push(n); aborted = true; return 'ok' },
    shouldAbort: async () => aborted,
  }).run
  await assert.rejects(() => run({ history: [{ role: 'user', content: 'q' }] }), /取消/)
  assert.deepEqual(calls, ['list_pods'], '副作用止步:队列第二个工具不再执行')
})

test('shouldAbort:工具排空后下一轮 chat 前取消 → 不再发起后续 LLM 轮', async () => {
  let chatCalls = 0
  let toolDone = false
  const run = createAgent({
    chat: async () => { chatCalls++; return toolCall('1', 'list_pods', {}) },
    execTool: async () => { toolDone = true; return 'ok' },
    shouldAbort: async () => toolDone,
  }).run
  await assert.rejects(() => run({ history: [{ role: 'user', content: 'q' }] }), /取消/)
  assert.equal(chatCalls, 1, '取消后不再发起后续 LLM 轮')
})

test('shouldAbort 检查点先于 needsApproval 咨询(取消后连审批 checkpoint 都不发生)', async () => {
  let approvals = 0
  const run = createAgent({
    chat: mockChat([toolCall('1', 'scale', {})]),
    execTool: async () => 'ok',
    needsApproval: () => { approvals++; return true },
    shouldAbort: async () => true,
  }).run
  await assert.rejects(() => run({
    resume: { messages: [], queue: [{ id: '1', type: 'function', function: { name: 'scale', arguments: '{}' } }], denied: [], steps: 1 },
  }), /取消/)
  assert.equal(approvals, 0, '检查点在 needsApproval 之前:取消不产生 pending_approval')
})

test('shouldAbort 检查点在收尾轮之前:取消后不再发起收尾生成(纯生成无工具也省一次调用)', async () => {
  let chats = 0
  const chat = async () => {
    chats++
    if (chats <= 3) return toolCall(String(chats), 'list_resources', {})
    if (chats === 4) return { role: 'assistant', content: '第4轮工具', tool_calls: [{ id: 'c4', type: 'function', function: { name: 'list_resources', arguments: '{}' } }] }
    return { role: 'assistant', content: '收尾答案' } // chats===5 = 收尾轮
  }
  let abort = false, toolRuns = 0
  const out = await createAgent({ chat, execTool: async () => { if (++toolRuns === 4) abort = true; return 'x' }, maxSteps: 4, shouldAbort: async () => abort })
    .run({ history: [{ role: 'user', content: 'hi' }] }).catch(e => e)
  // 在第 4 个工具执行前取消 → 队列检查点抛错,不应走到 maxSteps 收尾轮(chats 停在 4,第 5 次 chat 不发起)
  assert.ok(out instanceof Error, '取消即抛错')
  assert.equal(chats, 4, '收尾轮 chat 不发起(检查点先于收尾分支)')
})
