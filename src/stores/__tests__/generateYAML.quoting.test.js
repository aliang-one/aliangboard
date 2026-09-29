import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { load as yamlLoad } from 'js-yaml'

// === 系统审计(2026-09-29):selector/subjects 裸插值空间穿越 ===
// map[string]string 字段的值裸插进 YAML 时,数字/布尔形态的合法字符串
// ("8080"/"true"/"2")会被网关 js-yaml 解析成 int/bool → apiserver 拒收
// (与 2026-08-16 注解 3600 事故同类,当时只修了 annotations 走 yamlScalar 的面)。
// 本文件钉:Service selector / NetworkPolicy podSelector+peer matchLabels /
// PDB selector / RoleBinding subjects 的值经真 YAML 解析后必须仍是字符串。

vi.mock('@/api/client', () => ({
  api: { applyYaml: vi.fn(), k8s: vi.fn() },
  k8sStream: vi.fn(),
  portForwardApi: {},
  getSavedClusters: vi.fn(() => []),
  addSavedCluster: vi.fn(),
  removeSavedCluster: vi.fn(),
  setActiveToken: vi.fn(),
  activeApiServer: vi.fn(() => ''),
  getSessionToken: vi.fn(() => ''),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import { useClusterStore } from '@/stores/cluster'

let store
beforeAll(() => { setActivePinia(createPinia()); store = useClusterStore() })

describe('generateYAML: 值空间穿越防线(数字/布尔形态字符串保持字符串)', () => {
  it('service selector: "8080"/"true" 经 YAML 解析仍是字符串', () => {
    const y = store.generateYAML('service', {
      name: 'svc1', namespace: 'default', type: 'ClusterIP',
      selector: { port: '8080', enabled: 'true', tier: '2' },
      portList: [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP', nodePort: null }],
    })
    const o = yamlLoad(y)
    expect(o.spec.selector).toEqual({ port: '8080', enabled: 'true', tier: '2' })
  })

  it('networkpolicy podSelector 与 peer matchLabels: 数字形态值保持字符串', () => {
    const y = store.generateYAML('networkpolicy', {
      name: 'np1', namespace: 'default',
      podSelector: { tier: '2' },
      policyTypes: ['Ingress'],
      ingressRules: [{ from: [{ type: 'podSelector', matchLabels: { app: '3' } }] }],
      egressRules: [],
    })
    const o = yamlLoad(y)
    expect(o.spec.podSelector.matchLabels).toEqual({ tier: '2' })
    expect(o.spec.ingress[0].from[0].podSelector.matchLabels).toEqual({ app: '3' })
  })

  it('rolebinding subjects: 全数字用户名保持字符串', () => {
    const y = store.generateYAML('rolebinding', {
      name: 'rb1', namespace: 'default',
      subjects: [{ kind: 'User', name: '1234567890' }],
      roleKind: 'Role', roleName: 'reader',
    })
    const o = yamlLoad(y)
    expect(o.subjects[0].name).toBe('1234567890')
    expect(typeof o.subjects[0].name).toBe('string')
  })

  it('PDB(generateExtraYAML) selector: 数字形态值保持字符串', () => {
    const y = store.generateExtraYAML('pdb', {
      name: 'pdb1', namespace: 'default',
      selector: { shard: '1' },
      minAvailable: '1',
    })
    const o = yamlLoad(y)
    expect(o.spec.selector.matchLabels).toEqual({ shard: '1' })
  })
})
