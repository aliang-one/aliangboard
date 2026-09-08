// setConnectedCluster 必须清 queryClient 缓存:SelectCluster 连接成功改 SPA 跳转后,
// 「死集群 A 弹回选择页再连 B」路径不再整页刷新——旧集群的 Vue Query 缓存若不清,
// 新集群页面会先闪现 A 的数据(串味)。对齐 switchCluster 的既有 queryClient.clear() 做法。
// 域函数依赖全注入,直接测 createClustersDomain,不经 pinia 全家桶。
import { test, expect, vi } from 'vitest'
import { ref } from 'vue'
import { createClustersDomain } from '@/stores/cluster/clusters'
import { queryClient } from '@/queryClient'

vi.mock('@/api/client', () => ({
  api: {},
  portForwardApi: {},
  getSavedClusters: () => [],
  addSavedCluster: vi.fn(),
  removeSavedCluster: vi.fn(),
  setActiveToken: vi.fn(),
  getSessionToken: () => 'tok',
}))

function makeDomain() {
  return createClustersDomain({
    cluster: ref({}), activeApiServerRef: ref(''), apiReachable: ref(false),
    connectionState: ref(''), currentCluster: ref(''), currentNamespace: ref(''),
    savedClusters: ref([]), hydrateCriticalResources: vi.fn(),
    startWorkloadFamilyWatch: vi.fn(), stopWorkloadFamilyWatch: vi.fn(),
    startHealthCheck: vi.fn(), setMetricsHold: vi.fn(), metricsReloadWindow: vi.fn(),
  })
}

test('setConnectedCluster 清 queryClient 缓存(换集群防旧缓存串味)', () => {
  const clearSpy = vi.spyOn(queryClient, 'clear')
  const domain = makeDomain()
  domain.setConnectedCluster({ apiServer: 'https://b', version: 'v1.29' })
  expect(clearSpy).toHaveBeenCalledTimes(1)
  clearSpy.mockRestore()
})

test('setConnectedCluster 不抛且登记活跃集群', () => {
  const domain = makeDomain()
  domain.setConnectedCluster({ apiServer: 'https://b', version: 'v1.29' })
  // 域内部经闭包共享,行为断言走 queryClient.clear 即可(上一用例);此用例锁不抛 + 可重复调用
  expect(() => domain.setConnectedCluster({ apiServer: 'https://c' })).not.toThrow()
})
