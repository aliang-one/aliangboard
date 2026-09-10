// setConnectedCluster 契约:清 queryClient 缓存(换集群防旧缓存串味)+ name 优先
// (服务端下发集群名,hostname 仅极端缺字段兜底)+ 触发可用集群列表刷新。
// 域函数依赖全注入,直接测 createClustersDomain,不经 pinia 全家桶。
import { test, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { createClustersDomain } from '@/stores/cluster/clusters'
import { queryClient } from '@/queryClient'

const myClustersMock = vi.fn()
vi.mock('@/api/client', () => ({
  api: {},
  portForwardApi: {},
  authApi: { myClusters: (...a) => myClustersMock(...a) },
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

// 每用例清零:4 个用例各自触发一次 fire-and-forget 刷新,不清零会让计数跨用例累计
beforeEach(() => { myClustersMock.mockClear() })

function makeDomain(over = {}) {
  return createClustersDomain({
    cluster: ref({}), activeApiServerRef: ref(''), apiReachable: ref(false),
    connectionState: ref(''), currentCluster: ref(''), currentNamespace: ref(''),
    hydrateCriticalResources: vi.fn(), startWorkloadFamilyWatch: vi.fn(),
    stopWorkloadFamilyWatch: vi.fn(), startHealthCheck: vi.fn(), setMetricsHold: vi.fn(),
    metricsReloadWindow: vi.fn(), connectCluster: over.connectCluster ?? vi.fn(),
    clusterList: ref([]),
  })
}

test('setConnectedCluster 清 queryClient 缓存(换集群防旧缓存串味)', () => {
  const clearSpy = vi.spyOn(queryClient, 'clear')
  const domain = makeDomain()
  domain.setConnectedCluster({ name: 'b', apiServer: 'https://b', version: 'v1.29' })
  expect(clearSpy).toHaveBeenCalledTimes(1)
  clearSpy.mockRestore()
})

test('setConnectedCluster:name 优先于 hostname 兜底', () => {
  const domain = makeDomain()
  domain.setConnectedCluster({ name: 'prod-alias', apiServer: 'https://172.18.0.1:6443', version: 'v1.30' })
  expect(domain.currentCluster.value).toBe('prod-alias')
  expect(domain.cluster.value.name).toBe('prod-alias')
})

test('setConnectedCluster:无 name 时 hostname 兜底(孤儿会话展示退 IP 但不炸)', () => {
  const domain = makeDomain()
  domain.setConnectedCluster({ apiServer: 'https://172.18.0.1:6443' })
  expect(domain.currentCluster.value).toBe('172.18.0.1')
})

test('setConnectedCluster:fire-and-forget 刷新可用集群列表', async () => {
  myClustersMock.mockResolvedValue({ clusters: [{ id: 'c1', name: 'prod', apiServer: 'https://p', version: 'v1.30' }] })
  const domain = makeDomain()
  domain.setConnectedCluster({ name: 'prod', apiServer: 'https://p' })
  await new Promise(r => setTimeout(r, 0))
  expect(myClustersMock).toHaveBeenCalledTimes(1)
  expect(domain.clusterList.value.map(c => c.id)).toEqual(['c1'])
})
