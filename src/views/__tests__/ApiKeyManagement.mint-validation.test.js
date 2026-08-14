// 签发 API Key 表单必填校验回归(线上 bug:空字段直接提交 → 服务端 400
// 「mintKey 缺少必填字段」但前端无任何行内提示)。
// 期望:必填项(绑定集群 / SA namespace / SA name)为空时不发请求,
// 行内红字提示 + toast;填齐后才调 create。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const createMock = vi.fn(async () => ({ apikey: { id: 'k1', plaintext: 'x', prefix: 'p' } }))
const notifyMock = vi.fn()

vi.mock('@/api/client', () => ({
  adminApi: {
    apikeys: {
      list: vi.fn(async () => ({ apikeys: [] })),
      create: (...a) => createMock(...a),
      remove: vi.fn(),
      updateOverrides: vi.fn(),
      updateNamespaces: vi.fn(),
    },
    clusters: { list: vi.fn(async () => ({ clusters: [{ id: 'c1', name: 'demo', apiServer: 'https://x' }] })) },
  },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { username: 'admin', role: 'admin' } }) }))
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notifyMock(...a) }))
vi.mock('@/composables/useTableColumns', () => ({ useTableColumns: () => ({ tableColumns: () => [] }) }))

import ApiKeyManagement from '../admin/ApiKeyManagement.vue'

// Modal 打穿渲染(默认插槽 + actions 插槽),其余重组件 stub
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
async function openMintModal(w) {
  const btn = w.findAll('button').find(b => b.text().includes('签发 API Key'))
  expect(btn, '入口「签发 API Key」按钮存在').toBeTruthy()
  await btn.trigger('click')
  await flushPromises()
}
const submitBtn = w => w.findAll('button').find(b => b.text().trim() === '签发')

beforeEach(() => { createMock.mockClear(); notifyMock.mockClear() })

test('必填项为空:不发请求,行内提示 + toast', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()
  await openMintModal(w)

  await submitBtn(w).trigger('click')
  await flushPromises()

  expect(createMock).not.toHaveBeenCalled()
  expect(w.find('[data-testid="mint-error-clusterId"]').exists()).toBe(true)
  expect(w.find('[data-testid="mint-error-boundSA_namespace"]').exists()).toBe(true)
  expect(w.find('[data-testid="mint-error-boundSA_name"]').exists()).toBe(true)
  expect(notifyMock).toHaveBeenCalledWith('error', expect.any(String))
})

test('填齐必填项后才提交(值 trim)', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()
  await openMintModal(w)

  await w.find('select').setValue('c1') // 集群 select(第一个 select)
  await w.findAll('input').find(i => i.attributes('placeholder') === 'default').setValue(' kube-system ')
  await w.findAll('input').find(i => i.attributes('placeholder') === 'aliangboard-smoke').setValue('board-sa')
  await submitBtn(w).trigger('click')
  await flushPromises()

  expect(createMock).toHaveBeenCalledTimes(1)
  const payload = createMock.mock.calls[0][0]
  expect(payload.clusterId).toBe('c1')
  expect(payload.boundSA_namespace).toBe('kube-system')
  expect(payload.boundSA_name).toBe('board-sa')
  expect(w.find('[data-testid="mint-error-clusterId"]').exists()).toBe(false)
})
