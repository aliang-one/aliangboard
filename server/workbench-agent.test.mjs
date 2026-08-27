// SP2 Task 1: workbench-agent.mjs 单测。stub createAgentRunner + 真 :memory: db。
// 覆盖 done / paused / failed / multi-turn / resume 五条路径,验证 bus 事件序列 + db 状态。
// 纯重构守卫:这些测试锁定从 index.mjs 搬迁后的行为,未来回归即时报警。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import {
  createWorkbenchSchema,
  createProject,
  createConversation,
  getConversation,
  updateConversation,
  appendMessage,
} from './workbench-projects.mjs'
import { createWorkbenchAgent } from './workbench-agent.mjs'

// 构造 fresh db + 项目 + 对话;捕获 bus 事件到数组(可断言事件序列)。
function setup({ withPriorTurn = false } = {}) {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  const project = db.prepare("SELECT * FROM workbench_projects WHERE name='p1'").get()
  const conv = createConversation(db, { projectId: project.id, system: 'sys', userMessage: 'hi' })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })

  // 多轮:预置第 1 轮 user+assistant + 新 user 消息模拟续接
  if (withPriorTurn) {
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: '上一轮答案', trace: '[]' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: '追问' })
  }

  const events = []
  const busEmit = (id, evt) => events.push({ id, ...evt })
  const busDispose = (id) => events.push({ id, type: 'disposed' })

  // 捕获 run() 收到的 opts(含 history),测试可断言多轮上下文
  let capturedRunOpts = null
  const makeRunner = (runImpl) => ({
    createAgentRunner: () => ({
      run: async (opts) => { capturedRunOpts = opts; return runImpl(opts) },
    }),
  })

  return { db, project, conv, events, busEmit, busDispose, capturedRunOpts: () => capturedRunOpts, makeRunner }
}

// 公共 deps(buildWbCtx/buildK8sSession/fetchRefContext 都是 stub——agent loop 不测它们的内部)
const stubDeps = {
  buildWbCtx: () => ({ ctx: {} }),
  buildK8sSession: () => ({}),
  fetchRefContext: async () => '',
}

test('runConversation done: appendMessage(assistant) + busEmit(done+end) + dispose', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  const { createAgentRunner } = makeRunner(async () => ({
    status: 'done', content: 'answer', trace: [{ v: 1 }], steps: 1, messages: [], queue: [], denied: [],
  }))
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  await agent.runConversation(conv.id, { chat: async () => ({}) })

  // db:status done + assistant 消息追加
  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'done')
  assert.equal(row.content, 'answer')
  const msgs = db.prepare('SELECT role,content FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id)
  assert.equal(msgs.length, 2, 'user + assistant')
  assert.equal(msgs[1].role, 'assistant')
  assert.equal(msgs[1].content, 'answer')

  // bus:status running → status done → end → disposed(done 终态 dispose:true)
  const types = events.map(e => e.type)
  assert.ok(events.find(e => e.type === 'status' && e.status === 'running'), 'emit running')
  assert.ok(events.find(e => e.type === 'status' && e.status === 'done'), 'emit done')
  assert.ok(types.includes('end'), 'emit end')
  assert.ok(types.includes('disposed'), 'done 终态 busDispose')
})

test('runConversation paused: updateConversation(paused) + busEmit(approval+paused+end) + NOT dispose', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  const pending = { toolCallId: 'tc1', name: 'apply', args: { x: 1 } }
  const { createAgentRunner } = makeRunner(async () => ({
    status: 'pending_approval', pending,
    messages: [{ role: 'assistant', content: '审批' }],
    queue: [{ name: 'apply' }], denied: [], steps: 2,
  }))
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  await agent.runConversation(conv.id, { chat: async () => ({}) })

  // db:paused + pendingApproval 落库;不追加 assistant(done 才追加)
  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'paused')
  assert.deepEqual(JSON.parse(row.pendingApproval), pending)
  const msgs = db.prepare('SELECT role FROM workbench_messages WHERE conversationId=?').all(conv.id)
  assert.equal(msgs.length, 1, 'paused 不追加 assistant,仅首条 user')

  // bus:approval → status paused → end;无 disposed(paused dispose:false)
  const types = events.map(e => e.type)
  assert.ok(types.includes('approval'), 'emit approval')
  assert.ok(events.find(e => e.type === 'status' && e.status === 'paused'), 'emit paused')
  assert.ok(types.includes('end'), 'emit end')
  assert.ok(!types.includes('disposed'), 'paused 不 dispose(resume 续用)')
})

test('runConversation failed: catch → updateConversation(failed) + busEmit(failed+end) + dispose', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  const { createAgentRunner } = makeRunner(async () => { throw new Error('boom') })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  await agent.runConversation(conv.id, { chat: async () => ({}) })

  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'failed')
  assert.equal(row.error, 'boom')

  const types = events.map(e => e.type)
  assert.ok(events.find(e => e.type === 'status' && e.status === 'failed' && e.error === 'boom'), 'emit failed+error')
  assert.ok(types.includes('end'), 'emit end')
  assert.ok(types.includes('disposed'), 'failed 终态 busDispose')
})

test('runConversation 多轮:history 含之前轮次的 user/assistant 消息', async () => {
  const { db, conv, busEmit, busDispose, capturedRunOpts, makeRunner } = setup({ withPriorTurn: true })
  const { createAgentRunner } = makeRunner(async () => ({
    status: 'done', content: '新答案', trace: [], steps: 1, messages: [], queue: [], denied: [],
  }))
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  await agent.runConversation(conv.id, { chat: async () => ({}) })

  const opts = capturedRunOpts()
  assert.ok(opts, 'run() 被调用且捕获到 opts')
  // history 应含 3 条:首轮 user / 首轮 assistant / 新 user(续接)
  const h = opts.history
  assert.equal(h.length, 3, 'history 含 3 条消息')
  assert.equal(h[0].role, 'user')
  assert.equal(h[0].content, 'hi')
  assert.equal(h[1].role, 'assistant')
  assert.equal(h[1].content, '上一轮答案')
  assert.equal(h[2].role, 'user')
  assert.equal(h[2].content, '追问')
})

test('resumeConversation: 从 paused 续跑 → done', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  // 先把对话置为 paused(模拟 checkpoint)
  updateConversation(db, conv.id, {
    status: 'paused',
    messages: JSON.stringify([{ role: 'assistant', content: '审批?' }]),
    queue: JSON.stringify([{ name: 'apply' }]),
    denied: JSON.stringify([]),
    pendingApproval: JSON.stringify({ toolCallId: 'tc1', name: 'apply', args: {} }),
    steps: 1,
  })
  const { createAgentRunner } = makeRunner(async () => ({
    status: 'done', content: '已执行', trace: [], steps: 2, messages: [], queue: [], denied: [],
  }))
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  await agent.resumeConversation(conv.id, true, { chat: async () => ({}) })

  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'done', 'resume 后变 done')
  assert.equal(row.content, '已执行')
  // pendingApproval 清空(resume 入口 updateConversation running,pendingApproval null)
  assert.equal(row.pendingApproval, null)
})

// ═══ 用户取消(停止→修改重发):cancelConversation + agent 结果丢弃守卫 ═══
test('cancelConversation: running → cancelled + bus 事件(status cancelled + end + dispose);非运行态拒绝', async () => {
  const { db, conv, busEmit, busDispose } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner: () => ({}), busEmit, busDispose })

  const r = agent.cancelConversation(conv.id)
  assert.equal(r.ok, true)
  assert.equal(getConversation(db, conv.id).status, 'cancelled')
  assert.equal(getConversation(db, conv.id).error, '用户取消')
  assert.equal(getConversation(db, conv.id).pendingApproval, null)

  // 二次取消(已 cancelled)→ ok:false
  const r2 = agent.cancelConversation(conv.id)
  assert.equal(r2.ok, false)
  // done 态也拒绝
  updateConversation(db, conv.id, { status: 'done' })
  assert.equal(agent.cancelConversation(conv.id).ok, false)
  assert.equal(agent.cancelConversation('no-such-id').ok, false, '不存在 → ok:false')
})

test('取消后 agent 结果被丢弃:run 期间用户 cancel → 落库前守卫拦住,状态保持 cancelled 不追加历史', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  let resolveRun
  const { createAgentRunner } = makeRunner(() => new Promise(res => { resolveRun = res }))
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  const p = agent.runConversation(conv.id, { chat: async () => ({}) })
  await new Promise(r => setTimeout(r, 10))          // 等 runConversation 进入 run()
  agent.cancelConversation(conv.id)                  // 用户在 LLM 返回前取消
  resolveRun({ status: 'done', content: '迟到的答案', trace: [], steps: 1, messages: [], queue: [], denied: [] })
  await p

  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'cancelled', 'agent 完成不覆盖 cancelled')
  assert.equal(row.content ?? '', '', '迟到内容不入库')
  const msgs = db.prepare('SELECT count(*) c FROM workbench_messages WHERE conversationId=?').get(conv.id).c
  assert.equal(msgs, 1, '只保留原 user 消息,assistant 不追加')
})

// ── 意外中断内容保全(2026-08-17):用户看着流出来的答案在中断后不许蒸发 ──
// 根因:onDelta 只推 SSE 不落库,assistant 消息只在 done 追加,失败 catch 只写 status/error
// → 中断后从 workbench_messages 重建,答案消失。三层防御:catch 落部分内容/流式检查点/启动抢救。

test('runConversation 失败:已流出的部分内容落库为 assistant 消息(content+messages)', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onDelta('这是已经流出来的')
    opts.onDelta('部分答案')
    throw new Error('LLM HTTP 502: boom')
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  await agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })

  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'failed')
  assert.match(row.error, /502/)
  assert.equal(row.content, '这是已经流出来的部分答案', '部分内容保留在 conv.content')
  const msgs = db.prepare("SELECT role, content FROM workbench_messages WHERE conversationId=? ORDER BY seq").all(conv.id)
  assert.equal(msgs.at(-1).role, 'assistant', '部分答案落为 assistant 消息')
  assert.equal(msgs.at(-1).content, '这是已经流出来的部分答案', '重开对话可见,不再蒸发')
  assert.ok(events.some(e => e.type === 'status' && e.status === 'failed'))
})

test('runConversation 流式中途按 200 字符检查点写 content(进程硬死也有数据可救)', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  let midRunContent = null
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onDelta('x'.repeat(150)) // 未达阈值
    let mid1 = getConversation(db, conv.id).content
    opts.onDelta('y'.repeat(60))  // 累计 210 ≥ 200 → 检查点
    midRunContent = [mid1, getConversation(db, conv.id).content]
    return new Promise(() => {}) // 永不结束 = 模拟进程死亡前的运行态
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(midRunContent[0], null, '未达 200 字符不写库(防写放大)')
  assert.equal(midRunContent[1].length, 210, '达到阈值即检查点,run 进行中 content 已可救')
})

test('resumeConversation 失败:同样保全部分内容(审批续跑路径对称)', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, {
    status: 'paused', messages: '[]', queue: '[]', denied: '[]',
    pendingApproval: JSON.stringify({ toolCallId: 't1', name: 'wb_scale', args: {} }),
  })
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onDelta('续跑已产出')
    throw new Error('upstream dead')
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  await agent.resumeConversation(conv.id, true, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'failed')
  assert.equal(row.content, '续跑已产出')
  const msgs = db.prepare("SELECT role, content FROM workbench_messages WHERE conversationId=? ORDER BY seq").all(conv.id)
  assert.equal(msgs.at(-1).content, '续跑已产出')
})

// ── reasoning(思考过程)持久化(R1):与 content 同款三层防御,刷新/重进后 thinking 可回看 ──
test('runConversation done: reasoning 落 conv 检查点 + assistant 消息终值', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onReasoning('深度思考过程')
    return { status: 'done', content: 'answer', trace: [], steps: 1, messages: [], queue: [], denied: [] }
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  await agent.runConversation(conv.id, { chat: async () => ({}) })

  assert.equal(getConversation(db, conv.id).reasoning, '深度思考过程', 'conv 级 reasoning 落库')
  const last = db.prepare('SELECT role, reasoning FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id).at(-1)
  assert.equal(last.role, 'assistant')
  assert.equal(last.reasoning, '深度思考过程', '消息级 reasoning 落库(重建 turns 回看)')
})

test('runConversation 流式中途按 200 字符检查点写 reasoning(进程硬死 thinking 也有数据可救)', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  let midReasoning = null
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onReasoning('r'.repeat(210))
    midReasoning = getConversation(db, conv.id).reasoning
    return new Promise(() => {}) // 永不结束 = 模拟进程死亡前的运行态
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(midReasoning.length, 210, '达阈值即检查点,run 进行中 reasoning 已可救')
})

test('runConversation paused:reasoning 顺手落库(审批挂起时 <200 字尾巴不丢)', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onReasoning('想了一小段')
    return { status: 'pending_approval', pending: { toolCallId: 'tc1', name: 'apply', args: {} }, messages: [], queue: [], denied: [], steps: 1 }
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  await agent.runConversation(conv.id, { chat: async () => ({}) })
  assert.equal(getConversation(db, conv.id).reasoning, '想了一小段', 'paused 也落 reasoning 检查点')
})

// resume seed(暗坑修复):trackPartial 此前从空重新累计,续跑 200 字检查点会覆写暂停前
// 已写库的前半段——中断抢救只救得回后半。seed 化后连续累计。
test('resumeConversation:暂停前已写库的 content/reasoning 检查点不被续跑覆写', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, {
    status: 'paused', messages: '[]', queue: '[]', denied: '[]',
    pendingApproval: JSON.stringify({ toolCallId: 't1', name: 'wb_scale', args: {} }),
    content: '前半段', reasoning: '前段思考',
  })
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onDelta('后半段')
    opts.onReasoning('后段思考')
    throw new Error('died mid-resume')
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  await agent.resumeConversation(conv.id, true, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })

  const row = getConversation(db, conv.id)
  assert.equal(row.content, '前半段后半段', '前后拼接,前半段不丢')
  assert.equal(row.reasoning, '前段思考后段思考', 'reasoning 同款连续累计')
  const last = db.prepare('SELECT role, content, reasoning FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id).at(-1)
  assert.equal(last.role, 'assistant')
  assert.equal(last.content, '前半段后半段')
  assert.equal(last.reasoning, '前段思考后段思考')
})

// 取消保留部分答案(用户裁决 2026-08-19):与 failed 抢救对称——取消时已流出的
// content+reasoning 落 assistant 消息,状态保持 cancelled;无流出内容则不追加(上一测试锁定)。
test('取消后:已流出的部分内容+思考落 assistant 消息,状态保持 cancelled', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  let resolveRun
  const { createAgentRunner } = makeRunner((opts) => {
    opts.onDelta('已流出的一半')   // 取消前内容已流出(<200 字,未触发检查点)
    opts.onReasoning('想了一半')
    return new Promise(res => { resolveRun = res })
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  const p = agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  await new Promise(r => setTimeout(r, 10))
  agent.cancelConversation(conv.id)                  // 用户在 LLM 返回前取消
  resolveRun({ status: 'done', content: '迟到的完整答案', trace: [], steps: 1, messages: [], queue: [], denied: [] })
  await p

  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'cancelled', 'agent 完成不覆盖 cancelled')
  assert.equal(row.content ?? '', '', '迟到终答不写 conv 级字段')
  const msgs = db.prepare('SELECT role, content, reasoning FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id)
  assert.equal(msgs.length, 2, 'user + 部分答案')
  assert.equal(msgs.at(-1).role, 'assistant')
  assert.equal(msgs.at(-1).content, '已流出的一半', '已流出的部分答案保留,刷新不蒸发')
  assert.equal(msgs.at(-1).reasoning, '想了一半', '部分思考一并保留')
})

// ── 2026-08-27 静默终止审计:salvage 自身抛错(DB 中途损坏/锁死)不得让 runConversation ──
// reject——detached 调用点无 .catch,reject 会变 unhandledRejection 把网关进程带走
// (全站 SSE 断流,用户侧即「对话异常结束且无任何提示」的终极形态)。契约:
// 即使落库全废,busEmit(failed+end)+ dispose 事件序列必须完整发出(SSE 客户端仍能收到失败)。
test('runConversation:catch 块内 salvage 抛错 → 不 reject,failed/end/dispose 事件仍完整发出', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  // db 中途关死:salvage 的 updateConversation/appendMessage 全部抛错,模拟 DB 文件损坏/锁死
  // run 内部把 db 关死:salvage 的 updateConversation/appendMessage 全部抛错,模拟 DB 文件损坏/锁死
  const { createAgentRunner } = makeRunner(async () => {
    db.close()
    throw new Error('LLM HTTP 502: upstream down')
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  // 修复前:salvage 的 DB 异常穿透 reject(unhandledRejection);修复后:resolve 且事件序列完整
  await agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })

  const types = events.map(e => e.type)
  assert.ok(events.find(e => e.type === 'status' && e.status === 'failed' && /502/.test(e.error || '')), 'emit failed(带原始错误)')
  assert.ok(types.includes('end'), 'emit end')
  assert.ok(types.includes('disposed'), 'bus dispose')
})

test('resumeConversation:catch 块内 salvage 抛错 → 不 reject,failed/end/dispose 事件仍完整发出', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, {
    status: 'paused', messages: '[]', queue: '[]', denied: '[]',
    pendingApproval: JSON.stringify({ toolCallId: 't1', name: 'wb_exec', args: {} }), steps: 1,
  })
  const { createAgentRunner } = makeRunner(async () => {
    db.close()
    throw new Error('boom')
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  await agent.resumeConversation(conv.id, true, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })

  const types = events.map(e => e.type)
  assert.ok(events.find(e => e.type === 'status' && e.status === 'failed'), 'emit failed')
  assert.ok(types.includes('end'), 'emit end')
  assert.ok(types.includes('disposed'), 'bus dispose')
})
