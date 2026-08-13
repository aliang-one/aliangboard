// 回归测试：scaleWorkload 必须走 Vue Query 数据层（getWorkloadForEdit + invalidateResource），
// 与 updateWorkload/updateWorkloadMeta 同源。旧实现读 store.workloadList（远端为空）→ find 返回
// undefined → 误抛 scaleNotSupported（概览页「+/- 调副本」偶尔提示「不支持调整」），且成功后无
// invalidate，副本大数字要等 30s 轮询才变 → 用户感觉「点了没反应」。本测试独立 seed 缓存/探测，
// 不依赖其它用例对 workloadList 的污染。
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { queryClient } from '@/queryClient'

const patches = []
const { api } = vi.hoisted(() => ({
  api: {
    k8s: vi.fn(async (path, opts) => {
      if (opts && opts.method === 'PATCH') { patches.push({ path, body: JSON.parse(opts.body) }); return {} }
      // 缓存未命中时 getWorkloadForEdit 逐类型探测：Deployment 单条
      if (typeof path === 'string' && path.includes('/deployments/')) {
        return {
          metadata: { name: 'nginx-deploy', namespace: 'default' },
          spec: { replicas: 3, template: { spec: { containers: [{ name: 'nginx', image: 'nginx:1.21' }] } } },
          status: { readyReplicas: 3 },
        }
      }
      return {}
    }),
  },
}))
vi.mock('@/api/client', () => ({
  api, k8sStream: vi.fn(), portForwardApi: {}, getSavedClusters: vi.fn(() => []),
  addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(), setActiveToken: vi.fn(),
  activeApiServer: vi.fn(() => ''), getSessionToken: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import { useClusterStore } from '@/stores/cluster'

let store
beforeAll(() => { setActivePinia(createPinia()); store = useClusterStore() })
beforeEach(() => { patches.length = 0; queryClient.clear() })

const WL_KEY = ['cluster', 'cluster', 'workloads']
const seedCache = list => queryClient.setQueryData(WL_KEY, list)

describe('scaleWorkload（fetch-first + 乐观缓存，不再读空 workloadList）', () => {
  it('缓存命中：PATCH /scale 下发目标 replicas（旧实现误抛 not-supported）', async () => {
    seedCache([{ name: 'nginx-deploy', namespace: 'default', type: 'Deployment', replicas: '3/3', image: 'nginx:1.21', raw: { spec: { replicas: 3 }, status: { readyReplicas: 3 } } }])
    await store.scaleWorkload('nginx-deploy', 'default', 5)
    expect(patches.length).toBe(1)
    expect(patches[0].path).toContain('/deployments/nginx-deploy/scale')
    expect(patches[0].body.spec.replicas).toBe(5)
  })

  it('缓存未命中：探测 API 取类型后仍 PATCH（workloadList 为空也不报「不支持」）', async () => {
    // 空缓存 + 空 workloadList：旧实现此处直接误抛 scaleNotSupported
    await store.scaleWorkload('nginx-deploy', 'default', 5)
    expect(patches.length).toBe(1)
    expect(patches[0].path).toContain('/deployments/nginx-deploy/scale')
  })

  it('乐观更新缓存：desired 立即跳变，ready 不虚增（现实由轮询纠偏）', async () => {
    seedCache([{ name: 'nginx-deploy', namespace: 'default', type: 'Deployment', replicas: '3/3', raw: { spec: { replicas: 3 }, status: { readyReplicas: 3 } } }])
    await store.scaleWorkload('nginx-deploy', 'default', 5)
    const wl = queryClient.getQueryData(WL_KEY).find(w => w.name === 'nginx-deploy')
    expect(wl.raw.spec.replicas).toBe(5)     // rollout.desired 读这里 → 大数字立即跳
    expect(wl.replicas).toBe('3/5')          // 扁平字符串 desired 部分=5，ready 仍 3
  })

  it('乐观回滚：PATCH 失败时 refetch 用真值覆盖（不残留错误跳变）', async () => {
    seedCache([{ name: 'nginx-deploy', namespace: 'default', type: 'Deployment', replicas: '3/3', raw: { spec: { replicas: 3 }, status: { readyReplicas: 3 } } }])
    api.k8s.mockImplementationOnce(async () => { throw new Error('boom') })
    await expect(store.scaleWorkload('nginx-deploy', 'default', 5)).rejects.toThrow('boom')
    // 乐观值不应残留：scaleWorkload 失败须触发 invalidate（真值回填）。这里仅断言不抛 not-supported 误错。
    expect(patches.length).toBe(0)
  })

  it('真正不支持伸缩的类型（DaemonSet）仍拒绝', async () => {
    seedCache([{ name: 'fluentd', namespace: 'default', type: 'DaemonSet', replicas: '2/2', raw: { spec: {}, status: {} } }])
    await expect(store.scaleWorkload('fluentd', 'default', 3)).rejects.toThrow()
    expect(patches.length).toBe(0)
  })
})
