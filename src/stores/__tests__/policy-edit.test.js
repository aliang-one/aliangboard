import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { load as yamlLoad } from 'js-yaml'

const { applyYaml, k8s } = vi.hoisted(() => {
  const applyYaml = vi.fn()
  const k8s = vi.fn(async (path) => {
    if (typeof path === 'string' && path.includes('resourcequotas'))
      return { metadata: { name: 'rq1', namespace: 'anydoor', creationTimestamp: 'x' }, spec: { hard: { pods: '10', services: '5' } }, status: { used: {} } }
    if (typeof path === 'string' && path.includes('poddisruptionbudgets'))
      return { metadata: { name: 'pdb1', namespace: 'anydoor', creationTimestamp: 'x' }, spec: { minAvailable: 1, selector: { matchLabels: { app: 'x' } } }, status: {} }
    return {}
  })
  return { applyYaml, k8s }
})

vi.mock('@/api/client', () => ({
  api: { applyYaml, k8s },
  k8sStream: vi.fn(), portForwardApi: {}, getSavedClusters: vi.fn(() => []),
  addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(), setActiveToken: vi.fn(),
  activeApiServer: vi.fn(() => ''), getSessionToken: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import { useClusterStore } from '@/stores/cluster'

let store
beforeAll(() => { setActivePinia(createPinia()); store = useClusterStore() })

describe('策略组 updateXxx 真正下发', () => {
  it('updateResourceQuota: applyYaml 被调用且 YAML 含新 hard', async () => {
    applyYaml.mockClear()
    await store.updateResourceQuota('rq1', 'anydoor', { hard: { pods: '5' } })
    expect(applyYaml).toHaveBeenCalledTimes(1)
    const obj = yamlLoad(applyYaml.mock.calls.at(-1)[0])
    expect(obj.metadata.name).toBe('rq1')
    expect(obj.spec.hard.pods).toBe(5)
  })

  it('updatePDB: 下发新 minAvailable 且保留 selector', async () => {
    applyYaml.mockClear()
    await store.updatePDB('pdb1', 'anydoor', { minAvailable: '2', maxUnavailable: '' })
    expect(applyYaml.mock.calls.length).toBe(1)
    const obj = yamlLoad(applyYaml.mock.calls[0][0])
    expect(obj.spec.minAvailable).toBe(2)
    expect(obj.spec.selector?.matchLabels?.app).toBe('x')
  })
})
