// 护栏测试：rollbackWorkload 的 PATCH body.spec.template 必须是目标 revision 的
// 完整 ReplicaSet pod template（非镜像兜底）。改源 fetchWorkloadRevisions 后仍守此契约。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const k8sMock = vi.fn()
vi.mock('@/api/client', () => ({
  api: { k8s: (...a) => k8sMock(...a) },
  k8sStream: vi.fn(), getSavedClusters: vi.fn(() => []), addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(),
  setActiveToken: vi.fn(), activeApiServer: vi.fn(), getSessionToken: vi.fn(() => 't'),
}))
// 注意:不 mock useFetchers——rollbackWorkload 走真实 fetchWorkloadRevisions,
// 其 api.k8s 由上面的 k8sMock 供数( mock 整个 useFetchers 会把被测链路一起吞掉)
vi.mock('@/composables/useClusterWatch', () => ({ createWatchController: () => ({ start: vi.fn(), stop: vi.fn() }) }))

import { useClusterStore } from '@/stores/cluster'

beforeEach(() => { k8sMock.mockReset(); setActivePinia(createPinia()) })

describe('rollbackWorkload 护栏', () => {
  it('回滚到 rev2 的 PATCH body.spec.template 与该 rev ReplicaSet 的完整模板一致', async () => {
    const deploy = { metadata: { name: 'web', namespace: 'default', annotations: { 'deployment.kubernetes.io/revision': '3' } } }
    const tpl = rev => ({ metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'c', image: `img:${rev}` }] } })
    const rsList = { items: [1, 2].map(rev => ({ metadata: { name: `web-${rev}`, uid: `u${rev}`, annotations: { 'deployment.kubernetes.io/revision': String(rev) }, ownerReferences: [{ kind: 'Deployment', controller: true, name: 'web' }] }, spec: { template: tpl(rev) }, status: {} })) }
    k8sMock.mockImplementation(async p => {
      if (p.includes('/deployments/web') && !p.includes('replicasets')) return deploy
      if (p.includes('/namespaces/default/replicasets')) return rsList
      return {}
    })
    const store = useClusterStore()
    await store.rollbackWorkload('web', 'default', 2)
    const patchCall = k8sMock.mock.calls.find(c => c[1]?.method === 'PATCH')
    expect(patchCall).toBeTruthy()
    const body = JSON.parse(patchCall[1].body)
    expect(body.spec.template).toEqual(tpl(2))              // 完整模板,非镜像兜底
    expect(body.spec.template.spec.containers[0].image).toBe('img:2')
  })
})
