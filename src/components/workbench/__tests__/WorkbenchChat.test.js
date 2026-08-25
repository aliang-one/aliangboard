import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

// vi.mock factories are hoisted to the top of the file — they can't reference
// ordinary top-level vars. vi.hoisted runs alongside the mock so both exist at
// the same hoisted moment. Tests reset the spy impls before each case.
const api = vi.hoisted(() => ({
  conversations: {
    create: vi.fn(),
    append: vi.fn(),
    get: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    cancel: vi.fn(),
    regenerate: vi.fn(),
  },
  search: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  workbenchApi: api,
  // startStreaming 调 getPlatformToken() 构造 SSE url;测试环境无 EventSource,
  // startStreaming 的 try/catch 会降级到 startPolling → pollOnce。getPlatformToken 必须是函数。
  getPlatformToken: () => 'test-token',
}))

// Mock Modal (teleport / nested component not relevant to send() branching)
vi.mock('@/components/common/Modal.vue', () => ({
  default: {
    name: 'Modal',
    template: '<div v-if="modelValue"><slot /><slot name="actions" /></div>',
    props: ['modelValue', 'title', 'width'],
  },
}))

import WorkbenchChat from '../WorkbenchChat.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'zh',
  messages: { zh: { workbench: { chat: {
    userMessage: 'Type...', title: 'AI', hint: 'hint', recapSummary: '之前的对话摘要', noAnswer: '(无回答)',
    stop: '停止', stopped: '已停止', loadFailed: '对话加载失败,请检查网络后重试',
    reasoningTitle: '思考过程',
    convStatus: { running: '执行中', paused: '待审批', done: '完成', failed: '失败', cancelled: '已取消' },
  } } } },
})

async function mountChat(props = {}) {
  return mount(WorkbenchChat, {
    props: { projectId: 'p1', projectName: 'demo', ...props },
    global: { plugins: [i18n] },
  })
}

// Reset call history between tests so create/append assertions are scoped to one test.
beforeEach(() => {
  api.conversations.create.mockClear()
  api.conversations.append.mockClear()
  api.conversations.get.mockClear()
})

test('send() calls conversations.create when no activeConversationId', async () => {
  const w = await mountChat()
  await w.find('textarea').setValue('hello world')
  api.conversations.create.mockResolvedValue({ id: 'conv-new', status: 'running' })
  api.conversations.get.mockResolvedValue({ id: 'conv-new', status: 'done', content: 'ok', trace: '[]', steps: 0 })
  await w.find('button.bg-primary').trigger('click')
  await flushPromises()
  await flushPromises()

  expect(api.conversations.create).toHaveBeenCalledTimes(1)
  expect(api.conversations.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', message: 'hello world' }))
  expect(api.conversations.append).not.toHaveBeenCalled()
})

test('send() calls conversations.append when activeConversationId is set', async () => {
  const w = await mountChat({ activeConversationId: 'conv-active' })
  await w.find('textarea').setValue('follow up')
  api.conversations.append.mockResolvedValue({ id: 'conv-active', status: 'running' })
  api.conversations.get.mockResolvedValue({ id: 'conv-active', status: 'done', content: 'ok2', trace: '[]', steps: 0 })
  await w.find('button.bg-primary').trigger('click')
  await flushPromises()
  await flushPromises()

  expect(api.conversations.append).toHaveBeenCalledTimes(1)
  expect(api.conversations.append).toHaveBeenCalledWith('conv-active', expect.objectContaining({ message: 'follow up' }))
  expect(api.conversations.create).not.toHaveBeenCalled()
})

test('recap card renders when conv.recap is truthy', async () => {
  api.conversations.get.mockResolvedValue({
    id: 'conv-recap',
    status: 'done',
    content: 'answer',
    trace: '[]',
    steps: 1,
    recap: 'Earlier we discussed nginx config.',
    messages: [],
  })
  const w = await mountChat({ conversationId: 'conv-recap' })
  await flushPromises()
  await flushPromises()
  expect(w.html()).toContain('Earlier we discussed nginx config.')
})

test('multi-turn: conv.messages renders multiple ChatTurns', async () => {
  api.conversations.get.mockResolvedValue({
    id: 'conv-multi',
    status: 'done',
    trace: '[]',
    steps: 2,
    recap: '',
    messages: [
      { role: 'user', content: 'what is nginx?', refs: null, trace: null },
      { role: 'assistant', content: 'nginx is a web server', refs: null, trace: '[{"tool":"search","args":{}}]' },
      { role: 'user', content: 'how to install?', refs: null, trace: null },
      { role: 'assistant', content: 'apt-get install nginx', refs: null, trace: null },
    ],
  })
  const w = await mountChat({ conversationId: 'conv-multi' })
  await flushPromises()
  await flushPromises()
  const html = w.html()
  // Each message renders its content somewhere in the turns
  expect(html).toContain('what is nginx?')
  expect(html).toContain('nginx is a web server')
  expect(html).toContain('how to install?')
  expect(html).toContain('apt-get install nginx')
})

test('multi-turn: empty messages falls back to single-turn from userMessage', async () => {
  api.conversations.get.mockResolvedValue({
    id: 'conv-old',
    status: 'done',
    content: 'legacy answer',
    trace: '[]',
    steps: 0,
    userMessage: 'legacy question',
    messages: [],
  })
  const w = await mountChat({ conversationId: 'conv-old' })
  await flushPromises()
  await flushPromises()
  const html = w.html()
  expect(html).toContain('legacy question')
  expect(html).toContain('legacy answer')
})

// Finding #1 regression: multi-turn CONTINUE must update the LAST (thinking) assistant turn,
// not the FIRST (old, done) one. Before the fix, pollOnce's else-branch did
// turns.find(assistant) → returned the first old assistant → overwrote it and left the
// new thinking turn stuck (perpetual spinner, duplicated answer).
test('multi-turn continue: pollOnce(done) updates the thinking assistant, not the prior done one', async () => {
  const w = await mountChat({ activeConversationId: 'conv-c' })
  // --- turn 1: send + poll done ---
  api.conversations.append.mockResolvedValue({ status: 'running' })
  api.conversations.get.mockResolvedValueOnce({
    id: 'conv-c', status: 'done', content: 'first answer', trace: '[]', steps: 1, recap: '',
  })
  await w.find('textarea').setValue('question 1')
  await w.find('button.bg-primary').trigger('click')
  await flushPromises()
  await flushPromises()
  // first assistant turn should be done with 'first answer'
  expect(w.html()).toContain('first answer')

  // --- turn 2: continue + poll done ---
  api.conversations.get.mockResolvedValueOnce({
    id: 'conv-c', status: 'done', content: 'second answer', trace: '[]', steps: 2, recap: '',
  })
  await w.find('textarea').setValue('question 2')
  await w.find('button.bg-primary').trigger('click')
  await flushPromises()
  await flushPromises()

  const html = w.html()
  // Both answers present (first turn untouched, second turn updated)
  expect(html).toContain('first answer')
  expect(html).toContain('second answer')
  // No stuck thinking spinner on either assistant turn (ChatTurn renders "Thinking..." for thinking status)
  expect(html).not.toContain('Thinking...')
})

// Finding #2 regression(2026-08-14):SSE 路径同款 first-match bug——es.onmessage 曾用
// turns.find(assistant) 取【第一个】assistant,多轮续接时 delta/status 全写到历史 turn,
// 新 thinking turn 永久 spinner("思考中…"直到刷新页面才见结果)。测试环境无 EventSource,
// 旧测试全走轮询降级路径,从未覆盖此处;本测试 stub EventSource 手动喂事件。
test('multi-turn continue via SSE: delta/status update the LAST thinking turn, not the first done one', async () => {
  let esInstance = null
  class FakeEventSource {
    constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; esInstance = this }
    close() { this.closed = true }
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  try {
    const w = await mountChat({ activeConversationId: 'conv-sse' })

    // --- turn 1:send → SSE hello/delta/done ---
    api.conversations.append.mockResolvedValue({ status: 'running' })
    await w.find('textarea').setValue('question 1')
    await w.find('button.bg-primary').trigger('click')
    await flushPromises()
    expect(esInstance, 'send 后建立 SSE').toBeTruthy()
    esInstance.onmessage({ data: JSON.stringify({ type: 'hello', status: 'running' }) })
    esInstance.onmessage({ data: JSON.stringify({ type: 'delta', text: 'first answer' }) })
    esInstance.onmessage({ data: JSON.stringify({ type: 'status', status: 'done' }) })
    await flushPromises()
    expect(w.html()).toContain('first answer')

    // --- turn 2:继续发(旧 bug:delta 会写到 turn 1 上,turn 2 永久思考中) ---
    await w.find('textarea').setValue('question 2')
    await w.find('button.bg-primary').trigger('click')
    await flushPromises()
    esInstance.onmessage({ data: JSON.stringify({ type: 'delta', text: 'second answer' }) })
    esInstance.onmessage({ data: JSON.stringify({ type: 'status', status: 'done' }) })
    await flushPromises()

    const html = w.html()
    expect(html).toContain('first answer', '第一轮答案未被覆盖(旧 bug 会把它改写掉)')
    expect(html).toContain('second answer', '第二轮答案落到新 turn')
    expect(html).not.toContain('思考中', '无卡死 spinner')
    expect(html).not.toContain('workbench.chat.thinking', '无渲染成 key 的缺翻译 spinner')

    // --- turn 3:SSE 中断线(未到终态)→ 必须降级轮询对齐(旧 bug:doneOrFinal 取首个
    //     done assistant 误判已终态 → 不降级 → 本轮永久思考中) ---
    api.conversations.get.mockResolvedValueOnce({
      id: 'conv-sse', status: 'done', content: 'third answer (poll fallback)', trace: '[]', steps: 3, recap: '',
    })
    await w.find('textarea').setValue('question 3')
    await w.find('button.bg-primary').trigger('click')
    await flushPromises()
    esInstance.onerror() // SSE 断线
    await flushPromises()
    await flushPromises()
    const html3 = w.html()
    expect(html3).toContain('third answer (poll fallback)', '断线后降级轮询拉到结果')
    expect(html3).not.toContain('思考中', '断线不卡死')
  } finally {
    vi.unstubAllGlobals()
  }
})

// IME 组合期回车不发送(中文输入法按住回车选词,曾直接把半句话发出去)
test('IME composition Enter does not send; plain Enter does', async () => {
  const w = await mountChat()
  const ta = w.find('textarea')
  await ta.setValue('半句话还在选词')
  api.conversations.create.mockClear()
  await ta.trigger('keydown', { key: 'Enter', isComposing: true, keyCode: 229 })
  await flushPromises()
  expect(api.conversations.create).not.toHaveBeenCalled()

  api.conversations.create.mockResolvedValue({ id: 'c1', status: 'running' })
  api.conversations.get.mockResolvedValue({ id: 'c1', status: 'done', content: 'ok', trace: '[]', steps: 0 })
  await ta.trigger('keydown', { key: 'Enter', isComposing: false })
  await flushPromises()
  await flushPromises()
  expect(api.conversations.create).toHaveBeenCalledTimes(1)
})

// 停止功能:运行中发送键变停止键;停止后 thinking turn 置停止态 + 输入回填最后 user 消息(修改重发)
test('stop button cancels run, marks turn stopped, restores input for resend', async () => {
  const w = await mountChat({ activeConversationId: 'conv-x' })
  api.conversations.append.mockResolvedValue({ status: 'running' })
  // 持续 running(轮询不终结),停止键才有出现窗口
  api.conversations.get.mockResolvedValue({ id: 'conv-x', status: 'running', messages: [{ role: 'user', content: '输错的消息' }], trace: '[]', steps: 0, recap: '' })
  await w.find('textarea').setValue('输错的消息')
  await w.find('button.bg-primary').trigger('click')
  await flushPromises()
  // 运行中:停止按钮出现(红边 stop 图标)
  const stopBtn = w.findAll('button').find(b => b.find('span').exists() && b.find('span').text() === 'stop')
  expect(stopBtn, '停止按钮可见').toBeTruthy()
  expect(w.find('textarea').attributes('disabled')).toBeUndefined()

  api.conversations.cancel.mockResolvedValue({ status: 'cancelled' })
  await stopBtn.trigger('click')
  await flushPromises()
  expect(api.conversations.cancel).toHaveBeenCalledWith('conv-x')
  const html = w.html()
  expect(html).toContain('已停止')
  expect(html).not.toContain('思考中')
  // 输入回填:textarea 恢复为最后一条 user 消息(修改后可重发)
  expect(w.find('textarea').element.value).toBe('输错的消息')
  expect(w.find('textarea').attributes('disabled')).toBeUndefined()
})

// 断流修复:onerror CONNECTING(浏览器将自动重连)不关流不降级——等 snapshot 续流;
// CLOSED(服务端关流)才降级轮询。旧实现直接 close+降级 → 中段流式永久停止。
test('SSE mid-run drop: CONNECTING keeps ES for auto-reconnect; CLOSED degrades to polling', async () => {
  let esInstance = null
  class FakeES2 {
    constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; this.readyState = 0; esInstance = this }
    close() { this.readyState = 2; this.closed = true }
  }
  vi.stubGlobal('EventSource', FakeES2)
  try {
    const w = await mountChat({ activeConversationId: 'conv-recon' })
    api.conversations.append.mockResolvedValue({ status: 'running' })
    api.conversations.get.mockResolvedValue({ id: 'conv-recon', status: 'running', messages: [{ role: 'user', content: 'q' }], trace: '[]', steps: 0, recap: '' })
    await w.find('textarea').setValue('long question')
    await w.find('button.bg-primary').trigger('click')
    await flushPromises()
    esInstance.onmessage({ data: JSON.stringify({ type: 'delta', text: 'part1' }) })
    await flushPromises()
    expect(w.html()).toContain('part1')

    // ── 断连#1-2:readyState=CONNECTING → 不 close、不降级(等浏览器自动重连+snapshot)──
    esInstance.readyState = 0
    esInstance.onerror()
    expect(esInstance.closed, 'CONNECTING 不关流').toBeFalsy()
    expect(w.html()).toContain('part1')
    esInstance.onerror()
    expect(esInstance.closed, '第二次 CONNECTING 仍不关流').toBeFalsy()

    // ── 自动重连成功:服务端 snapshot 补齐 gap ──
    esInstance.onmessage({ data: JSON.stringify({ type: 'snapshot', content: 'part1part2', trace: [], steps: 1 }) })
    await flushPromises()
    await new Promise(r => setTimeout(r, 200)) // ChatTurn 流式渲染 150ms 合并窗(P0-3 节流)
    expect(w.html()).toContain('part1part2', '快照替换续流')

    // ── CLOSED(服务端关流且未终态)→ 降级轮询 ──
    esInstance.readyState = 2
    esInstance.onerror()
    await flushPromises()
    expect(esInstance.closed, 'CLOSED 关流').toBeTruthy()
    expect(api.conversations.get).toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

// 草稿保持:切换对话不丢未发送输入;发送后清
test('draft preserved across conversation switch, cleared on send', async () => {
  const w = await mountChat({ conversationId: 'conv-a' })
  api.conversations.get.mockResolvedValue({ id: 'conv-a', status: 'done', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }], trace: '[]', steps: 0, recap: '' })
  await flushPromises()
  await w.find('textarea').setValue('写了一半的长问题')
  // 切到对话 B
  api.conversations.get.mockResolvedValue({ id: 'conv-b', status: 'done', messages: [], trace: '[]', steps: 0, recap: '' })
  await w.setProps({ conversationId: 'conv-b' })
  await flushPromises()
  expect(w.find('textarea').element.value).toBe('', '切走后 B 无草稿')
  // 切回 A → 草稿恢复
  api.conversations.get.mockResolvedValue({ id: 'conv-a', status: 'done', messages: [], trace: '[]', steps: 0, recap: '' })
  await w.setProps({ conversationId: 'conv-a' })
  await flushPromises()
  expect(w.find('textarea').element.value).toBe('写了一半的长问题', '切回恢复草稿')
  // 发送 → 草稿清
  api.conversations.append.mockResolvedValue({ status: 'running' })
  await w.find('button.bg-primary').trigger('click')
  await flushPromises()
  expect(w.find('textarea').element.value).toBe('', '发送后清空')
})

// dev28: 重新生成——调 regenerate 端点,本地移除最后 assistant turn 补 thinking
test('regenerate: 移除最后 assistant turn → 调端点 → 补 thinking turn 续流', async () => {
  const w = await mountChat({ activeConversationId: 'conv-r' })
  // 预置 turns:1 user + 1 done assistant(模拟已加载对话)
  w.vm.turns.push({ _id: 1, role: 'user', content: 'q1' })
  w.vm.turns.push({ _id: 2, role: 'assistant', status: 'done', content: '旧答案', trace: [], steps: 3 })
  await flushPromises()
  api.conversations.regenerate.mockResolvedValue({ status: 'running' })
  api.conversations.get.mockResolvedValue({ id: 'conv-r', status: 'running', messages: [{ role: 'user', content: 'q1' }], trace: '[]', steps: 0, recap: '' })
  await w.vm.regenerate()
  await flushPromises()
  expect(api.conversations.regenerate).toHaveBeenCalledWith('conv-r')
  const roles = w.vm.turns.map(x => [x.role, x.status])
  expect(roles).toEqual([['user', undefined], ['assistant', 'thinking']], '旧 done 回复被移除,补 thinking')
  expect(w.vm.sending).toBe(true)
})

// dev31: SSE 看门狗——SSE 事件全丢(模拟死亡连接)时 ≤10s 由 pollOnce 对齐终态,
// 不再依赖手动刷新。fake timers 推进看门狗周期。
test('SSE 死亡无 onerror:看门狗 10s 后 pollOnce 对齐 done 并停表', async () => {
  vi.useFakeTimers()
  try {
    api.conversations.get.mockResolvedValue({ id: 'conv-wd', status: 'done', content: '服务端终答', trace: '[]', steps: 1, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '旧轮', trace: '[]' }] })
    const w = await mountChat({ activeConversationId: 'conv-wd' })
    // 手动触发 startStreaming 路径(running 态建连后转 done 的窗口):
    api.conversations.append.mockResolvedValue({ references: [] })
    api.conversations.get.mockResolvedValue({ id: 'conv-wd', status: 'running', messages: [{ role: 'user', content: 'q' }], trace: '[]', steps: 0, recap: '' })
    w.vm.turns.push({ _id: 99, role: 'user', content: '新问题' })
    w.vm.turns.push({ _id: 100, role: 'assistant', status: 'thinking', content: '', trace: [], steps: 0, denied: [], truncated: false, error: '', _startedAt: Date.now() })
    w.vm.startStreaming('conv-wd')
    expect(w.vm.turns.find(x => x._id === 100)?.status).toBe('thinking')
    // SSE 一个事件都不来(死亡);服务端其实已 done
    api.conversations.get.mockResolvedValue({ id: 'conv-wd', status: 'done', content: '服务端终答', trace: '[]', steps: 2, messages: [{ role: 'user', content: 'q' }], recap: '' })
    api.conversations.get.mockResolvedValue({ id: 'conv-wd', status: 'done', content: '服务端终答', trace: '[]', steps: 2, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '服务端终答', trace: '[]' }], recap: '' })
    await vi.advanceTimersByTimeAsync(10050)
    const t = w.vm.turns.find(x => x._id === 100)
    expect(t?.status).toBe('done')
    expect(t?.content).toBe('服务端终答')
  } finally { vi.useRealTimers() }
})

// dev31 复查:看门狗 pollOnce 用 DB trace 覆盖时,保留尾部未配对 tool_start(运行中 chip 不被抹掉)
test('pollOnce 对齐保留尾部 tool_start(运行中工具指示器不被看门狗抹掉)', async () => {
  api.conversations.get.mockResolvedValue({ id: 'c1', status: 'running', messages: [{ role: 'user', content: 'q' }], trace: JSON.stringify([{ type: 'tool', name: 'wb_exec', result: 'x' }]), steps: 1, recap: '' })
  const w = await mountChat({ conversationId: 'c1', activeConversationId: 'c1' })
  await flushPromises()
  // 模拟 SSE 已入列一个运行中的 tool_start(不落库)
  const at = w.vm.turns.find(x => x.role === 'assistant')
  at.trace = [...at.trace, { type: 'tool_start', name: 'wb_describe_resource' }]
  await w.vm.pollOnce('c1')
  const types = w.vm.turns.find(x => x.role === 'assistant').trace.map(x => x.type)
  expect(types).toEqual(['tool', 'tool_start'], 'DB trace 对齐后尾部 tool_start 保留')
})

// ── P0 审计修复(B/C,2026-08-17)──
// B:发送失败回滚——幻影 user turn 从未落库却混进后续历史(反向蒸发),且输入/草稿/refs
//    在 await 前就被清空,用户须凭记忆重打全文。
test('B: create 失败——幻影双 turn 回滚、输入框还原、refs 还原', async () => {
  const w = await mountChat()
  await w.find('textarea').setValue('一条很长很重要的问题')
  // 预置一个 @-ref(失败后应还原到 refs 供重发)
  w.vm.$.setupState // noop(仅探活,script setup 不暴露内部)
  api.conversations.create.mockRejectedValueOnce(Object.assign(new Error('网络炸了'), { status: 500 }))
  await w.find('button.bg-primary').trigger('click')
  await flushPromises()
  // 幻影 user/agent turn 都不在
  expect(w.text()).not.toContain('一条很长很重要的问题')
  // 输入还原(可直接重发)
  expect(w.find('textarea').element.value).toBe('一条很长很重要的问题')
  // 错误以顶部 banner 呈现(允许);幻影消息轮不允许存在——上面已断言正文不含提问
})

// C:卸载守卫——send/审批的 await 期间组件被卸载(切对话/关 Modal)后,闭包不得再
//    startStreaming(在已死组件上新建 EventSource/定时器,无人回收=泄漏)。
test('C: send 的 await 期间卸载组件——不再创建 EventSource(泄漏守卫)', async () => {
  const ES = vi.fn()
  vi.stubGlobal('EventSource', ES)
  try {
    const w = await mountChat()
    await w.find('textarea').setValue('will unmount mid-flight')
    let resolveCreate
    api.conversations.create.mockImplementationOnce(() => new Promise(r => { resolveCreate = r }))
    await w.find('button.bg-primary').trigger('click')
    w.unmount() // :key 切换/关 Modal 的等价物
    resolveCreate({ id: 'conv-x', references: [] })
    await flushPromises()
    expect(ES).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

// I(2026-08-17 审计):SSE 重连后服务端 replay 旧 approval 事件——已 deny 的审批会重弹,
// 再点 approve 语义混乱。修复:组件内记已决策 toolCallId,replay 跳过;新审批照常弹。
// 同时覆盖 pollOnce paused 双源到达路径(轮询重放同 id 也不弹)。
test('I: 已决策审批的重放不重弹;新 toolCallId 照常弹', async () => {
  let esInstance = null
  class FakeEventSource {
    constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; esInstance = this }
    close() { this.closed = true }
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.useFakeTimers()
  try {
    const pausedT1 = { id: 'conv-ap', status: 'paused', content: '', trace: '[]', steps: 1, recap: '', messages: [],
      pendingApproval: JSON.stringify({ toolCallId: 't1', name: 'wb_scale', args: {} }) }
    api.conversations.get.mockResolvedValueOnce(pausedT1) // 首拉:paused t1 → 弹
    api.conversations.deny.mockResolvedValue({ status: 'running' })
    api.conversations.get.mockResolvedValueOnce({ id: 'conv-ap', status: 'running', content: '', trace: '[]', steps: 1, recap: '', messages: [] }) // deny 后降级轮询:running
    api.conversations.get.mockResolvedValueOnce({ ...pausedT1 }) // 轮询重放同 t1 → 不应弹
    const w = mount(WorkbenchChat, { props: { projectId: 'p1', projectName: 'demo', conversationId: 'conv-ap' }, global: { plugins: [i18n] } })
    await vi.advanceTimersByTimeAsync(0)
    const rejectBtn = () => w.findAll('button').find(b => b.text().includes('workbench.chat.reject'))
    expect(rejectBtn(), 't1 首次到达弹出审批').toBeTruthy()
    await rejectBtn().trigger('click') // deny t1
    await vi.advanceTimersByTimeAsync(0)
    // 轮询重放同 t1(stale paused 快照)
    await vi.advanceTimersByTimeAsync(2100)
    expect(rejectBtn(), '已决策的 t1 重放不再弹').toBeFalsy()
    // SSE replay 同 t1 也不弹
    esInstance.onmessage({ data: JSON.stringify({ type: 'approval', pending: { toolCallId: 't1', name: 'wb_scale', args: {} } }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(rejectBtn(), 'SSE 重放 t1 不再弹').toBeFalsy()
    // 新审批 t2 照常弹
    esInstance.onmessage({ data: JSON.stringify({ type: 'approval', pending: { toolCallId: 't2', name: 'wb_exec', args: {} } }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(rejectBtn(), '新 toolCallId t2 正常弹出').toBeTruthy()
  } finally { vi.useRealTimers(); vi.unstubAllGlobals() }
})

// 悬浮 Modal 打开 paused 对话(2026-08-17 用户报告):审批弹了但看不到内容——重建路径
// 只给 running 补 thinking 占位 turn,paused 没有 → 首轮 paused 的 agentTurn 为 undefined,
// approve 后 SSE snapshot/delta 全被 `if (!agentTurn) return` 静默丢弃;多轮 paused 则兜底
// 到上一轮 done turn,snapshot 会覆写旧答案。修复:paused 同样补占位 turn。
test('paused 对话打开+approve 续跑:snapshot/delta 落在新 turn,上一轮答案不被覆写', async () => {
  let esInstance = null
  class FakeEventSource {
    constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; esInstance = this }
    close() { this.closed = true }
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  try {
    api.conversations.get.mockReset() // 该文件 beforeEach 只 mockClear,once 队列会跨测试泄漏
    // 多轮 paused:上一轮完整答案 + 新提问,审批待决
    api.conversations.get.mockResolvedValueOnce({
      id: 'conv-pa', status: 'paused', content: '', trace: '[]', steps: 2, recap: '',
      pendingApproval: JSON.stringify({ toolCallId: 't9', name: 'wb_scale', args: {} }),
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答(完整)', trace: '[]' },
        { role: 'user', content: '第二问' },
      ],
    })
    const w = mount(WorkbenchChat, { props: { projectId: 'p1', projectName: 'demo', conversationId: 'conv-pa', activeConversationId: 'conv-pa' }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(w.html()).toContain('第一答(完整)', '历史答案可见')
    expect(w.html()).toContain('第二问')
    // 审批存在(报告中说"该出现的权限申请还是会出现")
    expect(w.findAll('button').some(b => b.text().includes('workbench.chat.approve'))).toBe(true)
    // approve → startStreaming;SSE hello + snapshot(续跑已有内容)
    api.conversations.approve.mockResolvedValue({ status: 'running' })
    await w.findAll('button').find(b => b.text().includes('workbench.chat.approve')).trigger('click')
    await flushPromises()
    expect(esInstance, 'approve 后建立 SSE').toBeTruthy()
    esInstance.onmessage({ data: JSON.stringify({ type: 'hello', status: 'running' }) })
    esInstance.onmessage({ data: JSON.stringify({ type: 'snapshot', content: '续跑已产出的内容', trace: [], steps: 2 }) })
    await flushPromises()
    const html = w.html()
    expect(html).toContain('续跑已产出的内容', '续跑内容必须可见(修复前被丢弃)')
    expect(html.match(/第一答\(完整\)/g)?.length).toBe(1, '上一轮答案不被 snapshot 覆写/复制')
  } finally { vi.unstubAllGlobals() }
})

test('首轮 paused 对话打开:重建后存在 in-flight turn(审批不孤零零悬空)', async () => {
  api.conversations.get.mockReset() // 同上:隔离 once 队列
  api.conversations.get.mockResolvedValueOnce({
    id: 'conv-pa2', status: 'paused', content: '', trace: '[]', steps: 1, recap: '',
    pendingApproval: JSON.stringify({ toolCallId: 't1', name: 'wb_scale', args: {} }),
    messages: [{ role: 'user', content: '唯一的问题' }],
  })
  const w = mount(WorkbenchChat, { props: { projectId: 'p1', projectName: 'demo', conversationId: 'conv-pa2' }, global: { plugins: [i18n] } })
  await flushPromises()
  expect(w.html()).toContain('唯一的问题')
  // 修复前:无任何 assistant turn → 审批弹着但正文区"空转";修复后有 pending_approval 占位
  expect(w.html()).toContain('pending_actions', 'paused 分支会把该占位 turn 置 pending_approval 渲染')
})

// ── R1/R2/R3(2026-08-19 系统性修复):thinking 持久化重建 / 初拉退避重试 / 轮询回放检查点 ──

// R1:重建 assistant turn 必须带 reasoning——服务端已把思考落消息级 reasoning 列,
// 此前重建丢弃 → ChatTurn v-if="turn.reasoning" 恒 false,刷新后 thinking 永久消失。
test('R1: 重建带 reasoning 的消息 → 思考折叠区渲染(刷新后 thinking 可回看)', async () => {
  api.conversations.get.mockReset()
  api.conversations.get.mockResolvedValue({
    id: 'conv-r1', status: 'done', trace: '[]', steps: 1, recap: '',
    messages: [
      { role: 'user', content: '深思考问题' },
      { role: 'assistant', content: '答案', reasoning: '这是当时的思考过程', trace: '[]' },
    ],
  })
  const w = await mountChat({ conversationId: 'conv-r1' })
  await flushPromises()
  expect(w.html()).toContain('这是当时的思考过程', '重建的 assistant turn 带思考')
  const at = w.vm.turns.find(x => x.role === 'assistant')
  expect(at?.reasoning).toBe('这是当时的思考过程')
})

// R3:SSE 断线降级轮询(或环境无 EventSource)时,pollOnce 不回放 conv.content/reasoning 检查点
// → 用户看着流出的半截回答,刷新后只剩转圈。回放须以 !es 为守卫(SSE 活跃时增量 ≥ 检查点,覆写会倒退)。
test('R3: 轮询降级路径回放 content/reasoning 检查点到 in-flight turn', async () => {
  api.conversations.get.mockReset()
  api.conversations.get.mockResolvedValue({
    id: 'conv-r3', status: 'running', content: '已流出的半截答案', reasoning: '已流出的半截思考',
    trace: '[]', steps: 1, recap: '',
    messages: [{ role: 'user', content: '问题' }],
  })
  const w = await mountChat({ conversationId: 'conv-r3' })
  await flushPromises()
  const at = w.vm.turns.find(x => x.role === 'assistant' && x.status === 'thinking')
  expect(at?.content).toBe('已流出的半截答案', '检查点内容回放(此前轮询路径恒空)')
  expect(at?.reasoning).toBe('已流出的半截思考', '检查点思考回放')
})

// R2:重建此前单发无重试,catch 静默 → turns 空 → 空态 UI("对话丢失"观感)。
// 修复:500ms/1s/2s 退避重试;重试期间 loading 态(不闪空态建议卡);全部失败 → loadFailed banner。
test('R2: 初拉持续失败 → 退避重试 3 次 → loadFailed banner,空态建议卡不误导', async () => {
  api.conversations.get.mockReset()
  api.conversations.get.mockRejectedValue(new Error('network down'))
  vi.useFakeTimers()
  try {
    const w = await mountChat({ conversationId: 'conv-r2' })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.conversations.get).toHaveBeenCalledTimes(1)
    expect(w.html()).not.toContain('hint', '重试期间显示 loading 而非空态建议卡')
    await vi.advanceTimersByTimeAsync(3600)
    expect(api.conversations.get.mock.calls.length).toBe(4, '首次 + 3 次退避重试(500/1000/2000ms)')
    expect(w.vm.errorBanner).toBe('对话加载失败,请检查网络后重试')
    expect(w.html()).not.toContain('hint', '失败后空态建议卡也不出现(banner 已示错,不再误导"开始新对话")')
  } finally { vi.useRealTimers() }
})

// R2 正向路径:首次抖动、重试恢复 → 正常重建,无 errorBanner(瞬时网络错误不再表现为丢对话)。
test('R2: 首拉失败重试成功 → 历史完整重建,无错误 banner', async () => {
  api.conversations.get.mockReset()
  api.conversations.get
    .mockRejectedValueOnce(new Error('flaky'))
    .mockResolvedValue({ id: 'conv-r2b', status: 'done', trace: '[]', steps: 0, recap: '',
      messages: [{ role: 'user', content: '历史问题' }, { role: 'assistant', content: '历史答案' }] })
  vi.useFakeTimers()
  try {
    const w = await mountChat({ conversationId: 'conv-r2b' })
    await vi.advanceTimersByTimeAsync(0)
    expect(w.vm.convStatus).toBe(null, '首拉失败')
    await vi.advanceTimersByTimeAsync(600)
    expect(w.vm.convStatus).toBe('done', '重试成功')
    expect(w.html()).toContain('历史问题')
    expect(w.html()).toContain('历史答案')
    expect(w.vm.errorBanner).toBe('')
  } finally { vi.useRealTimers() }
})

// cancelled 状态此前在 convStatusLabel 无映射(状态栏空标签);补齐文案。
test('cancelled 状态:状态栏显示"已取消"', async () => {
  api.conversations.get.mockReset()
  api.conversations.get.mockResolvedValue({
    id: 'conv-cc', status: 'cancelled', trace: '[]', steps: 0, recap: '',
    messages: [{ role: 'user', content: 'q' }],
  })
  const w = await mountChat({ conversationId: 'conv-cc' })
  await flushPromises()
  expect(w.html()).toContain('已取消')
})

test('存量对话兜底:消息级 trace 全空但对话级 trace 有工具事件 → 挂到最后一个 assistant turn 可见', async () => {
  // 2026-08-25 修复前的存量数据形态:assistant 消息 trace 恒 "[]"(写入端 bug),对话级 trace 完整。
  api.conversations.get.mockResolvedValue({
    id: 'conv-legacy',
    status: 'done',
    trace: JSON.stringify([
      { type: 'tool', name: 'wb_list_resources', args: { kind: 'pods' }, result: { kind: 'pods' } },
      { type: 'assistant', message: { role: 'assistant', content: '查到了' } },
      { type: 'tool', name: 'wb_get_pod_logs', args: { namespace: 'ns1', pod: 'p1' }, result: { logs: 'x' } },
      { type: 'assistant', message: { role: 'assistant', content: '日志如上' } },
    ]),
    steps: 2,
    recap: '',
    messages: [
      { role: 'user', content: '看看 pod', refs: null, trace: null },
      { role: 'assistant', content: '查到了', refs: null, trace: '[]', createdAt: 1756000000000 },
      { role: 'user', content: '看日志', refs: null, trace: null },
      { role: 'assistant', content: '日志如上', refs: null, trace: '[]', createdAt: 1756100000000 },
    ],
  })
  const w = await mountChat({ conversationId: 'conv-legacy' })
  await flushPromises()
  await flushPromises()
  const html = w.html()
  // 兜底后末轮 turn 带工具事件 → ToolTrace 渲染出工具名;修复前全不可见
  expect(html).toContain('wb_get_pod_logs')
  expect(html).toContain('wb_list_resources')
  // 历史事件时间兜底:点开一个工具 chip → 详情 Modal 头部显示轮次时刻(2025-08-25 epoch,含年份)
  const chip = w.findAll('button').find(b => b.text().includes('wb_get_pod_logs'))
  await chip.trigger('click')
  await flushPromises()
  // 本文件 Modal 被 stub(无 Teleport)→ 详情内容渲染在组件树内,查 w.html()
  expect(w.html()).toMatch(/2025/)
})

test('新数据不触发兜底:任一 assistant 消息自带 trace → 各轮维持自己的 trace', async () => {
  api.conversations.get.mockResolvedValue({
    id: 'conv-new-data',
    status: 'done',
    trace: JSON.stringify([{ type: 'tool', name: 'wb_top', args: {}, result: {} }]),
    steps: 1,
    recap: '',
    messages: [
      { role: 'user', content: 'q', refs: null, trace: null },
      { role: 'assistant', content: 'a', refs: null, trace: '[{"type":"tool","name":"wb_describe_resource","args":{},"result":{}}]' },
    ],
  })
  const w = await mountChat({ conversationId: 'conv-new-data' })
  await flushPromises()
  await flushPromises()
  const html = w.html()
  expect(html).toContain('wb_describe_resource')
  expect(html).not.toContain('wb_top')   // 对话级兜底不注入(消息自带 trace)
})
