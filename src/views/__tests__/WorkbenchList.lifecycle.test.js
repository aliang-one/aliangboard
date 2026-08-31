import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const notifyMock = vi.fn()
const updateProjectMock = vi.fn()
const deleteProjectMock = vi.fn()
const pushMock = vi.fn()

vi.mock('@/api/client', () => ({
  workbenchApi: {
    listProjects: () => Promise.resolve({ projects: [{ id: 'p1', name: 'alpha', clusterId: 'c1', createdAt: 1 }] }),
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

beforeEach(() => { notifyMock.mockClear(); updateProjectMock.mockClear(); deleteProjectMock.mockClear(); pushMock.mockClear() })

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
