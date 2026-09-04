// Storage 页创建 PVC 回归(2026-09-04 集群默认不变式,spec §3.6):
//   无默认 SC 且未显式选择 → 创建按钮 disabled + hint 渲染;
//   有默认 → 选中「集群默认」(value='')提交 addPVC 收到 storageClass=显式默认名(去硬编码 'standard')。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const state = vi.hoisted(() => ({ scs: [] }))
const addPVC = vi.fn(async () => ({ ok: true }))
// I-2:SC 创建勾默认 → addStorageClass 恒 default:false,成功后 promoteStorageClassDefault(name)
const addStorageClass = vi.fn(async () => ({ ok: true }))
const promoteStorageClassDefault = vi.fn(async () => ({ ok: true }))
vi.mock('@/api/client', () => ({ api: { k8s: vi.fn(async () => ({ items: [] })) } }))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo', namespaceList: [{ name: 'default' }],
    fetchNamespaces: vi.fn(async () => [{ name: 'default' }]),
    fetchPVCs: vi.fn(async () => []), fetchPVs: vi.fn(async () => []),
    fetchStorageClasses: vi.fn(async () => state.scs),
    addPVC: (...a) => addPVC(...a),
    addPV: vi.fn(), addStorageClass: (...a) => addStorageClass(...a),
    promoteStorageClassDefault: (...a) => promoteStorageClassDefault(...a),
    generateYAML: vi.fn(() => ''), deletePV: vi.fn(), deleteStorageClass: vi.fn(),
  }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import Storage from '../Storage.vue'

beforeEach(() => { addPVC.mockClear(); addStorageClass.mockClear(); promoteStorageClassDefault.mockClear() })

function mountView() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(Storage, {
    global: {
      plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]],
      stubs: {
        Modal: { props: ['modelValue', 'title', 'width'], emits: ['update:modelValue'], template: '<div><slot/><slot name="actions"/></div>' },
        Pagination: true, DataTable: true, StatusChip: true, CodeViewer: true,
      },
    },
  })
  return { w, qc }
}

test('无默认且未选 → 创建按钮 disabled + hint 渲染', async () => {
  state.scs = [{ name: 'a', default: false }]
  const { w } = mountView()
  await flushPromises()
  await w.setData({ showCreatePVC: true, createForm: { name: 'pvc-1', namespace: 'default', capacity: '10Gi', accessModes: 'RWO', storageClass: '' } })
  const btns = w.findAll('button')
  const create = btns.find(b => b.text() === i18n.global.t('storage.create'))
  expect(create).toBeTruthy()
  expect(create.attributes('disabled')).toBeDefined()
  expect(w.find('[data-testid="pvc-cluster-default-hint"]').exists()).toBe(true)
  const opt = w.find('[data-testid="pvc-cluster-default-option"]')
  expect(opt.exists()).toBe(true)
  expect(opt.attributes('disabled')).toBeDefined()
})

test('有默认 → 选中「集群默认」提交:addPVC 收到 storageClass=默认名', async () => {
  state.scs = [{ name: 'a', default: false }, { name: 'fast-sc', default: true }]
  const { w } = mountView()
  await flushPromises()
  await w.setData({ showCreatePVC: true, createForm: { name: 'pvc-1', namespace: 'default', capacity: '10Gi', accessModes: 'RWO', storageClass: '' } })
  const opt = w.find('[data-testid="pvc-cluster-default-option"]')
  expect(opt.attributes('disabled')).toBeUndefined()
  expect(opt.text()).toContain('fast-sc')
  const create = w.findAll('button').find(b => b.text() === i18n.global.t('storage.create'))
  expect(create.attributes('disabled')).toBeUndefined()
  await w.vm.handleCreatePVC()
  await flushPromises()
  expect(addPVC).toHaveBeenCalledTimes(1)
  expect(addPVC.mock.calls[0][0].storageClass).toBe('fast-sc')
})

test('SC 创建勾默认:addStorageClass 恒 default:false,成功后走 promoteStorageClassDefault', async () => {
  state.scs = []
  const { w } = mountView()
  await flushPromises()
  await w.setData({
    showCreateSC: true,
    createSCForm: { name: 'my-sc', provisioner: 'rancher.io/local-path', parameters: [], reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate', allowVolumeExpansion: false, default: true },
  })
  await w.vm.handleCreateSC()
  await flushPromises()
  expect(addStorageClass).toHaveBeenCalledTimes(1)
  expect(addStorageClass.mock.calls[0][0]).toMatchObject({ name: 'my-sc', default: false })
  expect(promoteStorageClassDefault).toHaveBeenCalledWith('my-sc')
})

test('SC 创建未勾默认:成功后不调 promoteStorageClassDefault', async () => {
  state.scs = []
  const { w } = mountView()
  await flushPromises()
  await w.setData({
    showCreateSC: true,
    createSCForm: { name: 'plain-sc', provisioner: 'x', parameters: [], reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate', allowVolumeExpansion: false, default: false },
  })
  await w.vm.handleCreateSC()
  await flushPromises()
  expect(addStorageClass).toHaveBeenCalledWith(expect.objectContaining({ name: 'plain-sc', default: false }))
  expect(promoteStorageClassDefault).not.toHaveBeenCalled()
})
