import { test, expect, beforeAll, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// K8s 校验:Service 拥有多个端口时,每个 port 都必须有 name(spec.ports[i].name: Required value)。
// generateYAML 的 service 分支必须在多端口时自动补齐缺失 name(唯一化),单端口保持无损不补。

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

function yamlOf(portList) {
  return store.generateYAML('service', {
    name: 'kind-svc', namespace: 'demo', type: 'ClusterIP',
    selector: { app: 'web' }, portList, ports: '',
  })
}

test('多端口:全部缺 name → 每个 port 自动补 name: port-<port>', () => {
  const y = yamlOf([
    { name: '', port: 80, targetPort: 8080, protocol: 'TCP', nodePort: null, appProtocol: '' },
    { name: '', port: 443, targetPort: 8443, protocol: 'TCP', nodePort: null, appProtocol: '' },
  ])
  const names = [...y.matchAll(/^\s+name: (.+)$/gm)].map(m => m[1])
  expect(names).toContain('port-80')
  expect(names).toContain('port-443')
})

test('多端口:部分有 name → 缺的补、有的不动', () => {
  const y = yamlOf([
    { name: 'http', port: 80, targetPort: 8080, protocol: 'TCP', nodePort: null, appProtocol: '' },
    { name: '', port: 53, targetPort: 53, protocol: 'UDP', nodePort: null, appProtocol: '' },
  ])
  expect(y).toMatch(/name: http/)
  expect(y).toMatch(/name: port-53/)
})

test('多端口:port 号重复 → 自动名追加序号去重', () => {
  const y = yamlOf([
    { name: '', port: 8080, targetPort: 'a', protocol: 'TCP', nodePort: null, appProtocol: '' },
    { name: '', port: 8080, targetPort: 'b', protocol: 'TCP', nodePort: null, appProtocol: '' },
  ])
  expect(y).toMatch(/name: port-8080\b/)
  expect(y).toMatch(/name: port-8080-2\b/)
})

test('单端口无 name → 保持无损,不自动补(K8s 允许单端口匿名)', () => {
  const y = yamlOf([
    { name: '', port: 80, targetPort: 80, protocol: 'TCP', nodePort: null, appProtocol: '' },
  ])
  expect(y).not.toMatch(/^\s+name: port-/m)
})

test('自动补名不改动调用方传入的 portList 对象(纯函数性,防缓存污染)', () => {
  const row = { name: '', port: 80, targetPort: 8080, protocol: 'TCP', nodePort: null, appProtocol: '' }
  yamlOf([row, { ...row, port: 443, targetPort: 8443 }])
  expect(row.name).toBe('')
})
