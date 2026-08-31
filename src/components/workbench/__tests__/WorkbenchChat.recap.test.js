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
  expect(w.find('[data-testid="project-recap-card"]').exists()).toBe(false)
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
