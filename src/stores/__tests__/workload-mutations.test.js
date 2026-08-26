// 回归测试：restart/rollback/delete/applyWorkloadTemplate 与 scaleWorkload 同源——必须走
// Vue Query 数据层（getWorkloadForEdit + invalidateResource）。旧实现读 store.workloadList
// （远端为空）→ find 返回 undefined → restart 误抛 restartNotSupported、rollback/applyTemplate
// 误抛 workloadNotFound、delete 误报 deleteNotSupported 且不下发 DELETE。即概览页对这些操作
// 「点了没反应/偶尔提示不支持」的同源真因。本测试独立 seed 缓存/探测，不依赖其它用例污染。
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { queryClient } from '@/queryClient'

const mut = [] // { method, path, body }
const { api } = vi.hoisted(() => ({
  api: {
    k8s: vi.fn(async (path, opts) => {
      const method = opts?.method || 'GET'
      if (method !== 'GET') { mut.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null }); return {} }
      // 缓存未命中时 getWorkloadForEdit 逐类型探测：Deployment 单条
      if (typeof path === 'string' && path.includes('/deployments/')) {
        return {
          metadata: { name: 'nginx', namespace: 'default' },
          spec: { replicas: 3, template: { spec: { containers: [{ name: 'nginx', image: 'nginx:1.21' }] } } },
          status: { readyReplicas: 3 },
        }
      }
      // rollbackWorkload 改源后按需拉 replicasets(fetchWorkloadRevisions)
      if (typeof path === 'string' && path.includes('/replicasets')) {
        return {
          items: [{
            metadata: { name: 'nginx-abc', uid: 'u1', annotations: { 'deployment.kubernetes.io/revision': '1' }, ownerReferences: [{ kind: 'Deployment', controller: true, name: 'nginx' }] },
            spec: { template: { spec: { containers: [{ name: 'nginx', image: 'nginx:1.20' }] } } },
          }],
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
beforeEach(() => { mut.length = 0; queryClient.clear() })

const WL_KEY = ['cluster', 'cluster', 'workloads']
const deploy = (over = {}) => ({
  name: 'nginx', namespace: 'default', type: 'Deployment', replicas: '3/3', image: 'nginx:1.21',
  raw: { spec: { replicas: 3, template: { spec: { containers: [{ name: 'nginx', image: 'nginx:1.21' }] } } }, status: { readyReplicas: 3 } },
  ...over,
})

describe('workload 旁系变更 fetch-first（不再读空 workloadList）', () => {
  it('restartWorkload: PATCH restartedAt 注解（旧实现误抛 restartNotSupported）', async () => {
    queryClient.setQueryData(WL_KEY, [deploy()])
    await store.restartWorkload('nginx', 'default')
    expect(mut.length).toBe(1)
    expect(mut[0].method).toBe('PATCH')
    expect(mut[0].path).toContain('/deployments/nginx')
    expect(mut[0].body.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt']).toBeTruthy()
  })

  it('rollbackWorkload: PATCH 目标 template（旧实现误抛 workloadNotFound;改源后 revisions 走按需 fetch,不再读缓存对象）', async () => {
    const tpl = { spec: { containers: [{ name: 'nginx', image: 'nginx:1.20' }] } }
    queryClient.setQueryData(WL_KEY, [deploy()])
    await store.rollbackWorkload('nginx', 'default', 1)
    expect(mut.length).toBe(1)
    expect(mut[0].method).toBe('PATCH')
    expect(mut[0].body.spec.template).toEqual(tpl)
  })

  it('deleteWorkload: DELETE 工作负载（旧实现误报 deleteNotSupported 不下发）', async () => {
    queryClient.setQueryData(WL_KEY, [deploy()])
    await store.deleteWorkload('nginx', 'default')
    expect(mut.length).toBe(1)
    expect(mut[0].method).toBe('DELETE')
    expect(mut[0].path).toContain('/deployments/nginx')
  })

  it('applyWorkloadTemplate: PATCH 深编辑 template（旧实现误抛 workloadNotFound）', async () => {
    queryClient.setQueryData(WL_KEY, [deploy()])
    const template = { spec: { containers: [{ name: 'nginx', image: 'nginx:1.22' }] } }
    await store.applyWorkloadTemplate('nginx', 'default', template)
    expect(mut.length).toBe(1)
    expect(mut[0].method).toBe('PATCH')
    expect(mut[0].body.spec.template).toEqual(template)
  })

  // CPU/内存资源编辑（概览 Edit 的 4000m/512Mi）走的就是 applyWorkloadTemplate 这条深编辑路径。
  // 旧实现抛 workloadNotFound → saveEdit 吞错 → 字段回到旧值。回归：资源量(含 m 后缀)原样透传。
  it('applyWorkloadTemplate: resources(4000m/512Mi) 原样透传——CPU 编辑即此路径', async () => {
    queryClient.setQueryData(WL_KEY, [deploy()])
    const resources = { requests: { cpu: '4000m', memory: '512Mi' }, limits: { cpu: '4000m', memory: '512Mi' } }
    const template = { spec: { containers: [{ name: 'nginx', image: 'nginx:1.22', resources }] } }
    await store.applyWorkloadTemplate('nginx', 'default', template)
    expect(mut.length).toBe(1)
    expect(mut[0].body.spec.template.spec.containers[0].resources).toEqual(resources)
  })

  it('缓存未命中（探测 API 取类型）也能下发：delete', async () => {
    // 空缓存 + 空 workloadList：旧实现直接误报 deleteNotSupported 且 return
    await store.deleteWorkload('nginx', 'default')
    expect(mut.length).toBe(1)
    expect(mut[0].method).toBe('DELETE')
  })
})
