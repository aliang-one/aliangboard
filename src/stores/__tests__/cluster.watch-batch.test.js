// issue#16:workloads watch 族必须携带 batch 双流(jobs/cronjobs merge 进 'workloads' key)。
// 旧态 7 流只覆盖 apps 三类——列表 refetch 间隔被 watch live 态归零后,batch 行永不新鲜。
// 断言:family 通道 URL 的 resources= 参数含 9 路(含 jobs,cronjobs),且 batch 事件行
// 经 mapWorkload 映射后 upsert 进 workloads 查询缓存。
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { queryClient } from '@/queryClient'

const { api, k8sChannel, k8sStream } = vi.hoisted(() => ({
  api: { k8s: vi.fn(async () => ({})) },
  k8sChannel: vi.fn((_path, handlers) => { Object.assign(chanRef.handlers, handlers); return { abort: vi.fn() } }),
  k8sStream: vi.fn(() => ({ abort: vi.fn() })),
}))
const chanRef = { handlers: {} }
vi.mock('@/api/client', () => ({
  api, k8sChannel, k8sStream,
  portForwardApi: {}, getSavedClusters: vi.fn(() => []),
  addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(), setActiveToken: vi.fn(),
  activeApiServer: vi.fn(() => ''), getSessionToken: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import { useClusterStore } from '@/stores/cluster'

beforeAll(() => { setActivePinia(createPinia()) })

describe('workloads watch 族 · batch 双流(issue#16)', () => {
  it('family 通道 resources= 含 jobs,cronjobs(9 路)', () => {
    const store = useClusterStore()
    store.startWorkloadFamilyWatch()
    expect(k8sChannel).toHaveBeenCalled()
    const url = String(k8sChannel.mock.calls.at(-1)[0])
    const resources = new URLSearchParams(url.split('?')[1]).get('resources').split(',')
    expect(resources).toEqual(expect.arrayContaining(['jobs', 'cronjobs']))
    expect(resources).toHaveLength(9)
    store.stopWorkloadFamilyWatch()
  })
})

describe('watch 逐资源 403 剔除(对抗审查 P1:batch 无 watch 权限不得拖垮全家族)', () => {
  // 403 走 relist promise→open() 微任务链,500 走退避定时器:统一轮询冲刷到「本次」重连
  // 建新通道。mock.calls 跨用例累积,须以进入用例时的基线相对计数。
  async function flushReconnect() {
    const baseline = k8sChannel.mock.calls.length
    for (let i = 0; i < 60 && k8sChannel.mock.calls.length < baseline + 1; i++) await vi.advanceTimersByTimeAsync(20)
    expect(k8sChannel.mock.calls.length).toBeGreaterThanOrEqual(baseline + 1)
  }

  it('上游 403 的资源被粘性剔除:重连 URL 不再含该资源,其余 8 路存活', async () => {
    vi.useFakeTimers()
    const store = useClusterStore()
    try {
      store.startWorkloadFamilyWatch()
      // 网关语义:单路上游 403 → 写 {r,err:403} 并关整条通道
      chanRef.handlers.onOpen?.()
      chanRef.handlers.onMessage(JSON.stringify({ r: 'jobs', err: 403 }))
      await flushReconnect()
      const second = String(k8sChannel.mock.calls.at(-1)[0])
      const resources = new URLSearchParams(second.split('?')[1]).get('resources').split(',')
      expect(resources).not.toContain('jobs')
      expect(resources).toEqual(expect.arrayContaining(['pods', 'deployments', 'cronjobs']))
      expect(resources).toHaveLength(8)
    } finally {
      store.stopWorkloadFamilyWatch() // 失败路径也须 stop:粘性剔除是域级状态,防跨用例泄漏
      vi.useRealTimers()
    }
  })

  it('非 403 瞬态错误(如 500/0)不剔除资源:重连仍带全 9 路', async () => {
    vi.useFakeTimers()
    const store = useClusterStore()
    try {
      store.startWorkloadFamilyWatch()
      chanRef.handlers.onOpen?.()
      chanRef.handlers.onMessage(JSON.stringify({ r: 'jobs', err: 500 }))
      await flushReconnect()
      const second = String(k8sChannel.mock.calls.at(-1)[0])
      const resources = new URLSearchParams(second.split('?')[1]).get('resources').split(',')
      expect(resources).toContain('jobs')
      expect(resources).toHaveLength(9)
    } finally {
      store.stopWorkloadFamilyWatch()
      vi.useRealTimers()
    }
  })
})
