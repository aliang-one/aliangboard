// 2026-08-27 静默终止审计:SSE 链路的失败可见性回归。
// 动机:生产数据(04d58b45)显示用户曾把同一消息连发 3 次——agent 轮次已终态但前端无任何
// 提示。锁定四条契约:
//   1) SSE status:failed → errorBanner 顶部横幅(不止 turn 内小红块;与轮询降级路径对齐)
//   2) SSE approval 事件 → 审批 modal 必弹(不依赖 turn 归约是否成功)
//   3) SSE done 但 content/trace 全空 → 显示「无回答」兜底(轮询路径已有,SSE 路径曾缺)
//   4) 降级轮询连续失败 → 「连接中断,重试中」横幅(空 catch 吞网络错误曾致永久静默卡死)
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

const api = vi.hoisted(() => ({
  conversations: {
    create: vi.fn(), append: vi.fn(), get: vi.fn(),
    approve: vi.fn(), deny: vi.fn(), cancel: vi.fn(), regenerate: vi.fn(),
  },
  search: vi.fn(),
}))
vi.mock('@/api/client', () => ({ workbenchApi: api, getPlatformToken: () => 'test-token' }))
vi.mock('@/components/common/Modal.vue', () => ({
  default: { name: 'Modal', template: '<div v-if="modelValue" data-testid="modal"><slot /><slot name="actions" /></div>', props: ['modelValue', 'title', 'width'] },
}))

import WorkbenchChat from '../WorkbenchChat.vue'

const i18n = createI18n({
  legacy: false, locale: 'zh',
  messages: { zh: { workbench: { chat: {
    userMessage: 'Type...', title: 'AI', hint: 'hint', noAnswer: '(无回答)',
    stop: '停止', stopped: '已停止', agentFailed: 'Agent 调用失败',
    loadFailed: '对话加载失败', reconnecting: '连接中断,重试中…',
    execApprovalTitle: '确认执行', writeFileApproval: '确认写入',
    pendingApproval: '等待审批', reopenApproval: '点击重新打开审批',
    convStatus: { running: '执行中', paused: '待审批', done: '完成', failed: '失败', cancelled: '已取消' },
  } } } },
})

// ── FakeEventSource:捕获实例供测试手动派发 SSE 事件 ──
class FakeEventSource {
  constructor(url) { this.url = url; this.readyState = 1; FakeEventSource.instances.push(this) }
  close() { this.readyState = 2 }
  emit(evt) { this.onmessage?.({ data: JSON.stringify(evt) }) }
}
FakeEventSource.instances = []

async function mountChat(props = {}) {
  return mount(WorkbenchChat, {
    props: { projectId: 'p1', projectName: 'demo', ...props },
    global: { plugins: [i18n] },
  })
}

// 发送一条消息并建流(create 成功 → startStreaming → FakeEventSource)
async function sendAndStream(w) {
  api.conversations.create.mockResolvedValue({ id: 'conv-1', status: 'running' })
  await w.find('textarea').setValue('hello')
  await w.find('button.bg-primary').trigger('click')
  await flushPromises()
  return FakeEventSource.instances.at(-1)
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource)
  FakeEventSource.instances.length = 0
  api.conversations.create.mockClear()
  api.conversations.get.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

test('SSE status:failed → errorBanner 横幅显示错误(不只 turn 内提示)', async () => {
  const w = await mountChat()
  const es = await sendAndStream(w)
  expect(es).toBeTruthy()

  es.emit({ type: 'status', status: 'failed', error: 'LLM HTTP 502: upstream down' })
  await flushPromises()

  const banner = w.find('[data-testid="modal"]').exists() // modal 不应弹
  expect(banner).toBe(false)
  expect(w.html()).toContain('LLM HTTP 502: upstream down')
  // 顶部横幅元素(errorBanner 渲染在 .bg-error/5 容器)存在
  expect(w.html()).toContain('text-error bg-error/5')
})

test('SSE approval 事件 → 审批 modal 弹出', async () => {
  const w = await mountChat()
  const es = await sendAndStream(w)

  es.emit({ type: 'approval', pending: { toolCallId: 'tc1', name: 'wb_exec', args: { command: 'ls' } } })
  await flushPromises()

  const modal = w.find('[data-testid="modal"]')
  expect(modal.exists()).toBe(true)
  expect(w.html()).toContain('wb_exec')
})

test('SSE done 但 content/trace 全空 → 显示「无回答」兜底而非空白', async () => {
  const w = await mountChat()
  const es = await sendAndStream(w)

  es.emit({ type: 'status', status: 'done' })
  await flushPromises()

  expect(w.html()).toContain('(无回答)')
})

test('降级轮询连续失败 3 次 → 「连接中断」横幅;恢复后清除', async () => {
  vi.useFakeTimers()
  try {
    // EventSource 构造抛错 → startStreaming 降级 startPolling
    vi.stubGlobal('EventSource', class { constructor() { throw new Error('no ES') } })
    api.conversations.get.mockRejectedValue(new Error('network down'))

    const w = await mountChat()
    api.conversations.create.mockResolvedValue({ id: 'conv-1', status: 'running' })
    await w.find('textarea').setValue('hello')
    await w.find('button.bg-primary').trigger('click')
    await vi.advanceTimersByTimeAsync(4500)   // pollOnce 立即 + 2s interval×2 → ≥3 次失败
    await flushPromises()

    expect(w.html()).toContain('连接中断,重试中…')

    // 网络恢复:横幅清除
    api.conversations.get.mockResolvedValue({ id: 'conv-1', status: 'done', content: 'ok', trace: '[]', steps: 1, messages: [] })
    await vi.advanceTimersByTimeAsync(2500)
    await flushPromises()
    expect(w.html()).not.toContain('连接中断,重试中…')
  } finally {
    vi.useRealTimers()
  }
})

// ── 2026-08-27 modal 审计:审批 modal 的可关闭性与重开入口 ──
// N1:approval Modal 此前不监听 update:model-value——ESC/遮罩/X 的 close emit 丢失,
//     pendingApproval 不清 → modal 点不动;且 ESC 栈顶恒为她,悬浮 ChatModal 内连锁锁死。
// N2:收起后(轮询已停/SSE 已断)不再自动重弹 → turn 黄条必须是重开入口。
test('审批 modal:ESC/遮罩关闭生效,黄条可点击重开', async () => {
  const w = await mountChat()
  const es = await sendAndStream(w)

  es.emit({ type: 'approval', pending: { toolCallId: 'tc9', name: 'wb_exec', args: { command: 'ls' } } })
  await flushPromises()
  expect(w.find('[data-testid="modal"]').exists()).toBe(true)

  // ESC/遮罩/X → Modal emit update:modelValue=false → 收起(此前:emit 丢失,modal 纹丝不动)
  w.findComponent({ name: 'Modal' }).vm.$emit('update:modelValue', false)
  await flushPromises()
  expect(w.find('[data-testid="modal"]').exists()).toBe(false)
  // turn 处于 pending_approval:黄条仍在(等待审批提示)
  expect(w.html()).toContain('pending_actions')

  // 黄条点击 → 重开审批 modal(此前:无任何重开入口)
  await w.find('[data-testid="pending-approval-bar"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="modal"]').exists()).toBe(true)
  expect(w.html()).toContain('wb_exec')
})

// 第三轮复查(2026-08-27):SSE 终态事件必须熄 netLost——终态后 stopStreaming/stopWatchdog,
// 轮询与看门狗全停,pollOnce 的成功清除路径不再运行,不清则「连接中断」横幅永久残留。
test('断连横幅亮起后,SSE 终态事件到达即熄灭(不再永久残留)', async () => {
  vi.useFakeTimers()
  try {
    const w = await mountChat()
    api.conversations.create.mockResolvedValue({ id: 'conv-1', status: 'running' })
    await w.find('textarea').setValue('hello')
    await w.find('button.bg-primary').trigger('click')
    await flushPromises()
    const es = FakeEventSource.instances.at(-1)
    expect(es).toBeTruthy()

    // 看门狗 10s 对齐轮询连续失败 ≥3 次(看门狗在 SSE 存活时也跑)→ netLost 亮
    api.conversations.get.mockRejectedValue(new Error('network down'))
    await vi.advanceTimersByTimeAsync(31_000)
    await flushPromises()
    expect(w.html()).toContain('连接中断,重试中…')

    // SSE 终态事件到达(连接活着,服务端已完成)→ 横幅即灭
    es.emit({ type: 'status', status: 'done' })
    await flushPromises()
    expect(w.html()).not.toContain('连接中断,重试中…')
  } finally {
    vi.useRealTimers()
  }
})

// ── 2026-08-28 终答丢失审计(用户实测:1.0.9 对话完成后最后一段不显示,刷新才有)──
// 场景复刻:SSE 在最后一个 step.assistant(终答块)前死亡 → 看门狗 10s 对齐到 done。
// 交错模式下终答显示唯一依赖 trace 终答块;对齐路径只写 content → 终答无处渲染。
// 修复契约:done 对齐后终答文本必须出现在页面上。
test('SSE 死亡后看门狗对齐 done:交错模式终答必须可见(不只活在 content 里)', async () => {
  vi.useFakeTimers()
  try {
    const w = await mountChat()
    api.conversations.create.mockResolvedValue({ id: 'conv-1', status: 'running' })
    await w.find('textarea').setValue('诊断一下')
    await w.find('button.bg-primary').trigger('click')
    await flushPromises()
    const es = FakeEventSource.instances.at(-1)
    expect(es).toBeTruthy()

    // 流式中:中间轮 assistant 文本块 + 工具事件(交错模式确立);终答 delta 流到一半
    es.emit({ type: 'step', step: { type: 'assistant', content: '我先看看资源状态', ts: 1 } })
    es.emit({ type: 'delta', text: '根据检查结果' })
    await flushPromises()
    // SSE 死亡(终答块事件从未到达)——浏览器侧无感知,连接僵尸
    es.readyState = 2
    es.onmessage = null

    // 看门狗 10s 对齐:服务端已 done,conv.content=完整终答
    api.conversations.get.mockResolvedValue({
      id: 'conv-1', status: 'done', content: '根据检查结果,问题是镜像拉取失败,已修复。',
      reasoning: '', trace: '[]', steps: 3,
      messages: [
        { role: 'user', content: '诊断一下' },
        { role: 'assistant', content: '根据检查结果,问题是镜像拉取失败,已修复。' },
      ],
    })
    await vi.advanceTimersByTimeAsync(11_000)
    await flushPromises()

    // 终态到达且终答可见(修复前:交错模式只显示中间轮,终答无处渲染)
    expect(w.html()).toContain('已修复')
    expect(w.html()).toContain('我先看看资源状态')   // 中间轮仍在
    expect(w.html()).not.toContain('progress_activity')  // 不再转圈
  } finally {
    vi.useRealTimers()
  }
})
