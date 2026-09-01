// Task 5(2026-08-31 项目记忆):recap 卡人工纠偏通道——编辑/清空。
// mock 手法与 WorkbenchChat.approval.test.js 同源(模块级 mock @/api/client + reset)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zh from '@/locales/zh.json'
import en from '@/locales/en.json'

const api = vi.hoisted(() => ({
  conversations: {
    get: vi.fn(),
    create: vi.fn(), append: vi.fn(), approve: vi.fn(), deny: vi.fn(), cancel: vi.fn(),
    regenerate: vi.fn(), compact: vi.fn(), edit: vi.fn(),
  },
  search: vi.fn(),
  updateProject: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  workbenchApi: api,
  getPlatformToken: () => 'test-token',
}))

vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import { notify } from '@/composables/useToast'
import WorkbenchChat from '../WorkbenchChat.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh, en } })

async function mountWithProjectRecap(recapText) {
  api.conversations.get.mockReset()
  api.conversations.get.mockResolvedValueOnce({
    id: 'conv-r', status: 'done', content: 'ok', trace: '[]', steps: 1, recap: '',
    projectRecap: recapText, messages: [],
  })
  const w = mount(WorkbenchChat, {
    props: { projectId: 'p1', projectName: 'demo', conversationId: 'conv-r', activeConversationId: 'conv-r' },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return w
}

beforeEach(() => {
  api.updateProject.mockReset()
  notify.mockClear()
})

test('编辑保存:调 updateProject(id,{recap}) 并刷新卡片内容 + success 提示', async () => {
  const w = await mountWithProjectRecap('旧记忆')
  const card = w.find('[data-testid="project-recap-card"]')
  expect(card.exists()).toBe(true)
  await card.find('[data-testid="recap-edit-btn"]').trigger('click')
  const ta = card.find('textarea')
  expect(ta.exists()).toBe(true)
  await ta.setValue('新记忆')
  await card.find('[data-testid="recap-save-btn"]').trigger('click')
  await flushPromises()
  expect(api.updateProject).toHaveBeenCalledWith('p1', { recap: '新记忆' })
  expect(w.text()).toContain('新记忆')
  expect(notify).toHaveBeenCalledWith('success', expect.any(String))
})

test('清空:二次确认后调 updateProject(id,{recap:\'\'}) 卡片收起 + 提示', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true))
  const w = await mountWithProjectRecap('旧记忆')
  const card = w.find('[data-testid="project-recap-card"]')
  await card.find('[data-testid="recap-clear-btn"]').trigger('click')
  await flushPromises()
  expect(api.updateProject).toHaveBeenCalledWith('p1', { recap: '' })
  expect(w.find('[data-testid="project-recap-card"]').exists()).toBe(true, '清空后转空态卡(仍可再写入)')
  expect(w.find('[data-testid="recap-empty"]').exists()).toBe(true)
  expect(w.text()).not.toContain('旧记忆')
  expect(notify).toHaveBeenCalledWith('success', expect.any(String))
})

test('清空取消确认:不发请求,卡片保留', async () => {
  vi.stubGlobal('confirm', vi.fn(() => false))
  const w = await mountWithProjectRecap('旧记忆')
  const card = w.find('[data-testid="project-recap-card"]')
  await card.find('[data-testid="recap-clear-btn"]').trigger('click')
  await flushPromises()
  expect(api.updateProject).not.toHaveBeenCalled()
  expect(w.find('[data-testid="project-recap-card"]').exists()).toBe(true)
})

test('保存失败:error 提示且保留编辑态', async () => {
  api.updateProject.mockRejectedValueOnce(new Error('boom'))
  const w = await mountWithProjectRecap('旧记忆')
  const card = w.find('[data-testid="project-recap-card"]')
  await card.find('[data-testid="recap-edit-btn"]').trigger('click')
  await card.find('textarea').setValue('改而未存')
  await card.find('[data-testid="recap-save-btn"]').trigger('click')
  await flushPromises()
  expect(notify).toHaveBeenCalledWith('error', expect.any(String))
  expect(card.find('textarea').exists()).toBe(true)
  expect(card.find('textarea').element.value).toBe('改而未存')
})

// 终审 I4:编辑器在 <details> 折叠 body 里,卡片默认收起;点编辑若不同步展开,
// 按钮随编辑态消失而编辑器不可见——用户看到「点了没反应」。
test('编辑态强制展开卡:<details> 点编辑后处于 open(折叠时不藏编辑器)', async () => {
  const w = await mountWithProjectRecap('旧记忆')
  const card = w.find('[data-testid="project-recap-card"]')
  expect(card.element.open).toBe(false)               // 默认折叠
  await card.find('[data-testid="recap-edit-btn"]').trigger('click')
  expect(card.element.open).toBe(true, 'startRecapEdit 必须编程式展开卡片')
  expect(card.find('textarea').exists()).toBe(true)
  // 取消编辑:卡片保持展开(用户刚在读它),不再藏内容
  await card.find('[data-testid="recap-cancel-btn"]').trigger('click')
  expect(card.element.open).toBe(true)
  expect(card.element.textContent).toContain('旧记忆')
})

// ═══ 终审 M3:清空 textarea 再保存 = 清空项目记忆,必须走与「清空」按钮同款二次确认 ═══
test('空文本保存:confirm 同意 → 按「清空」提交(recap:\'\')且卡片收起', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true))
  const w = await mountWithProjectRecap('旧记忆')
  const card = w.find('[data-testid="project-recap-card"]')
  await card.find('[data-testid="recap-edit-btn"]').trigger('click')
  await card.find('textarea').setValue('   ')      // 清空(含空白)
  await card.find('[data-testid="recap-save-btn"]').trigger('click')
  await flushPromises()
  expect(confirm).toHaveBeenCalled()
  expect(api.updateProject).toHaveBeenCalledWith('p1', { recap: '' })
  expect(w.find('[data-testid="recap-empty"]').exists()).toBe(true, '清空后转空态卡')
  expect(notify).toHaveBeenCalledWith('success', expect.any(String))
  vi.unstubAllGlobals()
})

test('空文本保存:confirm 拒绝 → 不发请求且编辑态保留(非空保存无需 confirm)', async () => {
  vi.stubGlobal('confirm', vi.fn(() => false))
  const w = await mountWithProjectRecap('旧记忆')
  const card = w.find('[data-testid="project-recap-card"]')
  await card.find('[data-testid="recap-edit-btn"]').trigger('click')
  await card.find('textarea').setValue('')
  await card.find('[data-testid="recap-save-btn"]').trigger('click')
  await flushPromises()
  expect(api.updateProject).not.toHaveBeenCalled()
  expect(card.find('textarea').exists()).toBe(true, '留在编辑态可改主意')

  // 对照组:非空保存不弹 confirm(确认只拦「清空」语义)
  await card.find('textarea').setValue('正常改写')
  await card.find('[data-testid="recap-save-btn"]').trigger('click')
  await flushPromises()
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(api.updateProject).toHaveBeenCalledWith('p1', { recap: '正常改写' })
  vi.unstubAllGlobals()
})

test('保存失败:error 提示透传服务端 message(M3,与 WorkbenchList 一致)', async () => {
  api.updateProject.mockRejectedValueOnce(new Error('recap 太长'))
  const w = await mountWithProjectRecap('旧记忆')
  const card = w.find('[data-testid="project-recap-card"]')
  await card.find('[data-testid="recap-edit-btn"]').trigger('click')
  await card.find('textarea').setValue('超长内容')
  await card.find('[data-testid="recap-save-btn"]').trigger('click')
  await flushPromises()
  expect(notify).toHaveBeenCalledWith('error', 'recap 太长')
})

// ═══ 空态可写(2026-09-01 可见性修复,spec §3):v-if 恒真后,无记忆也有写入入口 ═══

test('有记忆态:载入后默认收起(recapLoaded 闸——终审 I2,不预展开)', async () => {
  const w = await mountWithProjectRecap('旧记忆')
  const card = w.find('[data-testid="project-recap-card"]')
  expect(card.exists()).toBe(true)
  expect(card.element.open).toBe(false, '有记忆载入后默认收起——不被空态预载撑开')
  expect(card.find('[data-testid="recap-empty"]').exists()).toBe(false)
})

test('空态:无记忆时卡片渲染、默认展开、写入记忆钮进编辑态', async () => {
  const w = await mountWithProjectRecap(null)
  const card = w.find('[data-testid="project-recap-card"]')
  expect(card.exists()).toBe(true)
  expect(card.element.open).toBe(true, '空态默认展开——入口必须一眼可见')
  expect(card.find('[data-testid="recap-empty"]').exists()).toBe(true)
  await card.find('[data-testid="recap-write-btn"]').trigger('click')
  expect(card.find('textarea').exists()).toBe(true)
})

test('空态:无对话项目(projectId 仅有的场景)卡片同样渲染', async () => {
  api.conversations.get.mockReset()
  api.conversations.get.mockRejectedValueOnce(new Error('no conv'))
  const w = mount(WorkbenchChat, {
    props: { projectId: 'p1', projectName: 'demo' },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  expect(w.find('[data-testid="project-recap-card"]').exists()).toBe(true, '无对话也要能写项目记忆')
  expect(w.find('[data-testid="recap-write-btn"]').exists()).toBe(true)
})

test('空态写入:草稿非空保存 → updateProject(recap) 创建记忆(非清空路径无 confirm)', async () => {
  vi.stubGlobal('confirm', vi.fn(() => { throw new Error('非空保存不应弹 confirm') }))
  const w = await mountWithProjectRecap(null)
  const card = w.find('[data-testid="project-recap-card"]')
  await card.find('[data-testid="recap-write-btn"]').trigger('click')
  await card.find('textarea').setValue('第一条记忆')
  await card.find('[data-testid="recap-save-btn"]').trigger('click')
  await flushPromises()
  expect(api.updateProject).toHaveBeenCalledWith('p1', { recap: '第一条记忆' })
  expect(card.find('[data-testid="recap-empty"]').exists()).toBe(false)
  expect(w.text()).toContain('第一条记忆')
  vi.unstubAllGlobals()
})
