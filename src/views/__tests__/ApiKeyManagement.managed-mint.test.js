// 托管双模式契约:默认托管(不填 SA name 可提交);BYO 需 SA name;托管 payload 不带 boundSA_name。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const createMock = vi.fn(async () => ({ apikey: { id: 'k1', plaintext: 'x', prefix: 'p', boundSA_namespace: 'ns', boundSA_name: 'aliangboard-mcp-11111111' } }))
const healthMock = vi.fn(async () => ({ health: [] }))
const notifyMock = vi.fn()

vi.mock('@/api/client', () => ({
  adminApi: {
    apikeys: {
      list: vi.fn(async () => ({ apikeys: [] })),
      create: (...a) => createMock(...a),
      remove: vi.fn(), updateOverrides: vi.fn(), updateNamespaces: vi.fn(),
      health: () => healthMock(), repairSa: vi.fn(),
    },
    clusters: { list: vi.fn(async () => ({ clusters: [{ id: 'c1', name: 'demo', apiServer: 'https://x' }] })) },
  },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { username: 'admin', role: 'admin' } }) }))
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notifyMock(...a) }))
vi.mock('@/composables/useTableColumns', () => ({ useTableColumns: () => ({ tableColumns: () => [] }) }))

import ApiKeyManagement from '../admin/ApiKeyManagement.vue'

function mountView() {
  return mount(ApiKeyManagement, {
    global: {
      plugins: [i18n],
      stubs: {
        Modal: { template: '<div><slot /><slot name="actions" /></div>' },
        DataTable: true, ToolOverrideEditor: true, NsAllowlistEditor: true,
      },
    },
  })
}
const fill = (wrapper, testid, value) => { wrapper.find(`[data-testid="${testid}"]`).setValue(value) }

beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

test('默认托管模式:填 cluster+ns 即可提交,payload 含 mode=managed 且无 boundSA_name', async () => {
  const w = mountView()
  await flushPromises()
  w.vm.mintForm.mode = 'managed'
  w.vm.mintForm.clusterId = 'c1'
  w.vm.mintForm.boundSA_namespace = 'ns'
  await w.vm.doMint()
  await flushPromises()
  expect(createMock).toHaveBeenCalledTimes(1)
  const payload = createMock.mock.calls[0][0]
  expect(payload.mode).toBe('managed')
  expect(payload.boundSA_name).toBeUndefined()
  expect(notifyMock).toHaveBeenCalledWith('success', expect.anything())
})

test('BYO 模式:SA name 必填,缺则行内报错不发请求', async () => {
  const w = mountView()
  await flushPromises()
  w.vm.mintForm.mode = 'byo'
  w.vm.mintForm.clusterId = 'c1'
  w.vm.mintForm.boundSA_namespace = 'ns'
  w.vm.mintForm.boundSA_name = ''
  await w.vm.doMint()
  await flushPromises()
  expect(createMock).not.toHaveBeenCalled()
  w.vm.mintForm.boundSA_name = 'my-sa'
  await w.vm.doMint()
  await flushPromises()
  const payload = createMock.mock.calls[0][0]
  expect(payload.mode).toBe('byo')
  expect(payload.boundSA_name).toBe('my-sa')
})

test('模式切换按钮存在且可切', async () => {
  const w = mountView()
  await flushPromises()
  expect(w.find('[data-testid="mint-mode-managed"]').exists()).toBe(true)
  expect(w.find('[data-testid="mint-mode-byo"]').exists()).toBe(true)
  await w.find('[data-testid="mint-mode-byo"]').trigger('click')
  expect(w.vm.mintForm.mode).toBe('byo')
})
