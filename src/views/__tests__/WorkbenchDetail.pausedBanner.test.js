// 审批可见性页面级契约(2026-08-26 用户报告「审批只在悬浮 Modal 出现,工作台里没弹出来」):
// 审批 UI 只活在「当前查看的那条对话」的 WorkbenchChat 实例里——当审批发生在别的对话上
// (切了对话/点了 New/挂到后台),工作台页面必须给出醒目入口:
// ① 本项目有 paused 且非当前查看 → 聊天区顶部横幅,点击切换过去(切过去即弹审批 Modal);
// ② 当前查看的 paused 不重复横幅(其审批 Modal 已在页面内弹出);
// ③ 对话列表 10s 活刷新——侧栏状态点/横幅不滞留在挂载快照(paused 半路出现也可见);
// ④ edit 模式不出横幅、不轮询。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { readFileSync } from 'node:fs'

const api = vi.hoisted(() => ({
  getProject: vi.fn(async () => ({ project: { id: 'p1', name: 'P1', clusterName: 'c1', activeConversationId: 'main' }, files: [], commits: [] })),
  conversations: { list: vi.fn(async () => ({ conversations: [] })) },
  reconcile: vi.fn(async () => ({})),
}))
vi.mock('@/api/client', () => ({ workbenchApi: api, getSavedClusters: () => [], activeApiServer: () => '' }))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: () => {} }),
  useRoute: () => ({ params: { id: 'p1' } }),
  onBeforeRouteLeave: () => {},
}))
// WorkbenchChat 桩:回显 conversationId 供断言切换;不渲染真组件(审批链已有 WorkbenchChat 测试覆盖)
vi.mock('@/components/workbench/WorkbenchChat.vue', () => ({ default: {
  name: 'WorkbenchChat',
  props: ['projectId', 'projectName', 'conversationId', 'activeConversationId'],
  template: '<div data-testid="chat-stub">{{ conversationId ?? "new" }}</div>',
} }))
vi.mock('@/composables/useToast.js', () => ({ notify: vi.fn() }))

import WorkbenchDetail from '@/views/WorkbenchDetail.vue'
import { createPinia } from 'pinia'

const messages = { zh: JSON.parse(readFileSync('./src/locales/zh.json', 'utf8')) }
const i18n = createI18n({ legacy: false, locale: 'zh', messages })

const conv = (over = {}) => ({ id: 'main', title: null, userMessage: '当前对话', status: 'done', updatedAt: 1_700_000_000_000, ...over })

async function mountDetail(mode = 'agent') {
  localStorage.setItem('aliangboard.workbench.mode', mode)
  const w = mount(WorkbenchDetail, { global: { plugins: [createPinia(), i18n] } })
  await flushPromises()
  mounted = w
  return w
}

// 本文件组件带 10s 轮询(不卸载会泄漏进后续测试的 interval);VTU 无 auto-unmount → 手动
let mounted = null

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  vi.setSystemTime(1_700_000_030_000)
})
afterEach(() => {
  vi.useRealTimers()
  mounted?.unmount()
  mounted = null
})

test('别的对话 paused → 聊天区顶部横幅;点击切换 → WorkbenchChat 收到该对话 id', async () => {
  api.conversations.list.mockResolvedValue({ conversations: [
    conv({ id: 'wait', title: '等审批的对话', userMessage: 'q2', status: 'paused' }),
    conv({ id: 'main', status: 'done' }),
  ] })
  const w = await mountDetail('agent')
  const banner = w.find('[data-testid="paused-conv-banner"]')
  expect(banner.exists(), '非当前查看的 paused 对话要有横幅').toBe(true)
  expect(banner.text()).toContain('等审批的对话')
  expect(w.find('[data-testid="chat-stub"]').text()).toBe('main', '未点击前不切换')
  await banner.trigger('click')
  expect(w.find('[data-testid="chat-stub"]').text()).toBe('wait', '点击横幅切换到待审批对话')
  expect(w.find('[data-testid="paused-conv-banner"]').exists(), '切换后成为当前查看 → 横幅退场(审批 Modal 由 WorkbenchChat 弹)').toBe(false)
})

test('当前查看的对话自身 paused → 不出横幅(审批 Modal 已在页面内弹出,不重复)', async () => {
  api.conversations.list.mockResolvedValue({ conversations: [conv({ id: 'main', status: 'paused' })] })
  const w = await mountDetail('agent')
  expect(w.find('[data-testid="paused-conv-banner"]').exists()).toBe(false)
})

test('对话列表 10s 活刷新:running 半路变 paused → 横幅出现(不滞留挂载快照)', async () => {
  vi.useFakeTimers()
  api.conversations.list.mockResolvedValueOnce({ conversations: [conv({ id: 'wait', userMessage: 'q2', status: 'running' })] })
  const w = await mountDetail('agent') // flushPromises 在 fake timers 下仍冲微任务
  await vi.advanceTimersByTimeAsync(0)
  expect(w.find('[data-testid="paused-conv-banner"]').exists()).toBe(false, 'running 期无横幅')
  // 下一轮刷新:服务端已 paused(agent 跑到审批点)
  api.conversations.list.mockResolvedValueOnce({ conversations: [conv({ id: 'wait', userMessage: 'q2', status: 'paused' })] })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(w.find('[data-testid="paused-conv-banner"]').exists(), '10s 刷新后 paused 横幅出现').toBe(true)
})

test('edit 模式:不出横幅、不轮询刷新列表', async () => {
  vi.useFakeTimers()
  api.conversations.list.mockClear()
  api.conversations.list.mockResolvedValue({ conversations: [conv({ id: 'wait', userMessage: 'q2', status: 'paused' })] })
  const w = await mountDetail('edit')
  expect(w.find('[data-testid="paused-conv-banner"]').exists()).toBe(false)
  const callsBefore = api.conversations.list.mock.calls.length
  await vi.advanceTimersByTimeAsync(20_000)
  expect(api.conversations.list.mock.calls.length).toBe(callsBefore, 'edit 模式不活刷新')
})

test('页面隐藏不刷新;回前台立即补一次(visibilitychange)', async () => {
  vi.useFakeTimers()
  api.conversations.list.mockResolvedValue({ conversations: [conv({ id: 'wait', userMessage: 'q2', status: 'paused' })] })
  const w = await mountDetail('agent')
  const callsAfterMount = api.conversations.list.mock.calls.length
  // happy-dom 的 document.hidden 是只读 getter → defineProperty 覆写(happy-dom 16+ 同)
  const setHidden = v => Object.defineProperty(document, 'hidden', { configurable: true, get: () => v })
  setHidden(true)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(api.conversations.list.mock.calls.length).toBe(callsAfterMount, '隐藏页不轮询')
  setHidden(false)
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(0)
  expect(api.conversations.list.mock.calls.length).toBe(callsAfterMount + 1, '回前台立即补一次')
})
