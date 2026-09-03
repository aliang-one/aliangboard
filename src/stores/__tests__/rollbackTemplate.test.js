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

  // 2026-09-03 事故回归:NsWorkloadDetail 曾把整个 revision 对象当 revNumber 传入,
  // 严格等恒 miss → 误报 revisionNotFound 且文案插值出 rev-{...整对象...}。
  // store 现兼容对象/数字/字符串数字三种形状,均命中同一 target。
  it.each([
    ['数字', 2],
    ['revision 对象', { rev: 2, image: 'img:2' }],
    ['字符串数字', '2'],
  ])('revNumber 传%s 也能命中 rev2 并 PATCH 完整模板', async (_label, arg) => {
    const deploy = { metadata: { name: 'web', namespace: 'default', annotations: { 'deployment.kubernetes.io/revision': '3' } } }
    const tpl = rev => ({ metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'c', image: `img:${rev}` }] } })
    const rsList = { items: [1, 2].map(rev => ({ metadata: { name: `web-${rev}`, uid: `u${rev}`, annotations: { 'deployment.kubernetes.io/revision': String(rev) }, ownerReferences: [{ kind: 'Deployment', controller: true, name: 'web' }] }, spec: { template: tpl(rev) }, status: {} })) }
    k8sMock.mockImplementation(async p => {
      if (p.includes('/deployments/web') && !p.includes('replicasets')) return deploy
      if (p.includes('/namespaces/default/replicasets')) return rsList
      return {}
    })
    const store = useClusterStore()
    await store.rollbackWorkload('web', 'default', arg)
    const patchCall = k8sMock.mock.calls.find(c => c[1]?.method === 'PATCH')
    expect(patchCall).toBeTruthy()
    const body = JSON.parse(patchCall[1].body)
    expect(body.spec.template).toEqual(tpl(2))
    // last-action 注解必须是数字形态,不得出现 [object Object]
    expect(body.metadata.annotations['aliangboard.io/last-action']).toBe('rollback-to-rev-2')
  })

  it('rev 不存在时报错文案携带可用版本列表(不再插值整对象)', async () => {
    const deploy = { metadata: { name: 'web', namespace: 'default', annotations: { 'deployment.kubernetes.io/revision': '3' } } }
    const rsList = { items: [{ metadata: { name: 'web-1', uid: 'u1', annotations: { 'deployment.kubernetes.io/revision': '1' }, ownerReferences: [{ kind: 'Deployment', controller: true, name: 'web' }] }, spec: { template: { metadata: {}, spec: { containers: [{ name: 'c', image: 'i:1' }] } } }, status: {} }] }
    k8sMock.mockImplementation(async p => {
      if (p.includes('/deployments/web') && !p.includes('replicasets')) return deploy
      if (p.includes('/namespaces/default/replicasets')) return rsList
      return {}
    })
    const store = useClusterStore()
    await expect(store.rollbackWorkload('web', 'default', 99)).rejects.toThrow(/99/)
    await expect(store.rollbackWorkload('web', 'default', 99)).rejects.toThrow(/1/) // 可用列表里含 rev 1
  })
})
