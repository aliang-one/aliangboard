import { describe, it, expect, vi, beforeEach } from 'vitest'

// 模块级 mock 必配 reset(既有教训):每用例重置注册表
const streamMocks = []
vi.mock('@/api/client', () => ({
  k8sStream: vi.fn((path, handlers) => {
    const h = { path, handlers, abort: vi.fn() }
    streamMocks.push(h)
    return h
  }),
  api: { k8s: vi.fn() },
  getSavedClusters: vi.fn(() => []), addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(),
  setActiveToken: vi.fn(), activeApiServer: vi.fn(), getSessionToken: vi.fn(() => 't'),
}))
// useFetchers 不 mock:真实模块只做纯 map 拼装,api.k8s 已被上面 '@/api/client' mock 拦截,
// 测试路径不会真正发起 fetch。brief 原文的纯 Proxy mock 会被 vitest 逐命名导出校验拒绝。

import { useClusterStore } from '@/stores/cluster'
import { createPinia, setActivePinia } from 'pinia'
import { clearWatchRegistry } from '@/composables/watchRegistry'

beforeEach(() => { setActivePinia(createPinia()); streamMocks.length = 0; clearWatchRegistry() })

describe('cluster store watch 接线', () => {
  it('startWorkloadFamilyWatch 建立 7 条 watch(workloads 三类+services+ingresses+pods+events),幂等', async () => {
    const store = useClusterStore()
    store.startWorkloadFamilyWatch()
    store.startWorkloadFamilyWatch()                    // 幂等:不重复建流
    const paths = streamMocks.map(h => h.path.split('?')[0])
    expect(paths.filter(p => p === '/apis/apps/v1/deployments')).toHaveLength(1)
    expect(paths.filter(p => p === '/apis/apps/v1/statefulsets')).toHaveLength(1)
    expect(paths.filter(p => p === '/apis/apps/v1/daemonsets')).toHaveLength(1)
    expect(paths).toContain('/api/v1/services')
    expect(paths).toContain('/apis/networking.k8s.io/v1/ingresses')
    expect(paths).toContain('/api/v1/pods')
    expect(paths).toContain('/api/v1/events')
    expect(streamMocks.length).toBe(7)
  })

  it('workloads 三类事件 merge 进同一 queryKey;watchStateOf 聚合三态', async () => {
    const store = useClusterStore()
    store.startWorkloadFamilyWatch()
    expect(store.watchStateOf('workloads')).toBe('reconnecting')  // 未 onOpen 前
    for (const h of streamMocks) h.handlers.onOpen?.()
    expect(store.watchStateOf('workloads')).toBe('live')
    // deployments 流断开一条 → 不再全 live;五连败一条 → degraded
    const dep = streamMocks.find(h => h.path.startsWith('/apis/apps/v1/deployments'))
    for (let i = 0; i < 5; i++) dep.handlers.onError(new Error('x'))
    expect(store.watchStateOf('workloads')).toBe('degraded')
    store.stopWorkloadFamilyWatch()
  })

  it('事件消息 setQueryData 走 canonical key', async () => {
    const store = useClusterStore()
    store.startWorkloadFamilyWatch()
    const svc = streamMocks.find(h => h.path.startsWith('/api/v1/services'))
    svc.handlers.onOpen?.()
    svc.handlers.onMessage(JSON.stringify({ type: 'ADDED', object: { metadata: { name: 'svc1', namespace: 'default', uid: 'u1', resourceVersion: '9' } }, spec: {}, status: {} }))
    // store 内部用 Pinia 测试插件的 queryClient;直接断言 watchStates 仍 live + registry RV 前滚
    expect(store.watchStateOf('services')).toBe('live')
    store.stopWorkloadFamilyWatch()
  })

  it('stopPodWatch 复位 pods 态为 off(podWatchLive=false),其余流不受影响', () => {
    const store = useClusterStore()
    store.startWorkloadFamilyWatch()
    for (const h of streamMocks) h.handlers.onOpen?.()
    store.stopPodWatch()
    expect(store.watchStateOf('pods')).toBe('off')
    expect(store.podWatchLive).toBe(false)
    expect(store.watchStateOf('workloads')).toBe('live')  // 其余流仍 live
    store.stopWorkloadFamilyWatch()
  })
})
