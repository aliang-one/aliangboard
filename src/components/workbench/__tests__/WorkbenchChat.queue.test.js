// 运行中追加队列(2026-09-03):Workspace 里组件常驻,sending 全程为 true,旧实现 send() 静默
// return——运行中回车石沉大海。修复:入队上屏 chip,convStatus 终态自动出队走正常 send()。
// 服务端 P0(D) 守卫(运行中 400)不变,排队纯前端。悬浮窗重挂载场景由 sessionStorage 持久化覆盖。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zh from '@/locales/zh.json'
import en from '@/locales/en.json'

const api = vi.hoisted(() => ({
  conversations: {
    create: vi.fn(), append: vi.fn(), get: vi.fn(),
    approve: vi.fn(), deny: vi.fn(), cancel: vi.fn(),
    regenerate: vi.fn(), compact: vi.fn(), edit: vi.fn(),
  },
  search: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  workbenchApi: api,
  getPlatformToken: () => 'test-token',
}))

vi.mock('@/components/common/Modal.vue', () => ({
  default: {
    name: 'Modal',
    template: '<div v-if="modelValue"><slot /><slot name="actions" /></div>',
    props: ['modelValue', 'title', 'width'],
  },
}))

import WorkbenchChat from '../WorkbenchChat.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh, en } })

// happy-dom 无 EventSource → startStreaming 走 catch 降级 startPolling(2s 轮询 get)。
// 用 get 的返回序列驱动:第一轮 running → 之后 done,触发终态 drain。
function runningConv() {
  return {
    id: 'conv-q', status: 'running', content: '正在想…', trace: '[]', steps: 1, recap: '',
    messages: [
      { id: 'm1', role: 'user', content: '第一问', refs: null },
      { id: 'm2', role: 'assistant', content: '', trace: '[]' },
    ],
  }
}
function doneConv() {
  const c = runningConv()
  c.status = 'done'
  c.content = '第一答'
  c.messages = [
    { id: 'm1', role: 'user', content: '第一问', refs: null },
    { id: 'm2', role: 'assistant', content: '第一答', trace: '[]' },
  ]
  return c
}

beforeEach(() => {
  sessionStorage.clear()
  for (const k of Object.values(api.conversations)) k.mockReset()
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

async function mountRunning() {
  api.conversations.get.mockImplementation(async () => runningConv())
  const w = mount(WorkbenchChat, {
    props: { projectId: 'p1', projectName: 'demo', conversationId: 'conv-q', activeConversationId: 'conv-q' },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return w
}

async function typeAndEnter(w, text) {
  const ta = w.find('textarea')
  await ta.setValue(text)
  await ta.trigger('keydown', { key: 'Enter', keyCode: 13 }) // 非 IME 组合期
  await flushPromises()
}

test('运行中回车不入队 API、上屏排队 chip;终态后自动出队调用 append', async () => {
  const w = await mountRunning()
  expect(api.conversations.append).not.toHaveBeenCalled()

  await typeAndEnter(w, '追加的问题')
  // P0 守卫:运行中绝不调用 append(防并发双 run)
  expect(api.conversations.append).not.toHaveBeenCalled()
  // chip 上屏 + 提示文案 + 输入框已清空
  expect(w.find('[data-testid="queue-panel"]').exists()).toBe(true)
  expect(w.text()).toContain('追加的问题')
  expect(w.text()).toContain(zh.workbench.chat.queueHint)
  expect(w.find('textarea').element.value).toBe('')

  // sessionStorage 持久化(重挂载恢复的原料)
  expect(sessionStorage.getItem('wb-chat-queue:conv-q')).toContain('追加的问题')

  // 驱动轮询到 done → 自动出队 → append 携带排队内容
  api.conversations.get.mockImplementation(async () => doneConv())
  await vi.advanceTimersByTimeAsync(2100)
  await flushPromises()
  expect(api.conversations.append).toHaveBeenCalledTimes(1)
  const [id, payload] = api.conversations.append.mock.calls[0]
  expect(id).toBe('conv-q') // URL 由真实 client 拼,mock 收到裸 id
  expect(payload.message).toBe('追加的问题')
  // 队列已清空(chip 消失 + sessionStorage 清除)
  expect(w.find('[data-testid="queue-panel"]').exists()).toBe(false)
  expect(sessionStorage.getItem('wb-chat-queue:conv-q')).toBeNull()
  w.unmount()
})

test('排队 chip 可单独移除,出队只发剩余', async () => {
  const w = await mountRunning()
  await typeAndEnter(w, '问题甲')
  await typeAndEnter(w, '问题乙')
  expect(w.findAll('[data-testid="queue-panel"] .flex.items-center')).toHaveLength(2)

  // 移除甲(第一个 chip 的 close 钮)
  await w.findAll('[data-testid="queue-panel"] button')[0].trigger('click')
  await flushPromises()
  expect(w.text()).not.toContain('问题甲')
  expect(w.text()).toContain('问题乙')

  api.conversations.get.mockImplementation(async () => doneConv())
  await vi.advanceTimersByTimeAsync(2100)
  await flushPromises()
  expect(api.conversations.append).toHaveBeenCalledTimes(1)
  expect(api.conversations.append.mock.calls[0][1].message).toBe('问题乙')
  w.unmount()
})

test('运行中挂载恢复 sending=true:停止键在,textarea 不因 sending 禁用', async () => {
  const w = await mountRunning()
  // 重挂载恢复修复:运行中对话挂载后必须回到「运行中」UI(停止键可见)——旧实现漏置 sending,
  // 发送键回归 → 发消息被服务端 400「运行中不能续接」打回
  expect(w.find(`button[title="${zh.workbench.chat.stop}"]`).exists()).toBe(true)
  // textarea 未被 sending 禁用(只受 pendingApproval/paused 禁用)= 打字追加的前提
  expect(w.find('textarea').attributes('disabled')).toBeUndefined()
  w.unmount()
})
