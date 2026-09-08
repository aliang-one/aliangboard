// 2026-09-08 性能批:nodes 健康轮询的后台暂停。
// 锁定:①可见时 10s 照常轮询;②document.hidden 时跳过(后台标签页不再常驻占用连接);
// ③visibilitychange 回前台立即补一次;④stopHealthCheck 解绑监听(不泄漏)。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/client', () => {
  return {
    api: { k8s: vi.fn(async () => ({ items: [] })) },
    k8sStream: vi.fn(), k8sChannel: vi.fn(() => ({ abort() {} })), portForwardApi: {},
    getSavedClusters: () => [], addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(),
    setActiveToken: vi.fn(), activeApiServer: () => '', getSessionToken: () => '',
  }
})

import { useClusterStore } from '@/stores/cluster'
import { api } from '@/api/client'

let _hidden
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  _hidden = Object.getOwnPropertyDescriptor(document, 'hidden')
})
afterEach(() => {
  if (_hidden) Object.defineProperty(document, 'hidden', _hidden)
})

function setHidden(v) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => v })
}

test('后台标签页跳过健康轮询,回前台 visibilitychange 立即补一次', () => {
  vi.useFakeTimers()
  const store = useClusterStore()
  setHidden(false)
  // setConnectedCluster 是 startHealthCheck 的生产触发点(clusters.js:65)
  store.setConnectedCluster('c1', { apiServer: 'https://k8s.local:6443', version: 'v1.31' })
  expect(api.k8s).toHaveBeenCalledTimes(1, '启动即首轮')

  setHidden(true) // 切到后台
  vi.advanceTimersByTime(30_000)
  expect(api.k8s).toHaveBeenCalledTimes(1, '后台 30s 内零轮询')

  setHidden(false) // 回前台
  document.dispatchEvent(new Event('visibilitychange'))
  expect(api.k8s).toHaveBeenCalledTimes(2, 'visibilitychange 立即补一次')

  vi.advanceTimersByTime(10_000)
  expect(api.k8s).toHaveBeenCalledTimes(3, '回前台后恢复 10s 节奏')

  store.stopHealthCheck()
  store.stopWorkloadFamilyWatch?.() // 顺带清 family watch 控制器(释放其定时器)
  const callsAtStop = api.k8s.mock.calls.length
  setHidden(true)
  document.dispatchEvent(new Event('visibilitychange'))
  vi.advanceTimersByTime(30_000)
  expect(api.k8s.mock.calls.length).toBe(callsAtStop, 'stop 后监听与定时器都应解除')
  vi.useRealTimers()
})
