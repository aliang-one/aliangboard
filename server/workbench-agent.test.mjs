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
// ── 2026-08-27 一致性审计:旧轮检查点回灌窗口 ──
// resetRound 此前只清内存,DB conv.content 滞留旧轮最后检查点;窗口内(assistant 事件后、
// 新轮首个 200 字检查点前)重连 snapshot / 降级轮询(R3)会把旧轮 partial 当「当前轮流式
// 文本」回灌前端——与旧轮 assistant chip 双显,后续 delta 还会拼在旧文本尾。
// 修复契约:resetRound 同步落库清零;所有读取方均有空值守卫(salvage/R3/snapshot),空值零副作用。
test('resetRound:assistant 轮完成即持久化清零 conv.content/reasoning(旧轮尾巴不滞留 DB)', async () => {
  const { db, conv, makeRunner } = setup()
  let midRun = null
  const { createAgentRunner } = makeRunner(async (opts) => {
    // 第 1 轮:流出 250 字(过 200 阈值,检查点已落库)
    opts.onDelta('A'.repeat(250))
    assert.equal(getConversation(db, conv.id).content, 'A'.repeat(250), '250 字检查点已写库')
    // assistant 轮完成 → resetRound(此刻须同步清 DB)
    opts.onStep({ type: 'assistant', message: { role: 'assistant', content: '第一轮文本' }, ts: 1 })
    midRun = getConversation(db, conv.id)
    // 第 2 轮:流出 100 字(< 200 阈值,不应触发检查点写库)
    opts.onDelta('B'.repeat(60))
    assert.equal(getConversation(db, conv.id).content, '', '新轮 <200 字不触发检查点,DB 无旧轮回灌源')
    return { status: 'done', content: '终答', steps: 2, messages: [], queue: [], denied: [] }
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit: () => {}, busDispose: () => {} })
  await agent.runConversation(conv.id, { chat: async () => ({}) })
  assert.equal(midRun.content, '', 'assistant 轮完成时 DB 检查点同步清零(窗口闭合)')
  assert.equal(midRun.reasoning, '', 'reasoning 同步清零')
  assert.equal(getConversation(db, conv.id).content, '终答', 'done 终值照常落库(清零不破坏终态写入)')
})

// ── 2026-08-27 一致性审计:trace/SSE 工具结果无界 ──
// get_resource/describe 返回全量 K8s 对象;onStep 此前把原始 result 原样 appendTrace 落库
// + busEmit 推流 → conv.trace 随大对象线性膨胀,GET /:id(降级 2s/看门狗 10s 轮询)与
// turnSnapshot(重连)载荷放大。修复:持久化/推流前按 32KB 截断(带标记);LLM feed 不受影响
// (agent.mjs clampToolContent 独立钳制)。
test('trace 工具结果超限截断:DB 与 SSE step 事件均存截断版,LLM feed 用原始 result', async () => {
  const { db, conv, events, makeRunner } = setup()
  const bigResult = { resource: { kind: 'ConfigMap', data: { big: 'x'.repeat(200_000) } } }
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onStep({ type: 'tool', name: 'wb_get_resource', args: { kind: 'configmaps', name: 'cm1' }, result: bigResult, ts: 1 })
    return { status: 'done', content: 'ok', steps: 1, messages: [], queue: [], denied: [] }
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit: (id, e) => events.push({ id, ...e }), busDispose: () => {} })
  await agent.runConversation(conv.id, { chat: async () => ({}) })

  // DB 对话级 trace:截断版(字符串 + truncated 标记)
  const trace = JSON.parse(getConversation(db, conv.id).trace)
  assert.equal(trace.length, 1)
  const toolEv = trace[0]
  assert.equal(toolEv.resultTruncated, true, '带截断标记')
  assert.ok(typeof toolEv.result === 'string' && toolEv.result.length < 40_000, 'result 为截断串')
  assert.ok(toolEv.resultOriginalBytes > 200_000, '记录原始字节数')
  // 消息级 trace(done 落库)同款截断
  const asst = db.prepare("SELECT trace FROM workbench_messages WHERE conversationId=? AND role='assistant'").get(conv.id)
  const msgTrace = JSON.parse(asst.trace)
  assert.equal(msgTrace[0].resultTruncated, true, '消息级 trace 同步截断')
  // SSE step 事件推的也是截断版
  const stepEvt = events.find(e => e.type === 'step' && e.step?.type === 'tool')
  assert.equal(stepEvt.step.resultTruncated, true, 'SSE step 事件同步截断')
})

// T2:裁剪预算注入到达 runner(llmClient.model → 窗口 → 70% 折算)
test('runConversation: budgetChars 按 llmClient.model 派生传入 runner', async () => {
  const { db, conv, busEmit, busDispose } = setup()
  let capturedBudget = null
  const createAgentRunner = (opts) => { capturedBudget = opts.budgetChars; return { run: async () => ({ status: 'done', content: 'ok', steps: 1, messages: [], queue: [], denied: [] }) } }
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  const llmClient = { chat: async () => ({}), model: 'qwen-max' }   // 128k 窗口
  await agent.runConversation(conv.id, llmClient)
  assert.equal(capturedBudget, 179_200, '128k×0.7×2=179200 字符')
})

// ── 项目记忆 T2:refreshSystem 拼入 projectRecap;projectMemory=false 不拼 ──
test('runConversation:projectRecap 拼入 refreshSystem 产物;projectMemory=false 不拼', async () => {
  const { db, conv, capturedRunOpts, makeRunner } = setup()
  db.prepare('UPDATE workbench_projects SET projectRecap=? WHERE id=?').run('定了用 nginx ingress', conv.projectId)
  const { createAgentRunner } = makeRunner(async () => ({ status: 'done', content: 'ok', steps: 1, messages: [], queue: [], denied: [] }))
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit: () => {}, busDispose: () => {} })
  await agent.runConversation(conv.id, { chat: async () => ({}), model: 'mock-1' })
  const sys = await capturedRunOpts().refreshSystem()
  assert.ok(sys.includes('[Project memory — 之前对话的决策摘要](历史经验供参考;工具与能力以本轮实际提供的为准)'), '注入标记(带 caveat)')
  assert.ok(sys.includes('定了用 nginx ingress'))
  // 开关关(platform_settings 直写 'false',与 admin setSetting 同存储)再跑一条新对话 → 不含标记
  db.exec('CREATE TABLE IF NOT EXISTS platform_settings ( key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER NOT NULL )')
  db.prepare("INSERT INTO platform_settings (key,value,updatedAt) VALUES ('workbench.projectMemory','false',?)").run(Date.now())
  const conv2 = createConversation(db, { projectId: conv.projectId, system: 'sys', userMessage: 'q2' })
  await agent.runConversation(conv2.id, { chat: async () => ({}), model: 'mock-1' })
  const sys2 = await capturedRunOpts().refreshSystem()
  assert.ok(!sys2.includes('[Project memory'), '关开关不注入')
})

// 检查点时间维度(2026-08-29):200 字或 500ms 任一触发——中途刷新当前轮滞后从 200 字压到半秒。
test('runConversation 检查点时间维度:两条 60 字 delta 间隔 >500ms 也落库;阈值守卫仍在', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  const probe = {}
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onDelta('A'.repeat(60)) // 不足 200 字 → 字数阈值不触发
    probe.afterA = getConversation(db, conv.id).content
    await new Promise(r => setTimeout(r, 600))
    opts.onDelta('B'.repeat(60)) // 仍不足 200,但距上次检查点 >500ms → 时间维度触发
    const ckAtB = Date.now()
    probe.afterB = getConversation(db, conv.id).content
    opts.onDelta('C'.repeat(60)) // flush 后立即:字数不足且 <500ms → 不落库
    probe.guardWindowMs = Date.now() - ckAtB // 自证守卫断言时间窗口有效
    probe.afterC = getConversation(db, conv.id).content
    return new Promise(() => {}) // 模拟运行态(中途刷新观察窗口)
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' }) // 不 await:runImpl 永不结束
  await new Promise(r => setTimeout(r, 800)) // 等 runImpl 走完三段
  assert.equal(probe.afterA, null, '首条 60 字未过阈值不落库')
  assert.ok(probe.afterB.includes('B'), '时间维度生效:>500ms 后第二条 delta 已检查点落库')
  assert.ok(probe.guardWindowMs < 500, `守卫窗口自证有效(${probe.guardWindowMs}ms < 500ms)`)
  assert.ok(!probe.afterC.includes('C'), '阈值守卫仍在:flush 后 <500ms 且 <200 字不落库')
})

// ── A2 回顾审计:done 后补 fire maybeSummarizeProject(finalize 之后,不阻塞 SSE;水位幂等)──
// 场景:预置 7 条项目 history,run done 追加 user+assistant=9 ≥8 → 轮询 DB 断言 projectRecap 落库。
test('A2:run done 后 fire 项目摘要——7 条预置 + done 追加 2 = 9 ≥8,projectRecap 落库', async () => {
  const { db, project, conv, busEmit, busDispose, makeRunner } = setup()
  // 显式 ts 裸 INSERT(避免 appendHistory 的 Date.now() 同毫秒并列,水位排序稳定)
  for (let i = 0; i < 7; i++) {
    db.prepare('INSERT INTO workbench_history (projectId,role,content,ts) VALUES (?,?,?,?)')
      .run(project.id, i % 2 ? 'assistant' : 'user', `预置历史 ${i + 1}`, 1_000_000 + i)
  }
  const { createAgentRunner } = makeRunner(async () => ({
    status: 'done', content: 'answer', trace: [], steps: 1, messages: [], queue: [], denied: [],
  }))
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  await agent.runConversation(conv.id, { chat: async () => ({ content: '项目摘要X' }), model: 'mock-1' })

  // fire 非 await(done 事件已先行)——行为面轮询 DB ≤2s
  const deadline = Date.now() + 2000
  let recap = null
  while (Date.now() < deadline) {
    recap = db.prepare('SELECT projectRecap FROM workbench_projects WHERE id=?').get(project.id)?.projectRecap ?? null
    if (recap) break
    await new Promise(r => setTimeout(r, 25))
  }
  assert.equal(recap, '项目摘要X', 'done 后项目摘要异步落库')
  // done 本身不受 fire 阻塞/失败影响(状态与消息先行落定)
  assert.equal(getConversation(db, conv.id).status, 'done')
})
