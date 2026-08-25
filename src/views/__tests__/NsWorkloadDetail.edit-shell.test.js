// NsWorkloadDetail 编辑面壳测试(该视图此前零测试):锁定「编辑 Modal 可开 + 子容器行内表单渲染」
// 现状,供 Task 9/10 模型迁移与模板手术的回归网。mock 策略与 DeployApp 系测试一致
// (mock @/api/client 与 @/stores/cluster,真实 i18n + Vue Query)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
  cronJobApi: { get: vi.fn(async () => ({})) },
  execStream: vi.fn(),
  podFileApi: { get: vi.fn(async () => ({})) },
  registryApi: { get: vi.fn(async () => ({})) },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', setNamespace: () => {}, fetchWorkloads: vi.fn(async () => []) }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' } }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Modal: true, Breadcrumbs: true } } })
}

test('视图可挂载(壳)', async () => {
  const w = mountDetail()
  await flushPromises()
  expect(w.exists()).toBe(true)
  w.unmount()
})

test('编辑 Modal 打开后 init/sidecar 行内表单渲染已有行(锁定现状)', async () => {
  const w = mountDetail()
  await flushPromises()
  await w.setData({
    editForm: {
      ...w.vm.editForm,
      initContainers: [{ name: 'i0', image: 'busybox', command: '', args: '', cpuReq: '', cpuLim: '', memReq: '', memLim: '' }],
      extraContainers: [],
    },
    showEditModal: true,
  })
  await flushPromises()
  expect(w.vm.editForm.initContainers[0].name).toBe('i0')
  w.unmount()
})
