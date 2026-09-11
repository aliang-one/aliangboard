// /clusters(管理全部)页服务端化(2026-09-10 issue#8):列表来自 store.clusterList
// (my-clusters 映射),卡片点击走 switchCluster(id);「新增集群」指 /add-cluster
// (旧 /login 入口会被守卫绕回选择页);本地移除流退役(登记簿已删)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const { pushMock, switchMock, loadMock } = vi.hoisted(() => ({ pushMock: vi.fn(), switchMock: vi.fn(async () => {}), loadMock: vi.fn(async () => {}) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushMock }), RouterLink: { template: '<a><slot/></a>' } }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    clusterList: [
      { id: 'c1', name: 'prod-alias', apiServer: 'https://172.18.0.1:6443', version: 'v1.31', status: 'Healthy', distribution: 'Kubernetes' },
      { id: 'c2', name: 'dev', apiServer: 'https://172.18.30.131:6443', version: 'v1.30', status: 'Healthy', distribution: 'Kubernetes' },
    ],
    cluster: { name: 'dev', apiServer: 'https://172.18.30.131:6443' },
    currentCluster: 'dev',
    loadAvailableClusters: loadMock,
    switchCluster: switchMock,
    invalidateAllClusterQueries: vi.fn(async () => {}),
  }),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@/composables/usePagination', () => ({ usePagination: (src) => ({ currentPage: { value: 1 }, pageSize: { value: 10 }, paginated: src, total: src.value.length }) }))

import Clusters from '../Clusters.vue'

beforeEach(() => { pushMock.mockClear(); switchMock.mockClear(); loadMock.mockClear() })

test('挂载即拉服务端列表;卡片标题为集群名(非 IP)', async () => {
  const w = mount(Clusters, { global: { plugins: [i18n] } })
  expect(loadMock).toHaveBeenCalledTimes(1)
  expect(w.text()).toContain('prod-alias')
  expect(w.text()).toContain('当前为')   // 副标题当前集群=dev(真名)
})

test('点卡片:换集群走 switchCluster(id),成功后进 /cluster', async () => {
  const w = mount(Clusters, { global: { plugins: [i18n] } })
  await flushPromises()
  await w.findAll('[data-test="cluster-card"]')[0].trigger('click')
  await flushPromises()
  expect(switchMock).toHaveBeenCalledWith('c1')
  expect(pushMock).toHaveBeenCalledWith('/cluster')
})

test('「新增集群」指 /add-cluster(不再绕 /login)', async () => {
  const w = mount(Clusters, { global: { plugins: [i18n] } })
  await w.findAll('button').find(b => b.text().includes('添加集群') || b.text().includes('Add')).trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/add-cluster')
})
