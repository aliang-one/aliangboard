// WorkbenchServers 浮层 Teleport 契约(2026-09-05 浮层受困事故):
// 台账/表单弹窗必须传送 body(wb-rise 曾以 both fill 常驻 transform,pane 内 fixed 被困进
// stage 裁切;传送后与祖先 transform 彻底解耦)。文件浏览浮窗同理(v-for 整体传送)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

vi.mock('@tanstack/vue-query', () => ({
  useQuery: () => ({ data: { value: [] }, isLoading: { value: false }, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn(), getQueryData: vi.fn() }),
  VueQueryPlugin: { install: vi.fn() },
}))
vi.mock('@/api/client', () => ({
  sshApi: {
    listServers: async () => ({ servers: [] }),
    createServer: async () => ({}),
    updateServer: async () => ({}),
    deleteServer: async () => ({}),
    testServer: async () => ({ ok: true }),
    ledger: async () => ({ rows: [] }),
  },
  platformHttp: { request: async () => ({}) },
}))
vi.mock('@/components/ssh/ServerLedgerPanel.vue', () => ({ default: { template: '<div data-test="stub-ledger-panel" />' } }))
vi.mock('@/components/ssh/SshServerForm.vue', () => ({ default: { template: '<div data-test="stub-server-form" />' } }))
vi.mock('@/components/ssh/SshFileBrowserWindow.vue', () => ({ default: { template: '<div data-test="stub-fb-window" />' } }))

import WorkbenchServers from '../WorkbenchServers.vue'

async function mountAdmin() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth')
  useAuthStore().user = { role: 'admin' }
  return mount(WorkbenchServers, { global: { plugins: [pinia, i18n] } })
}

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })

test('台账弹窗传送到 body:打开后挂载点在 document.body 下,不在组件子树内', async () => {
  const w = await mountAdmin()
  await flushPromises()
  await w.find('[data-test="btnLedger"]').trigger('click')
  await flushPromises()
  const inBody = document.body.querySelector('[data-test="ledgerModal"]')
  expect(inBody).toBeTruthy()
  expect(inBody.closest('section')).toBe(null)          // 不在组件子树(body 直挂)
  expect(w.find('[data-test="ledgerModal"]').exists()).toBe(false)  // 组件内不再有(旧受困位置)
})

test('服务器表单弹窗同样传送 body', async () => {
  const w = await mountAdmin()
  await flushPromises()
  await w.find('[data-test="btnAdd"]').trigger('click')
  await flushPromises()
  expect(document.body.querySelector('[data-test="stub-server-form"]')).toBeTruthy()
  expect(w.find('[data-test="stub-server-form"]').exists()).toBe(false)
})
