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
  // 816bd74 起会话项是 div(内嵌删除 button,@click.stop),不再用 findAll('button') 定位
  const convItem = w.find('[data-testid="conversation-item"]')
  expect(convItem.exists()).toBe(true)
  expect(convItem.text()).toContain('hello')
  await convItem.trigger('click')
  expect(w.findComponent({ name: 'WorkbenchChat' }).props('activeConversationId')).toBe('conv-a')
})

// ═══ SP4 Edit 模式:文件树 + dirty 守卫 + 删除 ═══
const editApi = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
}))
Object.assign(workbenchApi, editApi)

async function mountEdit(files) {
  workbenchApi.getProject.mockResolvedValue({ project: { id: 'proj-1', name: 'demo' }, files, commits: [] })
  // localStorage mode=edit(YamlEditor/WorkbenchChat 已桩)
  localStorage.setItem('aliangboard.workbench.mode', 'edit')
  const w = await mountDetail()
  localStorage.removeItem('aliangboard.workbench.mode')
  return w
}

test('Edit 文件树:根文件 + 目录分组(子文件缩进),目录行带文件数', async () => {
  const w = await mountEdit(['INDEX.md', 'manifests/deploy.yaml', 'manifests/svc.yaml', 'notes/x.md'])
  const text = w.text()
  expect(text).toContain('manifests/')
  expect(text).toContain('notes/')
  expect(text).toContain('2') // manifests/ 计数
  // 文件行只显示文件名(不重复全路径)
  const treeArea = w.findAll('button').map(b => b.text())
  expect(treeArea.some(t => t.includes('deploy.yaml') && !t.includes('manifests/deploy.yaml'))).toBe(true)
})

test('Edit dirty 守卫:编辑未保存切文件 → confirm 拦截;保存后不拦', async () => {
  const w = await mountEdit(['a.yaml', 'b.yaml'])
  workbenchApi.readFile.mockResolvedValue({ path: 'a.yaml', content: 'x: 1' })
  // 打开 a.yaml
  const btnA = w.findAll('button').find(b => b.text().includes('a.yaml'))
  await btnA.trigger('click')
  await flushPromises()
  expect(w.vm.dirty).toBe(false)
  // 模拟编辑器回写(YamlEditor @update:model-value)
  w.vm.currentContent = 'x: 2'
  expect(w.vm.dirty).toBe(true)
  // dirty 时切 b.yaml → confirm 返回 false → 不读
  vi.stubGlobal('confirm', vi.fn(() => false))
  const btnB = w.findAll('button').find(b => b.text().includes('b.yaml'))
  await btnB.trigger('click')
  expect(globalThis.confirm).toHaveBeenCalled()
  expect(w.vm.currentPath).toBe('a.yaml')
  // 保存 → dirty 消失
  workbenchApi.writeFile.mockResolvedValue({ ok: true })
  await w.vm.save('x: 2')
  expect(w.vm.dirty).toBe(false)
  vi.unstubAllGlobals()
})

test('Edit 删除文件:confirm 后调 deleteFile 并从树中移除;当前文件被删则清空编辑器', async () => {
  const w = await mountEdit(['manifests/deploy.yaml'])
  workbenchApi.readFile.mockResolvedValue({ path: 'manifests/deploy.yaml', content: 'a: 1' })
  const fileBtn = w.findAll('button').find(b => b.text().includes('deploy.yaml'))
  await fileBtn.trigger('click')
  await flushPromises()
  expect(w.vm.currentPath).toBe('manifests/deploy.yaml')
  workbenchApi.deleteFile.mockResolvedValue({ ok: true })
  vi.stubGlobal('confirm', vi.fn(() => true))
  await w.vm.deleteProjectFile('manifests/deploy.yaml')
  await flushPromises()
  expect(workbenchApi.deleteFile).toHaveBeenCalledWith('proj-1', 'manifests/deploy.yaml')
  expect(w.vm.currentPath).toBe('')
  expect(w.text()).not.toContain('deploy.yaml')
  vi.unstubAllGlobals()
})
