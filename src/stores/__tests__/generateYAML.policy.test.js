import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { load as yamlLoad } from 'js-yaml'

// 回归:策略组(ResourceQuota/LimitRange/PDB)创建清单必须生成合法 YAML,
// metadata.name 即便形如数字也须是字符串(K8s 拒绝 int name),ResourceQuota 不得带 status。
// 根因:
//  - resourcequota: hard/used 条目 2 空格缩进(与 hard: 同级)+ 多了一个 status: 块 → 同 mapping 下 limits.cpu 重复 → 解析报错。
//  - limitrange/pdb: name 未加引号 → name: 123 被解析成整数 → K8s 报 "expected string, got 123"。

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

describe('策略组创建 YAML', () => {
  it('ResourceQuota: 合法 YAML,hard 为 spec 子项,无 status,数字名为字符串', () => {
    const yaml = store.generateYAML('resourcequota', {
      name: '123', namespace: 'anydoor',
      hard: { 'limits.cpu': '8', 'limits.memory': '16Gi', pods: '20', services: '10' },
      used: { 'limits.cpu': '0', 'limits.memory': '0Gi', pods: '0' },
    })
    const obj = yamlLoad(yaml) // 改前:duplicated mapping key 抛错
    expect(obj.metadata.name).toBe('123')
    expect(obj.metadata.namespace).toBe('anydoor')
    // hard 值为 Quantity(kubectl 自身也输出带引号字符串);yamlScalar 隐式类型化防线后纯数字串加引号,round-trip 保真为字符串
    expect(obj.spec.hard).toMatchObject({ 'limits.cpu': '8', 'limits.memory': '16Gi', pods: '20', services: '10' })
    expect(obj.status).toBeUndefined()
  })

  it('LimitRange: 数字名为字符串', () => {
    const yaml = store.generateYAML('limitrange', {
      name: '123', namespace: 'anydoor',
      defaultCPU: '500m', defaultMemory: '512Mi',
      defaultRequestCPU: '250m', defaultRequestMemory: '256Mi',
      maxCPU: '2', maxMemory: '4Gi', minCPU: '50m', minMemory: '64Mi',
    })
    const obj = yamlLoad(yaml)
    expect(obj.metadata.name).toBe('123')
    expect(obj.metadata.namespace).toBe('anydoor')
  })

  it('PDB: 数字名为字符串', () => {
    const yaml = store.generateExtraYAML('pdb', {
      name: '123', namespace: 'anydoor', minAvailable: 2, selector: { app: 'web' },
    })
    const obj = yamlLoad(yaml)
    expect(obj.metadata.name).toBe('123')
    expect(obj.metadata.namespace).toBe('anydoor')
  })
})
