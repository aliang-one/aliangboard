import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const notifyMock = vi.fn()
const updateProjectMock = vi.fn()
const deleteProjectMock = vi.fn()
const pushMock = vi.fn()

// 列表数据可注入:trim 对称性测试需要带首尾空白的项目名
const state = vi.hoisted(() => ({
  projects: [{ id: 'p1', name: 'alpha', clusterId: 'c1', createdAt: 1 }],
}))

vi.mock('@/api/client', () => ({
  workbenchApi: {
    listProjects: () => Promise.resolve({ projects: state.projects }),
    createProject: vi.fn(),
    updateProject: (...a) => updateProjectMock(...a),
    deleteProject: (...a) => deleteProjectMock(...a),
  },
  authApi: { myClusters: () => Promise.resolve([]) },
}))
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notifyMock(...a) }))
vi.mock('@/composables/useTableColumns', () => ({ useTableColumns: () => ({ tableColumns: () => [] }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushMock }) }))

import WorkbenchList from '@/views/WorkbenchList.vue'

const dtStub = {
  props: ['headers', 'rows', 'columnKey'],
  template: `<div><div v-for="row in rows" :key="row.id" class="test-row">
    <slot name="name" :row="row" /><slot name="actions" :row="row" />
  </div></div>`,
}
const modalStub = {
  props: ['modelValue', 'title', 'width'],
  emits: ['update:modelValue'],
  template: `<div v-if="modelValue" class="test-modal"><div class="test-modal-body"><slot /></div><div class="test-modal-actions"><slot name="actions" /></div></div>`,
}

function mountView() {
  return mount(WorkbenchList, {
    global: { plugins: [i18n], stubs: { DataTable: dtStub, Modal: modalStub } },
  })
}

beforeEach(() => {
  notifyMock.mockClear(); updateProjectMock.mockClear(); deleteProjectMock.mockClear(); pushMock.mockClear()
  state.projects = [{ id: 'p1', name: 'alpha', clusterId: 'c1', createdAt: 1 }]
})

test('重命名:行内输入新名 → updateProject(id, {name}) 调用 + 本地列表刷新', async () => {
  const w = mountView()
  await flushPromises()
  const row = w.find('.test-row')
  expect(row.text()).toContain('alpha')
  await row.find('[data-testid="row-rename"]').trigger('click')
  const input = row.find('input[data-testid="rename-input"]')
  expect(input.exists()).toBe(true)
  await input.setValue('beta')
  await input.trigger('keyup.enter')
  expect(updateProjectMock).toHaveBeenCalledWith('p1', { name: 'beta' })
  await flushPromises()
  expect(w.vm.projects[0].name).toBe('beta')
  expect(notifyMock).toHaveBeenCalledWith('success', expect.stringContaining('beta'))
})

test('重命名:输入为空直接回车不发请求', async () => {
  const w = mountView()
  await flushPromises()
  const row = w.find('.test-row')
  await row.find('[data-testid="row-rename"]').trigger('click')
  await row.find('[data-testid="rename-input"]').setValue('   ')
  await row.find('[data-testid="rename-input"]').trigger('keyup.enter')
  expect(updateProjectMock).not.toHaveBeenCalled()
})

test('删除:确认名不一致时确定按钮禁用且点击不发请求', async () => {
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="row-delete"]').trigger('click')
  expect(w.find('.test-modal').exists()).toBe(true)
  await w.find('[data-testid="delete-confirm-input"]').setValue('alph')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  expect(btn.attributes('disabled')).toBeDefined()
  await btn.trigger('click')
  expect(deleteProjectMock).not.toHaveBeenCalled()
})

test('删除:确认名逐字一致 → deleteProject(id, name) + 列表移除 + notify', async () => {
  const w = mountView()
  await flushPromises()
  expect(w.findAll('.test-row')).toHaveLength(1)
  await w.find('[data-testid="row-delete"]').trigger('click')
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  expect(btn.attributes('disabled')).toBeUndefined()
  await btn.trigger('click')
  expect(deleteProjectMock).toHaveBeenCalledWith('p1', 'alpha')
  await flushPromises()
  expect(w.findAll('.test-row')).toHaveLength(0)
  expect(notifyMock).toHaveBeenCalledWith('success', expect.any(String))
})

test('重命名:enter 后紧接 blur 只发一次 PATCH(竞态守卫)', async () => {
  const w = mountView()
  await flushPromises()
  const row = w.find('.test-row')
  await row.find('[data-testid="row-rename"]').trigger('click')
  const input = row.find('input[data-testid="rename-input"]')
  await input.setValue('gamma')
  input.trigger('keyup.enter') // 不等 PATCH 落定,立刻 blur
  await input.trigger('blur')
  await flushPromises()
  expect(updateProjectMock).toHaveBeenCalledTimes(1)
  expect(w.vm.projects[0].name).toBe('gamma')
  expect(w.find('input[data-testid="rename-input"]').exists()).toBe(false)
})

test('重命名:PATCH 失败保留输入态可重试', async () => {
  updateProjectMock.mockRejectedValueOnce(new Error('nope'))
  const w = mountView()
  await flushPromises()
  const row = w.find('.test-row')
  await row.find('[data-testid="row-rename"]').trigger('click')
  const input = row.find('input[data-testid="rename-input"]')
  await input.setValue('delta')
  await input.trigger('keyup.enter')
  await flushPromises()
  expect(notifyMock).toHaveBeenCalledWith('error', 'nope')
  expect(w.find('input[data-testid="rename-input"]').exists()).toBe(true)
  expect(w.find('input[data-testid="rename-input"]').element.value).toBe('delta')
  updateProjectMock.mockResolvedValueOnce({ ok: true })
  await input.trigger('keyup.enter')
  await flushPromises()
  expect(updateProjectMock).toHaveBeenCalledTimes(2)
  expect(w.vm.projects[0].name).toBe('delta')
})

test('删除:请求失败时列表保留 + error notify', async () => {
  deleteProjectMock.mockRejectedValueOnce(new Error('boom'))
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="row-delete"]').trigger('click')
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  await w.find('[data-testid="delete-confirm-btn"]').trigger('click')
  await flushPromises()
  expect(w.findAll('.test-row')).toHaveLength(1)
  expect(notifyMock).toHaveBeenCalledWith('error', 'boom')
})

// 终审 I2:repo 目录清除失败时后端仍 200,但响应带 warning(数据已删、目录成孤儿)。
// 只报成功会让孤儿目录无人跟进——必须 error 级提示且内容含 warning 原文。
test('删除:响应带 warning(repo 目录清除失败)→ error 级提示含 warning,行仍移除', async () => {
  deleteProjectMock.mockResolvedValueOnce({ ok: true, removedConversations: 2, repoRemoved: false, warning: 'EBUSY: resource busy' })
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="row-delete"]').trigger('click')
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  await w.find('[data-testid="delete-confirm-btn"]').trigger('click')
  await flushPromises()
  // 数据确实已删(后端事务已提交):行移除,不误报「删除失败」
  expect(w.findAll('.test-row')).toHaveLength(0)
  expect(notifyMock).toHaveBeenCalledTimes(1)
  expect(notifyMock).toHaveBeenCalledWith('error', expect.stringContaining('EBUSY: resource busy'))
})

test('删除:无 warning → 恒 success 提示(不误报警)', async () => {
  deleteProjectMock.mockResolvedValueOnce({ ok: true, removedConversations: 0, repoRemoved: true })
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="row-delete"]').trigger('click')
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  await w.find('[data-testid="delete-confirm-btn"]').trigger('click')
  await flushPromises()
  expect(notifyMock).toHaveBeenCalledWith('success', expect.any(String))
  expect(notifyMock).not.toHaveBeenCalledWith('error', expect.anything())
})

// ═══ 终审 M1:确认名 trim 对称——项目名可含首尾空白,只比原文会让它永远删不掉 ═══
test('删除确认名 trim 对称:项目名带首尾空白,输入 trim 后即可删', async () => {
  state.projects = [{ id: 'p-pad', name: 'pad me ', clusterId: '', createdAt: 2 }]
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="row-delete"]').trigger('click')
  await w.find('[data-testid="delete-confirm-input"]').setValue('pad me')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  expect(btn.attributes('disabled')).toBeUndefined()
  await btn.trigger('click')
  await flushPromises()
  expect(deleteProjectMock).toHaveBeenCalledWith('p-pad', 'pad me')
  expect(w.findAll('.test-row')).toHaveLength(0)
})

test('删除确认名仍逐字敏感:trim 后不等则禁用(M1 不是放弃校验)', async () => {
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="row-delete"]').trigger('click')
  await w.find('[data-testid="delete-confirm-input"]').setValue('alph')
  expect(w.find('[data-testid="delete-confirm-btn"]').attributes('disabled')).toBeDefined()
  expect(deleteProjectMock).not.toHaveBeenCalled()
})

// ═══ 终审 M2:删除在途防重入——双击的第二发落在已删项目上会 404 → 假「删除失败」 ═══
test('删除:在途期间再点确定不发第二发请求', async () => {
  let release
  deleteProjectMock.mockImplementationOnce(() => new Promise(r => { release = r }))
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="row-delete"]').trigger('click')
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  await btn.trigger('click')       // 第一发(在途,不 resolve)
  await btn.trigger('click')       // 双击/ impatient 第二发
  await btn.trigger('click')
  expect(deleteProjectMock).toHaveBeenCalledTimes(1)
  release({ ok: true })
  await flushPromises()
  expect(deleteProjectMock).toHaveBeenCalledTimes(1)
  expect(w.findAll('.test-row')).toHaveLength(0)
})

test('删除:在途时确定按钮禁用', async () => {
  let release
  deleteProjectMock.mockImplementationOnce(() => new Promise(r => { release = r }))
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="row-delete"]').trigger('click')
  await w.find('[data-testid="delete-confirm-input"]').setValue('alpha')
  const btn = w.find('[data-testid="delete-confirm-btn"]')
  await btn.trigger('click')
  expect(btn.attributes('disabled')).toBeDefined()
  release({ ok: true })
  await flushPromises()
})
