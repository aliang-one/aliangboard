// src/views/__tests__/WorkbenchProjects.lifecycle.test.js
// 项目卡片 ⋮ 菜单生命周期(2026-09-01 可见性修复):语义自死组件 WorkbenchList 移植。
// 形态裁决(spec §6):行内 blur 重命名 → 弹窗确认式;enter/blur 竞态守卫随形态消失,由 busy 防重替代。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import { readFileSync } from 'node:fs'

const state = vi.hoisted(() => ({
  // trim 对称测试需要带首尾空白的项目名(终审 M1 语义)
  projects: [{ id: 'p1', name: 'alpha', clusterId: 'c1', namespace: 'default', manifestCount: 0, lastReconcile: null }],
}))
const updateProjectMock = vi.fn()
const deleteProjectMock = vi.fn()
const notifyMock = vi.fn()
const pushMock = vi.fn()

vi.mock('@/api/client', () => ({
  workbenchApi: {
    listProjects: () => Promise.resolve({ projects: state.projects }),
    createProject: vi.fn(),
    updateProjectCluster: vi.fn(),
    updateProject: (...a) => updateProjectMock(...a),
    deleteProject: (...a) => deleteProjectMock(...a),
  },
  authApi: { myClusters: () => Promise.resolve([]) },
}))
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notifyMock(...a) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushMock }) }))

import WorkbenchProjects from '@/views/WorkbenchProjects.vue'

const i18n = createI18n({ legacy: false, locale: 'zh',
  messages: { zh: JSON.parse(readFileSync('./src/locales/zh.json', 'utf8')) } })

// Modal 是 Teleport 组件,行为矩阵测试统一用 stub(和死组件 13 条测试同手法)
const modalStub = {
  props: ['modelValue', 'title', 'width'],
  emits: ['update:modelValue'],
  template: `<div v-if="modelValue" class="test-modal"><div class="test-modal-body"><slot /></div><div class="test-modal-actions"><slot name="actions" /></div></div>`,
}

// projects 内联在卡片网格(非 Teleport),可直接挂载
function mountView() {
  return mount(WorkbenchProjects, {
    global: { plugins: [createPinia(), i18n], stubs: { Modal: modalStub, Transition: true } },
  })
}
function openCardMenu(w) {
  return w.find('button[aria-label="项目操作"]')
}

beforeEach(() => {
  notifyMock.mockClear(); updateProjectMock.mockClear(); deleteProjectMock.mockClear(); pushMock.mockClear()
  state.projects = [{ id: 'p1', name: 'alpha', clusterId: 'c1', namespace: 'default', manifestCount: 0, lastReconcile: null }]
})

test('菜单:点 ⋮ 展开菜单且不触发整卡导航(stopPropagation)', async () => {
  const w = mountView()
  await flushPromises()
  await openCardMenu(w).trigger('click')
  expect(w.text()).toContain('重命名')
  expect(pushMock).not.toHaveBeenCalled()
})

// 注意:happy-dom 里 Material Symbols 图标 span 渲染为图标名文字,菜单钮 text() 是 'edit重命名'
// 形态——必须 includes 匹配,不能等值。
test('重命名:弹窗输入新名 → updateProject(id,{name}) + 本地刷新 + success', async () => {
  const w = mountView()
  await flushPromises()
  await openCardMenu(w).trigger('click')
  await w.findAll('button').find(b => b.text().includes('重命名')).trigger('click')
  const input = w.find('input[data-testid="rename-input"]')
  expect(input.exists()).toBe(true)
  await input.setValue('beta')
  await w.find('[data-testid="rename-confirm-btn"]').trigger('click')
  expect(updateProjectMock).toHaveBeenCalledWith('p1', { name: 'beta' })
  await flushPromises()
  expect(w.text()).toContain('beta')
  expect(notifyMock).toHaveBeenCalledWith('success', expect.stringContaining('beta'))
})

test('重命名:空名确定钮禁用不发请求', async () => {
  const w = mountView()
  await flushPromises()
  await openCardMenu(w).trigger('click')
  await w.findAll('button').find(b => b.text().includes('重命名')).trigger('click')
  await w.find('input[data-testid="rename-input"]').setValue('   ')
  expect(w.find('[data-testid="rename-confirm-btn"]').attributes('disabled')).toBeDefined()
  await w.find('[data-testid="rename-confirm-btn"]').trigger('click')
  expect(updateProjectMock).not.toHaveBeenCalled()
})

test('重命名:PATCH 失败保留弹窗与输入可重试(错误透传)', async () => {
  updateProjectMock.mockRejectedValueOnce(new Error('nope'))
  const w = mountView()
  await flushPromises()
  await openCardMenu(w).trigger('click')
  await w.findAll('button').find(b => b.text().includes('重命名')).trigger('click')
  await w.find('input[data-testid="rename-input"]').setValue('delta')
  await w.find('[data-testid="rename-confirm-btn"]').trigger('click')
  await flushPromises()
  expect(notifyMock).toHaveBeenCalledWith('error', 'nope')
  expect(w.find('input[data-testid="rename-input"]').exists()).toBe(true, '弹窗保留')
  expect(w.find('input[data-testid="rename-input"]').element.value).toBe('delta')
  updateProjectMock.mockResolvedValueOnce({ ok: true })
  await w.find('[data-testid="rename-confirm-btn"]').trigger('click')
  await flushPromises()
  expect(updateProjectMock).toHaveBeenCalledTimes(2)
  expect(w.text()).toContain('delta')
})
