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
// DropdownMenu 菜单已 Teleport 到 body(2026-09-01 遮挡根治),菜单项须从 body 查
const menuPanel = () => document.body.querySelector('[data-testid="dropdown-menu-panel"]')
async function clickMenuItem(label) {
  const btn = [...menuPanel().querySelectorAll('button')].find(b => b.textContent.includes(label))
  btn.click()
  await flushPromises()
}

beforeEach(() => {
  document.body.innerHTML = ''
  notifyMock.mockClear(); updateProjectMock.mockClear(); deleteProjectMock.mockClear(); pushMock.mockClear()
  state.projects = [{ id: 'p1', name: 'alpha', clusterId: 'c1', namespace: 'default', manifestCount: 0, lastReconcile: null }]
})

test('菜单:点 ⋮ 展开菜单且不触发整卡导航(stopPropagation)', async () => {
  const w = mountView()
  await flushPromises()
  await openCardMenu(w).trigger('click')
  await flushPromises()
  expect(menuPanel()?.textContent).toContain('重命名')
  expect(pushMock).not.toHaveBeenCalled()
})

test('菜单:点遮罩(点外部)关闭菜单且不冒泡整卡导航(终审 I1)', async () => {
  const w = mountView()
  await flushPromises()
  await openCardMenu(w).trigger('click')
  const overlay = w.find('.fixed.inset-0')
  expect(overlay.exists()).toBe(true, '菜单展开时遮罩存在')
  await overlay.trigger('click')
  expect(w.find('.fixed.inset-0').exists()).toBe(false, '遮罩点击后菜单关闭')
  expect(pushMock).not.toHaveBeenCalled()
})

// 注意:happy-dom 里 Material Symbols 图标 span 渲染为图标名文字,菜单钮 text() 是 'edit重命名'
// 形态——必须 includes 匹配,不能等值。
test('重命名:弹窗输入新名 → updateProject(id,{name}) + 本地刷新 + success', async () => {
  const w = mountView()
  await flushPromises()
  await openCardMenu(w).trigger('click')
  await clickMenuItem('重命名')
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
  await clickMenuItem('重命名')
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
  await clickMenuItem('重命名')
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

// ═══ 删除:确认名语义矩阵(自 WorkbenchList.lifecycle 逐条移植,文案键换 card.*) ═══

async function openDeleteModal(w) {
  await openCardMenu(w).trigger('click')
  await clickMenuItem('删除')
}

test('删除:确认名不一致时确定钮禁用且点击不发请求', async () => {
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  expect(w.find('.test-modal').exists()).toBe(true)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alph')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  expect(btn.attributes('disabled')).toBeDefined()
  await btn.trigger('click')
  expect(deleteProjectMock).not.toHaveBeenCalled()
})

test('删除:确认名逐字一致 → deleteProject(id, name) + 列表移除 + success', async () => {
  const w = mountView()
  await flushPromises()
  expect(w.text()).toContain('alpha')
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  expect(btn.attributes('disabled')).toBeUndefined()
  await btn.trigger('click')
  expect(deleteProjectMock).toHaveBeenCalledWith('p1', 'alpha')
  await flushPromises()
  expect(w.text()).not.toContain('alpha')
  expect(notifyMock).toHaveBeenCalledWith('success', expect.any(String))
})

test('删除:请求失败时列表保留 + error notify(透传)', async () => {
  deleteProjectMock.mockRejectedValueOnce(new Error('boom'))
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  await w.find('[data-testid="delete-confirm-btn"]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain('alpha')
  expect(notifyMock).toHaveBeenCalledWith('error', 'boom')
})

// 终审 I2 语义:repo 目录清除失败后端仍 200 但带 warning(数据已删、目录成孤儿)——
// 必须 error 级示警,只报成功会让孤儿目录永远无人跟进。
test('删除:响应带 warning → error 级提示含 warning 原文,行仍移除', async () => {
  deleteProjectMock.mockResolvedValueOnce({ ok: true, removedConversations: 2, repoRemoved: false, warning: 'EBUSY: resource busy' })
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  await w.find('[data-testid="delete-confirm-btn"]').trigger('click')
  await flushPromises()
  expect(w.text()).not.toContain('alpha')
  expect(notifyMock).toHaveBeenCalledTimes(1)
  expect(notifyMock).toHaveBeenCalledWith('error', expect.stringContaining('EBUSY: resource busy'))
})

test('删除:无 warning → 恒 success 提示(不误报警)', async () => {
  deleteProjectMock.mockResolvedValueOnce({ ok: true, removedConversations: 0, repoRemoved: true })
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  await w.find('[data-testid="delete-confirm-btn"]').trigger('click')
  await flushPromises()
  expect(notifyMock).toHaveBeenCalledWith('success', expect.any(String))
  expect(notifyMock).not.toHaveBeenCalledWith('error', expect.anything())
})

// 终审 M1 语义:确认名 trim 对称——项目名可含首尾空白,只比原文会让它永远删不掉
test('删除确认名 trim 对称:项目名带首尾空白,输入 trim 后即可删', async () => {
  state.projects = [{ id: 'p-pad', name: 'pad me ', clusterId: '', namespace: 'default', manifestCount: 0, lastReconcile: null }]
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('pad me')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  expect(btn.attributes('disabled')).toBeUndefined()
  await btn.trigger('click')
  await flushPromises()
  expect(deleteProjectMock).toHaveBeenCalledWith('p-pad', 'pad me')
  expect(w.text()).not.toContain('pad me')
})

test('删除确认名仍逐字敏感:trim 后不等则禁用(M1 不是放弃校验)', async () => {
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alph')
  expect(w.find('[data-testid="delete-confirm-btn"]').attributes('disabled')).toBeDefined()
  expect(deleteProjectMock).not.toHaveBeenCalled()
})

// 终审 M2 语义:删除在途防重入——双击第二发落在已删项目上 → 404 → 假「删除失败」
test('删除:在途期间再点确定不发第二发请求', async () => {
  let release
  deleteProjectMock.mockImplementationOnce(() => new Promise(r => { release = r }))
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  await btn.trigger('click')       // 第一发(在途,不 resolve)
  await btn.trigger('click')       // 双击第二发
  await btn.trigger('click')
  expect(deleteProjectMock).toHaveBeenCalledTimes(1)
  release({ ok: true })
  await flushPromises()
  expect(deleteProjectMock).toHaveBeenCalledTimes(1)
  expect(w.text()).not.toContain('alpha')
})

test('删除:在途时确定按钮禁用', async () => {
  let release
  deleteProjectMock.mockImplementationOnce(() => new Promise(r => { release = r }))
  const w = mountView()
  await flushPromises()
  await openDeleteModal(w)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  await btn.trigger('click')
  expect(btn.attributes('disabled')).toBeDefined()
  release({ ok: true })
  await flushPromises()
})
