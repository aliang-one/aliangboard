// steer 前端链路(spec D7,2026-10-13):运行中/paused 发送走 steer API 落库上屏;
// steer_ack 他端去重(无 thinking turn 兜底);409 终态竞态自动降级 append(带 refs);
// steer 网络失败字不丢;paused textarea 解锁;steer_consumed 徽标翻转;重建带徽标。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'

const api = vi.hoisted(() => ({
  conversations: {
    create: vi.fn(), append: vi.fn(), get: vi.fn(), steer: vi.fn(),
    approve: vi.fn(), deny: vi.fn(), cancel: vi.fn(),
    regenerate: vi.fn(), compact: vi.fn(), edit: vi.fn(),
  },
  search: vi.fn(),
}))
vi.mock('@/api/client', () => ({ workbenchApi: api, getPlatformToken: () => 'test-token' }))
vi.mock('@/components/common/Modal.vue', () => ({
  default: { name: 'Modal', template: '<div v-if="modelValue"><slot /><slot name="actions" /></div>', props: ['modelValue', 'title', 'width'] },
}))

import WorkbenchChat from '../WorkbenchChat.vue'

const i18n = createI18n({
  legacy: false, locale: 'zh',
  messages: { zh: { common: { copy: '复制' }, workbench: { chat: {
    userMessage: 'Type...', title: 'AI', noAnswer: '(无回答)',
    stop: '停止', stopped: '已停止', agentFailed: 'Agent 调用失败',
    loadFailed: '对话加载失败', reconnecting: '连接中断,重试中…',
    steerBadge: '已注入运行中的对话', steerBadgeRead: 'AI 已读取该补充',
    convStatus: { running: '执行中', paused: '待审批', done: '完成', failed: '失败', cancelled: '已取消' },
  } } } },
})

// ── FakeEventSource:捕获实例供测试手动派发 SSE 事件(模式同 sse.test.js) ──
class FakeEventSource {
  constructor(url) { this.url = url; this.readyState = 1; FakeEventSource.instances.push(this) }
  close() { this.readyState = 2 }
  emit(evt) { this.onmessage?.({ data: JSON.stringify(evt) }) }
}
FakeEventSource.instances = []
const es = () => FakeEventSource.instances.at(-1)

function runningConv(status = 'running') {
  return {
    id: 'conv-s', status, content: '', trace: '[]', steps: 1, recap: '', messages: [
      { id: 'm1', role: 'user', content: '第一问', refs: null },
      { id: 'm2', role: 'assistant', content: '', trace: '[]' },
    ],
  }
}
async function mountConv(conv) {
  api.conversations.get.mockImplementation(async () => conv)
  const w = mount(WorkbenchChat, {
    props: { projectId: 'p1', projectName: 'demo', conversationId: conv.id, activeConversationId: conv.id },
    global: { plugins: [i18n, createPinia()] },
  })
  await flushPromises()
  return w
}
async function mountRunning() { return mountConv(runningConv()) }
async function typeAndEnter(w, text) {
  const ta = w.find('textarea')
  await ta.setValue(text)
  await ta.trigger('keydown', { key: 'Enter', keyCode: 13 }) // 非 IME 组合期
  await flushPromises()
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource)
  FakeEventSource.instances.length = 0
  for (const k of Object.values(api.conversations)) k.mockReset()
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

test('运行中回车:调 steer、user turn 上屏带徽标、input 清空、不 append 不入队', async () => {
  const w = await mountRunning()
  api.conversations.steer.mockResolvedValue({ messageId: 'sm-1' })
  await typeAndEnter(w, '实时补充')
  expect(api.conversations.steer).toHaveBeenCalledWith('conv-s', { message: '实时补充', references: [] })
  expect(api.conversations.append).not.toHaveBeenCalled()
  expect(w.text()).toContain('实时补充')
  expect(w.text()).toContain('已注入运行中的对话')
  expect(w.find('textarea').element.value).toBe('')
  expect(w.find('[data-testid="queue-panel"]').exists()).toBe(false)
  w.unmount()
})

test('steer_ack 他端到达:同 messageId 去重,新 messageId 插屏', async () => {
  const w = await mountRunning()
  api.conversations.steer.mockResolvedValue({ messageId: 'sm-1' })
  await typeAndEnter(w, '本端补充')
  es().emit({ type: 'steer_ack', messageId: 'sm-1', content: '本端补充', refs: null })   // 去重
  await flushPromises()
  expect(w.findAll('p').filter(x => x.text().includes('本端补充'))).toHaveLength(1)
  es().emit({ type: 'steer_ack', messageId: 'sm-2', content: '他端补充', refs: null })   // 插屏
  await flushPromises()
  expect(w.text()).toContain('他端补充')
  w.unmount()
})

test('steer_ack 无 thinking turn 兜底:消息 push 尾部不丢(Review Focus #2)', async () => {
  const w = await mountRunning()
  es().emit({ type: 'status', status: 'done' })
  await flushPromises()
  es().emit({ type: 'steer_ack', messageId: 'sm-9', content: '边界补充', refs: null })
  await flushPromises()
  expect(w.text()).toContain('边界补充')
  w.unmount()
})

test('409 steerFinished:自动降级 append(带 refs 不丢,Review Focus #5)', async () => {
  const w = await mountRunning()
  api.conversations.steer.mockRejectedValue(Object.assign(new Error('对话已结束'), { status: 409 }))
  api.conversations.append.mockResolvedValue({ messageId: 'am-1' })
  w.vm.refs = [{ kind: 'pod', namespace: 'default', name: 'nginx' }]
  await typeAndEnter(w, '竞态补充')
  await flushPromises()
  expect(api.conversations.append).toHaveBeenCalledTimes(1)
  expect(api.conversations.append.mock.calls[0][1].message).toBe('竞态补充')
  expect(api.conversations.append.mock.calls[0][1].references).toEqual([{ kind: 'pod', namespace: 'default', name: 'nginx' }])
  w.unmount()
})

test('steer 网络失败:input 不清,亮横幅(字不丢)', async () => {
  const w = await mountRunning()
  api.conversations.steer.mockRejectedValue(new Error('网络断了'))
  await typeAndEnter(w, '会失败的补充')
  await flushPromises()
  expect(w.find('textarea').element.value).toBe('会失败的补充')
  expect(w.text()).toContain('网络断了')
  w.unmount()
})

test('paused:textarea 不禁用,发送走 steer(审批期间可补充)', async () => {
  const w = await mountConv(runningConv('paused'))
  expect(w.find('textarea').attributes('disabled')).toBeUndefined()
  api.conversations.steer.mockResolvedValue({ messageId: 'sm-p' })
  await typeAndEnter(w, '审批期间补充')
  await flushPromises()
  expect(api.conversations.steer).toHaveBeenCalledWith('conv-s', expect.objectContaining({ message: '审批期间补充' }))
  expect(api.conversations.append).not.toHaveBeenCalled()
  w.unmount()
})

test('steer_consumed:徽标翻「AI 已读取」', async () => {
  const w = await mountRunning()
  api.conversations.steer.mockResolvedValue({ messageId: 'sm-1' })
  await typeAndEnter(w, '待吸收补充')
  expect(w.text()).toContain('已注入运行中的对话')
  es().emit({ type: 'steer_consumed', messageIds: ['sm-1'] })
  await flushPromises()
  expect(w.text()).toContain('AI 已读取该补充')
  w.unmount()
})

test('刷新重建:steered 行带徽标(pollOnce 重建路径)', async () => {
  const c = runningConv()
  c.messages.push({ id: 'sm-0', role: 'user', content: '历史补充', refs: null, steered: 1 })
  const w = await mountConv(c)
  expect(w.text()).toContain('历史补充')
  expect(w.text()).toContain('已注入运行中的对话')
  w.unmount()
})
