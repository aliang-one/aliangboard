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
import { createLlmClient } from './llm.mjs' // fix round 1:总限 DB 级测试驱动真 chatStream(滴流桩)

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

  // 捕获 run() 收到的 opts(含 history),测试可断言多轮上下文;顺带捕获 createAgentRunner
  // 的装配参数(excludeTools/dynamicApproval 等)供 offering 契约测试断言
  let capturedRunOpts = null
  let capturedRunnerArgs = null
  const makeRunner = (runImpl) => ({
    createAgentRunner: (args) => {
      capturedRunnerArgs = args
      return {
        run: async (opts) => { capturedRunOpts = opts; return runImpl(opts) },
      }
    },
  })

  return { db, project, conv, events, busEmit, busDispose, capturedRunOpts: () => capturedRunOpts, capturedRunnerArgs: () => capturedRunnerArgs, makeRunner }
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
  // gap3-02:落库载荷=原审批对象+clusterId 戳(创建时项目绑定集群,夹具 c1)
  assert.deepEqual(JSON.parse(row.pendingApproval), { ...pending, clusterId: 'c1' })
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

// W2 审计 P0-①(2026-09-07):授权主体恒取 conv→project.ownerId(spec §6.3「不得把当前管理员
// 身份误当项目 owner」)——admin 代触发/代审批他人对话不得继承 admin 全权;逐调用门以 owner
// 的 userId 现查 DB 执法(authz 不信任 principal.role,userId 即授权线程)。actor 仅审计留痕。
test('run: admin 代触发 → buildWbCtx principal 仍为 project.ownerId(不继承 admin 全权)', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  const { createAgentRunner } = makeRunner(async () => ({
    status: 'done', content: 'answer', trace: [], steps: 1, messages: [], queue: [], denied: [],
  }))
  const principals = []
  const agent = createWorkbenchAgent({
    db,
    buildWbCtx: (project, principal) => { principals.push(principal); return { ctx: {} } },
    buildK8sSession: () => ({}),
    fetchRefContext: async () => '',
    createAgentRunner, busEmit, busDispose,
  })

  await agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'admin1', username: 'admin1', role: 'admin' })

  assert.equal(principals.length, 1)
  assert.equal(principals[0].userId, 'u1', 'principal 必须是 project.ownerId(u1),不是触发者 admin')
})

test('resume(审批续跑): admin 审批他人对话 → principal 仍为 project.ownerId', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
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
  const principals = []
  const agent = createWorkbenchAgent({
    db,
    buildWbCtx: (project, principal) => { principals.push(principal); return { ctx: {} } },
    buildK8sSession: () => ({}),
    fetchRefContext: async () => '',
    createAgentRunner, busEmit, busDispose,
  })

  await agent.resumeConversation(conv.id, true, { chat: async () => ({}) }, { userId: 'admin1', username: 'admin1', role: 'admin' })

  assert.equal(principals.length, 1)
  assert.equal(principals[0].userId, 'u1', '审批续跑的授权主体必须是 owner——一次审批不得解锁 admin 全权')
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

// 回归(2026-09-06「对话尾巴不展示」排查):resume 的 onStep 原缺 turnTrace 累积 + resetRound——
// 续跑段多轮时 partial 跨轮累积,失败 salvage 把多轮拼接串整体落一条消息(生产实例:408=26+212+50+7+113),
// 且消息级 trace 从 conv.trace 拉全对话累积(历史轮事件污染本轮渲染)。契约对齐 run 路径:
// ① assistant 轮完成即清零 partial(抢救内容只含当前轮)②消息 trace 只含本段事件。
test('resumeConversation 多轮:assistant 轮完成清零 partial + 消息 trace 只含本段事件', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, {
    status: 'paused', messages: '[]', queue: '[]', denied: '[]',
    pendingApproval: JSON.stringify({ toolCallId: 't1', name: 'wb_scale', args: {} }),
    // 预置历史轮事件:resume 落库的消息 trace 不得再包含(conv.trace 全量拉取是污染源)
    trace: JSON.stringify([{ type: 'assistant', message: { role: 'assistant', content: '历史轮文本' }, ts: 0 }]),
  })
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onDelta('第一轮文本')                                                      // 轮 1 流式中
    opts.onStep({ type: 'assistant', message: { role: 'assistant', content: '第一轮文本' }, ts: Date.now() + 1 }) // 轮 1 完成
    opts.onStep({ type: 'tool', name: 'wb_scale', args: {}, result: 'ok', ts: Date.now() + 2 })
    opts.onDelta('第二轮尾巴')                                                      // 轮 2 流式中(未完成即失败)
    throw new Error('LLM HTTP 400: messages 参数非法')
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  await agent.resumeConversation(conv.id, true, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })

  const last = db.prepare('SELECT content, trace FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id).at(-1)
  assert.equal(last.content, '第二轮尾巴', 'assistant 轮完成即清零:抢救内容只含当前轮,无历史轮拼接')
  const trace = JSON.parse(last.trace || '[]')
  // 末尾 assistant = 终答兜底块(2026-09-06):未完成轮的流出文本补块,交错模式可见
  assert.deepEqual(trace.map(e => e.type), ['assistant', 'tool', 'assistant'], '本段事件 + 终答兜底块(不含预置历史轮)')
  assert.equal(trace.at(-1).content, '第二轮尾巴', '兜底块内容 = 已流出尾巴')
  assert.ok(!JSON.stringify(trace).includes('历史轮文本'), '历史轮事件不污染本轮消息 trace')
})

// ── 终答兜底块(2026-09-06「对话尾巴不展示」修复核心)──
// 轮未完成(失败/取消/硬断)时已流出的文本只活在 content——没有 assistant step 事件 →
// trace 无对应块 → 前端交错渲染模式只渲染 trace 块,尾巴对用户永久不可见(生产 31% 近期
// 消息中招)。契约:三条落库路径(salvage/cancelled/done)凡 content 非空且 trace 末尾无
// 同文 assistant 块,一律补 {type:'assistant', content} 块。纯函数 ensureFinalTraceBlock。
test('ensureFinalTraceBlock:末尾无同文块 → 补;有 → 不重复;content 空 → 原样', async () => {
  const { ensureFinalTraceBlock } = await import('./workbench-agent.mjs')
  // 无块 → 补
  assert.deepEqual(ensureFinalTraceBlock('尾巴文本', [{ type: 'tool', name: 'x' }]),
    [{ type: 'tool', name: 'x' }, { type: 'assistant', content: '尾巴文本' }])
  // 末尾同文块已在 → 不重复(正常 done 路径)
  const withBlock = [{ type: 'assistant', content: '终答' }]
  assert.deepEqual(ensureFinalTraceBlock('终答', withBlock), withBlock)
  // content 空 → 原样(reasoning-only 抢救不补空块)
  assert.deepEqual(ensureFinalTraceBlock('', withBlock), withBlock)
  // 兼容 conv.trace 全量形状(message.content 嵌套)的同文判定
  const legacy = [{ type: 'assistant', message: { content: '旧形状终答' } }]
  assert.deepEqual(ensureFinalTraceBlock('旧形状终答', legacy), legacy)
})

test('salvage 落库补终答块:失败时已流出文本在交错模式可见', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onDelta('这是已经流出来的部分答案')
    throw new Error('LLM HTTP 502: boom')
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  await agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  const last = db.prepare('SELECT content, trace FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id).at(-1)
  const trace = JSON.parse(last.trace || '[]')
  const tailBlock = trace.filter(e => e?.type === 'assistant' && e.content).at(-1)
  assert.ok(tailBlock, '失败轮无 step 事件,须补 assistant 块')
  assert.equal(tailBlock.content, last.content, '补块内容 = 已流出文本')
})

test('done 落库终答兜底:硬断文案无 assistant step 事件 → 补块(交错模式可见,不再静默结束)', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  // 模拟旧硬断/异常:run 直接返回终态文本,但从未发 assistant step 事件(trace 无终答块)
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onStep({ type: 'tool', name: 'wb_exec', args: {}, result: 'ok', ts: 1 })
    return { status: 'done', content: '(达到最大步数,未给出终答)', steps: 2, messages: [], queue: [], denied: [], truncated: true }
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  await agent.runConversation(conv.id, { chat: async () => ({}) })
  const msgs = db.prepare('SELECT content, trace FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id)
  const trace = JSON.parse(msgs.at(-1).trace || '[]')
  assert.ok(trace.some(e => e?.type === 'assistant' && e.content === '(达到最大步数,未给出终答)'), '终答文本有 trace 块,交错模式可见')
})

test('取消落库补终答块:cancelled 路径已流出文本同样可见', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  let resolveRun
  const { createAgentRunner } = makeRunner((opts) => {
    opts.onDelta('已流出的一半')
    return new Promise(res => { resolveRun = res })
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  const p = agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  await new Promise(r => setTimeout(r, 10))
  agent.cancelConversation(conv.id)
  resolveRun({ status: 'done', content: '迟到的完整答案', trace: [], steps: 1, messages: [], queue: [], denied: [] })
  await p
  const last = db.prepare('SELECT content, trace FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id).at(-1)
  const trace = JSON.parse(last.trace || '[]')
  assert.ok(trace.some(e => e?.type === 'assistant' && e.content === '已流出的一半'), '取消时已流出文本有 trace 块')
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
// 桩形状修正(2026-09-07 审计 cancel-races-01):旧桩在 onDelta 后直接 resolve、从不发
// assistant step——而真实 agent 循环每轮 chat 完成必发 onStep({type:'assistant'})(agent.mjs
// 246-248),取消拦不断在途流,主流时序「看长答案中途点停止→流自然完成→assistant step 到达→
// resetRound 清零+检查点抹空」恰恰被旧桩形状掩蔽(保留分支读到空 partial,半截答案刷新蒸发)。
// 教训:锁定取消语义的桩必须复刻真实循环的必发事件,「桩比真实循环少发一个事件」= 假绿。
test('取消后:已流出的部分内容+思考落 assistant 消息,状态保持 cancelled(真实循环形状:取消后流自然完成必发 assistant step)', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  const HEAD = '已流出的前半段。'.repeat(30)   // 240 字 ≥200:取消前流式检查点已把 conv.content 落库
  const TAIL = '取消后残余尾巴'                 // 取消后到达的残余流(在途流不可中断,已知边界)
  let resolveRun, runOpts
  const { createAgentRunner } = makeRunner((opts) => {
    runOpts = opts
    opts.onReasoning('想了一半')                // 取消前:思考先流
    opts.onDelta(HEAD)                          // 取消前:正文过阈触发检查点
    return new Promise(res => { resolveRun = res })
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  const p = agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  await new Promise(r => setTimeout(r, 10))
  agent.cancelConversation(conv.id)                  // 用户在答案流到一半时点「停止」
  runOpts.onDelta(TAIL)                              // 在途流继续:残余 delta 取消后照常到达
  runOpts.onStep({ type: 'assistant', message: { role: 'assistant', content: HEAD + TAIL }, ts: Date.now() + 1 }) // 真实循环:轮完成必发
  resolveRun({ status: 'done', content: '迟到的完整答案', trace: [], steps: 1, messages: [], queue: [], denied: [] })
  await p

  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'cancelled', 'agent 完成不覆盖 cancelled')
  const msgs = db.prepare('SELECT role, content, reasoning FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id)
  assert.equal(msgs.length, 2, 'user + 部分答案')
  assert.equal(msgs.at(-1).role, 'assistant')
  assert.equal(msgs.at(-1).content, HEAD + TAIL, '已流出部分(含取消后残余)落 assistant 消息,刷新不蒸发')
  assert.equal(msgs.at(-1).reasoning, '想了一半', '部分思考一并保留')
  assert.equal(row.content, HEAD, 'conv.content 检查点不被 resetRound 抹空(重启抢救仍有数据;迟到终答亦不写 conv 级字段)')
})

// 用例 A(审计 cancel-races-01 多轮变体):cancel 落在工具执行段——上一轮 assistant step 已发过、
// resetRound 已正常清零一次(证明保留是「取消后到达的 step 不清零」,而非清零从未发生的假绿);
// 当前轮 chat 已在检查点② 之后在途,取消后自然完成 → assistant step 取消后到达 → 不得清零;
// 随后轮 2 的 tool_calls 开头检查点① 取消抛错走 catch → cancelledCatchGuard 读到保留的当前轮 partial。
test('多轮 run:cancel 落在工具执行段(上轮 assistant step 已发过)→ 当前轮已流出文本仍保留落库', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  const CUR = '当前轮已流出的一半'.repeat(30)   // 300 字 ≥200:取消后残余流仍过检查点(纯取消不拦写)
  let failRun, runOpts
  const { createAgentRunner } = makeRunner((opts) => {
    runOpts = opts
    // 轮 1:流式 + 完成(真实循环:每轮 chat 完成必发 assistant step)→ 此刻未取消,resetRound 正常清零
    opts.onDelta('第一轮分析文本')
    opts.onStep({ type: 'assistant', message: { role: 'assistant', content: '第一轮分析文本' }, ts: Date.now() + 1 })
    // 轮 1 的 tool_calls 执行段(tool_start 瞬态只推流不落库)
    opts.onStep({ type: 'tool_start', name: 'wb_scale', args: {}, ts: Date.now() + 2 })
    opts.onStep({ type: 'tool', name: 'wb_scale', args: {}, result: 'scaled', ts: Date.now() + 3 })
    // 轮 2 chat 已在途(检查点② 已过)——挂起等测试驱动残余流
    return new Promise((_, rej) => { failRun = rej })
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  const p = agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' }).catch(e => e)
  await new Promise(r => setTimeout(r, 10))
  agent.cancelConversation(conv.id)                  // cancel 落点 = 工具执行段(轮 2 流已在途不可中断)
  runOpts.onDelta(CUR)                               // 轮 2 残余流:取消后到达,过阈检查点照写(保留数据来源)
  runOpts.onStep({ type: 'assistant', message: { role: 'assistant', content: CUR }, ts: Date.now() + 4 }) // 轮 2 取消后自然完成
  failRun(new Error('对话已取消,中止工具执行'))      // 真实循环:轮 2 tool_calls 开头检查点① 取消抛错 → catch
  await p

  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'cancelled', '状态保持 cancelled(catch 走 cancelled 分支,不写 failed)')
  assert.equal(row.content, CUR, 'conv.content 检查点不被取消后到达的 resetRound 抹空')
  const msgs = db.prepare('SELECT role, content, trace FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id)
  assert.equal(msgs.at(-1).role, 'assistant', '当前轮 partial 落 assistant 消息')
  assert.equal(msgs.at(-1).content, CUR, '当前轮已流出文本保留落库(上轮 step 已清零过,不靠跨轮累积)')
  const trace = JSON.parse(msgs.at(-1).trace || '[]')
  assert.ok(trace.some(e => e?.type === 'assistant' && e.content === '第一轮分析文本'), '消息级 trace 保留轮 1 文本(交错渲染不断章)')
  assert.ok(trace.some(e => e?.type === 'assistant' && e.content === CUR), '消息级 trace 保留轮 2 文本')
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
  // context-assembly-05(2026-09-07 审计批次三)校准:按 CJK 最坏密度(1 token/字)折算——
  // 旧 ×2(2字/token 折中)对纯中文超发 2 倍预算,硬裁兜底失效。
  assert.equal(capturedBudget, 89_600, '128k×0.7=89600 字符(CJK 最坏密度校准)')
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

// ── context-assembly-07(2026-09-07 审计批次三):regenerate 不重复落项目历史提问 ──
// done 链路 handleAgentResult 每轮 append user(conv.userMessage)+assistant;regenerate 重答
// 同问(userMessage 不变、messages 截断由路由负责)会把同一提问再落一行 → 项目摘要输入读成
// Q/A1/Q/A2。契约:appendHistory 同角色同文本紧邻去重 → 提问单条、两轮答案各留。
test('regenerate(done×2 同问)→ 项目历史提问单条(context-assembly-07)', async () => {
  const { db, project, conv, busEmit, busDispose, makeRunner } = setup()
  let call = 0
  const { createAgentRunner } = makeRunner(async () => {
    call++
    return { status: 'done', content: `答案${call}`, trace: [], steps: 1, messages: [], queue: [], denied: [] }
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  await agent.runConversation(conv.id, { chat: async () => ({}) })
  // regenerate:同问重跑(userMessage 'hi' 不变;截断/复位由路由负责,此处直证 done 落 history 链路)
  await agent.runConversation(conv.id, { chat: async () => ({}) })
  const n = role => db.prepare('SELECT COUNT(*) n FROM workbench_history WHERE projectId=? AND role=?').get(project.id, role).n
  assert.equal(n('user'), 1, '提问单条(regenerate 重答不重复落 user 行)')
  assert.equal(n('assistant'), 2, '两轮答案各自落库')
})

// ═══ 终审 I5:P0(F) 不变式对流式运行无效——DELETE 项目后 in-flight run 的结果不许写孤儿行 ═══
// 路由在 DELETE 时已 cancelConversation(置 cancelled)并删行,但 in-flight run 的取消守卫读
// getConversation(id)?.status === 'cancelled' → 行已不在 → undefined → 放行落 handleAgentResult/
// salvagePartial,把终态/assistant 消息/项目历史写进已删的孤儿行。存在性守卫在一处同时关掉
// 「删对话」与「删项目」两条路由。
const deletedRowCounts = (db, convId) => ({
  conv: db.prepare('SELECT count(*) c FROM workbench_conversations WHERE id=?').get(convId).c,
  msgs: db.prepare('SELECT count(*) c FROM workbench_messages WHERE conversationId=?').get(convId).c,
  history: db.prepare('SELECT count(*) c FROM workbench_history').get().c,
})

test('I5:对话被删后 run done → handleAgentResult 零写入(无孤儿终态/消息/历史)', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  let baseline = null
  const { createAgentRunner } = makeRunner(async () => {
    baseline = deletedRowCounts(db, conv.id)                                    // 删除前基线(含首条 user 消息)
    db.prepare('DELETE FROM workbench_conversations WHERE id=?').run(conv.id)  // 模拟 DELETE 项目/对话提交
    return { status: 'done', content: '迟到的终答', trace: [], steps: 3, messages: [], queue: [], denied: [] }
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  await agent.runConversation(conv.id, { chat: async () => ({}) })

  const c = deletedRowCounts(db, conv.id)
  assert.equal(c.conv, 0, '行保持已删,不被复活')
  assert.equal(c.msgs, baseline.msgs, '消息零增长:不追加孤儿 assistant 消息')
  assert.equal(c.history, baseline.history, '项目历史零增长')
})

test('I5:对话被删后 run 失败 → salvagePartial 零写入(无孤儿 partial 抢救)', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  let baseline = null
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onDelta('已流出的部分')      // tracker 有 partial → 无守卫时会落 assistant 消息
    baseline = deletedRowCounts(db, conv.id)
    db.prepare('DELETE FROM workbench_conversations WHERE id=?').run(conv.id)
    throw new Error('LLM HTTP 502: boom')
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  await agent.runConversation(conv.id, { chat: async () => ({}) })

  const c = deletedRowCounts(db, conv.id)
  assert.equal(c.conv, 0)
  assert.equal(c.msgs, baseline.msgs, '部分内容不写孤儿行')
  // catch 块后续的 failed+end 事件照发(salvage 静默返回不打断事件链)
  assert.ok(events.some(e => e.type === 'status' && e.status === 'failed'), 'failed 事件照发')
  assert.ok(events.some(e => e.type === 'end'), 'end 事件照发')
})

// ===== SSH offering 契约(2026-09-01 接线事故回归钉)=====
// 生产者形状:index.mjs buildWbCtx 必须把 ssh/sshJobs 挂进 ctx(形状由
// workbench-ctx-wiring.test.mjs 静态守卫锁死);本组测试锁定消费方契约——
// exposedCount 只随 ctx.ssh.listExposed() 变化,有暴露服务器时 SSH 工具不得被剔除。
const DONE = { status: 'done', content: 'ok', trace: [], steps: 1, messages: [], queue: [], denied: [] }
const producerShapedDeps = (sshBridge, sshJobs = null) => ({
  buildWbCtx: () => ({ ctx: { ...(sshBridge ? { ssh: sshBridge } : {}), ...(sshJobs ? { sshJobs } : {}) } }),
  buildK8sSession: () => ({}),
  fetchRefContext: async () => '',
})
const fakeBridge = (exposed) => ({ listExposed: () => exposed, needsApproval: async () => false })

test('SSH offering:有暴露服务器 → excludeTools 为 null(SSH 工具不被剔除)+ 动态审批路由在场', async () => {
  const { db, conv, busEmit, busDispose, capturedRunnerArgs, makeRunner } = setup()
  const { createAgentRunner } = makeRunner(async () => DONE)
  const agent = createWorkbenchAgent({ db, ...producerShapedDeps(fakeBridge([{ id: 's1', name: 'srv1' }])), createAgentRunner, busEmit, busDispose })

  await agent.runConversation(conv.id, { chat: async () => ({}) })

  const args = capturedRunnerArgs()
  assert.equal(args.excludeTools, null, 'exposedCount≥1 → 不得剔除任何 SSH 工具')
  assert.ok(typeof args.dynamicApproval === 'function', 'sshBridge 在场 → routeDynamicApproval 必须接线')
})

test('SSH offering:零暴露 → excludeTools 恰含 SSH_HIDDEN_TOOLS 全集', async () => {
  const { SSH_HIDDEN_TOOLS } = await import('./tool-registry.mjs')
  const { db, conv, busEmit, busDispose, capturedRunnerArgs, makeRunner } = setup()
  const { createAgentRunner } = makeRunner(async () => DONE)
  const agent = createWorkbenchAgent({ db, ...producerShapedDeps(fakeBridge([])), createAgentRunner, busEmit, busDispose })

  await agent.runConversation(conv.id, { chat: async () => ({}) })

  const got = capturedRunnerArgs().excludeTools
  assert.ok(got instanceof Set, '零暴露必须返回剔除集合')
  for (const n of SSH_HIDDEN_TOOLS) assert.ok(got.has(n), `零暴露必须剔除 ${n}`)
})

test('SSH offering:无 ctx.ssh(未接线)→ fail-closed 剔除全集,而非放行', async () => {
  const { SSH_HIDDEN_TOOLS } = await import('./tool-registry.mjs')
  const { db, conv, busEmit, busDispose, capturedRunnerArgs, makeRunner } = setup()
  const { createAgentRunner } = makeRunner(async () => DONE)
  const agent = createWorkbenchAgent({ db, ...producerShapedDeps(null), createAgentRunner, busEmit, busDispose })

  await agent.runConversation(conv.id, { chat: async () => ({}) })

  const got = capturedRunnerArgs().excludeTools
  assert.ok(got instanceof Set, 'sshBridge 缺席(接线断裂)必须 fail-closed')
  for (const n of SSH_HIDDEN_TOOLS) assert.ok(got.has(n), `接线断裂必须剔除 ${n}`)
})

// ═══ 2026-09-06 审计#3 轻量取消中止:shouldAbort 装配 + catch 块 cancelled 分支 ═══
// 根因:cancelConversation 只置 DB cancelled+发 SSE,agent 循环无人查它——用户点「停止」后
// 队列剩余工具与后续 LLM 轮照跑(工具副作用不该继续发生)。契约三层:①run/resume 装配
// runner 时传 shouldAbort(读对话状态);②agent 循环两检查点(工具开头/chat 前)取消即抛;
// ③catch 块开头走 cancelled 分支(与落库前 cancelled 守卫同款保留,不发 failed 不 safeSalvage)。
const PAUSED = { status: 'paused', messages: '[]', queue: '[]', denied: '[]', pendingApproval: JSON.stringify({ toolCallId: 't1', name: 'wb_scale', args: {} }) }

test('取消中止装配:run/resume 均传 shouldAbort(函数,按对话取消态返回布尔)', async () => {
  const { db, conv, busEmit, busDispose, capturedRunnerArgs, makeRunner } = setup()
  const { createAgentRunner } = makeRunner(async () => DONE)
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  await agent.runConversation(conv.id, { chat: async () => ({}) })
  const runArgs = capturedRunnerArgs()
  assert.equal(typeof runArgs.shouldAbort, 'function', 'run 装配须传 shouldAbort 函数')
  assert.equal(runArgs.shouldAbort(), false, '非取消态返回 false')

  updateConversation(db, conv.id, { status: 'cancelled' })
  assert.equal(runArgs.shouldAbort(), true, '取消态返回 true')

  // resume 同款装配(convId 闭包可用)
  updateConversation(db, conv.id, PAUSED)
  await agent.resumeConversation(conv.id, true, { chat: async () => ({}) })
  const resumeArgs = capturedRunnerArgs()
  assert.equal(typeof resumeArgs.shouldAbort, 'function', 'resume 装配须传 shouldAbort 函数')
  assert.equal(resumeArgs.shouldAbort(), false, 'paused(非 cancelled)返回 false')
  updateConversation(db, conv.id, { status: 'cancelled' })
  assert.equal(resumeArgs.shouldAbort(), true, '取消态返回 true')
})

test('取消中止:run 期间被取消(run 抛错)→ catch 走 cancelled 分支——状态保持 cancelled、partial 落 assistant(含终答兜底块)、无 failed 事件', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onDelta('已流出的尾巴')
    // 模拟 run 期间用户点停止:DB 置 cancelled(真实链路=shouldAbort 检查点抛错落 catch)
    updateConversation(db, conv.id, { status: 'cancelled' })
    throw new Error('对话已取消,中止工具执行')
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  await agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })

  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'cancelled', '状态保持 cancelled(不被 failed 覆写)')
  const msgs = db.prepare('SELECT role, content, trace FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id)
  assert.equal(msgs.at(-1).role, 'assistant', '已流出 partial 落 assistant 消息')
  assert.equal(msgs.at(-1).content, '已流出的尾巴', '部分内容保留,刷新不蒸发')
  const trace = JSON.parse(msgs.at(-1).trace || '[]')
  assert.ok(trace.some(e => e?.type === 'assistant' && e.content === '已流出的尾巴'), 'trace 含终答兜底块(交错模式可见)')
  assert.ok(!events.some(e => e.type === 'status' && e.status === 'failed'), '不发 failed 事件(cancelConversation 已发 cancelled)')
  assert.ok(events.some(e => e.type === 'end'), '发 end 事件(幂等无害)')
  assert.ok(events.some(e => e.type === 'disposed'), '终态 dispose')
})

test('取消中止:resume 期间被取消(run 抛错)→ catch 同款 cancelled 分支(对称)', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, PAUSED)
  const { createAgentRunner } = makeRunner(async (opts) => {
    opts.onDelta('续跑已流出的一半')
    updateConversation(db, conv.id, { status: 'cancelled' })
    throw new Error('对话已取消,中止工具执行')
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  await agent.resumeConversation(conv.id, true, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })

  assert.equal(getConversation(db, conv.id).status, 'cancelled', '状态保持 cancelled')
  const last = db.prepare('SELECT role, content FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id).at(-1)
  assert.equal(last.role, 'assistant')
  assert.equal(last.content, '续跑已流出的一半', '续跑段 partial 保留')
  assert.ok(!events.some(e => e.type === 'status' && e.status === 'failed'), '不发 failed')
  assert.ok(events.some(e => e.type === 'end'), '发 end')
})

test('取消中止:对话不存在 + throw → 维持旧 safeSalvage 路径(EXISTENCE 守卫语义,不炸)', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  const { createAgentRunner } = makeRunner(async () => {
    db.prepare('DELETE FROM workbench_conversations WHERE id=?').run(conv.id)
    throw new Error('boom')
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })

  await agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })

  // 旧路径:salvage 的 EXISTENCE 守卫静默零写入,failed+end 事件照发
  assert.ok(events.some(e => e.type === 'status' && e.status === 'failed' && e.error === 'boom'), '对话不存在 → 旧 failed 路径')
  assert.ok(events.some(e => e.type === 'end'), 'end 事件照发')
  assert.ok(events.some(e => e.type === 'disposed'), 'dispose 照发')
})

// ── 审计#3 对抗审查收口(2026-09-06):「停止→修改重发」主流程击穿共享 status 取消信号──
// 重发路由放行 cancelled 并置回 running,旧 run 的检查点/落库前守卫读到 running 即放行——
// 旧 run 继续执行剩余工具、把终态与 bus 事件覆写到新 run 头上(路由 P0 守卫警告的并发双跑)。
// 契约:per-run epoch(每次 run 启动/cancelConversation bump),旧 run 一切产出静默丢弃。
test('取消→重发后旧 run 终态被丢弃:不覆写状态/消息/零 bus 事件(per-run epoch)', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  let release1
  const p1 = new Promise(r => { release1 = r })
  let call = 0
  const { createAgentRunner } = makeRunner(async () => {
    if (++call === 1) return p1            // run#1 挂起(在途 LLM 流的等价物)
    return { status: 'done', content: 'run2 答案', steps: 1, messages: [], queue: [], denied: [] }
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  const r1 = agent.runConversation(conv.id, { chat: async () => ({}) })
  await new Promise(r => setTimeout(r, 10))  // run#1 已挂起
  // 模拟「停止→修改重发」:重发路由复位运行态字段并启动 run#2
  updateConversation(db, conv.id, { status: 'running', content: '', reasoning: '', trace: '[]', steps: 0, pendingApproval: null })
  await agent.runConversation(conv.id, { chat: async () => ({}) })  // run#2 完成
  const eventsAfterRun2 = events.length
  const msgsAfterRun2 = db.prepare('SELECT COUNT(*) n FROM workbench_messages WHERE conversationId=?').get(conv.id).n
  const historyAfterRun2 = db.prepare('SELECT COUNT(*) n FROM workbench_history').get().n

  release1({ status: 'done', content: 'run1 迟到的答案', steps: 9, messages: [], queue: [], denied: [] })
  await r1
  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'done', '终态仍是 run#2 的 done')
  assert.equal(row.content, 'run2 答案', 'run#1 迟到终答不覆写')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workbench_messages WHERE conversationId=?').get(conv.id).n, msgsAfterRun2, '不追加 run#1 消息')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workbench_history').get().n, historyAfterRun2, '不追加 run#1 项目历史')
  assert.equal(events.length, eventsAfterRun2, 'run#1 不再发任何 bus 事件(幽灵 delta/step/done 绝迹)')
})

test('取消→重发后旧 run 抛错不再 safeSalvage:状态保持新 run 终态、无 failed 事件', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  let release1
  const p1 = new Promise((_, rej) => { release1 = rej })
  let call = 0
  const { createAgentRunner } = makeRunner(async () => {
    if (++call === 1) return p1
    return { status: 'done', content: 'run2 答案', steps: 1, messages: [], queue: [], denied: [] }
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  const r1 = agent.runConversation(conv.id, { chat: async () => ({}) }).catch(e => e)
  await new Promise(r => setTimeout(r, 10))
  updateConversation(db, conv.id, { status: 'running', content: '', reasoning: '', trace: '[]', steps: 0, pendingApproval: null })
  await agent.runConversation(conv.id, { chat: async () => ({}) })
  const eventsAfterRun2 = events.length

  release1(new Error('stale run 崩溃'))
  await r1
  assert.equal(getConversation(db, conv.id).status, 'done', '旧 catch 不再把新 run 标 failed')
  assert.ok(!events.some(e => e.type === 'status' && e.status === 'failed'), '无 failed 事件')
  assert.equal(events.length, eventsAfterRun2, '旧 run 静默退出,零事件')
})

// ═══ 2026-09-07 审计 agent-loop-03(F3):被取代 run 的在途流写点无 epoch 闸 ═══
// 上一组测试只锁了 run 出口(落库前/catch 的 isSuperseded);在途回调链——onDelta/onReasoning
// 的检查点写库+busEmit、makeOnStep 的 appendTrace/resetRound 清零+busEmit——此前无守卫:被取代
// run 的残余流继续写库并向新 run 的 bus/SSE 快照(conv-bus emit 同步累积快照)发幽灵事件,
// resetRound 还会把 conv.content 清零覆写新 run 的检查点。取消拦不断在途流(已知边界),「停止→
// 修改重发」重叠窗口对深思考模型可达分钟级。契约:全部写点前比对 epoch,stale 即静默 no-op。
test('supersede 写点守卫:被取代 run 的残余 onDelta/onReasoning/onStep(assistant/resetRound)/appendTrace 全 no-op——不写库、零 bus 事件,新 run 产出完好', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  let optsA, releaseA, optsB, releaseB, call = 0
  const { createAgentRunner } = makeRunner((opts) => {
    if (++call === 1) { optsA = opts; return new Promise(r => { releaseA = r }) }   // run#1(A)悬挂=在途 LLM 流
    optsB = opts; return new Promise(r => { releaseB = r })                         // run#2(B)
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  const rA = agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  await new Promise(r => setTimeout(r, 10))       // A 在途
  agent.cancelConversation(conv.id)               // 停止(纯取消,不 bump epoch)
  // 模拟「修改重发」:edit/regenerate 路由复位运行字段 + 新 run 启动(claimRunEpoch bump → A superseded)
  updateConversation(db, conv.id, { status: 'running', content: '', reasoning: '', trace: '[]', steps: 0, pendingApproval: null })
  const rB = agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  await new Promise(r => setTimeout(r, 10))
  optsB.onDelta('B'.repeat(250))                  // B 中途检查点(≥200 过阈)
  releaseB({ status: 'done', content: 'run2 答案', trace: [], steps: 1, messages: [], queue: [], denied: [] })
  await rB                                        // B 完整落库(done+end+dispose 已发)
  const eventsAfterB = events.length
  const traceAfterB = getConversation(db, conv.id).trace
  const msgsAfterB = db.prepare('SELECT COUNT(*) n FROM workbench_messages WHERE conversationId=?').get(conv.id).n
  const historyAfterB = db.prepare('SELECT COUNT(*) n FROM workbench_history').get().n

  // A 的在途残余(取消+取代后到达):delta/reasoning/assistant step(触发 resetRound+appendTrace)
  optsA.onReasoning('A-旧答案残余思考')
  optsA.onDelta('A-旧答案流出的残余文字')
  optsA.onStep({ type: 'assistant', message: { role: 'assistant', content: 'A 旧问题的完整答案' }, ts: Date.now() + 1 })
  releaseA({ status: 'done', content: 'run1 迟到的答案', trace: [], steps: 9, messages: [], queue: [], denied: [] })
  await rA

  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'done', '终态仍是 run#2 的 done')
  assert.equal(row.content, 'run2 答案', 'A 的 resetRound 检查点不覆写/不清零 B 的落库(conv.content 不被抹空)')
  assert.equal(row.trace, traceAfterB, 'A 的 appendTrace 不写 conv.trace(不污染新 run 的本轮切片)')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workbench_messages WHERE conversationId=?').get(conv.id).n, msgsAfterB, '不追加 A 的消息')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workbench_history').get().n, historyAfterB, '不追加 A 的项目历史')
  assert.equal(events.length, eventsAfterB, 'A 的残余 delta/reasoning/step 不发任何 bus 事件(bus/SSE 快照属新 run)')
})

// ═══ 批次三(2026-09-07 审计)Task 3:流与总线卫生——cancel 主动 abort + flushCheckpoint ═══

// agent-loop-05:cancelConversation 主动 abort 在途 LLM 流。旧模型只置 DB cancelled +
// shouldAbort 检查点(拦的是「下一个工具/下一轮 chat」),在途 fetch 任其烧完(深思考模型
// 可达分钟级)。契约:run/resume 装配的 runner 收到 AbortSignal;cancel 即 abort;断流抛错
// → catch → cancelledCatchGuard 走「保留 partial」分支——与 epoch 不 bump 语义正交(abort
// 只断流,保留分支照常)。
test('cancelConversation → runner 装配的 AbortSignal abort;断流抛错走保留分支(半截答案落库,状态 cancelled 不写 failed)', async () => {
  const { db, conv, busEmit, busDispose, makeRunner, capturedRunnerArgs } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  const HEAD = '取消前已流出的半截'.repeat(10) // 90 字——刻意 <200 阈:证明保留分支读的是内存累计而非检查点
  const { createAgentRunner } = makeRunner((opts) => {
    const sig = capturedRunnerArgs().signal
    opts.onDelta(HEAD)
    // 模拟真实链路:chatStream 以 abort reason 拒绝(undici body read 随 signal abort 拒绝)
    return new Promise((_, reject) => sig.addEventListener('abort', () => reject(sig.reason), { once: true }))
  })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  const p = agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  await new Promise(r => setTimeout(r, 10))
  const sig = capturedRunnerArgs().signal
  assert.ok(sig, 'run 装配携带 AbortSignal(在途 fetch 的断流通道)')
  assert.equal(sig.aborted, false, 'run 在途——signal 未 abort')
  agent.cancelConversation(conv.id)
  assert.equal(sig.aborted, true, '取消即 abort 在途流(不再等流自然烧完)')
  await p
  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'cancelled', '断流抛错走取消分支(catch → cancelledCatchGuard),不写 failed')
  const msgs = db.prepare('SELECT role, content FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id)
  assert.equal(msgs.at(-1).role, 'assistant')
  assert.equal(msgs.at(-1).content, HEAD, '半截答案落 assistant 消息(保留分支不受 abort 影响)')
})

// cancel-races-05:SSE 重连快照零滞后。检查点阈值(200 字/500ms)意味着快照读库时至多滞后
// 一段未落库的在途文本;flushCheckpoint 在快照前同步落一次检查点(窗口归零)。契约:在途
// run 的未过阈累计同步落库;无在途 run / run 已结束 = 空操作。
test('flushCheckpoint: 在途 run 未过阈(<200 字 & <500ms)的累计同步落库;无在途 run 空操作', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  let runOpts
  const { createAgentRunner } = makeRunner((opts) => { runOpts = opts; return new Promise(() => {}) })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  await new Promise(r => setTimeout(r, 10))
  runOpts.onDelta('才流了十个字')   // 6 字 <200 阈 & <500ms——无检查点(滞后窗口实存)
  runOpts.onReasoning('想了一点')
  assert.ok(!getConversation(db, conv.id).content, 'flush 前:未过阈不落库(滞后窗口实存,证明测试没踩在检查点上;建行初始 content=null)')
  assert.equal(agent.flushCheckpoint('no-such-conv'), undefined, '无在途 run:空操作不抛')
  agent.flushCheckpoint(conv.id)
  const row = getConversation(db, conv.id)
  assert.equal(row.content, '才流了十个字', 'flush 后同步落库(重连快照零滞后)')
  assert.equal(row.reasoning, '想了一点')
})

// fix round 1(minor #4):总限 → failed + partial 保留的 agent 层 DB 级测试。滴流桩 + 真
// createLlmClient(streamTotalMs 短值——与 llm 层同 seam)触发真总限;错误上抛 → catch →
// 非 cancelled → safeSalvage 保留半截内容 + 标 failed(与取消路径对照:取消走
// cancelledCatchGuard,状态 cancelled 不写 failed)。
test('总限到点(agent-loop-05): 滴流超总限 → status=failed + 半截内容落 assistant 消息 + failed 事件', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  const encoder = new TextEncoder()
  let n = 0
  const drip = async (u, o) => ({
    ok: true, status: 200,
    body: { getReader: () => ({ cancel: async () => {}, read: () => new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(t); reject(o.signal.reason || new Error('aborted')) }
      const t = setTimeout(() => {
        o.signal.removeEventListener('abort', onAbort)
        if (n >= 10) reject(new Error('stub: 滴流耗尽仍未触发总超时'))
        else resolve({ done: false, value: encoder.encode(`data: {"choices":[{"delta":{"content":"字${n++}"}}]}\n\n`) })
      }, 30)
      o.signal.addEventListener('abort', onAbort, { once: true })
    }) }) },
  })
  // runner 桩直接驱动真 chatStream:delta 经 opts.onDelta 进 tracker,总限抛错原样上抛给 run
  const { createAgentRunner } = makeRunner((opts) =>
    createLlmClient({ baseURL: 'http://x', model: 'm', timeoutMs: 100000, idleMs: 100000, streamTotalMs: 120, fetch: drip })
      .chatStream({}, { onDelta: opts.onDelta }))
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  await agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'failed', '总限超时走 salvage:标 failed(与取消的 cancelled 分支对照)')
  assert.match(row.error, /总超时/, 'error 带总超时语义')
  const msgs = db.prepare('SELECT role, content FROM workbench_messages WHERE conversationId=? ORDER BY seq').all(conv.id)
  assert.equal(msgs.at(-1).role, 'assistant')
  assert.ok(msgs.at(-1).content.length > 0, `半截内容落 assistant 消息(滴出的 delta 保留): ${msgs.at(-1).content}`)
  assert.ok(events.some(e => e.type === 'status' && e.status === 'failed'), 'bus 发 failed 事件(前端不无限 thinking)')
})

// ═══ gap3-03(2026-09-07 审计批次三):换绑/解绑协调——项目集群变更时在途对话失效 ═══
// 契约:invalidateConversation(convId, reason) 对 running/paused 对话:
//   ① DB 置 failed + error=reason + pendingApproval 清空(拒绝语义,PT5 deny 终态形状);
//   ② bump epoch + abort 在途 LLM 流(被取代 run 的残余写点/出口守卫即刻过期,产出静默丢弃,
//     不覆写 failed 终态);
//   ③ bus 三连(status failed + end + dispose)。
// 非运行态(done/failed/cancelled)或对话不存在 → no-op {ok:false}(幂等,重放无害)。
test('gap3-03 invalidateConversation: running → failed+原因+bus 三连;在途 run 被取代,迟到产出不覆写终态', async () => {
  const { db, conv, events, busEmit, busDispose, makeRunner } = setup()
  updateConversation(db, conv.id, { status: 'running' })
  let release
  const hung = new Promise(r => { release = r })
  const { createAgentRunner } = makeRunner(async () => { await hung; return { status: 'done', content: '迟到答案', steps: 1, messages: [], queue: [], denied: [] } })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  const runP = agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  await new Promise(r => setTimeout(r, 10))

  const r = agent.invalidateConversation(conv.id, '项目集群已变更')
  assert.equal(r.ok, true)
  let row = getConversation(db, conv.id)
  assert.equal(row.status, 'failed', '换绑 → running 对话置 failed')
  assert.equal(row.error, '项目集群已变更', '失败原因落库')
  assert.equal(row.pendingApproval, null, 'pendingApproval 一并清空(拒绝语义)')
  const types = events.map(e => e.type)
  assert.ok(events.some(e => e.type === 'status' && e.status === 'failed' && e.error === '项目集群已变更'), 'bus:status failed+原因')
  assert.ok(types.includes('end'), 'bus:end')
  assert.ok(types.includes('disposed'), 'bus:dispose(三连)')

  // 迟到的 done 产出必须被 epoch 闸丢弃——不覆写 failed 终态、不追加 assistant 消息
  release()
  await runP
  row = getConversation(db, conv.id)
  assert.equal(row.status, 'failed', '被取代 run 的 done 不覆写 failed')
  const msgs = db.prepare('SELECT role FROM workbench_messages WHERE conversationId=?').all(conv.id)
  assert.equal(msgs.length, 1, '迟到产出不追加 assistant 消息')
})

test('gap3-03 invalidateConversation: paused → failed+pendingApproval 失效;done/不存在 → no-op', async () => {
  const { db, conv, events, busEmit, busDispose } = setup()
  updateConversation(db, conv.id, { status: 'paused', pendingApproval: JSON.stringify({ toolCallId: 'tc1' }) })
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner: () => ({}), busEmit, busDispose })
  assert.equal(agent.invalidateConversation(conv.id, '项目集群已变更').ok, true)
  const row = getConversation(db, conv.id)
  assert.equal(row.status, 'failed', 'paused 审批随换绑失效(拒绝语义 → 终态 failed)')
  assert.equal(row.pendingApproval, null, 'pendingApproval 清空')
  assert.ok(events.some(e => e.type === 'status' && e.status === 'failed'), 'bus:failed')

  // 终态(done)与不存在 → {ok:false} no-op,不写库不发音
  updateConversation(db, conv.id, { status: 'done', error: '' })
  events.length = 0
  assert.equal(agent.invalidateConversation(conv.id, '项目集群已变更').ok, false, 'done → no-op')
  assert.equal(agent.invalidateConversation('no-such', '项目集群已变更').ok, false, '不存在 → no-op')
  assert.equal(getConversation(db, conv.id).status, 'done', '终态不被改写')
  assert.equal(events.length, 0, 'no-op 零事件')
})

// ═══ gap3-02(2026-09-07 审计批次三):审批盖集群戳——裁决快照锚定创建时集群 ═══
// 契约:handleAgentResult paused 分支落库的 pendingApproval 携带 clusterId(= 创建审批时的
// project.clusterId);approve/resume 执行前比对当下项目绑定,不一致拒绝(gap3-02 路由门)。
test('gap3-02 paused 落库:pendingApproval 盖 clusterId 戳(取 project.clusterId)', async () => {
  const { db, conv, busEmit, busDispose, makeRunner } = setup()
  const pending = { toolCallId: 'tc9', name: 'wb_apply', args: {} }
  const { createAgentRunner } = makeRunner(async () => ({
    status: 'pending_approval', pending,
    messages: [{ role: 'assistant', content: '审批' }], queue: [], denied: [], steps: 1,
  }))
  const agent = createWorkbenchAgent({ db, ...stubDeps, createAgentRunner, busEmit, busDispose })
  await agent.runConversation(conv.id, { chat: async () => ({}) }, { userId: 'u1', username: 'u' })
  const pa = JSON.parse(getConversation(db, conv.id).pendingApproval)
  assert.equal(pa.clusterId, 'c1', '审批载荷盖创建时集群戳(夹具项目绑 c1)')
  assert.equal(pa.toolCallId, 'tc9', '原载荷字段保留')
})
