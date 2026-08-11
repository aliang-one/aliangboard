// SP1-T7: 验证 WorkbenchDetail 的 sidebar 生命周期——
// activeConversationId 从 project 初始化、New → null、selectConversation → id。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'

const workbenchApi = vi.hoisted(() => ({
  getProject: vi.fn(),
  conversations: { list: vi.fn() },
}))

vi.mock('@/api/client', () => ({ workbenchApi }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'proj-1' } }),
  useRouter: () => ({ push: () => {} }),
}))

vi.mock('@/composables/useToast', () => ({ notify: () => {} }))

// 桩子组件:只测 sidebar 交互,不渲染真实 chat/editor
vi.mock('@/components/workbench/WorkbenchChat.vue', () => ({
  default: { name: 'WorkbenchChat', template: '<div class="chat-stub"></div>', props: ['projectId', 'conversationId', 'activeConversationId'] },
}))
vi.mock('@/components/common/YamlEditor.vue', () => ({
  default: { name: 'YamlEditor', template: '<div></div>' },
}))

import WorkbenchDetail from '../WorkbenchDetail.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: {} } })

beforeEach(() => {
  setActivePinia(createPinia())
  workbenchApi.getProject.mockReset()
  workbenchApi.conversations.list.mockReset()
  workbenchApi.getProject.mockResolvedValue({ project: { id: 'proj-1', name: 'demo' }, files: [], commits: [] })
  workbenchApi.conversations.list.mockResolvedValue({ conversations: [] })
})

async function mountDetail() {
  const w = mount(WorkbenchDetail, { global: { plugins: [i18n] } })
  await flushPromises()
  return w
}

test('activeConversationId initialized from project.activeConversationId', async () => {
  workbenchApi.getProject.mockResolvedValue({ project: { id: 'proj-1', name: 'demo', activeConversationId: 'conv-active' }, files: [], commits: [] })
  const w = await mountDetail()
  const chat = w.findComponent({ name: 'WorkbenchChat' })
  expect(chat.props('activeConversationId')).toBe('conv-active')
  expect(chat.props('conversationId')).toBe('conv-active')
})

test('activeConversationId is null when project has no active conversation', async () => {
  workbenchApi.getProject.mockResolvedValue({ project: { id: 'proj-1', name: 'demo', activeConversationId: null }, files: [], commits: [] })
  const w = await mountDetail()
  const chat = w.findComponent({ name: 'WorkbenchChat' })
  expect(chat.props('activeConversationId')).toBeNull()
})

test('New button sets activeConversationId to null', async () => {
  workbenchApi.getProject.mockResolvedValue({ project: { id: 'proj-1', name: 'demo', activeConversationId: 'conv-old' }, files: [], commits: [] })
  const w = await mountDetail()
  // Initially conv-old
  expect(w.findComponent({ name: 'WorkbenchChat' }).props('activeConversationId')).toBe('conv-old')
  // Click New (sidebar button containing "add" icon + "New" text)
  const newBtn = w.findAll('button').find(b => b.text().includes('New') && b.text().includes('add'))
  expect(newBtn).toBeTruthy()
  await newBtn.trigger('click')
  expect(w.findComponent({ name: 'WorkbenchChat' }).props('activeConversationId')).toBeNull()
})

test('selectConversation sets activeConversationId to the clicked id', async () => {
  workbenchApi.getProject.mockResolvedValue({ project: { id: 'proj-1', name: 'demo' }, files: [], commits: [] })
  workbenchApi.conversations.list.mockResolvedValue({ conversations: [{ id: 'conv-a', userMessage: 'hello', status: 'done' }] })
  const w = await mountDetail()
  // Click the conversation item (button containing the userMessage text 'hello')
  const convBtn = w.findAll('button').find(b => b.text().includes('hello'))
  expect(convBtn).toBeTruthy()
  await convBtn.trigger('click')
  expect(w.findComponent({ name: 'WorkbenchChat' }).props('activeConversationId')).toBe('conv-a')
})
