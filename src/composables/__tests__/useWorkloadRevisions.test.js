import { describe, it, expect, vi, beforeEach } from 'vitest'

const k8sMock = vi.fn()
vi.mock('@/api/client', () => ({ api: { k8s: (...a) => k8sMock(...a) } }))
beforeEach(() => { k8sMock.mockReset() })

import { fetchWorkloadRevisions } from '../useFetchers'

const deploy = { metadata: { name: 'web', namespace: 'default', annotations: { 'deployment.kubernetes.io/revision': '2' } } }
const rs = rev => ({ metadata: { name: `web-${rev}`, namespace: 'default', uid: `u${rev}`, annotations: { 'deployment.kubernetes.io/revision': String(rev) }, ownerReferences: [{ kind: 'Deployment', controller: true, name: 'web' }] }, spec: { replicas: 1, template: { spec: { containers: [{ name: 'c', image: `img:${rev}` }] } } }, status: { replicas: 1 } })
const otherRs = { ...rs(9), metadata: { ...rs(9).metadata, name: 'other-9', ownerReferences: [{ kind: 'Deployment', controller: true, name: 'other' }] } }

describe('fetchWorkloadRevisions', () => {
  it('Deployment:拉单对象+ns 级 RS,按 ownerReferences 过滤,rev 降序,带 _template', async () => {
    k8sMock.mockImplementation(async p => {
      if (p.includes('/deployments/web')) return deploy
      if (p.includes('/namespaces/default/replicasets')) return { items: [rs(1), rs(2), otherRs] }
      throw new Error('unexpected ' + p)
    })
    const revs = await fetchWorkloadRevisions('Deployment', 'web', 'default')
    expect(revs.map(r => r.rev)).toEqual([2, 1])            // 降序且滤掉 otherRs
    expect(revs[0].current).toBe(true); expect(revs[1].current).toBe(false)
    expect(revs[0]._template.spec.containers[0].image).toBe('img:2')
  })

  it('StatefulSet/DaemonSet:单条当前版本,无 _template(现状语义)', async () => {
    k8sMock.mockResolvedValue({ metadata: { name: 'mysql' }, spec: { template: { spec: { containers: [{ name: 'c', image: 'mysql:8' }] } } } })
    const revs = await fetchWorkloadRevisions('StatefulSet', 'mysql', 'default')
    expect(revs).toHaveLength(1); expect(revs[0].current).toBe(true); expect(revs[0]._template).toBeUndefined()
  })
})
