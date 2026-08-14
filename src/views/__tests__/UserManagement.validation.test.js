// 用户管理表单必填校验回归:创建用户(username/password)、重置密码(newPassword)
// 都曾裸发空字段吃服务端 400「不能为空」而无行内提示。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const createMock = vi.fn(async () => ({}))
const resetMock = vi.fn(async () => ({}))

vi.mock('@/api/client', () => ({
  adminApi: {
    users: {
      list: vi.fn(async () => ({ users: [{ id: 'u1', username: 'bob', role: 'user', disabled: 0, clusterIds: [] }] })),
      create: (...a) => createMock(...a),
      remove: vi.fn(),
      patch: vi.fn(),
      assignClusters: vi.fn(),
      resetPassword: (...a) => resetMock(...a),
    },
    clusters: { list: vi.fn(async () => ({ clusters: [] })) },
  },
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@/composables/useTableColumns', () => ({ useTableColumns: () => ({ tableColumns: () => [] }) }))

import UserManagement from '../admin/UserManagement.vue'

// DataTable stub:渲染 actions 作用域插槽(带假行)以触达「重置密码」按钮
function mountView() {
  return mount(UserManagement, {
    global: {
      plugins: [i18n],
      stubs: {
        Modal: { template: '<div><slot /><slot name="actions" /></div>' },
        DataTable: {
          props: ['headers', 'rows', 'columnKey', 'rowKey'],
          template: '<div><slot name="actions" :row="{ id: \'u1\', username: \'bob\', role: \'user\', disabled: 0, clusterIds: [] }" /></div>',
        },
      },
    },
  })
}
const btnByTitle = (w, title) => w.findAll('button').find(b => b.attributes('title') === title)
const submitBtn = (w, label) => w.findAll('button').find(b => b.text().trim() === label)

beforeEach(() => { createMock.mockClear(); resetMock.mockClear() })

test('创建用户:username/password 为空 → 不发请求 + 行内提示;填齐才提交(trim)', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()
  await w.findAll('button').find(b => b.text().includes('添加用户')).trigger('click')
  await flushPromises()

  await submitBtn(w, '创建').trigger('click')
  await flushPromises()
  expect(createMock).not.toHaveBeenCalled()
  expect(w.find('[data-testid="form-error-username"]').exists()).toBe(true)
  expect(w.find('[data-testid="form-error-password"]').exists()).toBe(true)

  // 填齐(第一个 input=用户名,type=password=密码)
  await w.findAll('input').find(i => i.attributes('type') !== 'password').setValue(' alice ')
  await w.find('input[type=password]').setValue('pw123')
  await submitBtn(w, '创建').trigger('click')
  await flushPromises()

  expect(createMock).toHaveBeenCalledTimes(1)
  expect(createMock.mock.calls[0][0]).toMatchObject({ username: 'alice', password: 'pw123' })
})

test('重置密码:为空 → 不发请求 + 行内提示;填齐才提交(trim)', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()

  await btnByTitle(w, '重置密码').trigger('click')
  await flushPromises()

  await submitBtn(w, '重置').trigger('click')
  await flushPromises()
  expect(resetMock).not.toHaveBeenCalled()
  expect(w.find('[data-testid="form-error-newPassword"]').exists()).toBe(true)

  await w.findAll('input[type=password]').find(i => i.attributes('placeholder') === '新密码').setValue(' newpw ')
  await submitBtn(w, '重置').trigger('click')
  await flushPromises()

  expect(resetMock).toHaveBeenCalledTimes(1)
  expect(resetMock.mock.calls[0][1]).toBe(' newpw ') // 密码不 trim(空格合法)
})
