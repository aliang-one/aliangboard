import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 模块级 mock 必配 reset(既有教训):每用例重置注册表与两种流的捕获队列
const streamMocks = []   // 旧直连单资源流(k8sStream)
const channelMocks = []  // 多路复用通道(k8sChannel)
vi.mock('@/api/client', () => ({
  k8sStream: vi.fn((path, handlers) => {
    const h = { path, handlers, abort: vi.fn() }
    streamMocks.push(h)
    return h
  }),
  k8sChannel: vi.fn((path, handlers) => {
    const h = { path, handlers, abort: vi.fn() }
    channelMocks.push(h)
    return h
  }),
  api: { k8s: vi.fn() },
  getSavedClusters: vi.fn(() => []), addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(),
  setActiveToken: vi.fn(), activeApiServer: vi.fn(), getSessionToken: vi.fn(() => 't'),
}))
// useFetchers 不 mock:真实模块只做纯 map 拼装,api.k8s 已被上面 '@/api/client' mock 拦截,
// 测试路径不会真正发起 fetch。

import { useClusterStore } from '@/stores/cluster'
import { createPinia, setActivePinia } from 'pinia'
import { clearWatchRegistry, getListRv, recordListRv } from '@/composables/watchRegistry'
import { queryClient } from '@/queryClient'

beforeEach(() => {
  setActivePinia(createPinia()); streamMocks.length = 0; channelMocks.length = 0; clearWatchRegistry()
  localStorage.removeItem('aliangboard.watchFamily')   // 现默认开;'0' 才是 kill-switch
})
afterEach(() => {
  const store = useClusterStore()
  try { store.stopWorkloadFamilyWatch() } catch { /* 未启动时忽略 */ }
  localStorage.removeItem('aliangboard.watchFamily')
  queryClient.clear()
})

describe('cluster store 多路复用通道接线', () => {
  it('默认开:startWorkloadFamilyWatch 只建 1 条 k8sChannel,URL 含 7 资源;零直连 k8sStream', () => {
    const store = useClusterStore()
    store.startWorkloadFamilyWatch()
    store.startWorkloadFamilyWatch()                    // 幂等:不重复建通道
    expect(channelMocks.length).toBe(1)
    expect(streamMocks.length).toBe(0)
    expect(channelMocks[0].path).toBe('/api/k8s-watch?resources=pods,events,deployments,statefulsets,daemonsets,services,ingresses')
  })

  it('kill-switch(watchFamily=0):不建通道,watchStateOf=off 回落轮询', () => {
    localStorage.setItem('aliangboard.watchFamily', '0')
    const store = useClusterStore()
    store.startWorkloadFamilyWatch()
    expect(channelMocks.length).toBe(0)
    expect(store.watchStateOf('workloads')).toBe('off')
  })

  it('重连带 RV 参数:注册表有 RV 的资源拼 rv_<r>', () => {
    vi.useFakeTimers()
    recordListRv('/api/v1/pods', '123')
    const store = useClusterStore()
    store.startWorkloadFamilyWatch()
    channelMocks[0].handlers.onClose?.()                // 触发一次退避重连(非 410)
    vi.runOnlyPendingTimers()                           // 退避到期 → 重连建新通道
    expect(channelMocks.length).toBe(2)
    expect(channelMocks[1].path).toContain('rv_pods=123')
    expect(channelMocks[1].path).not.toContain('rv_events=')
    vi.useRealTimers()
  })

  it('demux:onOpen 全家族 live;tagged services ADDED 行 setQueryData + 注册表 RV 前滚', () => {
    const store = useClusterStore()
    store.startWorkloadFamilyWatch()
    expect(store.watchStateOf('workloads')).toBe('reconnecting')  // 未 onOpen 前
    channelMocks[0].handlers.onOpen?.()
    // mux 下 7 资源状态同生共死
    for (const q of ['pods', 'events', 'workloads', 'services', 'ingresses']) {
      expect(store.watchStateOf(q)).toBe('live')
    }
    expect(store.podWatchLive).toBe(true)
    expect(store.eventWatchLive).toBe(true)
    channelMocks[0].handlers.onMessage(JSON.stringify({ r: 'services', t: 'ADDED', o: { metadata: { name: 'svc1', namespace: 'default', uid: 'u1', resourceVersion: '9' }, spec: {}, status: {} } }))
    expect(store.watchStateOf('services')).toBe('live')   // 消息不改变状态
    expect(getListRv('/api/v1/services')).toBe('9')       // RV 已按事件前滚
  })

  it('err 行({r:"pods",err:410}):relist pods queryKey + abort 通道 + 控制器转 reconnecting', async () => {
    const store = useClusterStore()
    const refetchSpy = vi.spyOn(queryClient, 'refetchQueries').mockResolvedValue()
    store.startWorkloadFamilyWatch()
    channelMocks[0].handlers.onOpen?.()
    recordListRv('/api/v1/pods', '5')
    channelMocks[0].handlers.onMessage(JSON.stringify({ r: 'pods', err: 410 }))
    expect(channelMocks[0].abort).toHaveBeenCalled()       // 通道被主动关掉
    expect(getListRv('/api/v1/pods')).toBe('5')            // 注册表不被 err 行改写,等 refetch 刷新
    // 410 走 relist 路径:该资源 refetch 被请求(两处:err 行 fire-and-forget + 控制器 relist)
    const podsRefetch = refetchSpy.mock.calls.some(([opt]) => opt?.predicate?.({ queryKey: ['cluster', 'c', 'pods'] }))
    expect(podsRefetch).toBe(true)
    expect(store.watchStateOf('pods')).toBe('reconnecting') // 控制器进入重连
    refetchSpy.mockRestore()
  })

  it('非 410 err 行:计失败退避(五连败 degraded)', async () => {
    vi.useFakeTimers()
    const store = useClusterStore()
    const refetchSpy = vi.spyOn(queryClient, 'refetchQueries').mockResolvedValue()
    store.startWorkloadFamilyWatch()
    channelMocks[0].handlers.onOpen?.()
    for (let i = 0; i < 5; i++) {
      channelMocks[i].handlers.onMessage(JSON.stringify({ r: 'events', err: 500 }))
      vi.runOnlyPendingTimers()                           // 退避定时器 → 重连建新通道
    }
    expect(store.watchStateOf('events')).toBe('degraded')
    refetchSpy.mockRestore()
    vi.useRealTimers()
  })

  it('旧入口:startEventWatch 仍开单资源直连 k8sStream(events only)', () => {
    const store = useClusterStore()
    store.startEventWatch()
    expect(streamMocks.length).toBe(1)
    expect(streamMocks[0].path.startsWith('/api/v1/events?watch=true')).toBe(true)
    expect(channelMocks.length).toBe(0)
  })

  it('stopWorkloadFamilyWatch:通道 off + 清注册表', () => {
    recordListRv('/api/v1/pods', '77')
    const store = useClusterStore()
    store.startWorkloadFamilyWatch()
    channelMocks[0].handlers.onOpen?.()
    store.stopWorkloadFamilyWatch()
    expect(store.watchStateOf('workloads')).toBe('off')
    expect(getListRv('/api/v1/pods')).toBe('')
  })
})
