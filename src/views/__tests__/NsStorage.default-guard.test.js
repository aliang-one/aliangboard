// NsStorage 创建 PVC 弹窗「集群默认」选项回归(2026-09-04 集群默认不变式,spec §3.6):
//   有默认 SC → option 可选,label 含默认名;无默认 → option disabled + hint;
//   提交落库不再出现硬编码 'standard'(storageClass=显式默认名)。
//   SC mapper 字段是 `default`(非 isDefault)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const state = vi.hoisted(() => ({ scs: [] }))
const addPVC = vi.fn(async () => ({ ok: true }))
vi.mock('@/api/client', () => ({ api: { k8s: vi.fn(async () => ({ items: [] })) } }))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo', setNamespace: () => {},
    fetchStorageClasses: vi.fn(async () => state.scs),
    fetchPVCs: vi.fn(async () => []),
    addPVC: (...a) => addPVC(...a),
    deletePVC: vi.fn(),
  }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'demo' } }), useRouter: () => ({ push: () => {} }) }))

import NsStorage from '../NsStorage.vue'

beforeEach(() => { addPVC.mockClear() })

function mountView() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(NsStorage, {
    global: {
      plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]],
      stubs: {
        Modal: { props: ['modelValue', 'title', 'width'], emits: ['update:modelValue'], template: '<div><slot/><slot name="actions"/></div>' },
        Breadcrumbs: true, Pagination: true, DataTable: true, StatusChip: true, ProgressBar: true, CreateWithYamlButton: true,
      },
    },
  })
  return { w, qc }
}

test('有默认 SC → 集群默认 option 可选,label 含默认名', async () => {
  state.scs = [{ name: 'a', default: false }, { name: 'fast-sc', default: true }]
  const { w } = mountView()
  await flushPromises()
  await w.setData({ showCreatePVC: true })
  const opt = w.find('[data-testid="pvc-cluster-default-option"]')
  expect(opt.exists()).toBe(true)
  expect(opt.attributes('disabled')).toBeUndefined()
  expect(opt.text()).toContain('fast-sc')
  expect(w.find('[data-testid="pvc-cluster-default-hint"]').exists()).toBe(false)
})

test('无默认 SC → option disabled + hint 渲染', async () => {
  state.scs = [{ name: 'a', default: false }]
  const { w } = mountView()
  await flushPromises()
  await w.setData({ showCreatePVC: true })
  const opt = w.find('[data-testid="pvc-cluster-default-option"]')
  expect(opt.attributes('disabled')).toBeDefined()
  expect(w.find('[data-testid="pvc-cluster-default-hint"]').exists()).toBe(true)
})

test('有默认 → 选中「集群默认」提交:addPVC 收到显式默认名(不再硬编码 standard)', async () => {
  state.scs = [{ name: 'a', default: false }, { name: 'fast-sc', default: true }]
  const { w } = mountView()
  await flushPromises()
  await w.setData({ showCreatePVC: true, createForm: { name: 'pvc-1', capacity: '10Gi', accessModes: 'RWO', storageClass: '' } })
  await w.vm.handleCreatePVC()
  await flushPromises()
  expect(addPVC).toHaveBeenCalledTimes(1)
  expect(addPVC.mock.calls[0][0].storageClass).toBe('fast-sc')
})
