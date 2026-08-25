import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { load as yamlLoad } from 'js-yaml'

vi.mock('@/api/client', () => ({
  api: { applyYaml: vi.fn(), k8s: vi.fn() },
  k8sStream: vi.fn(),
  portForwardApi: {},
  getSavedClusters: vi.fn(() => []),
  addSavedCluster: vi.fn(),
  removeSavedCluster: vi.fn(),
  setActiveToken: vi.fn(),
  activeApiServer: vi.fn(() => ''),
  getSessionToken: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import { useClusterStore } from '@/stores/cluster'

let store
beforeAll(() => { setActivePinia(createPinia()); store = useClusterStore() })

describe('generateYAML secret meta', () => {
  it('labels/annotations 写入 metadata（stringData 保持明文）', () => {
    const y = store.generateYAML('secret', {
      name: 's1', namespace: 'default', type: 'Opaque',
      data: { token: btoa('abc') },                    // gen 内部 decodeBase64 后写 stringData
      labels: { app: 'x' }, annotations: { note: 'n1' },
    })
    const o = yamlLoad(y)
    expect(o.metadata.labels).toEqual({ app: 'x' })
    expect(o.metadata.annotations).toEqual({ note: 'n1' })
    expect(o.stringData).toEqual({ token: 'abc' })
    expect(o.type).toBe('Opaque')
  })

  it('无 labels/annotations 时不输出空块（输出与旧行为逐字一致）', () => {
    const y = store.generateYAML('secret', { name: 's2', namespace: 'default', type: 'Opaque', data: {} })
    expect(y).toBe(`apiVersion: v1
kind: Secret
metadata:
  name: "s2"
  namespace: "default"
type: Opaque
stringData:
  {}`)
  })
})
