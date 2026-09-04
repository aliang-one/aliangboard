import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { load as yamlLoad } from 'js-yaml'

// 真实 K8s API:RuntimeClass 无 spec 节——handler/overhead/scheduling 都是顶层字段
// (与 PriorityClass 同类)。2026-09-04 前实现产出 spec.handler:apiserver 对 apply
// 报 unknown field → 创建必败;mapRuntimeClass 读 spec?.handler → 列表 handler 列恒空。
// 此测试钉住顶层形状不回退。

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
beforeAll(() => {
  setActivePinia(createPinia())
  store = useClusterStore()
})

describe('generateYAML runtimeclass:顶层 handler(真实 API 无 spec)', () => {
  it('handler 在顶层,且不产出 spec 节', () => {
    const obj = yamlLoad(store.generateYAML('runtimeclass', { name: 'rc1', handler: 'kata-runtime' }))
    expect(obj.handler).toBe('kata-runtime')
    expect(obj.spec).toBeUndefined()
    expect(obj.metadata.name).toBe('rc1')
  })

  it('缺省 handler 兜底 runc,仍在顶层', () => {
    const obj = yamlLoad(store.generateYAML('runtimeclass', { name: 'rc2' }))
    expect(obj.handler).toBe('runc')
    expect(obj.spec).toBeUndefined()
  })
})
