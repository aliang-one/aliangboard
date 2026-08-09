import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { load as yamlLoad } from 'js-yaml'

// 系统性回归:generateYAML/generateExtraYAML 对所有创建类型,
// 形如数字的 name(如 123)必须序列化为字符串,否则 K8s 报
// ".metadata.name: expected string, got int"。范围覆盖 metadata.name/namespace,
// 以及工作负载的 labels/selector/容器名(同样用 ${name}/${resource.name} 插值)。

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

// [type, generator, sample] — name 形如数字 123
const cases = [
  ['service', 'gen', { name: '123', namespace: 'anydoor' }],
  ['ingress', 'gen', { name: '123', namespace: 'anydoor' }],
  ['configmap', 'gen', { name: '123', namespace: 'anydoor' }],
  ['secret', 'gen', { name: '123', namespace: 'anydoor' }],
  ['pvc', 'gen', { name: '123', namespace: 'anydoor' }],
  ['pv', 'gen', { name: '123' }],
  ['deployment', 'gen', { name: '123', namespace: 'anydoor', type: 'Deployment' }],
  ['deployment', 'gen', { name: '123', namespace: 'anydoor', type: 'CronJob' }],
  ['networkpolicy', 'gen', { name: '123', namespace: 'anydoor' }],
  ['hpa', 'gen', { name: '123', namespace: 'anydoor', targetName: 'app' }],
  ['resourcequota', 'gen', { name: '123', namespace: 'anydoor', hard: { pods: '10' } }],
  ['limitrange', 'gen', { name: '123', namespace: 'anydoor' }],
  ['role', 'gen', { name: '123', namespace: 'anydoor' }],
  ['serviceaccount', 'gen', { name: '123', namespace: 'anydoor' }],
  ['rolebinding', 'gen', { name: '123', namespace: 'anydoor' }],
  ['clusterrolebinding', 'gen', { name: '123' }],
  ['ingressclass', 'gen', { name: '123' }],
  ['runtimeclass', 'gen', { name: '123' }],
  ['endpoints', 'gen', { name: '123', namespace: 'anydoor', addresses: ['1.2.3.4'], ports: [{ port: 80 }] }],
  ['node', 'gen', { name: '123' }],
  ['pdb', 'extra', { name: '123', namespace: 'anydoor', minAvailable: 1 }],
  ['priorityclass', 'extra', { name: '123', value: 1 }],
]

describe('generateYAML: 全类型数字名须序列化为字符串', () => {
  for (const [type, which, sample] of cases) {
    it(`${type}: metadata.name === "123" (string)`, () => {
      const yaml = which === 'extra'
        ? store.generateExtraYAML(type, sample)
        : store.generateYAML(type, sample)
      const obj = yamlLoad(yaml)
      expect(obj.metadata.name).toBe('123')
      expect(typeof obj.metadata.name).toBe('string')
    })
  }

  it('Deployment: 标签/选择器/容器名同样为字符串', () => {
    const yaml = store.generateYAML('deployment', { name: '123', namespace: 'anydoor', type: 'Deployment' })
    const obj = yamlLoad(yaml)
    expect(obj.spec.selector.matchLabels.app).toBe('123')
    expect(obj.spec.template.metadata.labels.app).toBe('123')
    expect(obj.spec.template.spec.containers[0].name).toBe('123')
  })

  it('Endpoints: addresses/ports 为空时仍产出合法 YAML', () => {
    const yaml = store.generateYAML('endpoints', { name: 'ep1', namespace: 'anydoor' })
    expect(() => yamlLoad(yaml)).not.toThrow()
    const obj = yamlLoad(yaml)
    expect(obj.metadata.name).toBe('ep1')
    expect(obj.subsets[0].addresses).toEqual([])
    expect(obj.subsets[0].ports).toEqual([])
  })
})
