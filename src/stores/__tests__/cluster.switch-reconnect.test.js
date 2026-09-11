// switchCluster 重写(2026-09-10 issue#8 根因B):切换集群必须走平台连接链
// (authStore.connectCluster 按 clusterId 换新 K8s token),不再消费 localStorage
// 登记簿里的缓存 token——服务端单活会话模型下,连过 B 之后 A 的缓存 token 必已
// 被吊销(connect-cluster 换集群即 revoke 旧 token),旧实现 = 401 → 整页弹回选择页。
import { test, expect, vi } from 'vitest'
import { ref } from 'vue'
import { createClustersDomain } from '@/stores/cluster/clusters'

const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn() }))
vi.mock('@/api/client', () => ({ api: {}, portForwardApi: {}, authApi: { myClusters: vi.fn(async () => ({ clusters: [] })) } }))
vi.mock('@/composables/useToast', () => ({ notify: notifyMock }))

function makeDomain(connectCluster) {
  const deps = {
    cluster: ref({ apiServer: 'https://a' }), activeApiServerRef: ref('https://a'), apiReachable: ref(true),
    connectionState: ref('connected'), currentCluster: ref('a'), currentNamespace: ref('default'),
    hydrateCriticalResources: vi.fn(), startWorkloadFamilyWatch: vi.fn(),
    stopWorkloadFamilyWatch: vi.fn(), startHealthCheck: vi.fn(), setMetricsHold: vi.fn(),
    metricsReloadWindow: vi.fn(), connectCluster, clusterList: ref([]),
  }
  return { domain: createClustersDomain(deps), deps }
}

test('switchCluster:按 clusterId 走平台连接,成功后身份全量换新 + 水合', async () => {
  const connect = vi.fn(async () => ({ token: 'fresh-tok', cluster: { name: 'prod', apiServer: 'https://prod.example/', version: 'v1.30' } }))
  const { domain, deps } = makeDomain(connect)
  await domain.switchCluster('c1')
  expect(connect).toHaveBeenCalledWith('c1')
  expect(deps.currentCluster.value).toBe('prod')
  expect(deps.cluster.value.apiServer).toBe('https://prod.example')   // 尾斜杠剥除
  expect(deps.currentNamespace.value).toBe('')                        // 换集群清 ns 作用域
  expect(deps.hydrateCriticalResources).toHaveBeenCalledTimes(1)
  expect(deps.setMetricsHold).toHaveBeenLastCalledWith(false)         // finally 必释放
})

test('switchCluster:连接失败 → notify + rethrow,不切身份不清 ns(调用方留原地)', async () => {
  const connect = vi.fn(async () => { throw new Error('boom') })
  const { domain, deps } = makeDomain(connect)
  await expect(domain.switchCluster('c2')).rejects.toThrow('boom')
  expect(notifyMock).toHaveBeenCalledWith('error', expect.stringContaining('boom'))
  expect(deps.currentCluster.value).toBe('a')          // 身份未动
  expect(deps.currentNamespace.value).toBe('default')  // ns 未动
  expect(deps.hydrateCriticalResources).not.toHaveBeenCalled()
  expect(deps.setMetricsHold).toHaveBeenLastCalledWith(false)
})
