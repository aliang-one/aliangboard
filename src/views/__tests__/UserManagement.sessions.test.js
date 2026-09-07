// W3 Task 5:用户管理行操作「强制下线」(ConfirmDialog danger)+ mfaPending 徽章。
// adminApi.sessions.list 提供徽章数据面(该用户任一会话 mfaPending=1 → 徽章);
// 强制下线确认后调 adminApi.sessions.forceLogout。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const forceLogoutMock = vi.fn(async () => ({ ok: true, revoked: 2 }))

vi.mock('@/api/client', () => ({
  adminApi: {
    users: {
      list: vi.fn(async () => ({ users: [{ id: 'u1', username: 'bob', role: 'user', disabled: 0, clusterIds: [] }] })),
      create: vi.fn(), remove: vi.fn(), patch: vi.fn(), assignClusters: vi.fn(), resetPassword: vi.fn(),
    },
    clusters: { list: vi.fn(async () => ({ clusters: [] })) },
    sessions: {
      list: vi.fn(async () => ({ items: [
        { userId: 'u1', username: 'bob', mfaPending: 1, ip: '2.2.2.2', userAgent: 'curl/8', createdAt: 1, lastSeenAt: 2 },
        { userId: 'u1', username: 'bob', mfaPending: 0, ip: '3.3.3.3', userAgent: 'Mozilla/5.0', createdAt: 1, lastSeenAt: 3 },
      ], total: 2 })),
      forceLogout: (...a) => forceLogoutMock(...a),
    },
  },
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@/composables/useTableColumns', () => ({ useTableColumns: () => ({ tableColumns: () => [] }) }))

import UserManagement from '../admin/UserManagement.vue'

function mountView() {
  return mount(UserManagement, {
    global: {
      plugins: [i18n],
      stubs: {
        Modal: { template: '<div><slot /><slot name="actions" /></div>' },
        DataTable: {
          props: ['headers', 'rows', 'columnKey', 'rowKey'],
          template: `<div><slot name="username" :row="row" /><slot name="actions" :row="row" /></div>`,
          data() { return { row: { id: 'u1', username: 'bob', role: 'user', disabled: 0, clusterIds: [] } } },
        },
        ConfirmDialog: {
          props: ['modelValue', 'title', 'message', 'danger'],
          emits: ['update:modelValue', 'confirm'],
          template: `<div v-if="modelValue" data-testid="force-confirm" @click="$emit('confirm')">{{ title }}</div>`,
        },
      },
    },
  })
}
const btnByTitle = (w, title) => w.findAll('button').find(b => b.attributes('title') === title)

beforeEach(() => { forceLogoutMock.mockClear() })

test('mfaPending 徽章:该用户存在受限会话 → username 列出徽章', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()
  expect(w.find('[data-testid="mfa-pending-badge"]').exists()).toBe(true)
})

test('强制下线:行按钮 → ConfirmDialog(danger) → 确认调 forceLogout(userId)', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()
  await btnByTitle(w, i18n.global.t('admin.sessions.forceLogout')).trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="force-confirm"]').exists()).toBe(true)
  await w.find('[data-testid="force-confirm"]').trigger('click')
  await flushPromises()
  expect(forceLogoutMock).toHaveBeenCalledTimes(1)
  expect(forceLogoutMock.mock.calls[0][0]).toBe('u1')
})
