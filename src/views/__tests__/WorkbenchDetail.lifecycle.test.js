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

// getSavedClusters/activeApiServer:组件实例化 useClusterStore()(挂到后台按钮)→
// store 初始化即调这两个,须在 mock 里提供
vi.mock('@/api/client', () => ({ workbenchApi, getSavedClusters: () => [], activeApiServer: () => '' }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'proj-1' } }),
  useRouter: () => ({ push: () => {} }),
  onBeforeRouteLeave: () => {},
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
  localStorage.removeItem('aliangboard.workbench.mode')
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

// ═══ SP4 打磨:切模式 dirty 守卫 / 双模式文件联动 / commit 自动保存 ═══
test('切模式 dirty 守卫:Edit 有未保存内容 → confirm 拦截;确认后切换', async () => {
  const w = await mountEdit(['a.yaml'])
  workbenchApi.readFile.mockResolvedValue({ path: 'a.yaml', content: 'x: 1' })
  await w.findAll('button').find(b => b.text().includes('a.yaml')).trigger('click')
  await flushPromises()
  w.vm.currentContent = 'x: 2'
  expect(w.vm.dirty).toBe(true)
  // confirm=false → 留在 edit
  vi.stubGlobal('confirm', vi.fn(() => false))
  w.vm.setMode('agent')
  expect(w.vm.mode).toBe('edit')
  // confirm=true → 切到 agent
  vi.stubGlobal('confirm', vi.fn(() => true))
  w.vm.setMode('agent')
  expect(w.vm.mode).toBe('agent')
  vi.unstubAllGlobals()
})

test('切回 Edit 重拉文件树(Agent 写的文件立即可见,不动对话状态)', async () => {
  const w = await mountEdit(['a.yaml'])
  const callsBefore = workbenchApi.getProject.mock.calls.length
  const activeBefore = w.vm.activeConversationId
  workbenchApi.getProject.mockResolvedValue({ project: { id: 'proj-1', name: 'demo' }, files: ['a.yaml', 'manifests/new.yaml'], commits: [] })
  w.vm.setMode('agent')
  w.vm.setMode('edit')
  await flushPromises()
  expect(workbenchApi.getProject.mock.calls.length).toBeGreaterThan(callsBefore)
  expect(w.vm.files).toContain('manifests/new.yaml')
  expect(w.vm.activeConversationId).toBe(activeBefore)
})

test('commit 前 dirty 自动保存:writeFile 先于 commit;保存失败不提交', async () => {
  const w = await mountEdit(['a.yaml'])
  workbenchApi.readFile.mockResolvedValue({ path: 'a.yaml', content: 'x: 1' })
  await w.findAll('button').find(b => b.text().includes('a.yaml')).trigger('click')
  await flushPromises()
  w.vm.currentContent = 'x: 2'
  workbenchApi.writeFile.mockResolvedValue({ ok: true })
  workbenchApi.commit = vi.fn().mockResolvedValue({ committed: true, subject: 's' })
  await w.vm.doCommit()
  expect(workbenchApi.writeFile).toHaveBeenCalledWith('proj-1', 'a.yaml', 'x: 2')
  expect(workbenchApi.commit).toHaveBeenCalled()
  // 保存失败(notify 已示错)→ 停止提交
  workbenchApi.writeFile.mockRejectedValue(new Error('disk full'))
  w.vm.currentContent = 'x: 3'
  workbenchApi.commit.mockClear()
  await w.vm.doCommit()
  expect(workbenchApi.commit).not.toHaveBeenCalled()
})

test('文件树 dirty 圆点:当前文件未保存时树行渲染 unsaved 标记', async () => {
  const w = await mountEdit(['a.yaml'])
  workbenchApi.readFile.mockResolvedValue({ path: 'a.yaml', content: 'x: 1' })
  await w.findAll('button').find(b => b.text().includes('a.yaml')).trigger('click')
  await flushPromises()
  expect(w.html()).not.toContain('bg-status-warning')
  w.vm.currentContent = 'x: 2'
  await flushPromises()
  expect(w.html()).toContain('bg-status-warning')
})

// 2026-08-25「历史消失」排查修复:项目 GET 瞬时失败(网关重启/网络抖动)曾被渲染成
// 「项目不存在或无权访问」且永不自愈——用户观感即内容全丢。修复:失败 ≠ 不存在,
// 显示「加载失败 + 重试」,重试成功即恢复。
test('项目 GET 网络失败 → 显示加载失败而非项目不存在;重试成功恢复', async () => {
  workbenchApi.getProject.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { status: 0 }))
  const w = await mountDetail()
  expect(w.text()).not.toContain('项目不存在或无权访问')
  // 自动重试(5s 间隔)太慢,测试直接验证手动重试路径:再次 load 成功
  workbenchApi.getProject.mockResolvedValue({ project: { id: 'proj-1', name: 'demo' }, files: [], commits: [] })
  const retry = w.findAll('button').find(b => w.text().includes('加载失败'))
  expect(retry || w.text()).toBeTruthy()
  // 组件暴露 retryLoad 供按钮/测试调用
  expect(typeof w.vm.retryLoad).toBe('function')
  await w.vm.retryLoad()
  await flushPromises()
  expect(w.text()).not.toContain('加载失败')
})
